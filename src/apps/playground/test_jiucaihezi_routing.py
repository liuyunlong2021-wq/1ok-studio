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
    def test_every_model_routes_to_the_single_jiucaihezi_adapter(self):
        """目录里只有韭菜盒子一家：不管 model_id 是什么都走同一个适配器。

        这里原来断言 `jiucaihezi/…` → jiucaihezi、`wan2.7-image-pro` → wanx。后者已
        随家族收敛删除；已下线的旧 id 不再在本地猜一个适配器，交给网关按模型名报错。
        """
        service = PlaygroundService(Mock())
        service._generate_image_jiucaihezi = Mock()
        service._generate_video_jiucaihezi = Mock()

        with tempfile.TemporaryDirectory() as output_dir, patch(
            "src.apps.playground.service.IMAGE_OUTPUT_DIR", output_dir
        ), patch("src.apps.playground.service.VIDEO_OUTPUT_DIR", output_dir):
            service._process_image_generation(_generation("jiucaihezi/gpt-image-2.5-1k", PlaygroundMode.T2I))
            service._process_video_generation(_generation("海seedance2.5", PlaygroundMode.R2V))
            # 已下线的旧 id 同样落到唯一适配器
            service._process_image_generation(_generation("wan2.7-image-pro", PlaygroundMode.T2I))

        assert service._generate_image_jiucaihezi.call_count == 2
        service._generate_video_jiucaihezi.assert_called_once()

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

    def test_image_quality_parameter_reaches_adapter(self):
        """质量档必须透传到适配器：没选时是 None，选了原样带走。"""
        service = PlaygroundService(Mock())
        service._jiucaihezi_image_model = Mock()

        service._generate_image_jiucaihezi(
            _generation("jiucaihezi/gpt-image-2.5-菠萝", PlaygroundMode.T2I),
            "/tmp/out.png",
        )
        service._jiucaihezi_image_model.generate.assert_called_once_with(
            "test",
            "/tmp/out.png",
            model_name="jiucaihezi/gpt-image-2.5-菠萝",
            size="1024x1024",
            n=1,
            quality=None,
        )

        gen = _generation("jiucaihezi/gpt-image-2.5-菠萝", PlaygroundMode.T2I)
        gen.parameters = {"size": "1024x1024", "quality": "low"}
        service._generate_image_jiucaihezi(gen, "/tmp/out.png")
        assert service._jiucaihezi_image_model.generate.call_args.kwargs["quality"] == "low"

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
