import base64
import mimetypes
import os
import time
from typing import Any, Dict, Optional, Sequence, Tuple

import requests

from .base import VideoGenModel
from .image import ImageGenModel
from ..utils.model_catalog import is_minimax_h3_model



MAX_TEMP_UPLOAD_BYTES = 20 * 1024 * 1024
JIUCAIHEZI_BASE_URL = "https://api.jiucaihezi.studio"
TEMP_UPLOAD_ATTEMPTS = 3
TEMP_UPLOAD_TIMEOUT = (15, 120)

# 音频生成是一个独立模型（不是视频模型上的开关）：`POST /v1/audio/speech`，
# 参考音频可选（0–3 段）。Playground 的 t2a/r2a 和 Studio 的「AI 配音」都走它。
AUDIO_MODEL_DEFAULT = "seed-audio-1.0"
AUDIO_MAX_REFERENCE_AUDIOS = 3
AUDIO_MAX_INPUT_CHARS = 3000
AUDIO_SPEECH_TIMEOUT = 300
# Task creation returns the task id in milliseconds; the transfer of reference
# assets and the upstream submission now happen in the background.
VIDEO_CREATE_TIMEOUT = (15, 180)
VIDEO_POLL_INTERVAL = 10
VIDEO_POLL_REQUEST_TIMEOUT = 60
VIDEO_POLL_TIMEOUT = 30 * 60


def _base_url() -> str:
    return JIUCAIHEZI_BASE_URL


# `resolution` 的 横/竖 后缀已经决定了横竖，`ratio` 是同一件事的冗余表达。
# 上游两个字段都收，所以传一对矛盾的组合（16:9 + 768p竖）行为不可预期。
# 规则：以 resolution 为准，且只在两者**横竖相反**时才纠正 —— 同向的合法组合原样保留。
_ORIENTATION_SUFFIXES = ("横", "竖")


def _ratio_orientation(ratio: str) -> str:
    """'16:9' -> '横'，'9:16' -> '竖'，'1:1' / 格式无法解析 -> ''。"""
    parts = str(ratio).split(":")
    if len(parts) != 2:
        return ""
    try:
        width, height = int(parts[0]), int(parts[1])
    except ValueError:
        return ""
    if width > height:
        return "横"
    if height > width:
        return "竖"
    return ""


def _align_ratio_with_resolution(ratio: str, resolution: str) -> str:
    suffix = str(resolution)[-1:] if resolution else ""
    if suffix not in _ORIENTATION_SUFFIXES:
        return ratio
    if _ratio_orientation(ratio) in ("", suffix):
        return ratio
    return "16:9" if suffix == "横" else "9:16"


def _headers() -> Dict[str, str]:
    key = os.getenv("JIUCAIHEZI_API_KEY")
    if not key:
        raise RuntimeError("JIUCAIHEZI_API_KEY not configured")
    return {"Authorization": f"Bearer {key}"}


def _download(url: str, output_path: str) -> None:
    response = requests.get(url, timeout=300)
    response.raise_for_status()
    with open(output_path, "wb") as output:
        output.write(response.content)


def _download_video_content(task_id: str, output_path: str) -> None:
    response = requests.get(
        f"{_base_url()}/v1/videos/{task_id}/content",
        headers=_headers(),
        timeout=300,
    )
    if not response.ok:
        raise RuntimeError(
            f"Jiucaihezi video content download failed ({response.status_code}): "
            f"{_error_message(response)}"
        )
    with open(output_path, "wb") as output:
        output.write(response.content)


def _error_message(response) -> str:
    """Return the gateway's structured ``error.message`` when it provides one."""
    try:
        payload = response.json()
    except ValueError:
        payload = None
    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict) and error.get("message"):
            return str(error["message"])
        if isinstance(error, str) and error:
            return error
        for key in ("message", "detail"):
            if payload.get(key):
                return str(payload[key])
    return (getattr(response, "text", "") or "").strip()[:300]


def generate_audio(
    prompt: str,
    output_path: str,
    model_name: Optional[str] = None,
    reference_audio_urls: Sequence[str] = (),
    response_format: str = "mp3",
) -> str:
    """用 ``seed-audio-1.0`` 生成音频（`POST /v1/audio/speech`）。

    参考音频**可选**：给了就作为 ``metadata.references`` 发过去（最多 3 段），
    不给就是纯文生音频。本地路径会先传到网关换成公开 URL —— 与视频参考素材同一
    条转存通道。

    失败直接抛：网关会返回结构化 ``error.message``，调用方据此决定是中断还是降级。
    返回 ``output_path``。
    """
    text = (prompt or "").strip()
    if not text:
        # 合同：input 必填、1–3000 字符。空字符串上游会 400，本地报清楚更省一次请求。
        raise ValueError("Seed Audio input must contain 1-3000 characters")

    refs = [
        {"audio_url": _public_media_url(ref, "audio")}
        for ref in list(reference_audio_urls or [])[:AUDIO_MAX_REFERENCE_AUDIOS]
    ]
    payload: Dict[str, Any] = {
        "model": model_name or AUDIO_MODEL_DEFAULT,
        "input": text[:AUDIO_MAX_INPUT_CHARS],
        "response_format": response_format,
    }
    if refs:
        payload["metadata"] = {"references": refs}

    response = requests.post(
        f"{_base_url()}/v1/audio/speech",
        headers={**_headers(), "Content-Type": "application/json"},
        json=payload,
        timeout=AUDIO_SPEECH_TIMEOUT,
    )
    if not response.ok:
        raise RuntimeError(f"Jiucaihezi audio generation failed: {_error_message(response)}")

    directory = os.path.dirname(output_path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(output_path, "wb") as output:
        output.write(response.content)
    return output_path


def upload_to_jiucaihezi(path: str, media_type: str = "media") -> str:
    """Upload a local URL-type reference to Jiucaihezi's temporary media API.

    This is intentionally fail-closed: Jiucaihezi reference URLs must never
    fall back to OSS or any other storage provider.
    """
    if not os.path.isfile(path):
        raise RuntimeError(f"Jiucaihezi {media_type} upload source not found: {path}")
    if os.path.getsize(path) > MAX_TEMP_UPLOAD_BYTES:
        raise RuntimeError(
            f"Jiucaihezi {media_type} upload exceeds the 20 MB temporary-media limit"
        )
    content_type = mimetypes.guess_type(path)[0]
    allowed_prefix = {"image": "image/", "audio": "audio/", "video": "video/"}.get(media_type)
    if not content_type or (allowed_prefix and not content_type.startswith(allowed_prefix)):
        raise RuntimeError(f"Jiucaihezi temporary upload does not accept this {media_type} file type")
    response = None
    for attempt in range(1, TEMP_UPLOAD_ATTEMPTS + 1):
        try:
            # Reopen the file on every attempt so retries always start at byte 0.
            with open(path, "rb") as handle:
                response = requests.post(
                    f"{_base_url()}/api/creations/uploads",
                    headers=_headers(),
                    files={"file": (os.path.basename(path), handle, content_type)},
                    timeout=TEMP_UPLOAD_TIMEOUT,
                )
            response.raise_for_status()
            data = response.json()
            url = data.get("url") or (data.get("data") or {}).get("url")
            break
        except requests.HTTPError as exc:
            status = exc.response.status_code if exc.response is not None else None
            detail = (exc.response.text if exc.response is not None else str(exc))[:300]
            if status is not None and status < 500:
                raise RuntimeError(
                    f"Jiucaihezi {media_type} upload rejected ({status}): {detail}"
                ) from exc
            last_error = f"HTTP {status}: {detail}" if status else str(exc)
        except (requests.Timeout, requests.ConnectionError) as exc:
            last_error = str(exc)
        except (ValueError, TypeError) as exc:
            raise RuntimeError(
                f"Jiucaihezi {media_type} upload returned an invalid response: {exc}"
            ) from exc
        if attempt < TEMP_UPLOAD_ATTEMPTS:
            time.sleep(attempt)
    else:
        raise RuntimeError(
            f"Jiucaihezi {media_type} upload failed after {TEMP_UPLOAD_ATTEMPTS} attempts: {last_error}"
        )
    if not isinstance(url, str) or not url.startswith(("http://", "https://")):
        raise RuntimeError(
            f"Jiucaihezi {media_type} upload returned no public URL"
        )
    return url


def _public_media_url(ref: str, media_type: str = "media") -> str:
    if ref.startswith(("http://", "https://")):
        return ref
    path = ref if os.path.exists(ref) else os.path.join("output", ref)
    return upload_to_jiucaihezi(path, media_type)


class JiucaiheziImageModel(ImageGenModel):
    def generate(self, prompt: str, output_path: str, **kwargs) -> Tuple[str, float]:
        started = time.time()
        refs = kwargs.get("ref_image_paths") or ([] if not kwargs.get("ref_image_path") else [kwargs["ref_image_path"]])
        model = kwargs.get("model_name") or "gpt-image-2.5-1k"
        model = model.split("/", 1)[-1].split("#", 1)[0]
        size = (kwargs.get("size") or "1024*1024").replace("*", "x")
        if refs:
            files = []
            handles = []
            for ref in refs:
                if ref.startswith(("http://", "https://")):
                    downloaded = requests.get(ref, timeout=180)
                    downloaded.raise_for_status()
                    mime = downloaded.headers.get("Content-Type", "image/png").split(";", 1)[0]
                    files.append(("image", (os.path.basename(ref) or "reference", downloaded.content, mime)))
                    continue
                path = ref if os.path.exists(ref) else os.path.join("output", ref)
                if os.path.exists(path):
                    handle = open(path, "rb")
                    handles.append(handle)
                    files.append(("image", (os.path.basename(path), handle, mimetypes.guess_type(path)[0] or "image/png")))
            if not files:
                raise ValueError("No valid reference images found for image editing")
            data = {"model": model, "prompt": prompt, "size": size, "n": str(kwargs.get("n", 1)), "response_format": "url"}
            try:
                response = requests.post(f"{_base_url()}/v1/images/edits", headers=_headers(), data=data, files=files, timeout=180)
            finally:
                for handle in handles:
                    handle.close()
        else:
            response = requests.post(f"{_base_url()}/v1/images/generations", headers={**_headers(), "Content-Type": "application/json"}, json={"model": model, "prompt": prompt, "size": size, "n": kwargs.get("n", 1), "response_format": "url"}, timeout=180)
        response.raise_for_status()
        item = (response.json().get("data") or [{}])[0]
        url = item.get("url")
        if url:
            _download(url, output_path)
        else:
            with open(output_path, "wb") as output:
                output.write(base64.b64decode(item["b64_json"]))
        return output_path, time.time() - started


class JiucaiheziVideoModel(VideoGenModel):
    def generate(self, prompt: str, output_path: str, **kwargs) -> Tuple[str, float]:
        started = time.time()
        model_name = (kwargs.get("model_name") or "dola-seedance2.5").split("/", 1)[-1].split("#", 1)[0]
        if model_name == "dola-seedance2.5-r2v":
            model_name = "dola-seedance2.5"
        images = list(kwargs.get("ref_image_urls") or [])
        if kwargs.get("img_url"):
            images.insert(0, kwargs["img_url"])
        if kwargs.get("img_path"):
            images.insert(0, kwargs["img_path"])
        images = [_public_media_url(ref, "image") for ref in dict.fromkeys(images)]
        resolution = str(kwargs.get("resolution") or "")
        ratio = kwargs.get("aspect_ratio") or kwargs.get("ratio") or "16:9"
        # 横/竖 是 MiniMax H3 独有的 resolution 约定，只有它的 resolution 会发给上游。
        # 别的模型（dola 用 "720p"，resolution 根本不进 payload）不能因为调用方传了个
        # 带 横/竖 的值就改掉它的 ratio。
        if is_minimax_h3_model(model_name):
            ratio = _align_ratio_with_resolution(ratio, resolution)
        payload = {"model": model_name, "prompt": prompt, "ratio": ratio}
        if is_minimax_h3_model(model_name):
            payload["duration"] = int(kwargs.get("duration") or 5)
            payload["resolution"] = resolution or "768p横"
            audio_refs = list(kwargs.get("reference_audio_urls") or [])
            if kwargs.get("audio_url"):
                audio_refs.insert(0, kwargs["audio_url"])
            if audio_refs:
                payload["audios"] = [_public_media_url(ref, "audio") for ref in dict.fromkeys(audio_refs)][:3]
        if images:
            payload["images"] = images[:30] if model_name == "dola-seedance2.5" else images[:9]
        try:
            response = requests.post(
                f"{_base_url()}/v1/videos",
                headers={**_headers(), "Content-Type": "application/json"},
                json=payload,
                timeout=VIDEO_CREATE_TIMEOUT,
            )
        except requests.Timeout as exc:
            # Never retry a task-creation POST automatically: the gateway may
            # already have accepted and billed it even though its response was
            # lost. Retrying here could create and charge for a duplicate task.
            raise RuntimeError(
                "Jiucaihezi video task creation did not return within 180 seconds; "
                "submission status is unknown and it was not retried to avoid duplicate billing"
            ) from exc
        if not response.ok:
            # The create endpoint returns a structured error.message for 4xx.
            raise RuntimeError(
                f"Jiucaihezi video task creation rejected ({response.status_code}): "
                f"{_error_message(response)}"
            )
        task = response.json()
        task_id = task.get("task_id") or task.get("id")
        if not task_id:
            raise RuntimeError(f"Jiucaihezi video response missing task id: {task}")

        deadline = time.monotonic() + VIDEO_POLL_TIMEOUT
        poll_url = f"{_base_url()}/v1/videos/{task_id}"
        while True:
            if time.monotonic() >= deadline:
                # Re-polling the same task id is safe; re-creating it would
                # submit and bill a duplicate task.
                raise TimeoutError(
                    f"Jiucaihezi video task {task_id} still running after "
                    f"{VIDEO_POLL_TIMEOUT // 60} minutes; retry by polling the same task id"
                )
            time.sleep(VIDEO_POLL_INTERVAL)
            try:
                poll = requests.get(poll_url, headers=_headers(), timeout=VIDEO_POLL_REQUEST_TIMEOUT)
            except (requests.Timeout, requests.ConnectionError):
                continue
            if not poll.ok:
                continue
            result = poll.json()
            status = str(result.get("status") or "").lower()
            if status in ("completed", "succeeded"):
                # Always fetch the artifact from the content endpoint; the
                # poll response's url field is not authoritative.
                _download_video_content(task_id, output_path)
                return output_path, time.time() - started
            if status in ("failed", "error", "cancelled"):
                raise RuntimeError(f"Jiucaihezi video failed: {_error_message(poll)}")
            # queued / in_progress / pending: keep polling until the deadline.
