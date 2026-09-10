import os
import tempfile
from unittest.mock import Mock, patch

from src.models.jiucaihezi import JiucaiheziImageModel, JiucaiheziVideoModel


def _response(data):
    response = Mock()
    response.json.return_value = data
    return response


@patch.dict(os.environ, {"JIUCAIHEZI_API_KEY": "test"})
@patch("src.models.jiucaihezi._download")
@patch("src.models.jiucaihezi.time.sleep")
@patch("src.models.jiucaihezi.requests.get")
@patch("src.models.jiucaihezi.requests.post")
def test_grok_text_to_image_uses_async_video_contract(post, get, _sleep, download):
    post.return_value = _response({"task_id": "task-1"})
    get.return_value = _response(
        {"status": "completed", "metadata": {"url": "https://example.com/image.png"}}
    )

    JiucaiheziImageModel({}).generate(
        "prompt",
        "/tmp/output.png",
        model_name="jiucaihezi/grok-imagine-image-2.0",
        size="2048x1152",
    )

    assert post.call_args.args[0].endswith("/v1/videos")
    assert post.call_args.kwargs["json"] == {
        "model": "grok-imagine-image-2.0",
        "prompt": "prompt",
        "size": "2048x1152",
        "response_format": "url",
    }
    assert get.call_args.args[0].endswith("/v1/videos/task-1")
    download.assert_called_once_with("https://example.com/image.png", "/tmp/output.png")


@patch.dict(os.environ, {"JIUCAIHEZI_API_KEY": "test"})
@patch("src.models.jiucaihezi._download")
@patch("src.models.jiucaihezi.time.sleep")
@patch("src.models.jiucaihezi.requests.get")
@patch("src.models.jiucaihezi.requests.post")
def test_grok_reference_images_use_image_array_fields(post, get, _sleep, _download_mock):
    post.return_value = _response({"id": "task-2"})
    get.return_value = _response(
        {"status": "completed", "metadata": {"url": "https://example.com/image.png"}}
    )

    with tempfile.NamedTemporaryFile(suffix=".png") as reference:
        JiucaiheziImageModel({}).generate(
            "edit",
            "/tmp/output.png",
            model_name="grok-imagine-image-2.0",
            ref_image_paths=[reference.name],
        )

    assert post.call_args.args[0].endswith("/v1/videos")
    assert "json" not in post.call_args.kwargs
    assert [field for field, _file in post.call_args.kwargs["files"]] == ["image[]"]


@patch.dict(os.environ, {"JIUCAIHEZI_API_KEY": "test"})
@patch("src.models.jiucaihezi._download")
@patch("src.models.jiucaihezi.time.sleep")
@patch("src.models.jiucaihezi.requests.get")
@patch("src.models.jiucaihezi.requests.post")
def test_video_uses_public_api_model_names(post, get, _sleep, _download_mock):
    post.return_value = _response({"task_id": "task-1"})
    get.return_value = _response({"status": "completed", "video_url": "https://example.com/video.mp4"})

    JiucaiheziVideoModel({}).generate(
        "prompt",
        "/tmp/output.mp4",
        model_name="minimax_h3_image_audio_to_video_v2_15s",
        duration=15,
        resolution="768p竖",
        ratio="9:16",
    )

    assert post.call_args.kwargs["json"] == {
        "model": "minimax_h3_image_audio_to_video_v2_15s",
        "prompt": "prompt",
        "ratio": "9:16",
        "duration": 15,
        "resolution": "768p竖",
    }

    JiucaiheziVideoModel({}).generate(
        "prompt",
        "/tmp/output.mp4",
        model_name="dola-seedance2.5",
        ratio="9:16",
    )

    assert post.call_args.kwargs["json"] == {
        "model": "dola-seedance2.5",
        "prompt": "prompt",
        "ratio": "9:16",
    }


@patch.dict(os.environ, {"JIUCAIHEZI_API_KEY": "test"})
@patch("src.models.jiucaihezi.time.sleep")
@patch("src.models.jiucaihezi.requests.get")
@patch("src.models.jiucaihezi.requests.post")
def test_video_downloads_content_endpoint_when_completed_task_has_no_url(post, get, _sleep, tmp_path):
    post.return_value = _response({"id": "task-content"})
    poll = _response({
        "id": "task-content",
        "status": "completed",
        "progress": 100,
    })
    content = _response({})
    content.content = b"video-bytes"
    get.side_effect = [poll, content]
    output_path = tmp_path / "output.mp4"

    JiucaiheziVideoModel({}).generate("prompt", str(output_path), model_name="minimax_h3_image_audio_to_video_v2_15s")

    assert output_path.read_bytes() == b"video-bytes"
    assert get.call_args_list[1].args[0].endswith("/v1/videos/task-content/content")
    assert get.call_args_list[1].kwargs["headers"] == {"Authorization": "Bearer test"}
