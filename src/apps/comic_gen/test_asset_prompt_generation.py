from unittest.mock import Mock, patch

from src.apps.comic_gen.llm import ScriptProcessor


def _processor(*results):
    processor = ScriptProcessor.__new__(ScriptProcessor)
    processor.llm = Mock(is_configured=True)
    processor.llm.chat.side_effect = results
    return processor


def test_asset_prompt_separates_skill_rules_from_asset_input():
    processor = _processor("一名身穿旧布袍的青年，正面全身站姿，白色背景")

    result = processor.generate_asset_prompt(
        "character",
        "刘备",
        "卖草鞋的青年",
        custom_prompt="---\nname: character-skill\n---\n## 任务\n设计角色",
    )

    assert result.startswith("一名身穿旧布袍")
    messages = processor.llm.chat.call_args.kwargs["messages"]
    assert messages[0]["role"] == "system"
    assert "name: character-skill" in messages[0]["content"]
    assert messages[1] == {
        "role": "user",
        "content": "资产类型：character\n资产名称：刘备\n资产描述：卖草鞋的青年",
    }


def test_asset_prompt_retries_when_model_echoes_skill_document():
    skill = "---\nname: character-skill\ndescription: test\n---\n## 任务\n" + ("角色规则" * 100)
    processor = _processor(skill, "刘备，青年男性，旧布袍，草鞋，正面全身站姿，纯色背景")

    result = processor.generate_asset_prompt("character", "刘备", "卖草鞋的青年", custom_prompt=skill)

    assert result.startswith("刘备，青年男性")
    assert processor.llm.chat.call_count == 2


def test_asset_prompt_empty_responses_fall_back_without_leaking_skill():
    skill = "---\nname: character-skill\n---\n## 任务\n输出角色 Skill"
    processor = _processor("", "")

    result = processor.generate_asset_prompt("character", "刘备", "卖草鞋的青年", custom_prompt=skill)

    assert "刘备" in result
    assert "卖草鞋的青年" in result
    assert "name: character-skill" not in result
    assert "## 任务" not in result


@patch("src.apps.comic_gen.llm.time.sleep")
def test_asset_prompt_retries_transient_provider_failure(_sleep):
    processor = _processor(
        RuntimeError("Jiucaihezi API error: 502 Bad Gateway"),
        "刘备，青年男性，旧布袍，草鞋，正面全身站姿，纯色背景",
    )

    result = processor.generate_asset_prompt("character", "刘备", "卖草鞋的青年")

    assert result.startswith("刘备，青年男性")
    assert processor.llm.chat.call_count == 2
    _sleep.assert_called_once_with(0.5)


@patch("src.apps.comic_gen.llm.time.sleep")
def test_asset_prompt_does_not_retry_permanent_provider_failure(_sleep):
    processor = _processor(RuntimeError("Jiucaihezi API error: 401 Unauthorized"))

    try:
        processor.generate_asset_prompt("character", "刘备", "卖草鞋的青年")
    except RuntimeError as exc:
        assert "401" in str(exc)
    else:
        raise AssertionError("expected permanent provider error")

    assert processor.llm.chat.call_count == 1
    _sleep.assert_not_called()
