import threading
from types import SimpleNamespace
from unittest.mock import Mock, patch

from src.apps.comic_gen.llm import ScriptProcessor
from src.apps.comic_gen.pipeline import ComicGenPipeline


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


def _prompt_pipeline(asset):
    pipeline = ComicGenPipeline.__new__(ComicGenPipeline)
    pipeline.scripts = {"project-1": SimpleNamespace()}
    pipeline.prompt_generation_tasks = {}
    pipeline._prompt_generation_slots = threading.BoundedSemaphore(2)
    pipeline._find_asset_with_source = Mock(return_value=(asset, "script"))
    pipeline._save_after_asset_mutation = Mock()
    pipeline.script_processor = Mock()
    return pipeline


def test_background_prompt_task_writes_result_to_asset():
    asset = SimpleNamespace(
        description_version=3, prompt_generation_status="idle",
        prompt_generation_task_id=None, prompt_generation_error=None,
        prompt_generation_started_at=0.0, full_body_prompt="",
    )
    pipeline = _prompt_pipeline(asset)
    pipeline.script_processor.generate_asset_prompt.return_value = "生成完成的角色提示词"

    task_id = pipeline.create_prompt_generation_task(
        "project-1", "asset-1", "character", "角色", "描述", "规则", "model",
    )
    pipeline.process_prompt_generation_task(task_id)

    assert asset.full_body_prompt == "生成完成的角色提示词"
    assert asset.prompt_generation_status == "completed"


def test_background_prompt_task_does_not_overwrite_after_description_changes():
    asset = SimpleNamespace(
        description_version=3, prompt_generation_status="idle",
        prompt_generation_task_id=None, prompt_generation_error=None,
        prompt_generation_started_at=0.0, full_body_prompt="原提示词",
    )
    pipeline = _prompt_pipeline(asset)
    pipeline.script_processor.generate_asset_prompt.return_value = "过期结果"
    task_id = pipeline.create_prompt_generation_task(
        "project-1", "asset-1", "character", "角色", "描述", "规则", "model",
    )
    asset.description_version = 4

    pipeline.process_prompt_generation_task(task_id)

    assert asset.full_body_prompt == "原提示词"
    assert asset.prompt_generation_status == "stale"
