from unittest.mock import Mock

from src.apps.comic_gen.llm import ScriptProcessor


def _processor(response):
    processor = ScriptProcessor.__new__(ScriptProcessor)
    processor.llm = Mock(is_configured=True)
    processor.llm.chat.return_value = response
    return processor


def test_entity_skill_is_system_and_source_text_is_user_input():
    processor = _processor('{"characters": [], "scenes": [], "props": [], "frames": []}')
    processor.parse_novel("Title", "SOURCE-TEXT", "SKILL-RULES")
    messages = processor.llm.chat.call_args.kwargs["messages"]
    assert messages[0] == {"role": "system", "content": "SKILL-RULES"}
    assert messages[1]["role"] == "user"
    assert "SOURCE-TEXT" in messages[1]["content"]


def test_storyboard_polish_skill_is_system_and_draft_is_user_input():
    processor = _processor('{"prompt_cn": "中文", "prompt_en": "English"}')
    result = processor.polish_storyboard_prompt("DRAFT", [], custom_system_prompt="SKILL-RULES")
    messages = processor.llm.chat.call_args.kwargs["messages"]
    assert result["prompt_cn"] == "中文"
    assert messages[0]["role"] == "system"
    assert "SKILL-RULES" in messages[0]["content"]
    assert messages[1]["role"] == "user"
    assert "DRAFT" in messages[1]["content"]
