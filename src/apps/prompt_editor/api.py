"""Independent text documents and generation, using the existing text gateway."""
import asyncio
import json
import os
import tempfile
import threading
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..comic_gen.llm_adapter import LLMAdapter

router = APIRouter(prefix="/prompt-documents", tags=["prompt-editor"])
_PATH = "output/prompt_documents.json"
_LOCK = threading.RLock()


def _now():
    return datetime.now(timezone.utc).isoformat()


def _read():
    if not os.path.exists(_PATH):
        return []
    try:
        with open(_PATH, encoding="utf-8") as file:
            data = json.load(file)
        if not isinstance(data, list):
            raise ValueError("Invalid document store")
        return data
    except (OSError, ValueError) as exc:
        raise HTTPException(500, "提示词文档读取失败，未覆盖已有数据") from exc


def _write(items):
    temporary = None
    try:
        directory = os.path.dirname(_PATH)
        os.makedirs(directory, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=directory, delete=False) as file:
            temporary = file.name
            json.dump(items, file, ensure_ascii=False, indent=2)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, _PATH)
    except OSError as exc:
        raise HTTPException(500, "提示词文档保存失败，请重试") from exc
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


def _find(items, document_id):
    document = next((item for item in items if item["id"] == document_id), None)
    if document is None:
        raise HTTPException(404, "提示词文档不存在")
    return document


def _public(document):
    return {key: value for key, value in document.items() if key != "versions"}


def _snapshot(document):
    if not document["versions"] or document["versions"][-1]["text"] != document["text"] or document["versions"][-1]["name"] != document["name"]:
        document["versions"].append({
            "id": uuid.uuid4().hex, "name": document["name"], "text": document["text"], "created_at": _now(),
        })


class DocumentCreate(BaseModel):
    name: str = Field("未命名提示词", min_length=1, max_length=200)


class DocumentSave(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    text: str = Field(..., max_length=200000)
    revision: int = Field(..., ge=0)
    snapshot: bool = False


class DocumentRestore(BaseModel):
    revision: int = Field(..., ge=0)


class TextGenerate(BaseModel):
    text: str = Field("", max_length=200000)
    instruction: str = Field("", max_length=20000)
    skill: str = Field("", max_length=200000)
    skill_id: str = ""


@router.get("")
def list_documents():
    with _LOCK:
        return sorted([_public(item) for item in _read()], key=lambda item: item["updated_at"], reverse=True)


@router.post("")
def create_document(request: DocumentCreate):
    with _LOCK:
        items = _read()
        now = _now()
        document = {"id": uuid.uuid4().hex, "name": request.name.strip() or "未命名提示词", "text": "", "revision": 0, "created_at": now, "updated_at": now, "versions": []}
        items.append(document)
        _write(items)
        return _public(document)


@router.get("/{document_id}")
def get_document(document_id: str):
    with _LOCK:
        return _public(_find(_read(), document_id))


@router.put("/{document_id}")
def save_document(document_id: str, request: DocumentSave):
    with _LOCK:
        items = _read()
        document = _find(items, document_id)
        if document["revision"] != request.revision:
            raise HTTPException(409, "文档已在其他窗口更新，请先复制当前内容，再重新加载")
        # Preserve the saved source before an accepted AI change or manual save.
        if request.snapshot:
            _snapshot(document)
        document.update(name=request.name.strip() or "未命名提示词", text=request.text, revision=document["revision"] + 1, updated_at=_now())
        if request.snapshot:
            _snapshot(document)
        _write(items)
        return _public(document)


@router.get("/{document_id}/versions")
def list_versions(document_id: str):
    with _LOCK:
        return list(reversed(_find(_read(), document_id)["versions"]))


@router.post("/{document_id}/versions/{version_id}/restore")
def restore_document(document_id: str, version_id: str, request: DocumentRestore):
    with _LOCK:
        items = _read()
        document = _find(items, document_id)
        if document["revision"] != request.revision:
            raise HTTPException(409, "文档已更新，请重新加载后恢复历史版本")
        version = next((item for item in document["versions"] if item["id"] == version_id), None)
        if version is None:
            raise HTTPException(404, "历史版本不存在")
        _snapshot(document)
        document.update(name=version["name"], text=version["text"], revision=document["revision"] + 1, updated_at=_now())
        _snapshot(document)
        _write(items)
        return _public(document)


@router.post("/{document_id}/generate")
async def generate_text(document_id: str, request: TextGenerate):
    with _LOCK:
        _find(_read(), document_id)
    if not request.text.strip() and not request.instruction.strip():
        raise HTTPException(400, "请填写本次要求或输入正文")
    if not request.skill.strip() and not request.instruction.strip():
        raise HTTPException(400, "不使用 Skill 时，请填写本次要求")
    if len(request.text) + len(request.skill) + len(request.instruction) > 250000:
        raise HTTPException(400, "本次输入过长，请缩小作用范围或精简 Skill；未截断内容")
    policy = """你是通用文字创作与编辑助手。按用户本次要求和 Skill 处理输入；本次明确要求优先。
有原文时，保留要求未涉及的内容；没有原文时从零创作。
输出格式遵循 Skill 和本次要求，可为文本、Markdown、JSON 或提示词，不强制剧本格式或双语。
没有指定输出格式时，仅返回所需正文。保留必要换行，不输出无关解释。
Skill 只提供文字规则，不会自动执行脚本、搜索、下载或读取外部文件。需要缺失材料时指出缺失，不得声称已执行工具。
"""
    messages = [{"role": "system", "content": policy + "\n以下为本次 Skill 内容快照：\n" + request.skill},
                {"role": "user", "content": "本次要求：\n" + request.instruction + "\n\n输入正文：\n" + request.text}]
    try:
        adapter = LLMAdapter()
        result = await asyncio.get_running_loop().run_in_executor(None, lambda: adapter.chat(messages))
        if not result or not result.strip():
            raise RuntimeError("模型返回空内容，请重试")
        return {"text": result, "document_id": document_id, "skill_id": request.skill_id}
    except Exception as exc:
        raise HTTPException(502, f"生成失败：{exc}") from exc
