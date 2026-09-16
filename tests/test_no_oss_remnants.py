"""对象存储（OSS / 阿里云）不得再回到代码库里。

产品把媒体存在本地 ``output/`` 下、经 ``/files`` 挂载点送出，不需要对象存储。

在这道闸门之前，那套代码只是被**关闭**而不是被**删除**：``is_oss_enabled()``
在未设 ``OSS_ENABLE`` 时返回 False，所有调用点都有本地回落，所以功能一切正常、
没人会发现。代价是留下了约 60 处代码引用、4 个依赖，以及设计稿里一个长得像
真 AccessKey 的占位值（``LTAI5t...``，正是阿里云 AccessKey ID 的前缀格式）——
任何扫描仓库的人都会一直被它绊住。

这个测试就是那道闸门。一旦这些标识符重新出现，它会失败，让「重新引入对象存储」
变成一个必须刻意做的决定，而不是复制粘贴的副产品。

刻意保留的例外：``api.py`` 的 ``LEGACY_USER_CONFIG_KEYS`` 里仍列着退役的
环境变量名（``OSS_BUCKET_NAME`` 等）。那是**清理**代码——保存配置时会把这些
陈旧键从既有用户的配置里删掉。它们只是字符串，不含下面的标识符。
"""

from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]

# 只匹配「存在的意义就是跟对象存储对话」的标识符。
# 不匹配裸的 "oss"，否则 cross / across / crossOrigin 会满屏误报。
FORBIDDEN = (
    "oss_utils",
    "OSSImageUploader",
    "is_oss_enabled",
    "sign_oss_urls_in_data",
    "is_object_key",
    "MEDIA_REF_OBJECT_KEY",
    "import oss2",
    "alibabacloud",
)

SCAN_DIRS = ("src", "tests", "frontend/src")
SCAN_SUFFIXES = (".py", ".ts", ".tsx")

# 本文件自己当然包含上面那些字符串
SELF = Path(__file__).name


def _scanned_files():
    for rel_dir in SCAN_DIRS:
        base = REPO_ROOT / rel_dir
        if not base.is_dir():
            continue
        for path in base.rglob("*"):
            if not path.is_file() or path.suffix not in SCAN_SUFFIXES:
                continue
            if path.name == SELF:
                continue
            if "node_modules" in path.parts:
                continue
            yield path


def test_no_object_storage_identifiers_remain():
    offenders = []
    for path in _scanned_files():
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for needle in FORBIDDEN:
            if needle in text:
                rel = path.relative_to(REPO_ROOT).as_posix()
                offenders.append(f"{rel}: {needle}")

    assert not offenders, (
        "对象存储的残留又出现了。产品用本地 output/ 存媒体，不需要对象存储；"
        "如果确实要重新引入，请连同这条闸门一起改，并说明理由：\n  "
        + "\n  ".join(offenders)
    )


def test_oss_dependencies_are_undeclared():
    """requirements 里不该再声明对象存储相关的包。"""
    packages = ("oss2", "alibabacloud")
    for name in ("requirements.txt", "requirements-docker.txt"):
        path = REPO_ROOT / name
        if not path.is_file():
            continue
        for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            stripped = line.strip()
            if stripped.startswith("#") or not stripped:
                continue
            assert not stripped.startswith(packages), f"{name}:{lineno} 仍声明 {stripped}"


def test_media_ref_module_has_no_object_key_concept():
    """``media_refs`` 只区分本地路径、远端 URL、blob、data URI。"""
    module = REPO_ROOT / "src" / "utils" / "media_refs.py"
    text = module.read_text(encoding="utf-8")

    assert "object_key" not in text
    assert "oss_base_path" not in text
