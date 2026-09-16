"""存储的媒体引用必须是 POSIX 分隔符。

回归自 Windows 上的真实故障：``out_path`` 是 ``os.path.join`` 拼出来的**文件系统**路径，
直接当 ``media_path`` 存下来，在 Windows 上就带反斜杠
（``output\\playground\\images\\x.png``）。前端按 ``/^output\\//`` 剥前缀，反斜杠匹配不上
→ 前缀原样留在 URL 里 → 请求打到 ``/files/output/output/...`` → 404。

现象很有迷惑性：生成日志一切正常、文件确实躺在硬盘上，界面上却只有一片占位符。
``playground/models.py`` 里写明了这个字段的契约（"relative to output/"），它就是
URL 的一部分，不是操作系统路径。
"""

import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from .models import PlaygroundMode
from .service import PlaygroundService


def _generation(mode):
    return SimpleNamespace(
        id="test",
        model_id="jiucaihezi/gpt-image-2.5-1k",
        mode=mode,
        prompt="test",
        parameters={},
        input_media=[],
        batch_size=1,
        outputs=[],
    )


class StoredMediaPathTest(unittest.TestCase):
    def _run_image_generation(self):
        service = PlaygroundService(Mock())
        service._generate_image_jiucaihezi = Mock()
        generation = _generation(PlaygroundMode.T2I)

        with tempfile.TemporaryDirectory() as output_dir, patch(
            "src.apps.playground.service.IMAGE_OUTPUT_DIR", output_dir
        ):
            service._process_image_generation(generation)

        return generation.outputs

    def _run_video_generation(self):
        service = PlaygroundService(Mock())
        service._generate_video_jiucaihezi = Mock()
        generation = _generation(PlaygroundMode.T2V)

        with tempfile.TemporaryDirectory() as output_dir, patch(
            "src.apps.playground.service.VIDEO_OUTPUT_DIR", output_dir
        ):
            service._process_video_generation(generation)

        return generation.outputs

    def test_image_ref_has_no_os_separator(self):
        outputs = self._run_image_generation()

        assert len(outputs) == 1
        media_path = outputs[0].media_path
        # os.sep 在 Windows 上是反斜杠——这正是曾经漏出去的那个字符。
        assert os.sep not in media_path or os.sep == "/", media_path
        assert "\\" not in media_path, media_path

    def test_video_ref_has_no_os_separator(self):
        outputs = self._run_video_generation()

        assert len(outputs) == 1
        media_path = outputs[0].media_path
        assert os.sep not in media_path or os.sep == "/", media_path
        assert "\\" not in media_path, media_path

    def test_ref_is_the_normalized_output_path(self):
        """存的是 out_path 的 POSIX 形式，不是 out_path 本身。"""
        outputs = self._run_image_generation()

        assert outputs[0].media_path.endswith("/t2i_test_0.png"), outputs[0].media_path
