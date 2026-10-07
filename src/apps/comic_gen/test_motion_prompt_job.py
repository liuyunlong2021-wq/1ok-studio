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
from src.apps.comic_gen.models import Script, Segment, StoryboardFrame

PROJECT_ID = "test-project"
PROMPT_URL = f"/projects/{PROJECT_ID}/motion/generate_prompt"


def _make_client(monkeypatch, segments=None) -> TestClient:
    script = Script(
        id=PROJECT_ID,
        title="test",
        original_text="test",
        frames=[
            StoryboardFrame(id="shot-1", scene_id="scene-1", visual_description="城门布告栏", duration=5),
            StoryboardFrame(id="shot-2", scene_id="scene-1", visual_description="围观百姓", duration=5),
        ],
        segments=list(segments or []),
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
    # 本地拼装现在的格式：先「画幅 + 输出总时长」头，再参考图，再镜头块
    # （每镜一行，固定的字段顺序；时长是所选镜头相加）。
    assert response.json()["prompt"] == (
        "画幅：16:9；输出总时长：10秒（所选镜头时长相加）。从00:00按每镜时长连续累计，原文时间码仅供定位。\n"
        "\n"
        "参考图1：城门布告栏（场景）\n"
        "参考图2：刘邦（角色）\n"
        "\n"
        "所有镜头严格沿用对应参考图，身份、服装、材质、比例和关键特征保持锁定。\n"
        "\n"
        "镜头1：机位：Medium Shot；时长：5秒；城门布告栏\n"
        "镜头2：机位：Medium Shot；时长：5秒；围观百姓"
    )


def test_assemble_without_references_only_lists_shots(monkeypatch):
    client = _make_client(monkeypatch)
    response = client.post(ASSEMBLE_URL, json={"frame_ids": ["shot-1"]})
    assert response.status_code == 200
    assert response.json()["prompt"] == (
        "画幅：16:9；输出总时长：5秒（所选镜头时长相加）。从00:00按每镜时长连续累计，原文时间码仅供定位。\n"
        "\n"
        "镜头1：机位：Medium Shot；时长：5秒；城门布告栏"
    )


def test_assemble_rejects_non_consecutive_frames(monkeypatch):
    client = _make_client(monkeypatch)
    response = client.post(ASSEMBLE_URL, json={"frame_ids": ["shot-2", "shot-1"]})
    assert response.status_code == 400


# ─── 段间衔接：起点继承（段 N 继承段 N-1 的接续句） ──────────────────────────

def _segment(index: int, frame_ids: list, exit_state: str = "") -> Segment:
    return Segment(index=index, frame_ids=frame_ids, duration=5, exit_state=exit_state)


def _assemble(client: TestClient, frame_ids: list) -> str:
    response = client.post(ASSEMBLE_URL, json={
        "frame_ids": frame_ids,
        "references": [{"name": "城门布告栏", "asset_type": "场景"}],
    })
    assert response.status_code == 200, response.text
    return response.json()["prompt"]


def test_second_segment_inherits_the_previous_segment_state(monkeypatch):
    client = _make_client(monkeypatch, segments=[
        _segment(1, ["shot-1"], "角色A 在画面左侧中景、面朝画面右侧"),
        _segment(2, ["shot-2"]),
    ])
    prompt = _assemble(client, ["shot-2"])
    assert "起点继承（上一段结束时的状态）：角色A 在画面左侧中景、面朝画面右侧" in prompt
    assert api_mod.MOTION_PROMPT_CONTINUITY_LOCK in prompt
    # 位置契约：在「一致性锁」之后、「镜头」之前 —— 先锁资产，再交代从哪接，再逐镜内容。
    assert prompt.index(api_mod.MOTION_PROMPT_REFERENCE_LOCK) < prompt.index("起点继承")
    assert prompt.index("起点继承") < prompt.index("镜头1：")


def test_first_segment_does_not_inherit_itself(monkeypatch):
    client = _make_client(monkeypatch, segments=[
        _segment(1, ["shot-1"], "不该被自己继承"),
        _segment(2, ["shot-2"]),
    ])
    prompt = _assemble(client, ["shot-1"])
    assert "起点继承" not in prompt
    assert "不该被自己继承" not in prompt


def test_empty_exit_state_adds_no_block(monkeypatch):
    client = _make_client(monkeypatch, segments=[
        _segment(1, ["shot-1"], ""),
        _segment(2, ["shot-2"]),
    ])
    assert "起点继承" not in _assemble(client, ["shot-2"])


def test_project_without_segments_is_unaffected(monkeypatch):
    prompt = _assemble(_make_client(monkeypatch), ["shot-2"])
    assert "起点继承" not in prompt


def test_llm_path_also_receives_the_continuity_block(monkeypatch):
    """LLM 那条路（生成 Skill 提示词）也要看到接续句，否则它会把上一段当全新场景写。"""
    client = _make_client(monkeypatch, segments=[
        _segment(1, ["shot-1"], "角色A 在画面左侧中景"),
        _segment(2, ["shot-2"]),
    ])
    seen = []

    def fake_chat(self, messages, model=None, response_format=None):
        seen.append(messages)
        return "镜头1：围观百姓"

    monkeypatch.setattr(LLMAdapter, "chat", fake_chat)
    # 只提交第二段的镜头，这样「上一段」才存在。
    job = client.post(PROMPT_URL, json={
        "frame_ids": ["shot-2"],
        "references": [{"name": "城门布告栏", "asset_type": "场景"}],
    }).json()
    _poll(client, job["job_id"])

    user_message = seen[0][1]["content"]
    assert "[起点继承]" in user_message
    assert "角色A 在画面左侧中景" in user_message
