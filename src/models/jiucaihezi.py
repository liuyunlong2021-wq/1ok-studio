import base64
import logging
import mimetypes
import os
import time
from typing import Any, Dict, Optional, Sequence, Tuple

import requests

from .base import VideoGenModel
from .image import ImageGenModel
from ..utils.model_catalog import is_minimax_h3_model


logger = logging.getLogger(__name__)


def _raise_for_status_with_body(response: requests.Response, what: str) -> None:
    """把上游的响应体带进异常。

    `requests` 的 raise_for_status() 只留一句 "400 Bad Request"，而网关（New API）的
    body 里写着真正的原因 —— `model not found` / 参数不合法 / 上游 502 之类。丢掉它
    就只能靠猜，偏偏排障最需要的就是那一句。

    判断仍然交给 raise_for_status() 自己（测试里常把 response 换成 Mock），这里只在
    它抛错之后补上响应体。
    """
    try:
        response.raise_for_status()
    except requests.exceptions.HTTPError as exc:
        detail = " ".join((response.text or "").split())[:400]
        if not detail:
            raise
        raise requests.exceptions.HTTPError(
            f"{exc} | upstream says: {detail}",
            response=response,
        ) from exc


def _log_image_request(endpoint: str, payload: Dict[str, Any]) -> None:
    """记录出图请求的关键字段（提示词只记长度）。

    出图失败时第一个要回答的问题是「我们到底发了什么」，而 model / size / quality /
    n 这几个字段正是历史踩坑点（模型名带中文、size 格式、质量档）。
    """
    logger.info(
        "Jiucaihezi image request -> %s | model=%s size=%s quality=%s n=%s format=%s prompt_chars=%s",
        endpoint,
        payload.get("model"),
        payload.get("size"),
        payload.get("quality"),
        payload.get("n"),
        payload.get("response_format"),
        len(str(payload.get("prompt") or "")),
    )


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
#: seed-audio 在合成前先审文本，拦下来只回一句 `demo text audit failed`（实测 2026-09-19，
#: 1 秒内返回 —— 没进合成、也没计费）。光看这句用户不知道该改什么，见 `_audio_failure_message`。
AUDIO_TEXT_AUDIT_CODE = "45001125"
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
    _raise_for_status_with_body(response, url)
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


def query_video_task(task_id: str) -> Dict[str, Any]:
    """按上游任务号问一次状态。**只读**：不提交、不计费。

    网关把任务留得比我们想得久（实测 3 天前的任务号仍可查），所以「回捞」是行得通
    的：拿着存下来的 task_id 重新问一次，完成了就补下载，不必重新生成。
    """
    response = requests.get(
        f"{_base_url()}/v1/videos/{task_id}",
        headers=_headers(),
        timeout=VIDEO_POLL_REQUEST_TIMEOUT,
    )
    if not response.ok:
        raise RuntimeError(
            f"Jiucaihezi video task query failed ({response.status_code}): "
            f"{_error_message(response)} [task {task_id}]"
        )
    payload = response.json()
    return payload if isinstance(payload, dict) else {}


def download_video_content(task_id: str, output_path: str, attempts: int = 3) -> str:
    """取回产物，瞬时故障重试几次。

    实测过 403 `request blocked: port … is not allowed` 这种中转侧的拦截 —— 任务在
    上游其实已经生成好了，下一次请求就能拿到。以前一次不成就把整个任务判死，代价
    是用户白付的钱。错误里**带上 task id**：不带的版本让我事后连是哪个上游任务都
    查不出来。
    """
    last_error: Optional[Exception] = None
    for attempt in range(max(1, attempts)):
        try:
            _download_video_content(task_id, output_path)
            return output_path
        except Exception as exc:  # noqa: BLE001 — 逐个重试，最后一次抛原异常
            last_error = exc
            if attempt + 1 < attempts:
                # 退避拉长一点：实测那种 403/502 是中转侧的瞬时状态，几秒后又好了。
                # 调用方是后台任务，多等十几秒换回一条已经付过费的视频，划算。
                time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"{last_error} [task {task_id}]")


def poll_video_task(
    task_id: str,
    output_path: str,
    timeout: int = VIDEO_POLL_TIMEOUT,
) -> str:
    """按**已存在**的上游任务号轮询到完成并取回产物。

    不会重新提交，所以重跑这个函数是安全的（重复提交才会重复计费）。超时抛
    ``TimeoutError``，任务号仍然有效 —— 稍后再调它一次就能接着等。
    """
    deadline = time.monotonic() + timeout
    while True:
        if time.monotonic() >= deadline:
            raise TimeoutError(
                f"Jiucaihezi video task {task_id} still running after "
                f"{timeout // 60} minutes; retry by polling the same task id"
            )
        time.sleep(VIDEO_POLL_INTERVAL)
        try:
            result = query_video_task(task_id)
        except Exception:  # noqa: BLE001 — 网络抖动不算失败，下一轮接着问
            continue
        status = str(result.get("status") or "").lower()
        if status in ("completed", "succeeded"):
            # Always fetch the artifact from the content endpoint; the poll
            # response's url field is not authoritative.
            try:
                return download_video_content(task_id, output_path)
            except Exception as exc:  # noqa: BLE001 — 换句人能看懂的话再抛
                # 实测：任务号能查很久，但产物只在有限窗口内可取 —— 过期之后再拉
                # 就是 502/400。这两种情况对用户来说完全不一样（「还要等」vs「已经取
                # 不回了」），报清楚才知道该不该重新生成。
                raise RuntimeError(
                    f"上游任务已完成，但产物取不回来（任务号 {task_id}，网关侧已不可用）：{exc}"
                ) from exc
        if status in ("failed", "error", "cancelled"):
            raise RuntimeError(
                f"Jiucaihezi video failed: {_payload_error_message(result)} [task {task_id}]"
            )
        # queued / in_progress / pending: keep polling until the deadline.


def _error_message(response) -> str:
    """Return the gateway's structured ``error.message`` when it provides one."""
    try:
        payload = response.json()
    except ValueError:
        payload = None
    return _payload_error_message(payload, getattr(response, "text", ""))


def _payload_error_message(payload, raw_text: str = "") -> str:
    """Same extraction, but from an already-parsed payload dict."""
    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict) and error.get("message"):
            return str(error["message"])
        if isinstance(error, str) and error:
            return error
        for key in ("message", "detail", "fail_reason", "error_message"):
            if payload.get(key):
                return str(payload[key])
    return (raw_text or "").strip()[:300]


def _audio_failure_message(response) -> str:
    """音频接口的错误读成人话。

    `demo text audit failed` 是上游文本审核拦下来的意思：导演稿里那段肉搏 / 血腥
    描写整篇都会被拒收，逐词改写没用（实测换掉「猛烈/粗暴/冲撞」全部无效，删两个字
    就能从拦变过）—— 所以这里给的是**处置办法**，不是错误码。上游原文照样带上，
    排障时还要看它。
    """
    try:
        payload = response.json()
    except ValueError:
        payload = None
    message = _payload_error_message(payload, getattr(response, "text", ""))
    error = payload.get("error") if isinstance(payload, dict) else None
    code = str(error.get("code") or "") if isinstance(error, dict) else ""
    if code == AUDIO_TEXT_AUDIT_CODE or "text audit" in message.lower():
        return (
            "上游文本审核没通过：这版导演稿里的打斗 / 血腥这类物理冲突描写会被 "
            f"seed-audio 整篇拒收（上游原文：{message}）。把这一段改成声音层描写"
            "（呼吸、衣料摩擦、脚步与地面、人群反应、环境声），或重新生成一版导演稿再试。"
        )
    return f"Jiucaihezi audio generation failed: {message}"


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
        raise RuntimeError(_audio_failure_message(response))

    directory = os.path.dirname(output_path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(output_path, "wb") as output:
        output.write(response.content)
    return output_path


def upload_to_jiucaihezi(path: str, media_type: str = "media") -> str:
    """Upload a local URL-type reference to Jiucaihezi's temporary media API.

    This is intentionally fail-closed: Jiucaihezi reference URLs must never
    fall back to any other storage provider.
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
        # quality 只有声明了该档位的模型（如 gpt-image-2.5-菠萝）才会传进来；
        # 别的模型这里是 None，JSON 里不带这个键。
        quality = kwargs.get("quality")
        if refs:
            files = []
            handles = []
            for ref in refs:
                if ref.startswith(("http://", "https://")):
                    downloaded = requests.get(ref, timeout=180)
                    _raise_for_status_with_body(downloaded, ref)
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
            if quality:
                data["quality"] = str(quality)
            endpoint = "/v1/images/edits"
            _log_image_request(endpoint, data)
            try:
                response = requests.post(f"{_base_url()}{endpoint}", headers=_headers(), data=data, files=files, timeout=180)
            finally:
                for handle in handles:
                    handle.close()
        else:
            payload = {"model": model, "prompt": prompt, "size": size, "n": kwargs.get("n", 1), "response_format": "url"}
            if quality:
                payload["quality"] = str(quality)
            endpoint = "/v1/images/generations"
            _log_image_request(endpoint, payload)
            response = requests.post(f"{_base_url()}{endpoint}", headers={**_headers(), "Content-Type": "application/json"}, json=payload, timeout=180)
        _raise_for_status_with_body(response, endpoint)
        try:
            payload = response.json()
        except ValueError:
            payload = None
        raw_item = ((payload or {}).get("data") or [{}])[0] if isinstance(payload, dict) else {}
        item = raw_item if isinstance(raw_item, dict) else {}
        url = item.get("url")
        b64 = item.get("b64_json")
        if url:
            _download(url, output_path)
        elif b64:
            with open(output_path, "wb") as output:
                output.write(base64.b64decode(b64))
        else:
            # 「HTTP 200 但 data 是空的」是网关的另一种坏法（z-image-turbo 实测如此）：
            # 通道在、上游没产出。裸 item["b64_json"] 只会扔一个 KeyError，
            # 把网关那句话丢掉，用户看到的是 `KeyError: 'b64_json'`。
            detail = _payload_error_message(payload, "") or "响应体里没有可读的错误信息"
            raise RuntimeError(f"出图失败：网关返回 200 但没有图片数据（{detail}）")
        return output_path, time.time() - started


class JiucaiheziVideoModel(VideoGenModel):
    def generate(self, prompt: str, output_path: str, **kwargs) -> Tuple[str, float]:
        started = time.time()
        model_name = (kwargs.get("model_name") or "海seedance2.5").split("/", 1)[-1].split("#", 1)[0]
        if model_name == "dola-seedance2.5-r2v":
            # 存量数据里存过的旧写法，网关没有这个名字（见目录里的 legacy 别名）。
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
            # 两个 Seedance 2.5 通道都是 9 张参考图上限（与目录的
            # inputs.reference_images.max 和前端 VideoCreator 的上限对齐）。
            payload["images"] = images[:9]
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
        # 拿到任务号的第一时间就交给调用方（落盘）。轮询可能要几分钟，期间后端一重启
        # 这个号就只活在内存里了 —— 存下去才能拿它回头把已经生成的视频捞回来。
        on_task_id = kwargs.get("on_task_id")
        if callable(on_task_id):
            try:
                on_task_id(str(task_id))
            except Exception:  # noqa: BLE001 — 记录失败不能拖垮生成本身
                pass

        poll_video_task(str(task_id), output_path)
        return output_path, time.time() - started
