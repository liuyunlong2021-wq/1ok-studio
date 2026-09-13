"""LLMAdapter 网关瞬时失败的重试与错误文案。

背景：走韭菜盒子会经过 Cloudflare，源站超过 120 秒代理读超时就会回 524。旧代码
只在**换模型**这条路上处理 524，而当时用的就是兜底模型 `gpt-5.6-sol`，于是命中
`if not transient or model == "gpt-5.6-sol": raise` —— 一次重试都没发生，用户
看到的就是一整块 Cloudflare JSON。

现在：非兜底模型仍然先换兜底模型；已经是兜底模型则原地退避重试一次，失败后抛
一句人话。

Run: `.venv/bin/python -m pytest tests/test_llm_adapter_transient.py -q`
"""

from unittest.mock import patch

import pytest

from src.apps.comic_gen.llm_adapter import (
    LLMAdapter,
    JIUCAIHEZI_FALLBACK_MODEL,
    _readable_gateway_error,
)

CLOUDFLARE_524 = (
    'Jiucaihezi API error: Error code: 524 - {\'type\': \'https://developers.cloudflare.com/'
    "support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/', "
    "'title': 'Error 524: A timeout occurred', 'status': 524, 'detail': 'The origin web "
    "server did not return a complete response within the 120-second Proxy Read Timeout window.'}"
)


@pytest.fixture
def adapter():
    return LLMAdapter()


def test_readable_gateway_error_compacts_the_cloudflare_json():
    message = _readable_gateway_error(RuntimeError(CLOUDFLARE_524))

    assert "524" in message
    assert "120" in message
    assert "cloudflare.com" not in message  # 别把那一大块 JSON 甩给用户
    assert len(message) < 200


def test_non_gateway_errors_are_passed_through_unchanged():
    assert _readable_gateway_error(RuntimeError("401 invalid api key")) == "401 invalid api key"


def test_fallback_model_is_retried_once_and_then_reports_readably(adapter):
    calls = []

    def fake_chat_once(client, model, messages, response_format, provider_label=None):
        calls.append(model)
        raise RuntimeError(CLOUDFLARE_524)

    with patch.object(LLMAdapter, "_get_jiucaihezi_client", return_value=object()), \
         patch.object(LLMAdapter, "_chat_once", side_effect=fake_chat_once), \
         patch("src.apps.comic_gen.llm_adapter.time.sleep") as sleeper:
        with pytest.raises(RuntimeError) as excinfo:
            adapter.chat([{"role": "user", "content": "hi"}], model=JIUCAIHEZI_FALLBACK_MODEL)

    assert calls == [JIUCAIHEZI_FALLBACK_MODEL, JIUCAIHEZI_FALLBACK_MODEL]
    assert sleeper.call_count == 1
    assert "cloudflare.com" not in str(excinfo.value)
    assert "120" in str(excinfo.value)


def test_fallback_model_retry_can_succeed(adapter):
    calls = []

    def fake_chat_once(client, model, messages, response_format, provider_label=None):
        calls.append(model)
        if len(calls) == 1:
            raise RuntimeError(CLOUDFLARE_524)
        return '{"frames": []}'

    with patch.object(LLMAdapter, "_get_jiucaihezi_client", return_value=object()), \
         patch.object(LLMAdapter, "_chat_once", side_effect=fake_chat_once), \
         patch("src.apps.comic_gen.llm_adapter.time.sleep"):
        result = adapter.chat([{"role": "user", "content": "hi"}], model=JIUCAIHEZI_FALLBACK_MODEL)

    assert result == '{"frames": []}'
    assert calls == [JIUCAIHEZI_FALLBACK_MODEL, JIUCAIHEZI_FALLBACK_MODEL]


def test_non_fallback_model_switches_to_the_fallback(adapter):
    calls = []

    def fake_chat_once(client, model, messages, response_format, provider_label=None):
        calls.append(model)
        if model != JIUCAIHEZI_FALLBACK_MODEL:
            raise RuntimeError(CLOUDFLARE_524)
        return "ok"

    with patch.object(LLMAdapter, "_get_jiucaihezi_client", return_value=object()), \
         patch.object(LLMAdapter, "_chat_once", side_effect=fake_chat_once), \
         patch("src.apps.comic_gen.llm_adapter.time.sleep"):
        result = adapter.chat([{"role": "user", "content": "hi"}], model="gemini-3.8-flash")

    assert result == "ok"
    assert calls == ["gemini-3.8-flash", JIUCAIHEZI_FALLBACK_MODEL]


def test_non_transient_errors_do_not_retry(adapter):
    calls = []

    def fake_chat_once(client, model, messages, response_format, provider_label=None):
        calls.append(model)
        raise RuntimeError("401 invalid api key")

    with patch.object(LLMAdapter, "_get_jiucaihezi_client", return_value=object()), \
         patch.object(LLMAdapter, "_chat_once", side_effect=fake_chat_once), \
         patch("src.apps.comic_gen.llm_adapter.time.sleep") as sleeper:
        with pytest.raises(RuntimeError, match="401"):
            adapter.chat([{"role": "user", "content": "hi"}], model=JIUCAIHEZI_FALLBACK_MODEL)

    assert calls == [JIUCAIHEZI_FALLBACK_MODEL]  # 鉴权错不值得再试一次
    assert sleeper.call_count == 0
