import os
from pathlib import Path

from src.utils.media_refs import (
    classify_media_ref,
    is_remote_media_ref,
    is_stable_project_media_ref,
    media_ref,
    resolve_local_media_path,
    to_media_ref,
)


def _project_root() -> Path:
    return Path(__file__).resolve().parents[1]


def test_classify_local_relative_path():
    assert classify_media_ref("uploads/foo.png") == "local_path"


def test_classify_local_absolute_path_under_output():
    abs_path = str(_project_root() / "output" / "uploads" / "foo.png")
    assert classify_media_ref(abs_path) == "local_path"


def test_classify_remote_url():
    assert classify_media_ref("https://example.com/a.png") == "remote_url"
    assert is_remote_media_ref("http://example.com/a.png")
    assert is_remote_media_ref("blob:https://example.com/abc")
    assert not is_stable_project_media_ref("blob:https://example.com/abc")


def test_classify_data_uri_is_not_stable_storage():
    value = "data:image/png;base64,AAAA"
    assert classify_media_ref(value) == "data_uri"
    assert not is_stable_project_media_ref(value)


def test_resolve_local_relative_path_to_absolute():
    resolved = resolve_local_media_path("uploads/foo.png")
    expected = str((_project_root() / "output" / "uploads" / "foo.png").resolve())
    assert resolved == expected


def test_resolve_local_absolute_path_under_output():
    input_path = str(_project_root() / "output" / "video" / "clip.mp4")
    expected = str((_project_root() / "output" / "video" / "clip.mp4").resolve())
    assert resolve_local_media_path(input_path) == expected


# ---------------------------------------------------------------------------
# 写入侧：引用必须是 POSIX 分隔符
#
# 引用会写进 projects.json、当 URL 交给前端，并被上面的 classify_media_ref
# 按 `video/`、`assets/` 这类前缀匹配。Windows 上 os.path.join/os.path.relpath
# 产出的是 `video\x.mp4`，前缀匹配不上、被判成 unknown，搬到 macOS 也解析不了
# —— 同一份数据在两端水土不服。所以构造引用一律走 media_ref()/to_media_ref()，
# 不要直接拼。
# ---------------------------------------------------------------------------

def test_media_ref_joins_path_parts_with_forward_slashes():
    assert media_ref("output", "audio", "take.mp3") == "output/audio/take.mp3"


def test_media_ref_never_emits_a_backslash():
    assert "\\" not in media_ref("video", "clip.mp4")


def test_to_media_ref_normalizes_filesystem_built_paths():
    assert to_media_ref(os.path.join("video", "clip.mp4")) == "video/clip.mp4"
    assert to_media_ref("video\\clip.mp4") == "video/clip.mp4"


def test_to_media_ref_is_a_no_op_for_already_normalized_refs():
    assert to_media_ref("assets/scenes/scene_1.png") == "assets/scenes/scene_1.png"


def test_filesystem_built_refs_are_not_valid_stored_refs_on_windows():
    """记录被修掉的真问题：os.path.join 的产物只在 POSIX 上侥幸能用。"""
    raw = os.path.join("video", "clip.mp4")
    if os.sep == "\\":
        assert classify_media_ref(raw) == "unknown"
    assert classify_media_ref(to_media_ref(raw)) == "local_path"
