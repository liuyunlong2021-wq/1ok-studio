import hashlib
import io
import json
import os
import posixpath
import re
import shutil
import uuid
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any, Dict, List, Optional

from ...utils import get_logger

logger = get_logger(__name__)


ALLOWED_TEXT_EXTENSIONS = {".md", ".markdown", ".txt", ".json", ".yaml", ".yml"}
MAX_FILES = 64
MAX_FILE_BYTES = 512 * 1024
MAX_PACKAGE_BYTES = 4 * 1024 * 1024
REFERENCE_RE = re.compile(
    r"(?<![A-Za-z0-9_.-])((?:references|reference)/[A-Za-z0-9_./ @()\-]+\.(?:md|markdown|txt|json|ya?ml))",
    re.IGNORECASE,
)

# Skills shipped with the app live in `skills/<name>/SKILL.md`. `parents[3]`
# resolves to the repo root in a checkout and to `_MEIPASS` in the PyInstaller
# sidecar (see `--add-data "skills:skills"` in build_sidecar.sh), so the same
# lookup works in both. They are read-only: the repo is the single source of
# truth, so an app upgrade refreshes them instead of leaving stale copies in
# the user data dir.
BUILTIN_PREFIX = "builtin:"
BUILTIN_ID_RE = re.compile(r"^builtin:[a-z0-9][a-z0-9-]*$")
BUILTIN_ROOT = Path(__file__).resolve().parents[3] / "skills"


class SkillPackageError(ValueError):
    pass


class SkillPackageStore:
    def __init__(self, root: str = "output/skill_packages", builtin_root: Optional[Path] = None):
        self.root = root
        self.builtin_root = Path(builtin_root) if builtin_root else BUILTIN_ROOT

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
        package_id = f"skillpkg_{uuid.uuid4().hex}"
        metadata = {
            "id": package_id,
            "name": self._skill_name(normalized[entry], source_name),
            "source_name": source_name,
            "entry": entry,
            "files": [{"path": path, "size": len(content.encode())} for path, content in sorted(normalized.items())],
            "sha256": self._digest(normalized),
            "validation": validation,
            "version": 1,
            "builtin": False,
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

    @staticmethod
    def _digest(files: Dict[str, str]) -> str:
        digest = hashlib.sha256()
        for path in sorted(files):
            digest.update(path.encode())
            digest.update(files[path].encode())
        return digest.hexdigest()

    @staticmethod
    def is_builtin(package_id: str) -> bool:
        return bool(package_id) and package_id.startswith(BUILTIN_PREFIX)

    def _builtin_names(self) -> List[str]:
        if not self.builtin_root.is_dir():
            return []
        return sorted(
            entry.name
            for entry in self.builtin_root.iterdir()
            if entry.is_dir()
            and (entry / "SKILL.md").is_file()
            and re.fullmatch(r"[a-z0-9][a-z0-9-]*", entry.name)
        )

    def _builtin_package(self, name: str) -> Dict[str, Any]:
        """Build the package dict for a bundled skill, reading it from disk.

        Read on demand rather than copied into the user data dir on first run:
        copying would pin an old version on every machine that already started
        the app once, and the repo is the source of truth.
        """
        directory = self.builtin_root / name
        files: Dict[str, str] = {}
        for path in sorted(directory.rglob("*")):
            if not path.is_file():
                continue
            relative = self._safe_path(path.relative_to(directory).as_posix())
            if os.path.splitext(relative)[1].lower() not in ALLOWED_TEXT_EXTENSIONS:
                continue
            if path.stat().st_size > MAX_FILE_BYTES:
                raise SkillPackageError(f"内置 Skill 文件超过 512KB: {relative}")
            if len(files) >= MAX_FILES:
                raise SkillPackageError(f"内置 Skill 文件数超过 {MAX_FILES}")
            files[relative] = path.read_text(encoding="utf-8-sig")
        entry = next((path for path in files if path.lower() == "skill.md"), None)
        if not entry:
            raise SkillPackageError(f"内置 Skill 缺少 SKILL.md: {name}")
        return {
            "metadata": {
                "id": f"{BUILTIN_PREFIX}{name}",
                "name": self._skill_name(files[entry], name),
                "source_name": name,
                "entry": entry,
                "files": [{"path": path, "size": len(content.encode())} for path, content in sorted(files.items())],
                "sha256": self._digest(files),
                "validation": self.validate_files(files, entry),
                "version": 1,
                "builtin": True,
            },
            "contents": files,
        }

    def list(self) -> List[Dict[str, Any]]:
        """Every selectable package: bundled built-ins first, then uploads."""
        packages: List[Dict[str, Any]] = []
        for name in self._builtin_names():
            try:
                packages.append(self._builtin_package(name)["metadata"])
            except (SkillPackageError, OSError) as exc:
                # One bad bundled skill must not blank the whole picker.
                logger.warning("Skipping unreadable built-in skill %s: %s", name, exc)
        if os.path.isdir(self.root):
            for entry in sorted(os.listdir(self.root)):
                path = os.path.join(self.root, entry, "package.json")
                if not os.path.exists(path):
                    continue
                try:
                    with open(path, encoding="utf-8") as handle:
                        metadata = json.load(handle)["metadata"]
                except (OSError, ValueError, KeyError) as exc:
                    logger.warning("Skipping malformed skill package %s: %s", entry, exc)
                    continue
                metadata["builtin"] = False
                packages.append(metadata)
        return packages

    def get(self, package_id: str) -> Dict[str, Any]:
        if self.is_builtin(package_id):
            if not BUILTIN_ID_RE.fullmatch(package_id):
                raise SkillPackageError("无效的 Skill Package ID")
            name = package_id[len(BUILTIN_PREFIX):]
            if name not in self._builtin_names():
                raise SkillPackageError("内置 Skill 不存在")
            return self._builtin_package(name)
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
        if self.is_builtin(package_id):
            raise SkillPackageError("内置 Skill 随应用分发，请直接删除 skills/ 下的目录")
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
