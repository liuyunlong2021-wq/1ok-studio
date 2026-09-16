"""LLMAdapter 的通道选择：产品只走韭菜盒子，DashScope 是显式 opt-in。

回归背景：`chat()` 曾有一条
    if not model and ... and not os.getenv("DASHSCOPE_API_KEY"): 走韭菜盒子
的守卫，把「环境里存在百炼 key」当成了「应该用百炼」。仓库 `.env` 里一个陈旧的
DashScope key 于是能把整条文本链路打回 `401 Incorrect API key` —— 声音步骤的
「生成导演稿」就是这么挂的（它不传 model，只能吃 adapter 的默认通道）。

Run: `.venv/bin/python -m pytest src/apps/comic_gen/test_llm_adapter.py -q`
"""

import pytest

from src.apps.comic_gen.llm_adapter import LLMAdapter


def test_transient_jiucaihezi_failure_falls_back_to_stable_model(monkeypatch):
    adapter = LLMAdapter()
    monkeypatch.setattr(adapter, "_get_jiucaihezi_client", lambda: "jiucaihezi")
    calls = []

    def chat_once(client, model, *_args, **_kwargs):
        calls.append((client, model))
        if model == "gemini-3.8-flash":
            raise RuntimeError("Jiucaihezi API error: 524 timeout")
        return f"{client}:{model}"

    monkeypatch.setattr(adapter, "_chat_once", chat_once)

    assert adapter.chat([], model="gemini-3.8-flash") == "jiucaihezi:gpt-5.6-sol"
    assert calls == [
        ("jiucaihezi", "gemini-3.8-flash"),
        ("jiucaihezi", "gpt-5.6-sol"),
    ]


def test_model_id_case_is_normalized_before_routing(monkeypatch):
    adapter = LLMAdapter()
    monkeypatch.setattr(adapter, "_get_jiucaihezi_client", lambda: "jiucaihezi")
    calls = []

    def chat_once(client, model, *_args, **_kwargs):
        calls.append((client, model))
        return f"{client}:{model}"

    monkeypatch.setattr(adapter, "_chat_once", chat_once)

    # 目录里的 id 是小写，UI / API 调用方可能送厂商那套混写字，统一转小写再发。
    assert adapter.chat([], model="deepSeek-flash") == "jiucaihezi:deepseek-flash"
    assert calls == [("jiucaihezi", "deepseek-flash")]


def test_stale_dashscope_key_does_not_hijack_the_default_channel(monkeypatch):
    """环境里有（陈旧 / 错误的）DASHSCOPE_API_KEY 时，未指定 model 仍走韭菜盒子。"""
    monkeypatch.delenv("LLM_PROVIDER", raising=False)
    monkeypatch.setenv("JIUCAIHEZI_API_KEY", "jc-key")
    monkeypatch.setenv("DASHSCOPE_API_KEY", "stale-and-wrong")

    adapter = LLMAdapter()
    assert adapter.provider == "jiucaihezi"

    calls = []
    monkeypatch.setattr(adapter, "_get_jiucaihezi_client", lambda: "jiucaihezi")
    monkeypatch.setattr(adapter, "_get_default_model", lambda: "deepseek-flash")
    monkeypatch.setattr(
        LLMAdapter, "_get_client", lambda self: pytest.fail("默认通道不该建 DashScope 客户端")
    )

    def chat_once(client, model, *_args, **_kwargs):
        calls.append((client, model))
        return f"{client}:{model}"

    monkeypatch.setattr(adapter, "_chat_once", chat_once)

    assert adapter.chat([{"role": "user", "content": "hi"}]) == "jiucaihezi:deepseek-flash"
    assert calls == [("jiucaihezi", "deepseek-flash")]


def test_default_model_follows_the_global_text_model(monkeypatch):
    """「设置 → 文本模型」选的那个，要能作用到没传 model 的调用点。"""
    monkeypatch.setenv("JIUCAIHEZI_API_KEY", "jc-key")
    monkeypatch.delenv("LLM_PROVIDER", raising=False)
    monkeypatch.setattr(
        "src.utils.global_settings.get_active_text_model", lambda: "claude-fable-5-1"
    )

    adapter = LLMAdapter()
    monkeypatch.setattr(adapter, "_get_jiucaihezi_client", lambda: "jiucaihezi")
    monkeypatch.setattr(adapter, "_chat_once", lambda client, model, *_a, **_k: f"{client}:{model}")

    assert adapter.chat([]) == "jiucaihezi:claude-fable-5-1"


def test_explicit_openai_provider_still_wins(monkeypatch):
    """`LLM_PROVIDER=openai` 是显式 opt-in，不该被默认通道覆盖。"""
    monkeypatch.setenv("LLM_PROVIDER", "openai")
    monkeypatch.setenv("OPENAI_API_KEY", "oa-key")
    monkeypatch.delenv("JIUCAIHEZI_API_KEY", raising=False)

    adapter = LLMAdapter()
    assert adapter.provider == "openai"

    monkeypatch.setattr(adapter, "_get_client", lambda: "openai")
    monkeypatch.setattr(adapter, "_chat_once", lambda client, model, *_a, **_k: f"{client}:{model}")

    assert adapter.chat([], model="gpt-4o") == "openai:gpt-4o"
