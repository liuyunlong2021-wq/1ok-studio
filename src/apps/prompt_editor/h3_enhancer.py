"""Native H3 Skill: durable Responses tasks shared by prompt editor and Motion.

Billed POSTs are submitted exactly once per local request ID. GETs may be retried;
a lost creation response stays uncertain instead of creating another billed task.
"""

import base64
import io
import hashlib
import json
import os
import tempfile
import threading
import time
from pathlib import Path
from typing import Literal
from uuid import UUID

import requests
from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel, Field, StrictInt, model_validator
from PIL import Image

from ...models.jiucaihezi import _base_url, _headers, upload_to_jiucaihezi
from .images import image_data, MAX_TOTAL_BYTES

SKILL_ID = "builtin-h3-context-ir"
SKILL = {
    "id": SKILL_ID,
    "name": "MiniMax H3 提示词增强",
    "content": "使用 H3 Context IR 增强当前视频提示词，也可根据本次要求从零创作。目标时长为 4–15 秒，需选择画幅。支持参考图、首帧、尾帧与首尾帧；素材通过韭菜盒子临时上传后提交。结果预览后采用，可恢复原文。",
    "scope": "system",
    "is_builtin": True,
    "kind": "motion",
    "executor": "h3_context_ir",
    "readonly": True,
}
router = APIRouter(prefix="/prompt-enhancements", tags=["prompt-enhancement"])
_DIRECTORY = Path("output/prompt_enhancements")
_LOCK = threading.RLock()
_ACTIVE: set[str] = set()
_POLLING: set[str] = set()
_TERMINAL = {"completed", "failed", "unknown"}


class EnhanceImage(BaseModel):
    ref: str = Field(..., min_length=1, max_length=4000)
    name: str = Field("参考图", max_length=200)
    role: Literal["reference_image", "first_frame", "last_frame"] = "reference_image"


class EnhanceRequest(BaseModel):
    request_id: UUID
    text: str = Field("", max_length=200000)
    instruction: str = Field("", max_length=20000)
    duration: StrictInt = Field(..., ge=4, le=15)
    ratio: Literal["21:9", "16:9", "4:3", "1:1", "3:4", "9:16", "adaptive"]
    images: list[EnhanceImage] = Field(default_factory=list, max_length=9)
    # Opaque source snapshot, used only by the caller when adopting the result.
    source_context: str = Field("", max_length=500000)

    @model_validator(mode="after")
    def validate_mode(self):
        roles = [image.role for image in self.images]
        if not roles and self.ratio == "adaptive":
            raise ValueError("纯文本增强需要明确画幅，不能使用 adaptive")
        if "reference_image" in roles and any(role != "reference_image" for role in roles):
            raise ValueError("首尾帧不能和参考图混用")
        if roles.count("first_frame") > 1 or roles.count("last_frame") > 1:
            raise ValueError("首帧和尾帧最多各一张")
        if any(role != "reference_image" for role in roles):
            self.ratio = "adaptive"
        return self


def _read(job_id: str):
    path = _DIRECTORY / f"{job_id}.json"
    if not path.exists():
        raise HTTPException(404, "增强任务不存在；请确认提交结果后再重新创建")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise HTTPException(500, "增强任务读取失败，已有记录未覆盖") from exc


def _write(job):
    _DIRECTORY.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=_DIRECTORY, delete=False
        ) as file:
            temporary = file.name
            json.dump(job, file, ensure_ascii=False)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, _DIRECTORY / f"{job['job_id']}.json")
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


def _public(job):
    return {key: value for key, value in job.items() if key != "fingerprint"}


def _update(job_id, **values):
    with _LOCK:
        job = _read(job_id)
        job.update(values, updated_at=time.time())
        _write(job)
        return job


def _safe_message(value):
    text = str(value)[:1000]
    key = os.getenv("JIUCAIHEZI_API_KEY", "")
    return text.replace(key, "[REDACTED]") if key else text


def _message(response):
    try:
        body = response.json()
        error = body.get("error") or {}
        message = error.get("message") if isinstance(error, dict) else str(error)
        message = message or body.get("message") or body.get("detail")
    except (ValueError, AttributeError):
        message = None
    return _safe_message(message or f"网关返回 HTTP {response.status_code}")


def _request(method, url, **kwargs):
    # Match the gateway media adapter: direct TLS, no automatic POST retries.
    with requests.Session() as session:
        session.trust_env = False
        return session.request(method, url, headers=_headers(), timeout=(10, 30), **kwargs)


def _result(payload):
    status = payload.get("status")
    if status == "completed":
        text = "\n".join(
            content["text"].strip()
            for item in (payload.get("output") or [])
            if isinstance(item, dict)
            for content in (item.get("content") or [])
            if isinstance(content, dict)
            if content.get("type") == "output_text"
            and isinstance(content.get("text"), str)
            and content["text"].strip()
        )
        return (
            {"status": "completed", "text": text, "error": "", "retry_after": 3}
            if text
            else {
                "status": "failed",
                "text": "",
                "error": "任务已完成但增强文本为空，请保留响应 ID 联系支持；未采用结果",
            }
        )
    if status in {"failed", "cancelled", "incomplete"}:
        error = payload.get("error") or {}
        message = error.get("message") if isinstance(error, dict) else str(error)
        return {
            "status": "failed",
            "text": "",
            "error": _safe_message(message or f"增强任务结束：{status}"),
        }
    return {"status": "in_progress", "text": "", "error": "", "retry_after": 3}


def _prepare_images(images):
    """Read managed assets, validate H3 dimensions, then upload public references."""
    content = []
    total = 0
    for index, image in enumerate(images, 1):
        try:
            uri, size = image_data(image["ref"])
            total += size
            if total > MAX_TOTAL_BYTES:
                raise ValueError("参考图片总量不能超过 30MB")
            data = base64.b64decode(uri.split(",", 1)[1])
            with Image.open(io.BytesIO(data)) as picture:
                width, height = picture.size
                if not (
                    256 <= width <= 5760 and 256 <= height <= 5760 and 0.4 <= width / height <= 2.5
                ):
                    raise ValueError("H3 图片宽高需为 256–5760 像素，宽高比需为 0.4–2.5")
                suffix = {"PNG": ".png", "JPEG": ".jpg", "WEBP": ".webp"}[picture.format]
            temporary = None
            try:
                with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as file:
                    temporary = file.name
                    file.write(data)
                url = upload_to_jiucaihezi(temporary, "image")
            finally:
                if temporary and os.path.exists(temporary):
                    os.unlink(temporary)
            content.append({"type": "image_url", "role": image["role"], "image_url": {"url": url}})
        except Exception as exc:
            raise ValueError(f"图片 {index} 准备失败：{_safe_message(exc)}") from exc
    return content


def _submit(job_id: str):
    try:
        job = _update(job_id, status="preparing")
        prompt = job["source_text"].strip()
        instruction = job["instruction"].strip()
        if prompt and instruction:
            prompt += "\n\n本次要求：\n" + instruction
        elif instruction:
            prompt = instruction
        image_content = _prepare_images(job.get("images", []))
        if job.get("images"):
            mapping = "\n".join(
                f"Image {index} / 参考图{index}：{image['name']}（{image['role']}）"
                for index, image in enumerate(job["images"], 1)
            )
            prompt += "\n\n素材按如下顺序绑定，保留对应编号与身份：\n" + mapping
        _update(job_id, status="submitting", submission_started=True)
        response = _request(
            "POST",
            f"{_base_url()}/v1/responses",
            json={
                "model": "MiniMax-H3-Context-IR",
                "background": True,
                "content": [{"type": "text", "text": prompt}, *image_content],
                "duration": job["duration"],
                "ratio": job["ratio"],
            },
        )
        if not response.ok:
            uncertain = response.status_code >= 500 or response.status_code == 408
            _update(job_id, status="unknown" if uncertain else "failed", error=_message(response))
            return
        payload = response.json()
        response_id = payload.get("id")
        if (
            not isinstance(response_id, str)
            or not response_id.startswith("resp_")
            or not all(c.isalnum() or c in "_-" for c in response_id)
        ):
            raise ValueError("未收到有效的 resp_ 响应 ID")
        # Persist the query handle before inspecting the result.
        _update(job_id, response_id=response_id, status="in_progress")
        _update(job_id, **_result(payload))
    except Exception as exc:
        # No retry: the upstream may already have accepted the billed POST.
        with _LOCK:
            current = _read(job_id)
        if not current.get("submission_started"):
            _update(job_id, status="failed", error=_safe_message(exc))
        elif current["response_id"]:
            _update(job_id, status="in_progress", error="已取得响应 ID，可继续查询原任务")
        else:
            _update(
                job_id,
                status="unknown",
                error=f"提交状态待确认：{type(exc).__name__}；未自动重提，请核对网关任务或账户记录",
            )
    finally:
        with _LOCK:
            _ACTIVE.discard(job_id)


@router.post("")
def create_enhancement(request: EnhanceRequest, background_tasks: BackgroundTasks):
    if not request.text.strip() and not request.instruction.strip():
        raise HTTPException(400, "请输入提示词或本次要求")
    job_id = request.request_id.hex
    fingerprint = hashlib.sha256(request.model_dump_json().encode()).hexdigest()
    with _LOCK:
        if (_DIRECTORY / f"{job_id}.json").exists():
            job = _read(job_id)
            if job["fingerprint"] != fingerprint:
                raise HTTPException(409, "请求标识已用于另一份提示词，未创建新任务")
            return _public(job)
        try:
            _headers()
        except RuntimeError as exc:
            raise HTTPException(400, "请先在设置中配置韭菜盒子 API Key") from exc
        job = {
            "job_id": job_id,
            "fingerprint": fingerprint,
            "status": "queued",
            "response_id": "",
            "text": "",
            "error": "",
            "submission_started": False,
            "images": [image.model_dump() for image in request.images],
            "source_text": request.text,
            "instruction": request.instruction,
            "source_context": request.source_context,
            "duration": request.duration,
            "ratio": request.ratio,
            "created_at": time.time(),
            "updated_at": time.time(),
        }
        _write(job)
        _ACTIVE.add(job_id)
        background_tasks.add_task(_submit, job_id)
        return _public(job)


@router.get("/{request_id}")
def query_enhancement(request_id: UUID):
    job_id = request_id.hex
    with _LOCK:
        job = _read(job_id)
        if job["status"] in {"queued", "preparing", "submitting"} and job_id not in _ACTIVE:
            if job.get("submission_started", job["status"] == "submitting"):
                job = _update(
                    job_id,
                    status="unknown",
                    error="应用在提交期间重启，提交状态待确认；未自动创建新任务",
                )
            else:
                job = _update(
                    job_id,
                    status="failed",
                    error="素材准备或任务排队期间应用重启，尚未提交增强任务",
                )
        if job["status"] in _TERMINAL or not job["response_id"] or job_id in _POLLING:
            return _public(job)
        _POLLING.add(job_id)
    try:
        response = _request("GET", f"{_base_url()}/v1/responses/{job['response_id']}")
        if not response.ok:
            retry_after = 10 if response.status_code == 429 else 5
            try:
                retry_after = max(3, min(60, int(response.headers.get("Retry-After", retry_after))))
            except ValueError:
                pass
            job = _update(job_id, error=_message(response), retry_after=retry_after)
        else:
            job = _update(job_id, **_result(response.json()))
    except (requests.RequestException, ValueError, RuntimeError):
        job = _update(job_id, error="暂时无法查询增强任务；可继续查询原任务，不会重复提交")
    finally:
        with _LOCK:
            _POLLING.discard(job_id)
    return _public(job)
