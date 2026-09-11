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
        parameters={"duration": 15, "resolution": "768p竖"},
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
            service._process_video_generation(_generation("dola-seedance2.5", PlaygroundMode.R2V))
            service._process_image_generation(_generation("wan2.7-image-pro", PlaygroundMode.T2I))

        service._generate_image_jiucaihezi.assert_called_once()
        service._generate_video_jiucaihezi.assert_called_once()
        service._generate_image_wanx.assert_called_once()

    def test_public_minimax_model_and_parameters_reach_adapter(self):
        service = PlaygroundService(Mock())
        service._jiucaihezi_video_model = Mock()

        service._generate_video_jiucaihezi(
            _generation("minimax_h3_image_audio_to_video_v2_15s", PlaygroundMode.R2V),
            "/tmp/out.mp4",
        )

        service._jiucaihezi_video_model.generate.assert_called_once_with(
            "test",
            "/tmp/out.mp4",
            model_name="minimax_h3_image_audio_to_video_v2_15s",
            duration=15,
            resolution="768p竖",
            img_path=None,
            img_url=None,
            ratio="16:9",
            ref_image_urls=[],
        )

    @patch.dict("os.environ", {"JIUCAIHEZI_API_KEY": "test"})
    @patch("src.models.jiucaihezi.upload_to_jiucaihezi")
    @patch("src.apps.playground.service.requests.post")
    def test_seed_audio_local_reference_uses_jiucaihezi_upload(self, post, upload):
        upload.return_value = "https://api.jiucaihezi.studio/media/creation/audio"
        response = Mock()
        response.content = b"mp3"
        response.raise_for_status.return_value = None
        post.return_value = response
        service = PlaygroundService(Mock())
        generation = _generation("seed-audio-1.0", PlaygroundMode.R2A)
        generation.input_media = ["output/reference.wav"]

        with patch("src.apps.playground.service.os.path.exists", return_value=True), patch(
            "builtins.open", unittest.mock.mock_open(read_data=b"audio")
        ):
            service._process_audio_generation(generation)

        upload.assert_called_once_with("output/reference.wav", "audio")
        assert post.call_args.kwargs["json"]["metadata"]["references"] == [
            {"audio_url": "https://api.jiucaihezi.studio/media/creation/audio"}
        ]


if __name__ == "__main__":
    unittest.main()
