import os
import tempfile
from unittest.mock import Mock, patch

from src.models.jiucaihezi import JiucaiheziImageModel


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
