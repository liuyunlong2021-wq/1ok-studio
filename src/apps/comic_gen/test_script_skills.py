from src.apps.comic_gen.api import BUILTIN_SHORT_SCRIPT_SKILL, BUILTIN_SCRIPT_SKILLS


def test_builtin_short_skill_uses_product_safe_wiki_format():
    skill = next(item for item in BUILTIN_SCRIPT_SKILLS if item["id"] == "builtin-short")

    assert skill["content"] == BUILTIN_SHORT_SCRIPT_SKILL
    assert "## 场X-X" in skill["content"]
    assert "[[场景/场景名]]" in skill["content"]
    assert "[[角色/角色名]]" in skill["content"]
    assert "[[道具/道具名]]" in skill["content"]
    assert "不访问外部 Wiki" in skill["content"]
    assert "不续写、不润色、不新增剧情事实" in skill["content"]
    assert "英文对白" not in skill["content"]
