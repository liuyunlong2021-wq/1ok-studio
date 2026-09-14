"""两个声音 Skill 槽位的契约测试。

背景：声音这块原本有两处系统提示词是**写死在 pipeline 里**的 ——
`generate_audio_plan_script`（图二那枚「生成导演稿」按钮）和
`generate_voice_prompt` → `translate_character_to_voice_prompt`（图三「生成提示词」）。
所以 `.agents/skills` 下的声音导演 / 角色音色 skill 没有地方挂。

这里锁五件事：

1. **两个新阶段真的接上了** —— 绑定后 system prompt 里能看见 skill 内容。
2. **没绑定时逐字等于原来的写死值** —— 接进来不能顺手改了默认行为。
3. **覆盖时不丢硬契约** —— 导演稿喂的是 seed-audio-1.0（输入上限 3000 字符），
   音色提示词喂的是 CosyVoice（voice_prompt 上限 500 字符，超了会被静默截断）。
   skill 写崩了也不能把这些盖掉。
4. **内置默认不重复追加契约** —— 默认里本来就逐条写了，再追加一遍是噪音。
5. **绑定不会漏进音色设计弹窗** —— 那个弹窗不属于任何项目、读不到绑定，而两个
   入口共用 `translate_character_to_voice_prompt`，所以传参必须是显式的。

另外锁住 `prompt_config` 的**部分更新**语义：漏发的字段保持原值，「」才是清空。
以前是拿请求建一个全新的 PromptConfig（全量替换），而字段清单是手工维护的、散在
3 个模态框 + 设置页 + store 的回填里 —— 加一个字段就要同时改五处，漏一处就是静默
丢数据。

跑法：
    python -m pytest tests/test_voice_skill_slots.py
"""
import time

import pytest
from fastapi.testclient import TestClient

from src.apps.comic_gen import api as api_mod
from src.apps.comic_gen.llm import (
    AUDIO_PLAN_OUTPUT_CONTRACT,
    DEFAULT_AUDIO_PLAN_PROMPT,
    DEFAULT_VOICE_PROMPT,
    VOICE_PROMPT_OUTPUT_CONTRACT,
)
from src.apps.comic_gen.models import Character, Script, Series


PROJECT_ID = "p1"
SERIES_ID = "s1"
PACKAGE_ID = "pkg-x"
SKILL_TEXT = "## 绑定的 Skill\n先判断这段是不是动作戏，是就别铺环境声。"


# ---------------------------------------------------------------------------
# 夹具
# ---------------------------------------------------------------------------

def _script() -> Script:
    now = time.time()
    return Script(
        id=PROJECT_ID,
        title="声音槽位",
        original_text="陈默走进雨里，风把伞掀翻了。",
        series_id=SERIES_ID,
        characters=[
            Character(id="char-1", name="陈默", description="男主",
                      voice_id="voice-a", voice_name="低沉男声",
                      voice_description="四十来岁的男中音，语速偏慢，尾音压得住。"),
        ],
        created_at=now,
        updated_at=now,
    )


def _series() -> Series:
    now = time.time()
    return Series(id=SERIES_ID, title="声音槽位系列", created_at=now, updated_at=now)


def _client(monkeypatch, script: Script, series: Series | None = None) -> TestClient:
    """把 pipeline 的读写全挡在内存里，不碰磁盘。

    series 必须是**同一个实例**：系列级 PUT 会先 get_series 读出现存的 prompt_config
    再合并，每次返回新对象的话读到的永远是空的。
    """
    series = series if series is not None else _series()
    monkeypatch.setattr(
        api_mod.pipeline, "get_script",
        lambda script_id: script if script_id == PROJECT_ID else None,
    )
    monkeypatch.setattr(api_mod.pipeline, "get_series", lambda _sid: series)
    monkeypatch.setattr(api_mod.pipeline, "series_store", {SERIES_ID: series})
    monkeypatch.setattr(api_mod.pipeline, "_save_data", lambda: None)
    monkeypatch.setattr(api_mod.pipeline, "_save_series_data_unlocked", lambda: None)
    return TestClient(api_mod.app)


@pytest.fixture
def llm_spy(monkeypatch) -> list:
    """记下每次 chat 的 messages，返回一段假内容，不联网。"""
    from src.apps.comic_gen.llm_adapter import LLMAdapter

    calls: list = []

    def fake_chat(self, messages=None, **kwargs):
        calls.append(messages or [])
        return "模型返回的一段内容。"

    monkeypatch.setattr(LLMAdapter, "chat", fake_chat)
    monkeypatch.setattr(LLMAdapter, "is_configured", property(lambda self: True))
    return calls


def _fake_skill(monkeypatch) -> None:
    """只验接线，所以让 skill 包直接回一段标记文本，不碰真实包存储。"""
    monkeypatch.setattr(
        api_mod.pipeline.skill_packages, "compile",
        lambda package_id: SKILL_TEXT if package_id == PACKAGE_ID else "",
    )
    monkeypatch.setattr(
        api_mod.pipeline.skill_packages, "describe",
        lambda package_id: {"id": package_id, "name": "fake"},
    )


def _bind(script: Script, stage: str) -> None:
    script.prompt_config.skill_bindings[stage] = PACKAGE_ID


def _system_prompt(calls: list) -> str:
    """取第一次 chat 调用里的 system 内容。"""
    assert calls, "没有发生任何 LLM 调用"
    messages = calls[0]
    return next(m["content"] for m in messages if m["role"] == "system")


# ---------------------------------------------------------------------------
# 1. 全集导演声音稿（图二）
# ---------------------------------------------------------------------------

def test_audio_plan_default_is_byte_for_byte_the_old_hardcoded_prompt(monkeypatch, llm_spy):
    """没绑 skill 时，必须跟接进来之前一模一样 —— 不能顺手改了默认行为。"""
    script = _script()
    _client(monkeypatch, script)

    api_mod.pipeline.generate_audio_plan_script(PROJECT_ID)

    system = _system_prompt(llm_spy)
    assert system == DEFAULT_AUDIO_PLAN_PROMPT
    assert "你是影视声音导演" in system


def test_audio_plan_default_does_not_duplicate_the_contract(monkeypatch, llm_spy):
    """默认里已经写了长度和【】标记，不该再追加一遍。"""
    script = _script()
    _client(monkeypatch, script)

    api_mod.pipeline.generate_audio_plan_script(PROJECT_ID)

    assert AUDIO_PLAN_OUTPUT_CONTRACT not in _system_prompt(llm_spy)


def test_audio_plan_uses_the_bound_skill(monkeypatch, llm_spy):
    script = _script()
    _client(monkeypatch, script)
    _fake_skill(monkeypatch)
    _bind(script, "audio_plan")

    api_mod.pipeline.generate_audio_plan_script(PROJECT_ID)

    assert SKILL_TEXT in _system_prompt(llm_spy)


def test_audio_plan_keeps_the_downstream_contract_when_a_skill_overrides_it(monkeypatch, llm_spy):
    """skill 可以换人格，但 3000 字符上限是 seed-audio-1.0 的物理限制，不能被盖掉。"""
    script = _script()
    _client(monkeypatch, script)
    _fake_skill(monkeypatch)
    _bind(script, "audio_plan")

    api_mod.pipeline.generate_audio_plan_script(PROJECT_ID)

    system = _system_prompt(llm_spy)
    assert SKILL_TEXT in system
    assert AUDIO_PLAN_OUTPUT_CONTRACT in system
    assert "3000" in system


# ---------------------------------------------------------------------------
# 2. 角色音色提示词（图三「生成提示词」）
# ---------------------------------------------------------------------------

def test_voice_prompt_default_is_byte_for_byte_the_old_hardcoded_prompt(monkeypatch, llm_spy):
    script = _script()
    _client(monkeypatch, script)

    api_mod.pipeline.generate_voice_prompt(PROJECT_ID, "char-1")

    system = _system_prompt(llm_spy)
    assert system == DEFAULT_VOICE_PROMPT
    assert "你是一个语音设计师" in system


def test_voice_prompt_uses_the_bound_skill(monkeypatch, llm_spy):
    script = _script()
    _client(monkeypatch, script)
    _fake_skill(monkeypatch)
    _bind(script, "voice_prompt")

    api_mod.pipeline.generate_voice_prompt(PROJECT_ID, "char-1")

    assert SKILL_TEXT in _system_prompt(llm_spy)


def test_voice_prompt_keeps_the_500_char_contract_when_a_skill_overrides_it(monkeypatch, llm_spy):
    """CosyVoice 的 voice_prompt 上限 500 字符，超了会被 [:500] 静默截成半句。"""
    script = _script()
    _client(monkeypatch, script)
    _fake_skill(monkeypatch)
    _bind(script, "voice_prompt")

    api_mod.pipeline.generate_voice_prompt(PROJECT_ID, "char-1")

    assert VOICE_PROMPT_OUTPUT_CONTRACT in _system_prompt(llm_spy)


def test_bindings_do_not_leak_into_the_voice_design_dialog(monkeypatch, llm_spy):
    """音色设计弹窗（/voice/design/translate）不属于任何项目，不该继承项目绑定。

    两个入口共用 translate_character_to_voice_prompt，所以这里直接调它、不传
    system_prompt —— 传参一旦写成默认从 pipeline 里读，这个测试就会红。
    """
    script = _script()
    _client(monkeypatch, script)
    _fake_skill(monkeypatch)
    _bind(script, "voice_prompt")

    api_mod.pipeline.translate_character_to_voice_prompt("陈默，四十岁，话少。")

    system = _system_prompt(llm_spy)
    assert system == DEFAULT_VOICE_PROMPT
    assert SKILL_TEXT not in system


# ---------------------------------------------------------------------------
# 3. 两个阶段要被 API 认下来
# ---------------------------------------------------------------------------

def test_both_new_stages_are_accepted_as_skill_bindings(monkeypatch):
    script = _script()
    client = _client(monkeypatch, script)
    _fake_skill(monkeypatch)

    res = client.put(
        f"/projects/{PROJECT_ID}/prompt_config",
        json={"skill_bindings": {"audio_plan": PACKAGE_ID, "voice_prompt": PACKAGE_ID}},
    )

    assert res.status_code == 200, res.text
    assert res.json()["prompt_config"]["skill_bindings"]["audio_plan"] == PACKAGE_ID


def test_unknown_stage_is_still_rejected(monkeypatch):
    script = _script()
    client = _client(monkeypatch, script)
    _fake_skill(monkeypatch)

    res = client.put(
        f"/projects/{PROJECT_ID}/prompt_config",
        json={"skill_bindings": {"no_such_stage": PACKAGE_ID}},
    )

    assert res.status_code == 400


# ---------------------------------------------------------------------------
# 4. prompt_config 是部分更新，不是全量替换
# ---------------------------------------------------------------------------

def test_put_keeps_fields_the_client_did_not_send(monkeypatch):
    """客户端（那三个模态框）都是手工列字段的，漏发一个不能把它抹掉。"""
    script = _script()
    script.prompt_config.audio_plan = "已存的声音导演稿提示词"
    script.prompt_config.prop_prompt = "已存的道具提示词"
    client = _client(monkeypatch, script)

    res = client.put(
        f"/projects/{PROJECT_ID}/prompt_config",
        json={"storyboard_polish": "只改这一个"},
    )

    assert res.status_code == 200, res.text
    saved = res.json()["prompt_config"]
    assert saved["storyboard_polish"] == "只改这一个"
    assert saved["audio_plan"] == "已存的声音导演稿提示词"
    assert saved["prop_prompt"] == "已存的道具提示词"


def test_put_empty_string_still_clears_to_system_default(monkeypatch):
    """显式传 "" 的语义没变 —— 还是「回退到系统默认」。"""
    script = _script()
    script.prompt_config.audio_plan = "已存的声音导演稿提示词"
    client = _client(monkeypatch, script)

    res = client.put(
        f"/projects/{PROJECT_ID}/prompt_config",
        json={"audio_plan": ""},
    )

    assert res.status_code == 200, res.text
    assert res.json()["prompt_config"]["audio_plan"] == ""


def test_series_put_is_also_a_partial_update(monkeypatch):
    script = _script()
    series = _series()
    series.prompt_config.voice_prompt = "已存的音色提示词"
    client = _client(monkeypatch, script, series)

    res = client.put(
        f"/series/{SERIES_ID}/prompt_config",
        json={"audio_plan": "只改这一个"},
    )

    assert res.status_code == 200, res.text
    saved = res.json()["prompt_config"]
    assert saved["audio_plan"] == "只改这一个"
    assert saved["voice_prompt"] == "已存的音色提示词"


def test_skill_bindings_is_replaced_wholesale_not_merged(monkeypatch):
    """`skill_bindings` 是**整张表替换**，不是逐键合并 —— 发半张表会删掉没提到的绑定。

    这是有意的：要是合并，就没法解绑了（发什么都会被旧值填回来）。前端三个模态框
    都是先读全表再整表写回，符合这个约定。

    写这个测试是因为我自己手搓 curl 调试时踩了：只想加一个 audio_plan，结果把整个
    项目原有的四条绑定全抹了。别的字段都是「漏发 = 保持」，偏偏这张表是反的，所以
    钉在这里。
    """
    script = _script()
    client = _client(monkeypatch, script)
    _fake_skill(monkeypatch)

    client.put(
        f"/projects/{PROJECT_ID}/prompt_config",
        json={"skill_bindings": {"character_prompt": PACKAGE_ID,
                                 "r2v_polish": PACKAGE_ID}},
    )

    res = client.put(
        f"/projects/{PROJECT_ID}/prompt_config",
        json={"skill_bindings": {"audio_plan": PACKAGE_ID}},
    )

    saved = res.json()["prompt_config"]["skill_bindings"]
    assert saved == {"audio_plan": PACKAGE_ID}, "没提到的绑定应当被这条整表写掉"
