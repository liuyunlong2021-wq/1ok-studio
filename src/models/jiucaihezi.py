import base64
import mimetypes
import os
import time
from typing import Any, Dict, Tuple

import requests

from .base import VideoGenModel
from .image import ImageGenModel


def _base_url() -> str:
    return (os.getenv("JIUCAIHEZI_BASE_URL") or "https://api.jiucaihezi.studio").rstrip("/")


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


def _public_image_url(ref: str) -> str:
    if ref.startswith(("http://", "https://")):
        return ref
    path = ref if os.path.exists(ref) else os.path.join("output", ref)
    from ..utils.oss_utils import OSSImageUploader

    uploader = OSSImageUploader()
    if os.path.exists(path):
        object_key = uploader.upload_file(path, sub_path="temp/jiucaihezi")
    else:
        object_key = ref
    url = uploader.sign_url_for_api(object_key) if object_key else ""
    if not url:
        raise RuntimeError("Seedance 2.5 reference images require public URLs or configured OSS")
    return url


class JiucaiheziImageModel(ImageGenModel):
    def generate(self, prompt: str, output_path: str, **kwargs) -> Tuple[str, float]:
        started = time.time()
        model_name = (kwargs.get("model_name") or "dola-seedance2.5").split("/", 1)[-1].split("#", 1)[0]
        refs = kwargs.get("ref_image_paths") or ([] if not kwargs.get("ref_image_path") else [kwargs["ref_image_path"]])
        model = kwargs.get("model_name") or "gpt-image-2-1k"
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
        images = list(kwargs.get("ref_image_urls") or [])
        if kwargs.get("img_url"):
            images.insert(0, kwargs["img_url"])
        if kwargs.get("img_path"):
            images.insert(0, kwargs["img_path"])
        images = [_public_image_url(ref) for ref in dict.fromkeys(images)]
        payload = {"model": model_name, "prompt": prompt, "ratio": kwargs.get("aspect_ratio") or kwargs.get("ratio") or "16:9"}
        if model_name == "minimax_h3_image_audio_to_video_v2_15s":
            payload["duration"] = int(kwargs.get("duration") or 5)
            payload["resolution"] = kwargs.get("resolution") or "768p横"
            audio_refs = list(kwargs.get("reference_audio_urls") or [])
            if kwargs.get("audio_url"):
                audio_refs.insert(0, kwargs["audio_url"])
            if audio_refs:
                payload["audios"] = [_public_image_url(ref) for ref in dict.fromkeys(audio_refs)][:3]
        if images:
            payload["images"] = images[:9]
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
                if not url:
                    raise RuntimeError(f"Jiucaihezi video completed without video_url: {result}")
                _download(url, output_path)
                return output_path, time.time() - started
            if result.get("status") in ("failed", "error", "cancelled"):
                raise RuntimeError(f"Jiucaihezi video failed: {result}")
        raise TimeoutError("Jiucaihezi video task timed out")
