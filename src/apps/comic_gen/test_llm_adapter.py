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
