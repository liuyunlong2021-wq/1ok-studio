import base64
import logging
import os
from unittest.mock import Mock, patch

import pytest
import requests

from src.models.jiucaihezi import (
    JiucaiheziImageModel,
    JiucaiheziVideoModel,
    _align_ratio_with_resolution,
    _log_image_request,
    _raise_for_status_with_body,
    generate_audio,
    upload_to_jiucaihezi,
)


def _response(data):
    response = Mock()
    response.json.return_value = data
    return response


def test_upstream_error_carries_the_gateway_response_body():
    """上游报错时要把它那句话带出来。

    网关（New API）的 body 里写着真正的原因（model not found / 参数不合法 / 上游 502），
    而 requests 的 raise_for_status() 只给一句 "400 Bad Request" —— 排障最需要的
    那行信息就这样丢了。
    """
    response = Mock()
    response.text = '{"error":{"message":"model gpt-image-2.5 is not available"}}'
    response.raise_for_status.side_effect = requests.exceptions.HTTPError(
        "400 Client Error: Bad Request for url: https://api.jiucaihezi.studio/v1/images/generations"
    )

    with pytest.raises(requests.exceptions.HTTPError) as excinfo:
        _raise_for_status_with_body(response, "/v1/images/generations")

    assert "model gpt-image-2.5 is not available" in str(excinfo.value)
    assert "400 Client Error" in str(excinfo.value)


def test_upstream_error_without_a_body_raises_the_original():
    """没有响应体时不要改变异常类型，也不要把错误信息搞丢。"""
    response = Mock()
    response.text = ""
    original = requests.exceptions.HTTPError("524 Server Error: <none>")
    response.raise_for_status.side_effect = original

    with pytest.raises(requests.exceptions.HTTPError) as excinfo:
        _raise_for_status_with_body(response, "/v1/images/generations")

    assert excinfo.value is original


def test_successful_response_is_passed_through():
    response = Mock()

    _raise_for_status_with_body(response, "/v1/images/generations")

    response.raise_for_status.assert_called_once()


def test_image_request_fields_are_logged(caplog):
    """出图失败时第一个要回答的问题是「我们到底发了什么」。"""
    caplog.set_level(logging.INFO)

    _log_image_request(
        "/v1/images/generations",
        {"model": "gpt-image-2.5-菠萝", "size": "576*1024", "n": 1, "prompt": "x" * 20},
    )

    assert "model=gpt-image-2.5-菠萝" in caplog.text
    assert "size=576*1024" in caplog.text
    assert "prompt_chars=20" in caplog.text


@patch.dict(os.environ, {"JIUCAIHEZI_API_KEY": "test"})
@patch("src.models.jiucaihezi.requests.post")
def test_local_media_upload_uses_jiucaihezi_temporary_media_api(post, tmp_path):
    source = tmp_path / "reference.wav"
    source.write_bytes(b"audio")
    post.return_value = _response({
        "url": "https://api.jiucaihezi.studio/media/creation/token"
    })

    url = upload_to_jiucaihezi(str(source), "audio")

    assert url.endswith("/media/creation/token")
    assert post.call_args.args[0].endswith("/api/creations/uploads")
    assert post.call_args.kwargs["headers"] == {"Authorization": "Bearer test"}
    assert post.call_args.kwargs["files"]["file"][0] == "reference.wav"
    assert post.call_args.kwargs["timeout"] == (15, 120)


@patch.dict(os.environ, {"JIUCAIHEZI_API_KEY": "test"})
@patch("src.models.jiucaihezi.requests.post")
def test_local_media_upload_retries_transient_gateway_failure(post, tmp_path):
    source = tmp_path / "reference.png"
    source.write_bytes(b"image")
    failed = _response({})
    failed.status_code = 503
    failed.text = "gateway unavailable"
    failed.raise_for_status.side_effect = requests.HTTPError(response=failed)
    post.side_effect = [failed, _response({
        "url": "https://api.jiucaihezi.studio/media/creation/recovered"
    })]

    with patch("src.models.jiucaihezi.time.sleep"):
        url = upload_to_jiucaihezi(str(source), "image")

    assert url.endswith("/recovered")
    assert post.call_count == 2


@patch.dict(os.environ, {"JIUCAIHEZI_API_KEY": "test"})
@patch("src.models.jiucaihezi.requests.post")
def test_local_media_upload_rejects_missing_url_without_a_fallback(post, tmp_path):
    source = tmp_path / "reference.png"
    source.write_bytes(b"image")
    post.return_value = _response({})

    with pytest.raises(RuntimeError, match="returned no public URL"):
        upload_to_jiucaihezi(str(source), "image")


@patch.dict(os.environ, {"JIUCAIHEZI_API_KEY": "test"})
@patch("src.models.jiucaihezi._download")
@patch("src.models.jiucaihezi.requests.post")
def test_grok_text_to_image_uses_openai_image_channel(post, download):
    """Grok 图片走韭菜盒子 OpenAI 兼容图片通道，不是历史 /v1/videos 异步方案。"""
    post.return_value = _response({"data": [{"url": "https://example.com/image.png"}]})

    JiucaiheziImageModel({}).generate(
        "prompt",
        "/tmp/output.png",
        model_name="jiucaihezi/grok-imagine-image-2.0",
        size="2048x1152",
    )

    assert post.call_args.args[0].endswith("/v1/images/generations")
    assert post.call_args.kwargs["json"] == {
        "model": "grok-imagine-image-2.0",
        "prompt": "prompt",
        "size": "2048x1152",
        "n": 1,
        "response_format": "url",
    }
    download.assert_called_once_with("https://example.com/image.png", "/tmp/output.png")


@patch.dict(os.environ, {"JIUCAIHEZI_API_KEY": "test"})
@patch("src.models.jiucaihezi._download")
@patch("src.models.jiucaihezi.requests.post")
def test_image_quality_reaches_gateway_payload(post, download):
    """菠萝的质量档要进 JSON payload；没传 quality 的模型不带这个键。"""
    post.return_value = _response({"data": [{"url": "https://example.com/image.png"}]})

    JiucaiheziImageModel({}).generate(
        "prompt",
        "/tmp/output.png",
        model_name="jiucaihezi/gpt-image-2.5-菠萝",
        size="1024x1024",
        quality="low",
    )
    assert post.call_args.kwargs["json"]["quality"] == "low"
    assert post.call_args.kwargs["json"]["model"] == "gpt-image-2.5-菠萝"

    post.reset_mock()
    JiucaiheziImageModel({}).generate(
        "prompt",
        "/tmp/output.png",
        model_name="jiucaihezi/gpt-image-2.5-1k",
        size="1024x1024",
    )
    assert "quality" not in post.call_args.kwargs["json"]


@patch.dict(os.environ, {"JIUCAIHEZI_API_KEY": "test"})
@patch("src.models.jiucaihezi.requests.post")
def test_grok_reference_images_use_edits_endpoint(post, tmp_path):
    post.return_value = _response({"data": [{"b64_json": base64.b64encode(b"image").decode()}]})

    # 参考图必须先落盘并关闭。这里原来用的是仍处于打开状态的
    # NamedTemporaryFile：POSIX 允许第二个读者再打开同一文件，Windows 会直接
    # PermissionError（Errno 13），因为适配器还要 open() 一次读它。输出路径同理，
    # 原来是写死的 /tmp/output.png —— 在 Windows 上那是 C:\tmp\，目录通常不存在。
    reference = tmp_path / "reference.png"
    reference.write_bytes(b"reference")

    JiucaiheziImageModel({}).generate(
        "edit",
        str(tmp_path / "output.png"),
        model_name="grok-imagine-image-2.0",
        ref_image_paths=[str(reference)],
    )

    assert post.call_args.args[0].endswith("/v1/images/edits")
    assert "json" not in post.call_args.kwargs
    assert post.call_args.kwargs["data"]["model"] == "grok-imagine-image-2.0"
    # 网关合同的多图字段名是 `image`（见 /v1/images/edits 的 -F image=@...）。
    assert [field for field, _file in post.call_args.kwargs["files"]] == ["image"]


@patch.dict(os.environ, {"JIUCAIHEZI_API_KEY": "test"})
@patch("src.models.jiucaihezi._download_video_content")
@patch("src.models.jiucaihezi.time.sleep")
@patch("src.models.jiucaihezi.requests.get")
@patch("src.models.jiucaihezi.requests.post")
def test_video_uses_public_api_model_names(post, get, _sleep, _download_content):
    post.return_value = _response({"task_id": "task-1"})
    get.return_value = _response({"status": "completed"})

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
    assert post.call_args.kwargs["timeout"] == (15, 180)
    _download_content.assert_called_once_with("task-1", "/tmp/output.mp4")

    JiucaiheziVideoModel({}).generate(
        "prompt",
        "/tmp/output.mp4",
        model_name="海seedance2.5",
        ratio="9:16",
    )

    assert post.call_args.kwargs["json"] == {
        "model": "海seedance2.5",
        "prompt": "prompt",
        "ratio": "9:16",
    }


@patch.dict(os.environ, {"JIUCAIHEZI_API_KEY": "test"})
@patch("src.models.jiucaihezi.requests.post")
def test_video_create_timeout_is_not_retried(post, tmp_path):
    post.side_effect = requests.Timeout("gateway stalled")

    with pytest.raises(RuntimeError, match="not retried to avoid duplicate billing"):
        JiucaiheziVideoModel({}).generate(
            "prompt", str(tmp_path / "output.mp4"), model_name="海seedance2.5"
        )

    assert post.call_count == 1


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


@patch.dict(os.environ, {"JIUCAIHEZI_API_KEY": "test"})
@patch("src.models.jiucaihezi._download_video_content")
@patch("src.models.jiucaihezi.time.sleep")
@patch("src.models.jiucaihezi.requests.get")
@patch("src.models.jiucaihezi.requests.post")
def test_video_keeps_polling_queued_and_in_progress(post, get, _sleep, _download_content, tmp_path):
    post.return_value = _response({"task_id": "task-slow"})
    get.side_effect = [
        _response({"status": "queued"}),
        _response({"status": "in_progress"}),
        _response({"status": "completed"}),
    ]

    _, elapsed = JiucaiheziVideoModel({}).generate(
        "prompt", str(tmp_path / "output.mp4"), model_name="海seedance2.5"
    )

    assert get.call_count == 3
    assert post.call_count == 1
    _download_content.assert_called_once_with("task-slow", str(tmp_path / "output.mp4"))
    assert elapsed >= 0


@patch.dict(os.environ, {"JIUCAIHEZI_API_KEY": "test"})
@patch("src.models.jiucaihezi.time.sleep")
@patch("src.models.jiucaihezi.requests.get")
@patch("src.models.jiucaihezi.requests.post")
def test_video_poll_failures_are_retried_without_recreating_the_task(post, get, _sleep, tmp_path):
    post.return_value = _response({"task_id": "task-flaky"})
    content = _response({})
    content.content = b"video-bytes"

    def _get(url, **kwargs):
        _get.calls = getattr(_get, "calls", 0) + 1
        if _get.calls == 1:
            raise requests.ConnectionError("gateway dropped")
        if url.endswith("/content"):
            return content
        return _response({"status": "completed"})

    get.side_effect = _get
    output_path = tmp_path / "output.mp4"

    JiucaiheziVideoModel({}).generate("prompt", str(output_path), model_name="海seedance2.5")

    assert post.call_count == 1
    assert output_path.read_bytes() == b"video-bytes"


@patch.dict(os.environ, {"JIUCAIHEZI_API_KEY": "test"})
@patch("src.models.jiucaihezi.time.sleep")
@patch("src.models.jiucaihezi.requests.get")
@patch("src.models.jiucaihezi.requests.post")
def test_video_failure_surfaces_structured_error_message(post, get, _sleep, tmp_path):
    post.return_value = _response({"task_id": "task-bad"})
    get.return_value = _response({
        "status": "failed",
        "error": {"message": "素材下载失败：cdn.example.com 无法访问"},
    })

    with pytest.raises(RuntimeError, match="cdn.example.com 无法访问"):
        JiucaiheziVideoModel({}).generate(
            "prompt", str(tmp_path / "output.mp4"), model_name="海seedance2.5"
        )


@patch.dict(os.environ, {"JIUCAIHEZI_API_KEY": "test"})
@patch("src.models.jiucaihezi.requests.post")
def test_video_create_rejection_surfaces_structured_error_message(post, tmp_path):
    rejected = _response({"error": {"message": "images[0] 素材格式不受支持"}})
    rejected.ok = False
    rejected.status_code = 400
    rejected.text = ""
    post.return_value = rejected

    with pytest.raises(RuntimeError, match="images\\[0\\] 素材格式不受支持"):
        JiucaiheziVideoModel({}).generate(
            "prompt", str(tmp_path / "output.mp4"), model_name="海seedance2.5"
        )

    assert post.call_count == 1


# ---------------------------------------------------------------------------
# MiniMax H3 系列：同配置不同名 + ratio/resolution 一致性
# ---------------------------------------------------------------------------


@patch.dict(os.environ, {"JIUCAIHEZI_API_KEY": "test"})
@patch("src.models.jiucaihezi._download_video_content")
@patch("src.models.jiucaihezi.time.sleep")
@patch("src.models.jiucaihezi.requests.get")
@patch("src.models.jiucaihezi.requests.post")
def test_minimax_sibling_model_shares_the_same_config(post, get, _sleep, _download_content):
    """minimax_h3_zm_u24 与 v2_15s 同规格：必须拿到 duration/resolution/audios。

    这条是回归防线：门控曾经是 `model_name == "minimax_h3_image_audio_to_video_v2_15s"`
    精确匹配，加同规格兄弟模型时会静默丢掉这三个字段。
    """
    post.return_value = _response({"task_id": "task-1"})
    get.return_value = _response({"status": "completed"})

    JiucaiheziVideoModel({}).generate(
        "prompt",
        "/tmp/output.mp4",
        model_name="jiucaihezi/minimax_h3_zm_u24",
        duration=12,
        resolution="768p竖",
        aspect_ratio="16:9",  # 与 768p竖 矛盾的旧值，应被 resolution 纠正
        reference_audio_urls=["https://example.com/bgm.mp3"],
    )

    payload = post.call_args.kwargs["json"]
    assert payload["model"] == "minimax_h3_zm_u24"
    assert payload["duration"] == 12
    assert payload["resolution"] == "768p竖"
    assert payload["audios"] == ["https://example.com/bgm.mp3"]
    assert payload["ratio"] == "9:16"


@patch.dict(os.environ, {"JIUCAIHEZI_API_KEY": "test"})
@patch("src.models.jiucaihezi._download_video_content")
@patch("src.models.jiucaihezi.time.sleep")
@patch("src.models.jiucaihezi.requests.get")
@patch("src.models.jiucaihezi.requests.post")
def test_seedance_never_receives_minimax_only_fields(post, get, _sleep, _download_content):
    """反向守：只有 MiniMax H3 系列能带 duration/resolution/audios。"""
    post.return_value = _response({"task_id": "task-1"})
    get.return_value = _response({"status": "completed"})

    JiucaiheziVideoModel({}).generate(
        "prompt",
        "/tmp/output.mp4",
        model_name="海seedance2.5",
        duration=12,
        resolution="768p竖",
    )

    payload = post.call_args.kwargs["json"]
    assert payload == {"model": "海seedance2.5", "prompt": "prompt", "ratio": "16:9"}


@pytest.mark.parametrize(
    "ratio,resolution,expected",
    [
        ("16:9", "768p横", "16:9"),   # 一致，原样保留
        ("9:16", "768p竖", "9:16"),   # 一致，原样保留
        ("16:9", "768p竖", "9:16"),   # 矛盾，以 resolution 为准
        ("9:16", "768p横", "16:9"),   # 矛盾，以 resolution 为准
        ("21:9", "768p横", "21:9"),   # 同向（都是横），不强行改成 16:9
        ("1:1", "768p横", "1:1"),     # 方形不表态，保留
        ("16:9", "720p", "16:9"),     # resolution 不带横竖，不受影响
        ("9:16", "", "9:16"),         # resolution 缺失，不受影响
    ],
)
def test_align_ratio_with_resolution(ratio, resolution, expected):
    assert _align_ratio_with_resolution(ratio, resolution) == expected



# ---------------------------------------------------------------------------
# 音频生成：seed-audio-1.0 是一个独立模型，参考音频可选
# ---------------------------------------------------------------------------

def _audio_response(payload: bytes = b"mp3-bytes"):
    response = Mock()
    response.ok = True
    response.content = payload
    response.raise_for_status.return_value = None
    return response


@patch.dict(os.environ, {"JIUCAIHEZI_API_KEY": "test"})
@patch("src.models.jiucaihezi.requests.post")
def test_generate_audio_without_reference_audio(post, tmp_path):
    """纯文生音频：不带 metadata.references。"""
    post.return_value = _audio_response()
    target = tmp_path / "out.mp3"

    result = generate_audio("海浪拍岸的环境声", str(target))

    assert result == str(target)
    assert target.read_bytes() == b"mp3-bytes"
    assert post.call_args.args[0].endswith("/v1/audio/speech")
    assert post.call_args.kwargs["json"] == {
        "model": "seed-audio-1.0",
        "input": "海浪拍岸的环境声",
        "response_format": "mp3",
    }
    assert "metadata" not in post.call_args.kwargs["json"]


@patch.dict(os.environ, {"JIUCAIHEZI_API_KEY": "test"})
@patch("src.models.jiucaihezi.requests.post")
def test_generate_audio_with_reference_audio(post, tmp_path):
    """带参考音频：放进 metadata.references。远程 URL 直接透传。"""
    post.return_value = _audio_response()

    generate_audio(
        "照着这个音色念台词",
        str(tmp_path / "out.mp3"),
        reference_audio_urls=["https://cdn.example/ref.wav"],
    )

    assert post.call_args.kwargs["json"]["metadata"]["references"] == [
        {"audio_url": "https://cdn.example/ref.wav"}
    ]


@patch.dict(os.environ, {"JIUCAIHEZI_API_KEY": "test"})
@patch("src.models.jiucaihezi.requests.post")
def test_generate_audio_caps_reference_audios_at_three(post, tmp_path):
    post.return_value = _audio_response()

    generate_audio(
        "p",
        str(tmp_path / "out.mp3"),
        reference_audio_urls=[f"https://cdn.example/ref{i}.wav" for i in range(5)],
    )

    assert len(post.call_args.kwargs["json"]["metadata"]["references"]) == 3


@patch.dict(os.environ, {"JIUCAIHEZI_API_KEY": "test"})
@patch("src.models.jiucaihezi.requests.post")
def test_generate_audio_surfaces_gateway_error_message(post, tmp_path):
    response = Mock()
    response.ok = False
    response.json.return_value = {"error": {"message": "该模型未开通"}}
    post.return_value = response

    with pytest.raises(RuntimeError, match="该模型未开通"):
        generate_audio("p", str(tmp_path / "out.mp3"))


# ---------------------------------------------------------------------------
# 合同补漏：input 必须 1-3000 字符（见 Seed Audio 1.0 接入合同）
# ---------------------------------------------------------------------------

def test_generate_audio_rejects_blank_input(tmp_path):
    """input 是必填且 1-3000 字符。空字符串上游会 400，不如在本地报清楚。"""
    with pytest.raises(ValueError, match="1-3000"):
        generate_audio("   ", str(tmp_path / "out.mp3"))


def test_generate_audio_truncates_input_at_contract_limit(tmp_path):
    """3000 是合同上限，超了要截断而不是原样发出去。"""
    with patch.dict(os.environ, {"JIUCAIHEZI_API_KEY": "test"}), patch(
        "src.models.jiucaihezi.requests.post"
    ) as post:
        post.return_value = _audio_response()
        generate_audio("字" * 5000, str(tmp_path / "out.mp3"))

    assert len(post.call_args.kwargs["json"]["input"]) == 3000
