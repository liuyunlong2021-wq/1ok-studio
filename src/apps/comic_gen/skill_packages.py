import hashlib
import io
import json
import os
import posixpath
import re
import shutil
import uuid
import zipfile
from pathlib import PurePosixPath
from typing import Any, Dict, List, Optional


ALLOWED_TEXT_EXTENSIONS = {".md", ".markdown", ".txt", ".json", ".yaml", ".yml"}
MAX_FILES = 64
MAX_FILE_BYTES = 512 * 1024
MAX_PACKAGE_BYTES = 4 * 1024 * 1024
REFERENCE_RE = re.compile(
    r"(?<![A-Za-z0-9_.-])((?:references|reference)/[A-Za-z0-9_./ @()\-]+\.(?:md|markdown|txt|json|ya?ml))",
    re.IGNORECASE,
)


class SkillPackageError(ValueError):
    pass


class SkillPackageStore:
    def __init__(self, root: str = "output/skill_packages"):
        self.root = root

    @staticmethod
    def _safe_path(path: str) -> str:
        raw = path.replace("\\", "/")
        raw_parts = PurePosixPath(raw).parts
        if raw.startswith("/") or ".." in raw_parts:
            raise SkillPackageError(f"Skill 包含非法路径: {path}")
        normalized = posixpath.normpath(raw).lstrip("./")
        pure = PurePosixPath(normalized)
        if not normalized or pure.is_absolute() or ".." in pure.parts:
            raise SkillPackageError(f"Skill 包含非法路径: {path}")
        return normalized

    def import_upload(self, filename: str, data: bytes) -> Dict[str, Any]:
        if len(data) > MAX_PACKAGE_BYTES:
            raise SkillPackageError("Skill 包超过 4MB 限制")
        if filename.lower().endswith(".zip"):
            files = self._read_zip(data)
        elif os.path.splitext(filename)[1].lower() in ALLOWED_TEXT_EXTENSIONS:
            files = {"SKILL.md": data.decode("utf-8-sig")}
        else:
            raise SkillPackageError("仅支持 .zip、.md、.markdown 或 .txt Skill")
        return self.create(files, filename)

    def _read_zip(self, data: bytes) -> Dict[str, str]:
        try:
            archive = zipfile.ZipFile(io.BytesIO(data))
        except zipfile.BadZipFile as exc:
            raise SkillPackageError("无效的 ZIP Skill 包") from exc
        members = [item for item in archive.infolist() if not item.is_dir() and "__MACOSX" not in item.filename]
        if len(members) > MAX_FILES:
            raise SkillPackageError(f"Skill 包文件数超过 {MAX_FILES}")
        roots = [self._safe_path(item.filename) for item in members]
        skill_candidates = [path for path in roots if path.lower().endswith("skill.md")]
        if not skill_candidates:
            raise SkillPackageError("Skill 包根目录中缺少 SKILL.md")
        entry = min(skill_candidates, key=lambda value: (value.count("/"), len(value)))
        prefix = entry[: -len("SKILL.md")]
        files: Dict[str, str] = {}
        total = 0
        for item, safe in zip(members, roots):
            if prefix and not safe.startswith(prefix):
                continue
            relative = safe[len(prefix):] if prefix else safe
            ext = os.path.splitext(relative)[1].lower()
            if ext not in ALLOWED_TEXT_EXTENSIONS:
                continue
            if item.file_size > MAX_FILE_BYTES:
                raise SkillPackageError(f"Skill 文件超过 512KB: {relative}")
            payload = archive.read(item)
            total += len(payload)
            if total > MAX_PACKAGE_BYTES:
                raise SkillPackageError("Skill 文本总量超过 4MB")
            try:
                files[self._safe_path(relative)] = payload.decode("utf-8-sig")
            except UnicodeDecodeError as exc:
                raise SkillPackageError(f"Skill 文件不是 UTF-8: {relative}") from exc
        return files

    def create(self, files: Dict[str, str], source_name: str) -> Dict[str, Any]:
        normalized = {self._safe_path(path): content for path, content in files.items()}
        entry = next((path for path in normalized if path.lower() == "skill.md"), None)
        if not entry:
            raise SkillPackageError("Skill 包根目录中缺少 SKILL.md")
        validation = self.validate_files(normalized, entry)
        if validation["errors"]:
            raise SkillPackageError("；".join(validation["errors"]))
        digest = hashlib.sha256()
        for path in sorted(normalized):
            digest.update(path.encode())
            digest.update(normalized[path].encode())
        package_id = f"skillpkg_{uuid.uuid4().hex}"
        metadata = {
            "id": package_id,
            "name": self._skill_name(normalized[entry], source_name),
            "source_name": source_name,
            "entry": entry,
            "files": [{"path": path, "size": len(content.encode())} for path, content in sorted(normalized.items())],
            "sha256": digest.hexdigest(),
            "validation": validation,
            "version": 1,
        }
        package_dir = os.path.join(self.root, package_id)
        os.makedirs(package_dir, exist_ok=False)
        with open(os.path.join(package_dir, "package.json"), "w", encoding="utf-8") as handle:
            json.dump({"metadata": metadata, "contents": normalized}, handle, ensure_ascii=False, indent=2)
        return metadata

    @staticmethod
    def _skill_name(content: str, fallback: str) -> str:
        match = re.search(r"^name:\s*[\"']?([^\n\"']+)", content, re.MULTILINE | re.IGNORECASE)
        return match.group(1).strip() if match else os.path.splitext(os.path.basename(fallback))[0]

    def get(self, package_id: str) -> Dict[str, Any]:
        if not re.fullmatch(r"skillpkg_[a-f0-9]{32}", package_id or ""):
            raise SkillPackageError("无效的 Skill Package ID")
        path = os.path.join(self.root, package_id, "package.json")
        if not os.path.exists(path):
            raise SkillPackageError("Skill Package 不存在")
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)

    def describe(self, package_id: str) -> Dict[str, Any]:
        return self.get(package_id)["metadata"]

    def delete(self, package_id: str) -> None:
        self.get(package_id)
        shutil.rmtree(os.path.join(self.root, package_id))

    def compile(self, package_id: str) -> str:
        package = self.get(package_id)
        files = package["contents"]
        entry = package["metadata"]["entry"]
        selected = self._resolve_references(files, entry)
        sections = [f"# Skill Package: {package['metadata']['name']}\n\n{files[entry]}"]
        for path in selected:
            sections.append(f"# Referenced file: {path}\n\n{files[path]}")
        return "\n\n---\n\n".join(sections)

    def validate_files(self, files: Dict[str, str], entry: str) -> Dict[str, List[str]]:
        refs = self._find_refs(files[entry])
        missing = [path for path in refs if path not in files]
        return {
            "errors": [f"缺少引用文件: {path}" for path in missing],
            "warnings": [],
            "references": refs,
        }

    def _resolve_references(self, files: Dict[str, str], entry: str) -> List[str]:
        resolved: List[str] = []
        pending = self._find_refs(files[entry])
        while pending:
            path = pending.pop(0)
            if path in resolved or path == entry:
                continue
            if path not in files:
                raise SkillPackageError(f"缺少引用文件: {path}")
            resolved.append(path)
            if len(resolved) > MAX_FILES:
                raise SkillPackageError("Skill 引用文件数量超限")
            pending.extend(self._find_refs(files[path]))
        return resolved

    @staticmethod
    def _find_refs(content: str) -> List[str]:
        refs: List[str] = []
        for match in REFERENCE_RE.findall(content):
            path = posixpath.normpath(match.strip().rstrip(".,;:)]}"))
            if path not in refs:
                refs.append(path)
        return refs
