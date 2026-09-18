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


def test_asset_prompt_writes_the_configured_aspect_ratio_into_the_input():
    """设置里选 9:16，提示词就必须按 9:16 的版式写。

    Skill 里 16:9 与 9:16 各有独立版式段落；不传画幅模型就自己挑（历史上固定挑成
    16:9），于是出图用 9:16、提示词却写「16:9横屏」，两处自相矛盾。
    """
    processor = _processor("生成的提示词")

    processor.generate_asset_prompt("character", "九殿下", "华夏年轻皇族少女", aspect_ratio="9:16")

    user_message = processor.llm.chat.call_args.kwargs["messages"][1]["content"]
    assert "画幅：9:16（竖屏" in user_message


def test_asset_prompt_stays_ratio_free_when_none_is_configured():
    """没给画幅时不能凭空编一个 —— 其他调用点的行为保持不变。"""
    processor = _processor("生成的提示词")

    processor.generate_asset_prompt("character", "九殿下", "华夏年轻皇族少女")

    user_message = processor.llm.chat.call_args.kwargs["messages"][1]["content"]
    assert user_message == "资产类型：character\n资产名称：九殿下\n资产描述：华夏年轻皇族少女"


def test_asset_prompt_fallback_still_carries_the_aspect_ratio():
    skill = "---\nname: character-skill\n---\n## 任务\n输出角色 Skill"
    processor = _processor("", "")

    result = processor.generate_asset_prompt(
        "character", "刘备", "卖草鞋的青年", custom_prompt=skill, aspect_ratio="9:16",
    )

    assert "画幅：9:16" in result
    assert "name: character-skill" not in result


def test_background_prompt_task_carries_the_aspect_ratio_to_the_generator():
    """工作台走的是后台任务这条路，画幅必须一起传下去。"""
    asset = SimpleNamespace(
        description_version=1, prompt_generation_status="idle",
        prompt_generation_task_id=None, prompt_generation_error=None,
        prompt_generation_started_at=0.0, full_body_prompt="",
    )
    pipeline = _prompt_pipeline(asset)

    task_id = pipeline.create_prompt_generation_task(
        "project-1", "asset-1", "character", "角色", "描述", "规则", "model", "", "9:16",
    )
    pipeline.process_prompt_generation_task(task_id)

    # (asset_type, name, description, custom_prompt, model, style_prompt, aspect_ratio)
    assert pipeline.script_processor.generate_asset_prompt.call_args.args[-1] == "9:16"


def test_effective_asset_aspect_ratio_reads_the_same_settings_as_the_image_path():
    """出图与提示词共用这一个解析处，避免以后再分叉。"""
    pipeline = ComicGenPipeline.__new__(ComicGenPipeline)
    script = SimpleNamespace(
        model_settings=SimpleNamespace(
            character_aspect_ratio="9:16",
            scene_aspect_ratio="16:9",
            prop_aspect_ratio="1:1",
        )
    )

    assert pipeline.get_effective_asset_aspect_ratio(script, "character") == "9:16"
    assert pipeline.get_effective_asset_aspect_ratio(script, "scene") == "16:9"
    assert pipeline.get_effective_asset_aspect_ratio(script, "prop") == "1:1"
    assert pipeline.get_effective_asset_aspect_ratio(script, "unknown") == "9:16"
