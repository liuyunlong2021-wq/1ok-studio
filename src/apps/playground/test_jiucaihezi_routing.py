import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from .models import PlaygroundMode
from .service import PlaygroundService


def _generation(model_id, mode):
    return SimpleNamespace(
        id="test",
        model_id=model_id,
        mode=mode,
        prompt="test",
        parameters={},
        input_media=[],
        batch_size=1,
        outputs=[],
    )


class JiucaiheziRoutingTest(unittest.TestCase):
    def test_jiucaihezi_and_wan_routes(self):
        service = PlaygroundService(Mock())
        service._generate_image_jiucaihezi = Mock()
        service._generate_image_wanx = Mock()
        service._generate_video_jiucaihezi = Mock()
        service._generate_video_wanx = Mock()

        with tempfile.TemporaryDirectory() as output_dir, patch(
            "src.apps.playground.service.IMAGE_OUTPUT_DIR", output_dir
        ), patch("src.apps.playground.service.VIDEO_OUTPUT_DIR", output_dir):
            service._process_image_generation(_generation("jiucaihezi/gpt-image-2-1k", PlaygroundMode.T2I))
            service._process_video_generation(_generation("jiucaihezi/dola-seedance2.5-r2v", PlaygroundMode.R2V))
            service._process_image_generation(_generation("wan2.7-image-pro", PlaygroundMode.T2I))

        service._generate_image_jiucaihezi.assert_called_once()
        service._generate_video_jiucaihezi.assert_called_once()
        service._generate_image_wanx.assert_called_once()


if __name__ == "__main__":
    unittest.main()
