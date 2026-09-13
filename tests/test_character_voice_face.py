"""角色工作台「声音面」的契约测试。

工作台被拆成两个镜像的面：**左=素材、中=人的描述、右=给模型的提示词**。
生图面早就有这一整套（主参考图 / 描述 / 生图提示词），声音面照抄一份：

    主参考音  ↔  主参考图        reference_audio_url
    声音描述  ↔  描述            voice_description (+ source / version)
    音色提示词 ↔  生图提示词      voice_prompt (+ source / model / 描述版本)

锁四件事：

1. **向后兼容** —— 老 project 的 JSON 里没有这些字段，反序列化照常。
2. **两级是有版本的** —— 改「声音描述」必须让右列的「音色提示词」变成过期
   （`voice_prompt_description_version < voice_description_version`），跟生图面
   的 v1/v2 语义一致；不能悄悄沿用旧提示词。
3. **参考音要有实物** —— 参考音必须落成一个仓库内相对路径的真实文件。设计音色
   天生没有源音频，所以「用当前音色念一句」是拿到参考音的唯一途径。
4. **参考音优先级** —— 角色自己的参考音 > 系列里那个音色共用的克隆源。

跑法：
    python -m pytest tests/test_character_voice_face.py
"""
import time

import pytest
from fastapi.testclient import TestClient

from src.apps.comic_gen import api as api_mod
from src.apps.comic_gen.models import Character, CustomVoice, Script, Series


PROJECT_ID = "test-project"
SERIES_ID = "test-series"
CHAR_ID = "char-1"
BASE = f"/projects/{PROJECT_ID}/characters/{CHAR_ID}"


# ---------------------------------------------------------------------------
# 夹具
# ---------------------------------------------------------------------------

def _script() -> Script:
    now = time.time()
    return Script(
        id=PROJECT_ID,
        title="声音面测试",
        original_text="demo",
        series_id=SERIES_ID,
        characters=[
            # 绑了设计音色（没有源音频）—— 参考音只能靠「生成」
            Character(id="char-1", name="中年卖草鞋人", description="四十来岁，草鞋摊主",
                      voice_id="voice-c", voice_name="温和中年男"),
            # 完全没绑音色
            Character(id="char-2", name="刘备", description="汉室后裔"),
        ],
        created_at=now,
        updated_at=now,
    )


def _series() -> Series:
    now = time.time()
    return Series(
        id=SERIES_ID,
        title="声音面测试系列",
        created_at=now,
        updated_at=now,
        custom_voices=[
            CustomVoice(id="voice-c", label="温和中年男", origin="design",
                        voice_prompt="温和的中年男声，语速偏慢"),
            CustomVoice(id="voice-d", label="克隆男声", origin="clone",
                        source_audio_url="uploads/voice-d.wav"),
        ],
    )


def _client(monkeypatch, script: Script) -> TestClient:
    monkeypatch.setattr(
        api_mod.pipeline, "get_script",
        lambda script_id: script if script_id == PROJECT_ID else None,
    )
    monkeypatch.setattr(api_mod.pipeline, "get_series", lambda _sid: _series())
    monkeypatch.setattr(api_mod.pipeline, "series_store", {SERIES_ID: _series()})
    monkeypatch.setattr(api_mod.pipeline, "_save_data", lambda: None)
    return TestClient(api_mod.app)


@pytest.fixture
def llm_spy(monkeypatch):
    """把 LLM 换成可控的假模型，不联网。"""
    from src.apps.comic_gen.llm_adapter import LLMAdapter

    calls = []

    def fake_chat(self, messages, **kwargs):
        calls.append(messages)
        return "沙哑的中年男声，语速偏慢，尾音略沉。"

    monkeypatch.setattr(LLMAdapter, "is_configured", property(lambda self: True))
    monkeypatch.setattr(LLMAdapter, "chat", fake_chat)
    return calls


@pytest.fixture
def tts_spy(monkeypatch):
    """替掉 TTS，记录用的是哪个音色，并真的落一个文件（参考音必须是实物）。"""
    import os

    calls = []

    class FakeTTS:
        def synthesize(self, text, output_path, voice=None, speech_rate=1.0,
                       pitch_rate=1.0, volume=50, instructions=None,
                       model_override=None, family_override=None):
            calls.append({
                "text": text,
                "output_path": output_path,
                "voice": voice,
                "model_override": model_override,
            })
            os.makedirs(os.path.dirname(output_path), exist_ok=True)
            with open(output_path, "wb") as handle:
                handle.write(b"fake-mp3")
            return (output_path, 1.4, "audio/mpeg")

    monkeypatch.setattr(api_mod.pipeline.audio_generator, "tts", FakeTTS())
    return calls


def _character(script: Script, char_id: str = CHAR_ID) -> Character:
    return next(c for c in script.characters if c.id == char_id)


# ---------------------------------------------------------------------------
# 1. 数据模型 / 向后兼容
# ---------------------------------------------------------------------------

def test_legacy_character_without_voice_face_fields_still_loads():
    """老 project 的角色对象没有这些字段 —— 读了不能炸。"""
    char = Character.model_validate({"id": "c1", "name": "老角色", "description": "旧数据"})

    assert char.reference_audio_url is None
    assert char.voice_description is None
    assert char.voice_prompt is None
    assert char.voice_description_version == 0
    assert char.voice_prompt_description_version == 0


def test_voice_face_mirrors_the_image_face_shape():
    """两侧「描述」那一层字段一一对应，名字也要对得上（读代码的人不用猜）。

    注意生图侧的提示词字段是分视图的（full_body_prompt / three_view_prompt /
    headshot_prompt，因为一个角色有三张图），声音只有一个「视图」，所以只有一个
    voice_prompt —— 这是刻意的，不是漏了。
    """
    for field in ("description", "description_source", "description_version",
                  "full_body_prompt", "full_body_image_url"):
        assert field in Character.model_fields, f"生图侧 {field} 不该动"
    for field in ("voice_description", "voice_description_source", "voice_description_version",
                  "voice_prompt", "reference_audio_url"):
        assert field in Character.model_fields, f"声音侧 {field} 缺了"


def test_voice_face_deliberately_has_no_async_prompt_queue():
    """生图侧的「生成提示词」是异步任务 + 轮询；声音侧刻意走同步。

    一次 LLM 调用两三秒就回来了，为此镜像一整套队列 / 状态机 / 轮询不划算
    （用户拍板：1A 两级 · 同步 · 分段控件）。这条测试是防止有人「顺手补齐对称性」
    把队列字段加回来 —— 那些字段没人消费，只会变成永远 stale 的死状态。
    """
    for field in ("prompt_generation_status", "prompt_generation_task_id",
                  "prompt_generation_error", "prompt_generation_started_at"):
        assert field in Character.model_fields, "生图侧的任务字段不该动"
    for field in ("voice_prompt_generation_status", "voice_prompt_generation_task_id",
                  "voice_prompt_generation_error"):
        assert field not in Character.model_fields, \
            "声音侧同步生成，不要加异步队列字段"


# ---------------------------------------------------------------------------
# 2. 中列：声音描述
# ---------------------------------------------------------------------------

def test_generate_voice_description_writes_text_and_bumps_version(monkeypatch, llm_spy):
    script = _script()
    client = _client(monkeypatch, script)

    response = client.post(f"{BASE}/voice-description", json={})

    assert response.status_code == 200, response.text
    char = _character(script)
    assert char.voice_description == "沙哑的中年男声，语速偏慢，尾音略沉。"
    assert char.voice_description_source == "ai"
    assert char.voice_description_version == 1, "每生成一次就该进一版"


def test_generate_voice_description_rejects_an_empty_model_reply(monkeypatch):
    """模型返回空不能被当成合法结果存下来 —— 否则右列拿空描述去生成提示词。"""
    from src.apps.comic_gen.llm_adapter import LLMAdapter

    script = _script()
    client = _client(monkeypatch, script)
    monkeypatch.setattr(LLMAdapter, "is_configured", property(lambda self: True))
    monkeypatch.setattr(LLMAdapter, "chat", lambda self, messages, **kwargs: "   ")

    response = client.post(f"{BASE}/voice-description", json={})

    assert response.status_code == 500
    assert "空" in response.json()["detail"]
    assert _character(script).voice_description is None


# ---------------------------------------------------------------------------
# 3. 右列：音色提示词（两级 + 版本）
# ---------------------------------------------------------------------------

def test_generate_voice_prompt_requires_a_description_first(monkeypatch, llm_spy):
    script = _script()
    client = _client(monkeypatch, script)

    response = client.post(f"{BASE}/voice-prompt", json={})

    assert response.status_code == 400
    assert "声音描述" in response.json()["detail"], "要说清先做什么，不能只报 400"


def test_generate_voice_prompt_records_which_description_version_it_used(monkeypatch, llm_spy):
    script = _script()
    client = _client(monkeypatch, script)

    client.post(f"{BASE}/voice-description", json={})
    response = client.post(f"{BASE}/voice-prompt", json={})

    assert response.status_code == 200, response.text
    char = _character(script)
    assert char.voice_prompt, "要落到角色身上"
    assert char.voice_prompt_source == "ai"
    assert char.voice_prompt_description_version == char.voice_description_version


def test_editing_the_description_makes_the_prompt_stale(monkeypatch, llm_spy):
    """改中列 → 右列必须变成过期。这是生图面 description_version 的同款语义。"""
    script = _script()
    client = _client(monkeypatch, script)

    client.post(f"{BASE}/voice-description", json={})
    client.post(f"{BASE}/voice-prompt", json={})
    char = _character(script)
    fresh_version = char.voice_prompt_description_version

    # 手改声音描述
    response = client.patch(f"{BASE}/voice-fields",
                            json={"voice_description": "换成清亮的少年音"})

    assert response.status_code == 200, response.text
    char = _character(script)
    assert char.voice_description == "换成清亮的少年音"
    assert char.voice_description_source == "manual"
    assert char.voice_description_version == fresh_version + 1, "手改也要进版本"
    assert char.voice_prompt_description_version < char.voice_description_version, \
        "旧提示词必须显成过期，不能假装还新鲜"


def test_patching_only_the_prompt_does_not_bump_the_description_version(monkeypatch, llm_spy):
    script = _script()
    client = _client(monkeypatch, script)
    client.post(f"{BASE}/voice-description", json={})
    before = _character(script).voice_description_version

    response = client.patch(f"{BASE}/voice-fields", json={"voice_prompt": "手写的音色提示词"})

    assert response.status_code == 200
    char = _character(script)
    assert char.voice_prompt == "手写的音色提示词"
    assert char.voice_description_version == before, "只改右列不该动中列的版本"
    assert char.voice_prompt_description_version == before, "手写的提示词对当前描述是新鲜的"


# ---------------------------------------------------------------------------
# 4. 左列：主参考音
# ---------------------------------------------------------------------------

def test_reference_audio_is_generated_with_the_bound_voice(monkeypatch, tts_spy):
    """设计音色没有源音频 —— 「念一句」就是拿到参考音的唯一途径。"""
    script = _script()
    client = _client(monkeypatch, script)

    response = client.post(f"{BASE}/reference-audio", json={})

    assert response.status_code == 200, response.text
    char = _character(script)
    assert char.reference_audio_url, "要写到角色身上"
    assert char.reference_audio_url.startswith("uploads/"), \
        "要存仓库内相对路径 —— 网关临时素材 15 分钟就失效"
    assert char.reference_audio_url.endswith(".mp3")

    assert len(tts_spy) == 1
    assert tts_spy[0]["voice"] == "voice-c", "要用这个角色绑的音色"
    assert tts_spy[0]["model_override"] == "cosyvoice-v3.5-plus", \
        "设计音色不在静态音色表里，得带上它自己的 target_model"
    assert "中年卖草鞋人" in tts_spy[0]["text"], "默认台词要带上角色名，方便听出是谁"


def test_reference_audio_text_can_be_supplied(monkeypatch, tts_spy):
    script = _script()
    client = _client(monkeypatch, script)

    response = client.post(f"{BASE}/reference-audio", json={"text": "这批货再卖不动就回涿县了。"})

    assert response.status_code == 200
    assert tts_spy[0]["text"] == "这批货再卖不动就回涿县了。"


def test_reference_audio_requires_a_bound_voice(monkeypatch, tts_spy):
    script = _script()
    client = _client(monkeypatch, script)

    response = client.post(f"/projects/{PROJECT_ID}/characters/char-2/reference-audio", json={})

    assert response.status_code == 400
    assert "音色" in response.json()["detail"], "要说清是先选音色，而不是含糊报错"
    assert not tts_spy, "没音色就别去调 TTS"


def test_reference_audio_can_be_an_uploaded_file(monkeypatch):
    """上传的参考音走现成的 POST /upload 拿路径，再由 PATCH 指过来。

    克隆音色本来就没有源音频、也不想让模型念 —— 这时候上传一段真人录音才是对的。
    """
    script = _script()
    client = _client(monkeypatch, script)

    response = client.patch(f"{BASE}/voice-fields",
                            json={"reference_audio_url": "uploads/abc123.wav"})

    assert response.status_code == 200, response.text
    assert _character(script).reference_audio_url == "uploads/abc123.wav"

    # 上传完就该能当参考音用了
    assert api_mod.pipeline.resolve_character_reference_audios(PROJECT_ID, [CHAR_ID]) == \
        ["uploads/abc123.wav"]


def test_reference_audio_rejects_a_non_audio_upload(monkeypatch):
    """传成 jpg 要在这一步就说清楚 —— 否则要到真正生成音频时才炸在网关上。"""
    script = _script()
    client = _client(monkeypatch, script)

    response = client.patch(f"{BASE}/voice-fields",
                            json={"reference_audio_url": "uploads/portrait.jpg"})

    assert response.status_code == 400
    assert "音频文件" in response.json()["detail"]
    assert _character(script).reference_audio_url is None, "不能把错的路径存下来"


def test_reference_audio_accepts_a_remote_url_without_an_extension(monkeypatch):
    """OSS 链接后面可能挂 query、也可能没有扩展名 —— 认不出来不等于错，要放行。"""
    script = _script()
    client = _client(monkeypatch, script)

    response = client.patch(
        f"{BASE}/voice-fields",
        json={"reference_audio_url": "https://cdn.example.com/voice/ref-1?sign=xyz"},
    )

    assert response.status_code == 200, response.text
    assert _character(script).reference_audio_url == "https://cdn.example.com/voice/ref-1?sign=xyz"


def test_changing_the_reference_audio_does_not_bump_the_description_version(monkeypatch):
    script = _script()
    client = _client(monkeypatch, script)
    client.post(f"{BASE}/voice-description", json={}, )
    before = _character(script).voice_description_version

    client.patch(f"{BASE}/voice-fields", json={"reference_audio_url": "uploads/abc123.mp3"})

    assert _character(script).voice_description_version == before, "换素材不该动中列的版本"


# ---------------------------------------------------------------------------
# 5. 参考音优先级（喂给「声音」步骤的那条链）
# ---------------------------------------------------------------------------

def test_character_reference_audio_wins_over_the_shared_voice_source(monkeypatch):
    """角色自己的参考音优先；没有才回落到系列里那个音色的克隆源。"""
    script = _script()
    _client(monkeypatch, script)

    # 没生成过 → 回落：char-1 绑的是设计音色，没有源音频 → 该角色报缺参考音
    with pytest.raises(ValueError, match="参考音"):
        api_mod.pipeline.resolve_character_reference_audios(PROJECT_ID, [CHAR_ID])

    _character(script).reference_audio_url = "uploads/reference_audio/char-1.mp3"
    resolved = api_mod.pipeline.resolve_character_reference_audios(PROJECT_ID, [CHAR_ID])
    assert resolved == ["uploads/reference_audio/char-1.mp3"]

    # 克隆音色仍走老路
    script.characters.append(
        Character(id="char-3", name="旁白", description="",
                  voice_id="voice-d", voice_name="克隆男声"))
    assert api_mod.pipeline.resolve_character_reference_audios(PROJECT_ID, ["char-3"]) == \
        ["uploads/voice-d.wav"]
