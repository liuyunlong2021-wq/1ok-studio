"""「声音」步骤（一期）的契约测试。

这一步的产出**纯粹给人听**：不参与任何自动决策，分镜怎么切仍由人判断，整块可跳过。
所以这里只锁三件事：

1. **向后兼容** —— 老 project 的 JSON 里没有 audio_plan，反序列化照常，值为 None。
2. **参考音按合同传** —— seed-audio-1.0 的 `metadata.references` 是 1–3 项，
   **不能是空数组**，所以「不带参考音」时必须整个 metadata 字段都不出现。
3. **每次生成追加一个版本** —— 绑定参考音就多生成几版对比着听；导演稿改动后
   已有版本靠 script_hash 标「已过期」，但不删除、不拦截。

未实现的用例标了 ``xfail(strict=True)``：套件现在仍是全绿，实现落地时 strict 会让
它们反过来失败、要求把标记摘掉 —— 这就是 TDD 的红绿灯。

跑法：
    python -m pytest tests/test_audio_plan.py
"""
import time

import pytest
from fastapi.testclient import TestClient

from src.apps.comic_gen import api as api_mod
from src.apps.comic_gen.models import Character, Script, StoryboardFrame


PROJECT_ID = "test-project"
PLAN_URL = f"/projects/{PROJECT_ID}/audio-plan"


# ---------------------------------------------------------------------------
# 夹具
# ---------------------------------------------------------------------------

def _script() -> Script:
    now = time.time()
    return Script(
        id=PROJECT_ID,
        title="声音测试",
        original_text="demo",
        characters=[
            Character(id="char-1", name="小满", description="女主",
                      voice_id="voice-a", voice_name="清澈女声"),
            Character(id="char-2", name="陈默", description="男主",
                      voice_id="voice-b", voice_name="低沉男声"),
            Character(id="char-3", name="老师", description="配角"),
            Character(id="char-4", name="路人", description="配角"),
        ],
        frames=[StoryboardFrame(id="shot-1", scene_id="scene-1")],
        created_at=now,
        updated_at=now,
    )


def _client(monkeypatch, script: Script) -> TestClient:
    """把 pipeline 的读写全部挡在内存里，不碰磁盘。"""
    monkeypatch.setattr(
        api_mod.pipeline, "get_script",
        lambda script_id: script if script_id == PROJECT_ID else None,
    )
    monkeypatch.setattr(api_mod.pipeline, "get_series", lambda _sid: None)
    monkeypatch.setattr(api_mod.pipeline, "_save_data", lambda: None)
    return TestClient(api_mod.app)


@pytest.fixture
def audio_spy(monkeypatch):
    """替掉适配器的 generate_audio，记录调用参数，不联网。"""
    calls = []

    def fake_generate_audio(prompt, output_path, model_name=None,
                            reference_audio_urls=(), response_format="mp3"):
        calls.append({
            "prompt": prompt,
            "output_path": output_path,
            "reference_audio_urls": list(reference_audio_urls),
        })
        import os
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        with open(output_path, "wb") as handle:
            handle.write(b"fake-mp3")
        return output_path

    monkeypatch.setattr("src.models.jiucaihezi.generate_audio", fake_generate_audio)
    return calls


# ---------------------------------------------------------------------------
# 1. 数据模型 / 向后兼容
# ---------------------------------------------------------------------------

@pytest.mark.xfail(strict=True, reason="一期未实现：Script.audio_plan 字段")
def test_project_without_audio_plan_still_loads():
    """老 project 没有 audio_plan 字段 —— 读了不能炸，值为 None。"""
    script = Script.model_validate({
        "id": "legacy",
        "title": "老项目",
        "original_text": "x",
        "created_at": time.time(),
        "updated_at": time.time(),
    })

    assert script.audio_plan is None


@pytest.mark.xfail(strict=True, reason="一期未实现：AudioTake / EpisodeAudioPlan")
def test_audio_plan_holds_director_script_and_takes():
    from src.apps.comic_gen.models import AudioTake, EpisodeAudioPlan

    take = AudioTake(
        id="take-1",
        audio_url="output/audio/episode_test.mp3",
        duration_ms=42000,
        reference_character_ids=["char-1", "char-2"],
        created_at=time.time(),
    )
    plan = EpisodeAudioPlan(
        script_text="【全局声音导演稿】…",
        script_hash="abc",
        takes=[take],
        selected_take_id="take-1",
    )

    assert plan.takes[0].duration_ms == 42000
    assert plan.takes[0].reference_character_ids == ["char-1", "char-2"]
    assert plan.selected_take_id == "take-1"
    # 默认值：整块可选，空计划是合法状态。
    empty = EpisodeAudioPlan()
    assert empty.takes == []
    assert empty.script_text is None


# ---------------------------------------------------------------------------
# 2. 生成导演稿
# ---------------------------------------------------------------------------

@pytest.mark.xfail(strict=True, reason="一期未实现：/audio-plan/generate-script")
def test_generate_script_saves_director_script_and_hash(monkeypatch):
    script = _script()
    client = _client(monkeypatch, script)
    monkeypatch.setattr(
        api_mod.pipeline, "generate_audio_plan_script",
        lambda script_id: "【全局声音导演稿】小满：……",
    )

    response = client.post(f"{PLAN_URL}/generate-script", json={})

    assert response.status_code == 200, response.text
    plan = response.json()["audio_plan"]
    assert plan["script_text"].startswith("【全局声音导演稿】")
    assert plan["script_hash"], "要记 hash，改了导演稿才能标音频过期"
    assert plan["takes"] == []


# ---------------------------------------------------------------------------
# 3. 生成全集声音 —— 参考音按合同传
# ---------------------------------------------------------------------------

@pytest.mark.xfail(strict=True, reason="一期未实现：/audio-plan/generate-audio")
def test_generate_audio_without_references_sends_no_metadata(monkeypatch, audio_spy):
    """不带参考音：纯文生音频。合同规定 references 是 1–3 项，空数组是非法的，
    所以整个 metadata 字段都不能出现。"""
    script = _script()
    client = _client(monkeypatch, script)
    script.audio_plan = _plan_with_script()

    response = client.post(f"{PLAN_URL}/generate-audio", json={"character_ids": []})

    assert response.status_code == 200, response.text
    assert len(audio_spy) == 1
    assert audio_spy[0]["reference_audio_urls"] == []
    assert audio_spy[0]["prompt"].startswith("【全局声音导演稿】")


@pytest.mark.xfail(strict=True, reason="一期未实现：/audio-plan/generate-audio")
def test_generate_audio_resolves_character_reference_audio(monkeypatch, audio_spy):
    """勾了角色 → 取这些角色绑定音色的参考音频（本地相对路径，生成时才转存，
    避开网关临时素材 15 分钟失效）。"""
    script = _script()
    client = _client(monkeypatch, script)
    script.audio_plan = _plan_with_script()
    monkeypatch.setattr(
        api_mod.pipeline, "resolve_character_reference_audios",
        lambda script_id, character_ids: ["uploads/voice-a.wav", "uploads/voice-b.wav"],
    )

    response = client.post(
        f"{PLAN_URL}/generate-audio", json={"character_ids": ["char-1", "char-2"]}
    )

    assert response.status_code == 200, response.text
    assert audio_spy[0]["reference_audio_urls"] == [
        "uploads/voice-a.wav", "uploads/voice-b.wav"
    ]


@pytest.mark.xfail(strict=True, reason="一期未实现：参考音上限校验")
def test_generate_audio_rejects_more_than_three_references(monkeypatch, audio_spy):
    """合同：最多 3 段。超了要报清楚，不能悄悄截断 —— 用户勾了 4 个却只生效 3 个
    会让人以为音色没生效。"""
    script = _script()
    client = _client(monkeypatch, script)
    script.audio_plan = _plan_with_script()

    response = client.post(
        f"{PLAN_URL}/generate-audio",
        json={"character_ids": ["char-1", "char-2", "char-3", "char-4"]},
    )

    assert response.status_code == 400, response.text
    assert audio_spy == [], "校验不通过就不该发起生成"


@pytest.mark.xfail(strict=True, reason="一期未实现：没有导演稿不能生成音频")
def test_generate_audio_requires_a_director_script(monkeypatch, audio_spy):
    from src.apps.comic_gen.models import EpisodeAudioPlan

    script = _script()
    client = _client(monkeypatch, script)
    script.audio_plan = EpisodeAudioPlan()  # 还没有导演稿

    response = client.post(f"{PLAN_URL}/generate-audio", json={"character_ids": []})

    assert response.status_code == 400, response.text
    assert audio_spy == []


@pytest.mark.xfail(strict=True, reason="一期未实现：每次生成追加一个版本")
def test_generate_audio_appends_a_take_and_selects_it(monkeypatch, audio_spy):
    """「绑定参考音了就多生成几段」—— 每次生成追加一个版本，并设为当前选中。"""
    script = _script()
    client = _client(monkeypatch, script)
    script.audio_plan = _plan_with_script()

    first = client.post(f"{PLAN_URL}/generate-audio", json={"character_ids": []})
    second = client.post(f"{PLAN_URL}/generate-audio", json={"character_ids": ["char-1"]})

    assert first.status_code == second.status_code == 200
    plan = second.json()["audio_plan"]
    assert len(plan["takes"]) == 2, "两版都要留着，方便对比着听"
    take_ids = [t["id"] for t in plan["takes"]]
    assert len(set(take_ids)) == 2, "版本 id 要唯一"
    assert plan["selected_take_id"] == take_ids[-1], "新生成的那版自动选中"
    assert plan["takes"][0]["audio_url"].endswith(".mp3")


# ---------------------------------------------------------------------------
# 4. 保存 / 编辑 / 选版本
# ---------------------------------------------------------------------------

@pytest.mark.xfail(strict=True, reason="一期未实现：PATCH /audio-plan")
def test_patch_script_text_updates_hash_but_keeps_takes(monkeypatch, audio_spy):
    """改了导演稿：hash 变、已有版本留着（前端据此标「已过期」），不删不拦。"""
    script = _script()
    client = _client(monkeypatch, script)
    script.audio_plan = _plan_with_script()

    client.post(f"{PLAN_URL}/generate-audio", json={"character_ids": []})
    before = script.audio_plan.takes[0].id
    original_hash = script.audio_plan.script_hash

    response = client.patch(f"{PLAN_URL}", json={"script_text": "【改过的导演稿】…"})

    assert response.status_code == 200, response.text
    plan = response.json()["audio_plan"]
    assert plan["script_text"] == "【改过的导演稿】…"
    assert plan["script_hash"] != original_hash
    assert [t["id"] for t in plan["takes"]] == [before], "旧版本不能因为改稿就消失"


# ---------------------------------------------------------------------------
# 辅助
# ---------------------------------------------------------------------------

def _plan_with_script():
    from src.apps.comic_gen.models import EpisodeAudioPlan

    return EpisodeAudioPlan(script_text="【全局声音导演稿】小满：……", script_hash="h1")
