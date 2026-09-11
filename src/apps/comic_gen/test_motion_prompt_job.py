"""Motion 提示词后台任务契约测试。

这条接口原来是「一个请求等 2 分钟」，上游超过 Cloudflare 的 120 秒读超时就 524。
现在拆成：POST 立刻返回 job_id → 后台线程生成 → GET 轮询。

测试用假的 LLMAdapter.chat，所以不联网、不花钱、可重复跑：
    python -m pytest src/apps/comic_gen/test_motion_prompt_job.py
"""
import time

from fastapi.testclient import TestClient

from src.apps.comic_gen import api as api_mod
from src.apps.comic_gen.llm_adapter import LLMAdapter
from src.apps.comic_gen.models import Script, StoryboardFrame

PROJECT_ID = "test-project"
PROMPT_URL = f"/projects/{PROJECT_ID}/motion/generate_prompt"


def _make_client(monkeypatch) -> TestClient:
    script = Script(
        id=PROJECT_ID,
        title="test",
        original_text="test",
        frames=[
            StoryboardFrame(id="shot-1", scene_id="scene-1", visual_description="城门布告栏"),
            StoryboardFrame(id="shot-2", scene_id="scene-1", visual_description="围观百姓"),
        ],
        created_at=time.time(),
        updated_at=time.time(),
    )
    monkeypatch.setattr(api_mod.pipeline, "get_script", lambda script_id: script if script_id == PROJECT_ID else None)
    monkeypatch.setattr(api_mod.pipeline, "get_series", lambda _series_id: None)
    monkeypatch.setattr(api_mod.pipeline, "get_effective_prompt", lambda *_args, **_kwargs: "FAKE SKILL")
    monkeypatch.setattr(api_mod, "_MOTION_PROMPT_JOB_RETRY_DELAY", 0)
    return TestClient(api_mod.app)


def _post(client: TestClient) -> dict:
    response = client.post(PROMPT_URL, json={
        "frame_ids": ["shot-1", "shot-2"],
        "references": [{"name": "城门布告栏", "asset_type": "场景"}],
    })
    assert response.status_code == 200, response.text
    return response.json()


def _poll(client: TestClient, job_id: str) -> dict:
    response = client.get(f"{PROMPT_URL}/{job_id}")
    assert response.status_code == 200, response.text
    return response.json()


def test_job_returns_id_immediately_and_finishes(monkeypatch):
    client = _make_client(monkeypatch)
    seen_messages = []

    def fake_chat(self, messages, model=None, response_format=None):
        seen_messages.append(messages)
        return "```text\n参考图1：城门布告栏\n镜头1：城门布告栏\n```"

    monkeypatch.setattr(LLMAdapter, "chat", fake_chat)

    job = _post(client)
    assert job["status"] == "queued"
    assert job["job_id"]

    state = _poll(client, job["job_id"])
    assert state["status"] == "done"
    # 代码块围栏要被剥掉
    assert state["prompt"] == "参考图1：城门布告栏\n镜头1：城门布告栏"
    # 参考图名称必须进提示词，否则 Skill 写不出「参考图N 是什么」
    user_message = seen_messages[0][1]["content"]
    assert "参考图1：城门布告栏（场景）" in user_message
    assert "镜头1：" in user_message


def test_job_retries_once_then_reports_failure(monkeypatch):
    client = _make_client(monkeypatch)
    calls = []

    def failing_chat(self, messages, model=None, response_format=None):
        calls.append(1)
        raise RuntimeError("Jiucaihezi API error: Error code: 524 - origin_response_timeout")

    monkeypatch.setattr(LLMAdapter, "chat", failing_chat)

    job = _post(client)
    state = _poll(client, job["job_id"])

    assert state["status"] == "failed"
    assert len(calls) == api_mod._MOTION_PROMPT_JOB_ATTEMPTS
    assert "524" in state["error"]


def test_job_second_attempt_can_succeed(monkeypatch):
    client = _make_client(monkeypatch)
    calls = []

    def flaky_chat(self, messages, model=None, response_format=None):
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("Jiucaihezi API error: Request timed out.")
        return "镜头1：城门布告栏"

    monkeypatch.setattr(LLMAdapter, "chat", flaky_chat)

    job = _post(client)
    state = _poll(client, job["job_id"])

    assert state["status"] == "done"
    assert state["prompt"] == "镜头1：城门布告栏"
    assert state["attempt"] == 2


def test_unknown_job_returns_404(monkeypatch):
    client = _make_client(monkeypatch)
    assert client.get(f"{PROMPT_URL}/not-a-job").status_code == 404


def test_non_consecutive_frames_rejected_without_creating_job(monkeypatch):
    client = _make_client(monkeypatch)
    response = client.post(PROMPT_URL, json={"frame_ids": ["shot-2", "shot-1"]})
    assert response.status_code == 400


# ─── 本地拼装（不调 AI，秒回） ────────────────────────────────────────────────

ASSEMBLE_URL = f"/projects/{PROJECT_ID}/motion/assemble_prompt"


def test_assemble_puts_references_then_shots_in_order(monkeypatch):
    client = _make_client(monkeypatch)
    response = client.post(ASSEMBLE_URL, json={
        "frame_ids": ["shot-1", "shot-2"],
        "references": [
            {"name": "城门布告栏", "asset_type": "场景"},
            {"name": "刘邦", "asset_type": "角色"},
        ],
    })
    assert response.status_code == 200, response.text
    assert response.json()["prompt"] == (
        "参考图1：城门布告栏（场景）\n"
        "参考图2：刘邦（角色）\n"
        "\n"
        "所有镜头严格沿用对应参考图，身份、服装、材质、比例和关键特征保持锁定。\n"
        "\n"
        "镜头1：城门布告栏；运镜：Medium Shot\n"
        "镜头2：围观百姓；运镜：Medium Shot"
    )


def test_assemble_without_references_only_lists_shots(monkeypatch):
    client = _make_client(monkeypatch)
    response = client.post(ASSEMBLE_URL, json={"frame_ids": ["shot-1"]})
    assert response.status_code == 200
    assert response.json()["prompt"] == "镜头1：城门布告栏；运镜：Medium Shot"


def test_assemble_rejects_non_consecutive_frames(monkeypatch):
    client = _make_client(monkeypatch)
    response = client.post(ASSEMBLE_URL, json={"frame_ids": ["shot-2", "shot-1"]})
    assert response.status_code == 400
