import base64
import mimetypes
import os
import time
from typing import Dict, Tuple

import requests

from .base import VideoGenModel
from .image import ImageGenModel

GROK_IMAGE_MODEL = "grok-imagine-image-2.0"
MAX_TEMP_UPLOAD_BYTES = 20 * 1024 * 1024
JIUCAIHEZI_BASE_URL = "https://api.jiucaihezi.studio"
TEMP_UPLOAD_ATTEMPTS = 3
TEMP_UPLOAD_TIMEOUT = (15, 120)


def _base_url() -> str:
    return JIUCAIHEZI_BASE_URL


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
    response.raise_for_status()
    with open(output_path, "wb") as output:
        output.write(response.content)


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
        model = kwargs.get("model_name") or "gpt-image-2-1k"
        model = model.split("/", 1)[-1].split("#", 1)[0]
        size = (kwargs.get("size") or "1024*1024").replace("*", "x")
        if model == GROK_IMAGE_MODEL:
            return self._generate_grok(prompt, output_path, model, size, refs, started)
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

    def _generate_grok(
        self,
        prompt: str,
        output_path: str,
        model: str,
        size: str,
        refs: list,
        started: float,
    ) -> Tuple[str, float]:
        payload = {"model": model, "prompt": prompt, "size": size, "response_format": "url"}
        handles = []
        try:
            if refs:
                files = []
                for ref in refs[:8]:
                    if ref.startswith(("http://", "https://")):
                        downloaded = requests.get(ref, timeout=180)
                        downloaded.raise_for_status()
                        mime = downloaded.headers.get("Content-Type", "image/png").split(";", 1)[0]
                        name = os.path.basename(ref.split("?", 1)[0]) or "reference.png"
                        files.append(("image[]", (name, downloaded.content, mime)))
                        continue
                    path = ref if os.path.exists(ref) else os.path.join("output", ref)
                    if os.path.exists(path):
                        handle = open(path, "rb")
                        handles.append(handle)
                        files.append(("image[]", (os.path.basename(path), handle, mimetypes.guess_type(path)[0] or "image/png")))
                if not files:
                    raise ValueError("No valid reference images found for Grok image generation")
                response = requests.post(
                    f"{_base_url()}/v1/videos",
                    headers=_headers(),
                    data=payload,
                    files=files,
                    timeout=180,
                )
            else:
                response = requests.post(
                    f"{_base_url()}/v1/videos",
                    headers={**_headers(), "Content-Type": "application/json"},
                    json=payload,
                    timeout=180,
                )
        finally:
            for handle in handles:
                handle.close()

        response.raise_for_status()
        task = response.json()
        task_id = task.get("task_id") or task.get("id")
        if not task_id:
            raise RuntimeError(f"Grok image response missing task id: {task}")

        for _ in range(180):
            time.sleep(10)
            poll = requests.get(f"{_base_url()}/v1/videos/{task_id}", headers=_headers(), timeout=60)
            poll.raise_for_status()
            result = poll.json()
            if result.get("status") in ("completed", "succeeded"):
                url = (result.get("metadata") or {}).get("url")
                if not url:
                    raise RuntimeError(f"Grok image completed without metadata.url: {result}")
                _download(url, output_path)
                return output_path, time.time() - started
            if result.get("status") in ("failed", "error", "cancelled"):
                raise RuntimeError(f"Grok image failed: {result}")
        raise TimeoutError("Grok image task timed out")


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
        payload = {"model": model_name, "prompt": prompt, "ratio": kwargs.get("aspect_ratio") or kwargs.get("ratio") or "16:9"}
        if model_name == "minimax_h3_image_audio_to_video_v2_15s":
            payload["duration"] = int(kwargs.get("duration") or 5)
            payload["resolution"] = kwargs.get("resolution") or "768p横"
            audio_refs = list(kwargs.get("reference_audio_urls") or [])
            if kwargs.get("audio_url"):
                audio_refs.insert(0, kwargs["audio_url"])
            if audio_refs:
                payload["audios"] = [_public_media_url(ref, "audio") for ref in dict.fromkeys(audio_refs)][:3]
        if images:
            payload["images"] = images[:30] if model_name == "dola-seedance2.5" else images[:9]
        response = requests.post(f"{_base_url()}/v1/videos", headers={**_headers(), "Content-Type": "application/json"}, json=payload, timeout=120)
        response.raise_for_status()
        task = response.json()
        task_id = task.get("task_id") or task.get("id")
        if not task_id:
            raise RuntimeError(f"Jiucaihezi video response missing task id: {task}")
        for _ in range(180):
            time.sleep(10)
            poll = requests.get(f"{_base_url()}/v1/videos/{task_id}", headers=_headers(), timeout=60)
            poll.raise_for_status()
            result = poll.json()
            if result.get("status") in ("completed", "succeeded"):
                url = result.get("video_url")
                if url:
                    _download(url, output_path)
                else:
                    _download_video_content(task_id, output_path)
                return output_path, time.time() - started
            if result.get("status") in ("failed", "error", "cancelled"):
                raise RuntimeError(f"Jiucaihezi video failed: {result}")
        raise TimeoutError("Jiucaihezi video task timed out")
