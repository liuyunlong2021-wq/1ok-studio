"""Fk's public NewAPI video contract; no supplier credentials or endpoints."""

from pathlib import PurePosixPath
from urllib.parse import urlparse

from ..utils.model_catalog import load_generated_model_catalog


def fk_video_spec(model_id: str):
    model_id = (model_id or "").split("/", 1)[-1].split("#", 1)[0]
    spec = load_generated_model_catalog()["models"].get(model_id, {})
    return (
        spec
        if spec.get("runtime", {}).get("jiucaihezi", {}).get("video_contract") == "fk_video"
        else None
    )


def split_fk_media(refs):
    images, videos, audios = [], [], []
    for ref in dict.fromkeys(refs or []):
        suffix = PurePosixPath(urlparse(ref).path).suffix.lower()
        target = (
            videos
            if suffix in {".mp4", ".mov", ".webm", ".avi", ".mkv"}
            else (
                audios
                if suffix in {".mp3", ".wav", ".ogg", ".opus", ".pcm", ".m4a", ".flac", ".aac"}
                else images
            )
        )
        target.append(ref)
    return images, videos, audios


def fk_video_payload(model_id, prompt, images, kwargs):
    spec = fk_video_spec(model_id)
    if not spec:
        return None
    params, timing = spec["params"], spec["duration"]
    if not prompt.strip() or len(prompt) > params.get("maxPromptLength", 12000):
        raise ValueError(f"此 Fk 模型提示词需为 1–{params.get('maxPromptLength', 12000)} 字符")
    duration = kwargs.get("duration")
    if duration is None:
        duration = timing.get("default", timing.get("value"))
    if (
        isinstance(duration, bool)
        or not isinstance(duration, (int, float))
        or int(duration) != duration
    ):
        raise ValueError("Fk 视频时长必须为整数秒")
    duration = int(duration)
    valid = (
        duration == timing["value"]
        if timing["type"] == "fixed"
        else (
            duration in timing["options"]
            if timing["type"] == "buttons"
            else timing["min"] <= duration <= timing["max"]
        )
    )
    if not valid:
        raise ValueError(f"此 Fk 模型不支持 {duration} 秒，请按模型时长调整镜头选择")
    ratio = kwargs.get("aspect_ratio") or kwargs.get("ratio") or params["ratio"]["default"]
    if ratio not in params["ratio"]["options"]:
        raise ValueError(f"此 Fk 模型不支持画幅 {ratio}")
    resolutions = params["resolution"]["options"]
    resolution = (
        resolutions[0]
        if len(resolutions) == 1
        else kwargs.get("resolution") or params["resolution"]["default"]
    )
    if resolution not in resolutions:
        raise ValueError(f"此 Fk 模型不支持分辨率 {resolution}")
    videos = list(dict.fromkeys(kwargs.get("reference_video_urls") or []))
    audios = list(
        dict.fromkeys(
            (kwargs.get("reference_audio_urls") or [])
            + ([kwargs["audio_url"]] if kwargs.get("audio_url") else [])
        )
    )
    images = list(dict.fromkeys(images))
    for key, refs, label in [
        ("reference_images", images, "图片"),
        ("reference_videos", videos, "视频"),
        ("reference_audios", audios, "音频"),
    ]:
        limit = spec["inputs"][key]["max"]
        if len(refs) > limit:
            raise ValueError(f"此 Fk 模型最多支持 {limit} 个参考{label}")
        if any(
            not isinstance(ref, str) or ref.startswith(("data:", "file:", "blob:")) for ref in refs
        ):
            raise ValueError("参考素材需使用已上传的应用素材或公网 URL")
    return {
        "model": spec["id"],
        "prompt": prompt,
        "duration": duration,
        "ratio": ratio,
        "resolution": resolution,
        "imageUrls": images,
        "videoUrls": videos,
        "audioUrls": audios,
    }
