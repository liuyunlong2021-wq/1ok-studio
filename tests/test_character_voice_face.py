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
from src.apps.comic_gen.models import Character, Script, Series


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
            # 声音面的入口是「生成提示词 → 生成参考音」，所以参考音那一节的
            # 夹具先备一个提示词：没提示词就不该去调声音模型（见 4 节那条）。
            Character(id="char-1", name="中年卖草鞋人", description="四十来岁，草鞋摊主",
                      voice_prompt="四十来岁的中男声，语速偏慢，尾音压得住。"),
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
    )


def _client(monkeypatch, script: Script, series: Series = None) -> TestClient:
    series = series or _series()
    monkeypatch.setattr(
        api_mod.pipeline, "get_script",
        lambda script_id: script if script_id == PROJECT_ID else None,
    )
    monkeypatch.setattr(api_mod.pipeline, "get_series", lambda _sid: series)
    monkeypatch.setattr(api_mod.pipeline, "series_store", {SERIES_ID: series})
    monkeypatch.setattr(api_mod.pipeline, "_save_data", lambda: None)
    monkeypatch.setattr(api_mod.pipeline, "_save_series_data", lambda: None)
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
def audio_model_spy(monkeypatch):
    """替掉产品唯一的音频模型（韭菜盒子 `seed-audio-1.0`），记录提示词并落一个真文件。

    左列「生成参考音」走的是 `src/models/jiucaihezi.generate_audio`（`POST /v1/audio/speech`）
    —— 跟创作台、跟「声音」步骤是同一条路，不再是 DashScope 的音色设计。
    """
    import os

    calls = []

    def fake_generate_audio(prompt, output_path, model_name=None,
                            reference_audio_urls=(), response_format="mp3"):
        calls.append({"prompt": prompt, "reference_audio_urls": list(reference_audio_urls)})
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        with open(output_path, "wb") as handle:
            handle.write(b"fake-mp3")
        return output_path

    monkeypatch.setattr("src.models.jiucaihezi.generate_audio", fake_generate_audio)
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


def test_generate_voice_description_rejects_an_empty_model_reply(monkeypatch, llm_spy):
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

def test_generate_voice_prompt_works_without_a_description(monkeypatch, llm_spy):
    """中列可以为空 —— 去掉「AI 提取」之后，产品的入口就是直接点右列的「生成提示词」
    （用户 2026-09-17 拍板）。以前这里报 400 「还没有声音描述」。"""
    script = _script()
    _character(script).voice_description = None
    client = _client(monkeypatch, script)

    response = client.post(f"{BASE}/voice-prompt", json={})

    assert response.status_code == 200, response.text
    assert _character(script).voice_prompt


def test_generate_voice_prompt_feeds_the_script_lines_to_the_model(monkeypatch, llm_spy):
    """右列要拿「本集剧本里这个角色的台词」当配音内容 —— 参考音才是这个角色在剧里说话。"""
    from src.apps.comic_gen.models import StoryboardFrame

    script = _script()
    script.original_text = "刘备（拱手）：在下刘备，中山靖王之后。\n小兵：什么人！"
    script.frames = [
        StoryboardFrame(id="f1", scene_id="s1", character_ids=["char-2"],
                        dialogue="在下刘备，中山靖王之后。"),
        StoryboardFrame(id="f2", scene_id="s1", character_ids=["char-1"],
                        dialogue="这批草鞋再卖不动就回涿县了。"),
    ]
    client = _client(monkeypatch, script)

    client.post(f"{BASE}/voice-prompt", json={})

    user = next(m["content"] for m in llm_spy[-1] if m["role"] == "user")
    assert "这批草鞋再卖不动就回涿县了。" in user, "该角色的台词要喂进去"
    assert "在下刘备，中山靖王之后。" not in user, "别人的台词不该混进来"


def test_generate_voice_prompt_splits_the_two_sections(monkeypatch, llm_spy):
    """两段式成品：九维那段拆回中列（那是喂 create_voice 的一层），成品落右列。"""
    from src.apps.comic_gen.llm_adapter import LLMAdapter

    script = _script()
    client = _client(monkeypatch, script)
    monkeypatch.setattr(
        LLMAdapter, "chat",
        lambda self, messages, **kwargs: (
            "### 九维声音档案\n"
            "年龄感：二十出头。音高：偏低的男声。共鸣：胸腔为主。\n\n"
            "### 可直接使用的提示词\n"
            "略低的年轻男声，胸腔共鸣足。配音内容：“在下刘备。”"
        ),
    )

    response = client.post(f"{BASE}/voice-prompt", json={})

    assert response.status_code == 200, response.text
    char = _character(script)
    assert char.voice_description.startswith("年龄感：二十出头"), "九维档案要写回中列"
    assert "### 九维声音档案" not in char.voice_description, "标题不要留在档案里"
    assert char.voice_prompt.startswith("略低的年轻男声"), "成品里不要标题"
    assert "直接使用的提示词" not in char.voice_prompt
    assert char.voice_description_version == 1, "回填中列要进一版，右列据此不算过期"
    assert char.voice_prompt_description_version == char.voice_description_version


def test_generate_voice_prompt_keeps_a_unstructured_reply_out_of_the_description(monkeypatch, llm_spy):
    """模型没按两段式写：整段当成品、中列留空 —— 不能把一两千字塞进要喂
    create_voice 的那一层（≤500）。"""
    from src.apps.comic_gen.llm_adapter import LLMAdapter

    script = _script()
    client = _client(monkeypatch, script)
    monkeypatch.setattr(
        LLMAdapter, "chat", lambda self, messages, **kwargs: "一段没有标题的成品提示词。"
    )

    response = client.post(f"{BASE}/voice-prompt", json={})

    assert response.status_code == 200, response.text
    char = _character(script)
    assert char.voice_prompt == "一段没有标题的成品提示词。"
    assert char.voice_description == _script().characters[0].voice_description, "中列不该被覆写"


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
# 4. 左列：主参考音 —— 候选条（跟生图面同一个逻辑）
#
# 不是「一次出几张挑一张」（TTS 没有 seed，同参重复等于花钱拿同样的文件），
# 而是：改一版提示词、生成一版，每版都留档；攒几条之后回头看哪条好，
# 把那条设为主音。所以下面锁的是「追加 / 选中 / 删掉 / 回落」，不是批量。
# ---------------------------------------------------------------------------

def test_every_generation_appends_a_candidate(monkeypatch, audio_model_spy):
    """生成第二版不能覆盖第一版 —— 包括磁盘上的文件。"""
    script = _script()
    client = _client(monkeypatch, script)

    client.post(f"{BASE}/reference-audio", json={"text": "第一版：市井气重一点"})
    client.post(f"{BASE}/reference-audio", json={"text": "第二版：稳一点"})

    char = _character(script)
    assert len(char.reference_audio_variants) == 2, "两版都要留着，才能对比着挑"
    assert len({v.url for v in char.reference_audio_variants}) == 2, \
        "两个候选必须指向两个不同的音频路径"
    assert len(audio_model_spy) == 2, "每点一次就是一次声音模型调用（= 新的一版）"
    assert char.reference_audio_selected_id == char.reference_audio_variants[-1].id, \
        "新生成的那版自动成为主音"
    assert char.reference_audio_url == char.reference_audio_variants[-1].url, \
        "reference_audio_url 要跟着主音走 —— 「声音」步骤读的是它"
    assert char.reference_audio_variants[-1].origin == "seed-audio-1.0", "记下是哪条路产的"


def test_reference_audio_text_can_be_supplied(monkeypatch, audio_model_spy):
    script = _script()
    client = _client(monkeypatch, script)

    response = client.post(f"{BASE}/reference-audio", json={"text": "这批货再卖不动就回涿县了。"})

    assert response.status_code == 200
    assert "这批货再卖不动就回涿县了。" in audio_model_spy[0]["prompt"]


def test_reference_audio_without_a_prompt_says_what_to_do_first(monkeypatch, audio_model_spy):
    """没提示词时不能瞎调模型 —— 得说清先去做么。"""
    script = _script()
    char = _character(script)
    char.voice_description = None
    char.voice_prompt = None
    client = _client(monkeypatch, script)

    response = client.post(f"{BASE}/reference-audio", json={})

    assert response.status_code == 400
    assert "音色提示词" in response.json()["detail"], "要说清是先点生成提示词"
    assert not audio_model_spy, "没提示词就别去调模型"


def test_an_uploaded_recording_joins_the_same_candidate_strip(monkeypatch, audio_model_spy):
    """上传的录音跟生成的一版是同一个待遇 —— 都进候选条、都被选为主音。

    克隆音色本来就是从真人录音来的，那段录音往往就是最想要的那一版。
    """
    script = _script()
    client = _client(monkeypatch, script)
    client.post(f"{BASE}/reference-audio", json={})

    response = client.patch(f"{BASE}/voice-fields",
                            json={"reference_audio_url": "uploads/real-take.wav"})

    assert response.status_code == 200, response.text
    char = _character(script)
    assert len(char.reference_audio_variants) == 2
    assert char.reference_audio_url == "uploads/real-take.wav"
    assert char.reference_audio_variants[-1].origin == "upload"
    assert api_mod.pipeline.resolve_character_reference_audios(PROJECT_ID, [CHAR_ID]) == \
        ["uploads/real-take.wav"]


def test_re_uploading_the_same_file_does_not_duplicate_the_candidate(monkeypatch, audio_model_spy):
    script = _script()
    client = _client(monkeypatch, script)

    client.patch(f"{BASE}/voice-fields", json={"reference_audio_url": "uploads/take.wav"})
    client.patch(f"{BASE}/voice-fields", json={"reference_audio_url": "uploads/take.wav"})

    assert len(_character(script).reference_audio_variants) == 1, "同一段音频收两次没意义"


def test_reference_audio_rejects_a_non_audio_upload(monkeypatch):
    """传成 jpg 要在这一步就说清楚 —— 否则要到真正生成音频时才炸在网关上。"""
    script = _script()
    client = _client(monkeypatch, script)

    response = client.patch(f"{BASE}/voice-fields",
                            json={"reference_audio_url": "uploads/portrait.jpg"})

    assert response.status_code == 400
    assert "音频文件" in response.json()["detail"]
    assert _character(script).reference_audio_variants == [], "不能把错的路径收进候选"


def test_reference_audio_accepts_a_remote_url_without_an_extension(monkeypatch):
    """远端链接后面可能挂 query、也可能没有扩展名 —— 认不出来不等于错，要放行。"""
    script = _script()
    client = _client(monkeypatch, script)

    response = client.patch(
        f"{BASE}/voice-fields",
        json={"reference_audio_url": "https://cdn.example.com/voice/ref-1?sign=xyz"},
    )

    assert response.status_code == 200, response.text
    assert _character(script).reference_audio_url == "https://cdn.example.com/voice/ref-1?sign=xyz"


def test_changing_the_reference_audio_does_not_bump_the_description_version(monkeypatch, llm_spy):
    script = _script()
    client = _client(monkeypatch, script)
    client.post(f"{BASE}/voice-description", json={})
    before = _character(script).voice_description_version

    client.patch(f"{BASE}/voice-fields", json={"reference_audio_url": "uploads/abc123.mp3"})

    assert _character(script).voice_description_version == before, "换素材不该动中列的版本"


def test_the_best_take_can_be_selected_after_the_fact(monkeypatch, audio_model_spy):
    """核心用例：攒了几版之后回头看，发现还是第一版好，把它设为主音。"""
    script = _script()
    client = _client(monkeypatch, script)
    for line in ("第一版", "第二版", "第三版"):
        client.post(f"{BASE}/reference-audio", json={"text": line})
    char = _character(script)
    first = char.reference_audio_variants[0]

    response = client.patch(f"{BASE}/reference-audio", json={"variant_id": first.id})

    assert response.status_code == 200, response.text
    char = _character(script)
    assert char.reference_audio_selected_id == first.id
    assert char.reference_audio_url == first.url, "主音换了，「声音」步骤读到的也要换"
    assert len(char.reference_audio_variants) == 3, "选一版不该动其他候选"


def test_selecting_an_unknown_take_reports_it(monkeypatch, audio_model_spy):
    script = _script()
    client = _client(monkeypatch, script)

    response = client.patch(f"{BASE}/reference-audio", json={"variant_id": "nope"})

    assert response.status_code == 400
    assert "不存在" in response.json()["detail"]


def test_deleting_a_take_keeps_the_others(monkeypatch, audio_model_spy):
    script = _script()
    client = _client(monkeypatch, script)
    for line in ("第一版", "第二版"):
        client.post(f"{BASE}/reference-audio", json={"text": line})
    char = _character(script)
    first, second = char.reference_audio_variants

    response = client.delete(f"{BASE}/reference-audio/{second.id}")

    assert response.status_code == 200, response.text
    char = _character(script)
    assert [v.id for v in char.reference_audio_variants] == [first.id]
    assert char.reference_audio_selected_id == first.id, "删掉主音要回落到还在的那版"
    assert char.reference_audio_url == first.url


def test_deleting_the_last_take_clears_the_primary(monkeypatch, audio_model_spy):
    script = _script()
    client = _client(monkeypatch, script)
    client.post(f"{BASE}/reference-audio", json={})
    only = _character(script).reference_audio_variants[0]

    response = client.delete(f"{BASE}/reference-audio/{only.id}")

    assert response.status_code == 200
    char = _character(script)
    assert char.reference_audio_variants == []
    assert char.reference_audio_selected_id is None
    assert char.reference_audio_url is None, "一条都不剩就该是空的，不能留个悬空指针"


def test_the_candidate_strip_is_capped(monkeypatch, audio_model_spy):
    """攒太多要剪枝，但**永远不剪掉当前主音** —— 那是用户刚挑出来的。"""
    from src.apps.comic_gen.models import MAX_VARIANTS_PER_ASSET

    script = _script()
    client = _client(monkeypatch, script)
    for i in range(MAX_VARIANTS_PER_ASSET + 3):
        client.post(f"{BASE}/reference-audio", json={"text": f"第 {i} 版"})
    char = _character(script)
    assert len(char.reference_audio_variants) == MAX_VARIANTS_PER_ASSET

    # 挑一版旧的当主音，然后继续生成，主音不能被剪掉
    oldest = char.reference_audio_variants[0]
    client.patch(f"{BASE}/reference-audio", json={"variant_id": oldest.id})
    client.post(f"{BASE}/reference-audio", json={"text": "再来一版"})

    char = _character(script)
    assert oldest.id in {v.id for v in char.reference_audio_variants}, "主音被剪掉了"


# ---------------------------------------------------------------------------
# 5. 参考音优先级（喂给「声音」步骤的那条链）
# ---------------------------------------------------------------------------

def test_character_reference_audio_comes_from_the_character_itself(monkeypatch, audio_model_spy):
    """参考音只有一层：角色自己的 reference_audio_url。

    音色池 / 音色克隆已经随「音色选择」一起收掉（产品只有一个音频通道）。
    """
    script = _script()
    _client(monkeypatch, script)

    # 还没生成过 → 该角色报缺参考音
    with pytest.raises(ValueError, match="参考音"):
        api_mod.pipeline.resolve_character_reference_audios(PROJECT_ID, [CHAR_ID])

    _character(script).reference_audio_url = "uploads/reference_audio/char-1.mp3"
    resolved = api_mod.pipeline.resolve_character_reference_audios(PROJECT_ID, [CHAR_ID])
    assert resolved == ["uploads/reference_audio/char-1.mp3"]


# ---------------------------------------------------------------------------
# 7. 「AI 修改」—— 跟生图面描述那一列同一个动作
#
# 生图面那列有「AI 修改」：输入一句要求（比如「补充服装细节」）让模型改描述。
# 声音面镜像一份，改的是「声音描述」。这里只锁三件事：改了、进了版本、右列的
# 提示词因此变过期。
# ---------------------------------------------------------------------------

def test_rewriting_the_voice_description_replaces_the_text(monkeypatch, llm_spy):
    script = _script()
    client = _client(monkeypatch, script)
    client.post(f"{BASE}/voice-description", json={})
    before = _character(script).voice_description_version

    response = client.post(f"{BASE}/voice-description/rewrite",
                           json={"instruction": "再老成一点，语速放慢"})

    assert response.status_code == 200, response.text
    char = _character(script)
    assert char.voice_description == "沙哑的中年男声，语速偏慢，尾音略沉。"
    assert char.voice_description_source == "ai", "AI 改出来的算 AI 来源，不是手工"
    assert char.voice_description_version == before + 1, "改写也要进版本"


def test_rewriting_makes_the_voice_prompt_stale(monkeypatch, llm_spy):
    """改写声音描述之后，右列的提示词必须显成过期 —— 跟手改一个待遇。"""
    script = _script()
    client = _client(monkeypatch, script)
    client.post(f"{BASE}/voice-description", json={})
    client.post(f"{BASE}/voice-prompt", json={})
    fresh = _character(script).voice_prompt_description_version

    client.post(f"{BASE}/voice-description/rewrite", json={"instruction": "换少女音"})

    char = _character(script)
    assert char.voice_prompt_description_version < char.voice_description_version
    assert char.voice_prompt_description_version == fresh, "旧提示词的版本号不该被改"


def test_rewriting_sends_the_instruction_to_the_model(monkeypatch, llm_spy):
    """用户输入的要求必须真的到模型手里，不能只拿描述重新生成一遍。"""
    script = _script()
    client = _client(monkeypatch, script)
    client.post(f"{BASE}/voice-description", json={})
    llm_spy.clear()

    client.post(f"{BASE}/voice-description/rewrite",
                json={"instruction": "再老成一点，语速放慢"})

    assert llm_spy, "没调用模型"
    payload = str(llm_spy[-1])
    assert "再老成一点" in payload, "修改要求被吞了"


def test_rewriting_uses_the_voice_persona_not_the_image_one(monkeypatch, llm_spy):
    """不能直接把生图面那句「影视资产描述编辑器」搬过来 —— 它会去描述外貌。"""
    script = _script()
    client = _client(monkeypatch, script)
    client.post(f"{BASE}/voice-description", json={})
    llm_spy.clear()

    client.post(f"{BASE}/voice-description/rewrite", json={"instruction": "语速慢点"})

    system = "".join(m["content"] for m in llm_spy[-1] if m["role"] == "system")
    assert "声音" in system, "用的是声音的 persona"
    assert "资产描述编辑器" not in system, "搬了生图面的 persona 过来"


def test_rewriting_without_a_description_is_rejected(monkeypatch, llm_spy):
    script = _script()
    client = _client(monkeypatch, script)

    response = client.post(f"{BASE}/voice-description/rewrite", json={"instruction": "短一点"})

    assert response.status_code == 400
    assert "声音描述" in response.json()["detail"]


def test_rewriting_rejects_an_empty_model_reply(monkeypatch, llm_spy):
    from src.apps.comic_gen.llm_adapter import LLMAdapter

    script = _script()
    client = _client(monkeypatch, script)
    client.post(f"{BASE}/voice-description", json={})
    original = _character(script).voice_description
    monkeypatch.setattr(LLMAdapter, "chat", lambda self, messages, **kwargs: "  ")

    response = client.post(f"{BASE}/voice-description/rewrite", json={"instruction": "短一点"})

    assert response.status_code == 400
    assert _character(script).voice_description == original, "空回复不能把原描述冲掉"


# ---------------------------------------------------------------------------
# 8. 角色住在系列池（或全局库）时，声音面照样能用
# ---------------------------------------------------------------------------

def _series_with_the_character() -> Series:
    """角色只活在系列池里 —— 同名提取 / 手动关联之后本集不再留副本。"""
    series = _series()
    series.characters = [
        Character(id=CHAR_ID, name="刘备", description="汉室后裔，涿县卖草鞋"),
    ]
    return series


def _script_without_local_copy() -> Script:
    """本集只保留「本集私有」的那个角色，系列池那条不在 script.characters 里。"""
    script = _script()
    script.characters = [c for c in script.characters if c.id != CHAR_ID]
    return script


def test_voice_face_reads_a_character_that_lives_in_the_series_pool(monkeypatch, llm_spy):
    """回归：以前 `_character_or_raise` 只扫 script.characters，于是前端列表里
    明明看得见（它走三层合并），一点「AI 提取」就整列报「角色不存在」。"""
    script = _script_without_local_copy()
    client = _client(monkeypatch, script, series=_series_with_the_character())

    response = client.post(f"{BASE}/voice-description", json={})

    assert response.status_code == 200, response.text
    assert _series_with_the_character().characters  # 系列池那边确实有角色
    assert response.json()["voice_description"]


def test_voice_face_writes_back_to_the_layer_that_owns_the_character(monkeypatch, llm_spy):
    """改动必须落回持有角色的那层。以前无条件 `_save_data()`：角色在系列池时
    改动写进 projects.json（那儿根本没有它），重启即失效且不报错。"""
    script = _script_without_local_copy()
    saved = []
    client = _client(monkeypatch, script, series=_series_with_the_character())
    monkeypatch.setattr(api_mod.pipeline, "_save_series_data", lambda: saved.append("series"))
    monkeypatch.setattr(api_mod.pipeline, "_save_data", lambda: saved.append("episode"))

    response = client.post(f"{BASE}/voice-description", json={})

    assert response.status_code == 200, response.text
    assert saved == ["series"]


def test_reference_audio_resolution_accepts_a_series_level_character(monkeypatch):
    """喂给「声音」步骤的那条链（resolve_character_reference_audios）也要认三层池子，
    否则勾了系列池里的角色会报「角色不存在」。"""
    script = _script_without_local_copy()
    series = _series_with_the_character()
    series.characters[0].reference_audio_url = "uploads/lord.wav"
    _client(monkeypatch, script, series=series)  # 复用夹具，装上 get_script / get_series 的桩

    resolved = api_mod.pipeline.resolve_character_reference_audios(PROJECT_ID, [CHAR_ID])

    assert resolved == ["uploads/lord.wav"]


# ---------------------------------------------------------------------------
# 9. 「生成参考音」= 把右列提示词交给产品的音频模型
# ---------------------------------------------------------------------------

def test_reference_audio_generates_without_any_bound_voice(monkeypatch, audio_model_spy):
    """无需先选音色就能一键出参考音 —— 产品里就这一个音频模型。

    `seed-audio-1.0` 不注册音色，它只回音频，所以角色身上不会多出任何音色字段。"""
    script = _script()
    char = _character(script)
    client = _client(monkeypatch, script)

    response = client.post(f"{BASE}/reference-audio", json={})

    assert response.status_code == 200, response.text
    assert len(audio_model_spy) == 1, "这一点就是一次音频模型调用"
    assert char.reference_audio_url, "产物要落成主音"


def test_reference_audio_feeds_the_artifact_to_the_model(monkeypatch, audio_model_spy):
    """喂给模型的应该是右列的成品（九维 + 配音内容）—— 模型照它说话。"""
    script = _script()
    _character(script).voice_prompt = "略低的年轻男声。配音内容：“在下刘备。”"
    client = _client(monkeypatch, script)

    client.post(f"{BASE}/reference-audio", json={})

    assert audio_model_spy[0]["prompt"].startswith("略低的年轻男声。")
    assert "在下刘备。" in audio_model_spy[0]["prompt"]


def test_reference_audio_without_voice_or_prompt_says_what_to_do_first(monkeypatch, llm_spy):
    script = _script()
    char = _character(script)
    char.voice_description = None
    char.voice_prompt = None
    client = _client(monkeypatch, script)

    response = client.post(f"{BASE}/reference-audio", json={})

    assert response.status_code == 400
    assert "生成提示词" in response.json()["detail"], "要说清先做什么"


def test_reference_audio_lands_where_the_static_mount_can_serve_it(monkeypatch, audio_model_spy):
    """存储引用是 `uploads/reference_audio/…`（前端拼 /files/<它>），而磁盘上必须在
    `output/` 下面 —— 静态挂载 `/files` 的根就是 `output/`。

    踩过的坑：这个常量被当成磁盘路径用过，文件落在**数据目录根**下，前端取的时候
    永远 404（历史上一版能播的参考音都没有）。
    """
    import os

    script = _script()
    client = _client(monkeypatch, script)

    response = client.post(f"{BASE}/reference-audio", json={})

    assert response.status_code == 200, response.text
    stored = _character(script).reference_audio_url
    assert stored.startswith("uploads/reference_audio/"), stored
    assert not stored.startswith("output/"), "存的是引用，不带 output/ 前缀"
    assert os.path.isfile(os.path.join("output", stored)), \
        f"磁盘上要在 output/ 下面（前端只能通过 /files 拿到这个子树）：output/{stored}"


# ---------------------------------------------------------------------------
# 10. 声音要跟形象搭：年龄/性别/服装 + 生图提示词都要进输入
# ---------------------------------------------------------------------------

def test_voice_prompt_feeds_the_look_to_the_model(monkeypatch, llm_spy):
    """用户 2026-09-17 提的：定好形象之后，声音得跟长相搭（魁梧 → 中气十足）。

    形象的事实源是「生图提示词」—— 描述里可能只写了性格，体型在那句里。
    """
    script = _script()
    char = _character(script)
    char.description = "十九岁青年，性格沉稳"
    char.age = 19
    char.gender = "男"
    char.clothing = "汉末青年士人长袍"
    char.full_body_prompt = "一个十九岁的汉代宗室青年，高大魁梧、过度发达的身体撑起宽大的儒衫"
    client = _client(monkeypatch, script)

    client.post(f"{BASE}/voice-prompt", json={})

    user = next(m["content"] for m in llm_spy[-1] if m["role"] == "user")
    assert "形象（声音要跟它搭得上）" in user
    assert "年龄：19" in user and "性别：男" in user
    assert "汉末青年士人长袍" in user
    assert "高大魁梧" in user, "生图提示词要带进去 —— 体型在那儿"


def test_art_prompt_prefers_the_prompt_that_made_the_selected_image(monkeypatch, llm_spy):
    """参考图那条链：优先用「选中的那张图是用什么提示词生成的」。"""
    from src.apps.comic_gen.models import AssetUnit, ImageVariant

    script = _script()
    char = _character(script)
    char.full_body_prompt = "legacy 的旧提示词"
    char.reference_sheet = AssetUnit(
        selected_image_id="img-2",
        image_variants=[
            ImageVariant(id="img-1", url="a.png", prompt_used="没被选中的那张"),
            ImageVariant(id="img-2", url="b.png", prompt_used="选中的那张的提示词"),
        ],
        image_prompt="容器上的提示词",
    )
    client = _client(monkeypatch, script)

    client.post(f"{BASE}/voice-prompt", json={})

    user = next(m["content"] for m in llm_spy[-1] if m["role"] == "user")
    assert "选中的那张的提示词" in user
    assert "容器上的提示词" not in user, "有更准的就别退回去"
    assert "legacy 的旧提示词" not in user


def test_the_defaults_require_the_voice_to_match_the_look():
    """内置 persona 里得写着这条要求 —— 否则 Skill 没绑时它就悄悄丢了。"""
    from src.apps.comic_gen.llm import DEFAULT_VOICE_ARTIFACT_PROMPT, VOICE_PROMPT_OUTPUT_CONTRACT
    from src.apps.comic_gen.pipeline import ComicGenPipeline

    assert "形象" in DEFAULT_VOICE_ARTIFACT_PROMPT
    assert "不能打架" in DEFAULT_VOICE_ARTIFACT_PROMPT
    assert "形象" in VOICE_PROMPT_OUTPUT_CONTRACT
    assert "形象" in ComicGenPipeline._VOICE_DESCRIPTION_SYSTEM_PROMPT
