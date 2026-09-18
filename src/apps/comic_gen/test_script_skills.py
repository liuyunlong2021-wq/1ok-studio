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
