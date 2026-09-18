"""实体提取时注入"已有资产名册"的护栏。

名册的作用是让模型**沿用已有的名字**：同一个角色在第 2 集被重新起名
（刘备 → 刘玄德）之后就只能靠事后匹配去猜，而一开始把名册给它便宜得多。
"""

import os
import sys
from unittest.mock import Mock

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../..")))

from src.apps.comic_gen.llm import ScriptProcessor


def _processor(response='{"characters": [], "scenes": [], "props": [], "frames": []}'):
    processor = ScriptProcessor.__new__(ScriptProcessor)
    processor.llm = Mock(is_configured=True)
    processor.llm.chat.return_value = response
    return processor


def test_parse_novel_injects_roster_into_system_prompt():
    processor = _processor()

    processor.parse_novel(
        "Title", "TEXT", "", "",
        known_entities=[{"type": "characters", "name": "刘备", "description": "汉室宗亲"}],
    )

    system = processor.llm.chat.call_args.kwargs["messages"][0]["content"]
    assert "刘备" in system
    assert "务必沿用名字" in system
    # 剧本文本仍然只走 user 消息
    assert "TEXT" not in system


def test_parse_novel_without_roster_keeps_prompt_unchanged():
    """没有任何已有资产时提示词必须逐字不变 —— 老项目/单集项目不受影响。"""
    processor = _processor()

    processor.parse_novel("Title", "TEXT", "SKILL-RULES")

    assert processor.llm.chat.call_args.kwargs["messages"][0]["content"] == "SKILL-RULES"


def test_empty_roster_renders_nothing():
    """没有已有资产时不能往提示词里塞一段空标题 —— 老行为必须逐字不变。"""
    assert ScriptProcessor._render_known_entities(None) == ""
    assert ScriptProcessor._render_known_entities([]) == ""
    assert ScriptProcessor._render_known_entities([{"type": "characters", "name": ""}]) == ""


def test_roster_groups_by_kind_and_truncates_descriptions():
    rendered = ScriptProcessor._render_known_entities([
        {"type": "characters", "name": "刘备", "description": "汉室宗亲"},
        {"type": "characters", "name": "张飞", "description": "豹头环眼"},
        {"type": "scenes", "name": "涿县城门口", "description": ""},
        {"type": "props", "name": "招兵布告", "description": "x" * 200},
    ])

    assert "务必沿用名字" in rendered
    assert "- 角色：刘备（汉室宗亲）、张飞（豹头环眼）" in rendered
    assert "- 场景：涿县城门口" in rendered          # 没描述就不加空括号
    assert "- 道具：招兵布告（" in rendered
    assert "x" * 41 not in rendered                  # 描述被截断
    assert "x" * 40 in rendered


def test_roster_caps_long_lists():
    many = [{"type": "characters", "name": f"路人{i}", "description": ""} for i in range(45)]

    rendered = ScriptProcessor._render_known_entities(many)

    assert "路人29" in rendered
    assert "路人30" not in rendered
    assert "等共 45 个" in rendered
