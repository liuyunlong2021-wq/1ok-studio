"""ffmpeg 查找逻辑的自检。

守的是一个只会在**打包后**才暴露的 bug：从 Finder 启动的 GUI 进程 PATH 是
launchd 默认值（``/usr/bin:/bin:/usr/sbin:/sbin``），macOS 又不自带
``/usr/bin/ffmpeg``，所以 ``shutil.which("ffmpeg")`` 对 ``brew install ffmpeg``
的用户也返回 None —— 用户装了却用不了。这里保证 POSIX 回退路径确实被查。
"""

import pytest

from src.utils import system_check


@pytest.fixture(autouse=True)
def _not_frozen(monkeypatch):
    """默认按「已打包」跑，并让 PATH 查找必定失败。"""
    monkeypatch.setattr(system_check.sys, "frozen", True, raising=False)
    monkeypatch.setattr(system_check.shutil, "which", lambda _name: None)


def test_falls_back_to_common_macos_path_when_not_on_path(monkeypatch, tmp_path):
    fake = tmp_path / "ffmpeg"
    fake.write_text("#!/bin/sh\necho ffmpeg\n")
    fake.chmod(0o755)
    monkeypatch.setattr(system_check, "POSIX_FFMPEG_FALLBACKS", (str(fake),))
    monkeypatch.setattr(system_check.platform, "system", lambda: "Darwin")

    assert system_check.get_ffmpeg_path() == str(fake)


def test_skips_fallback_paths_that_are_not_executable(monkeypatch, tmp_path):
    not_executable = tmp_path / "ffmpeg"
    not_executable.write_text("not a binary")
    not_executable.chmod(0o644)
    monkeypatch.setattr(system_check, "POSIX_FFMPEG_FALLBACKS", (str(not_executable),))
    monkeypatch.setattr(system_check.platform, "system", lambda: "Darwin")

    assert system_check.get_ffmpeg_path() is None


def test_returns_none_when_nothing_is_available(monkeypatch):
    monkeypatch.setattr(system_check, "POSIX_FFMPEG_FALLBACKS", ())
    monkeypatch.setattr(system_check.platform, "system", lambda: "Darwin")

    assert system_check.get_ffmpeg_path() is None
    assert system_check.check_ffmpeg() == (False, "FFmpeg not found in bundle or system PATH")


def test_bundle_path_wins_over_fallback(monkeypatch, tmp_path):
    """被打进 App 的 ffmpeg 优先级最高，不受系统里装了什么影响。"""
    bundled = tmp_path / "bin" / "ffmpeg"
    bundled.parent.mkdir()
    bundled.write_text("#!/bin/sh\n")
    bundled.chmod(0o755)
    system_ffmpeg = tmp_path / "system-ffmpeg"
    system_ffmpeg.write_text("#!/bin/sh\n")
    system_ffmpeg.chmod(0o755)

    monkeypatch.setattr(system_check.sys, "_MEIPASS", str(tmp_path), raising=False)
    monkeypatch.setattr(system_check, "POSIX_FFMPEG_FALLBACKS", (str(system_ffmpeg),))
    monkeypatch.setattr(system_check.platform, "system", lambda: "Darwin")

    assert system_check.get_ffmpeg_path() == str(bundled)
