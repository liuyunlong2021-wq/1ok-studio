from src.apps.comic_gen.api import BUILTIN_SHORT_SCRIPT_SKILL, BUILTIN_SCRIPT_SKILLS


def test_builtin_short_skill_uses_editor_parseable_format():
    skill = next(item for item in BUILTIN_SCRIPT_SKILLS if item["id"] == "builtin-short")

    assert skill["content"] == BUILTIN_SHORT_SCRIPT_SKILL
    assert "场X-X 地点 - 时间" in skill["content"]
    assert "△" in skill["content"]
    assert "不访问外部 Wiki" in skill["content"]
    assert "不续写、不润色、不新增剧情事实" in skill["content"]
    # 编辑器只认「场次标题 / △ 行 / 角色名：台词」三件套（见
    # frontend/.../usePasteHandler.ts 的启发式规则），双链、▲、字数统计、
    # 字段清单都落不成结构化节点，加回来等于白写。
    assert "[[" not in skill["content"]
    assert "▲" not in skill["content"]
    assert "字数：" not in skill["content"]
    assert "英文对白" not in skill["content"]


def test_native_h3_skill_is_motion_only_and_readonly(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from src.apps.comic_gen import api
    from src.apps.prompt_editor.h3_enhancer import SKILL_ID
    monkeypatch.setattr(api, 'SKILLS_FILE', str(tmp_path / 'skills.json'))
    monkeypatch.setattr(api, 'DELETED_BUILTINS_FILE', str(tmp_path / 'hidden.json'))
    client = TestClient(api.app)
    native = next(item for item in client.get('/script-skills', params={'kind': 'motion'}).json() if item['id'] == SKILL_ID)
    assert native['executor'] == 'h3_context_ir' and native['readonly']
    assert not any(item['id'] == SKILL_ID for item in client.get('/script-skills', params={'kind': 'script'}).json())
    assert client.put('/script-skills/' + SKILL_ID, json={'name': 'Changed', 'content': 'changed'}).status_code == 400
    assert client.get('/script-skills/' + SKILL_ID + '/export').status_code == 400
    assert client.delete('/script-skills/' + SKILL_ID).status_code == 200
    assert not any(item['id'] == SKILL_ID for item in client.get('/script-skills').json())
    assert client.post('/script-skills/' + SKILL_ID + '/restore').status_code == 200
    assert any(item['id'] == SKILL_ID for item in client.get('/script-skills').json())
