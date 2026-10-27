import copy
import json
import threading
from unittest.mock import Mock

import pytest

from src.apps.comic_gen.llm import ScriptProcessor


SCREENPLAY = """统一风格：电影写实。莱拉是皇女，手腕有黑红色9527烙印。
场1-1 广场 日 外
镜头一【00:00-00:04】
【单人中景，固定镜头，平视机位，竖屏居中构图】
莱拉穿打满补丁的工装和带泥的皮靴，裹着破旧外套。
镜头二【00:04-00:08】
【单人中景，固定镜头，平视机位，竖屏居中构图】
莱拉换上白色礼服，仍露出手腕烙印。
"""


def extraction():
    return {
        "characters": [{"id": "c1", "name": "莱拉", "description": "皇女，手腕有黑红色9527烙印。", "gender": "女",
                        "extraction_evidence": [{"shot_number": None, "quote": "莱拉是皇女"}],
                        "looks": [
                            {"id": "l1", "name": "工装", "description": "打满补丁的工装、带泥的皮靴、破旧外套。", "extraction_evidence": [{"shot_number": 1, "quote": "带泥的皮靴"}]},
                            {"id": "l2", "name": "礼服", "description": "白色礼服"},
                        ]}],
        "scenes": [{"id": "s1", "name": "广场", "description": "日间室外广场"}],
        "props": [],
        "shot_bindings": [
            {"shot_number": 1, "scene_id": "s1", "characters": [{"character_id": "c1", "look_id": "l1"}], "prop_ids": []},
            {"shot_number": 2, "scene_id": "s1", "characters": [{"character_id": "c1", "look_id": "l2"}], "prop_ids": []},
        ],
    }


def processor(response):
    result = ScriptProcessor.__new__(ScriptProcessor)
    result.llm = Mock(is_configured=True)
    result.llm.chat.return_value = json.dumps(response, ensure_ascii=False)
    return result


def test_single_request_preserves_full_engineering_text_and_all_looks():
    worker = processor(extraction())
    result = worker.extract_production_assets(SCREENPLAY, "selected-model", [{"name": "旧人", "description": "SECRET-OLD-STORY", "aliases": []}])
    worker.llm.chat.assert_called_once()
    request = worker.llm.chat.call_args.kwargs
    assert request["model"] == "selected-model"
    assert SCREENPLAY in request["messages"][1]["content"]
    assert "SECRET-OLD-STORY" not in str(request["messages"])
    assert [look.name for look in result.characters[0].looks] == ["工装", "礼服"]
    assert "皮靴" in result.characters[0].looks[0].description
    assert result.shot_bindings[1].characters[0].look_id == "l2"


@pytest.mark.parametrize("mutation", ["unknown_shot", "missing_shot", "foreign_look", "forged_quote", "duplicate_id"])
def test_invalid_model_references_do_not_trigger_a_second_call(mutation):
    data = copy.deepcopy(extraction())
    if mutation == "unknown_shot":
        data["shot_bindings"][0]["shot_number"] = 99
    elif mutation == "missing_shot":
        data["shot_bindings"].pop()
    elif mutation == "foreign_look":
        data["shot_bindings"][0]["characters"][0]["look_id"] = "foreign"
    elif mutation == "forged_quote":
        data["characters"][0]["extraction_evidence"][0]["quote"] = "工程剧本未写的银色长发"
    else:
        data["characters"][0]["looks"][1]["id"] = "l1"
    worker = processor(data)
    with pytest.raises(ValueError):
        worker.extract_production_assets(SCREENPLAY)
    worker.llm.chat.assert_called_once()


def test_missing_required_collection_is_not_an_empty_success():
    data = extraction()
    del data["shot_bindings"]
    with pytest.raises(ValueError):
        processor(data).extract_production_assets(SCREENPLAY)


@pytest.fixture
def production(tmp_path):
    from src.apps.comic_gen.engineering_script import parse_engineering_script
    from src.apps.comic_gen.models import ArtDirection, GlobalAssetLibrary, Script
    from src.apps.comic_gen.pipeline import ComicGenPipeline
    from src.apps.comic_gen.production_workflow import PRODUCTION_WORKFLOW_ID, production_settings_revision, source_revision, style_revision

    pipeline = ComicGenPipeline.__new__(ComicGenPipeline)
    pipeline._save_lock = threading.RLock()
    pipeline._prompt_generation_slots = threading.BoundedSemaphore(2)
    pipeline.data_file = str(tmp_path / "projects.json")
    pipeline.series_data_file = str(tmp_path / "series.json")
    pipeline.library_store = GlobalAssetLibrary()
    pipeline.series_store = {}
    pipeline.prompt_generation_tasks = {}
    pipeline.asset_generation_tasks = {}
    pipeline.video_generation_tasks = {}
    pipeline.script_processor = processor(extraction())
    pipeline.asset_generator = Mock()
    pipeline.get_effective_polish_model = Mock(return_value="text-model")
    script = Script(id="project", title="测试", original_text="SECRET-ORIGINAL-STORY", production_workflow=PRODUCTION_WORKFLOW_ID, created_at=1, updated_at=1)
    script.art_direction = ArtDirection(selected_style_id="cinematic", style_config={"name": "写实", "positive_prompt": "cinematic"})
    script.production_style_revision = style_revision(script.art_direction)
    script.production_style_confirmed_at = 1
    script.production_engineering_source_revision = source_revision(script.original_text)
    script.production_engineering_style_revision = script.production_style_revision
    script.production_settings = {"image_model": "qwen-image", "aspect_ratio": "9:16", "max_segment_seconds": 30}
    script.production_settings["revision"] = production_settings_revision(script.production_settings, script.production_style_revision)
    script.engineering_script = parse_engineering_script(SCREENPLAY, validate_specs=False)
    pipeline.scripts = {script.id: script}
    return pipeline


def adopt(pipeline):
    script = pipeline.get_script("project")
    task = pipeline.queue_production_asset_extraction(script.id)
    pipeline.process_production_asset_extraction_task(script.id, task["task_id"])
    assert script.production_asset_extraction_task["status"] == "completed", script.production_asset_extraction_task
    preview = script.production_asset_preview
    return pipeline.apply_production_assets(script.id, preview["source_revision"], preview["screenplay_revision"])


def test_full_extract_apply_repeat_preserves_identity_media_and_voice(production):
    from src.apps.comic_gen.models import ImageVariant

    script = adopt(production)
    character = script.characters[0]
    assert len(script.characters) == 1
    assert [look.name for look in character.looks] == ["工装", "礼服"]
    assert [frame.character_look_ids[character.id] for frame in script.frames] == [look.id for look in character.looks]
    look_ids = [look.id for look in character.looks]
    character.description = "人工保留的皇女身份"
    character.description_source = "manual"
    character.voice_design = {"年龄感": "青年"}
    look = character.looks[0]
    look.reference_sheet.image_variants.append(ImageVariant(id="chosen", url="chosen.png"))
    look.reference_sheet.selected_image_id = "chosen"
    data = extraction()
    data["characters"][0]["looks"][0]["description"] += "破旧外套的面料已补充"
    production.script_processor.llm.chat.return_value = json.dumps(data, ensure_ascii=False)
    updated = adopt(production)
    assert [item.id for item in updated.characters[0].looks] == look_ids
    assert updated.characters[0].description == "人工保留的皇女身份"
    assert updated.characters[0].voice_design == {"年龄感": "青年"}
    assert updated.characters[0].looks[0].reference_sheet.selected_image_id == "chosen"
    assert "补充" in updated.characters[0].looks[0].description
    assert "SECRET-ORIGINAL-STORY" not in str(production.script_processor.llm.chat.call_args)
    assert updated.characters[0].extraction_evidence[0]["script_id"] == "project"


def add_images(script):
    from src.apps.comic_gen.models import ImageVariant
    for index, look in enumerate(script.characters[0].looks):
        look.reference_sheet.image_variants = [ImageVariant(id=f"image{index}", url=f"look{index}.png")]
        look.reference_sheet.selected_image_id = f"image{index}"


def test_segment_keeps_two_looks_and_local_shot_reference_numbers(production):
    script = adopt(production)
    add_images(script)
    segment = production.plan_production_segments(script.id)[0]
    refs = [ref for ref in segment["asset_refs"] if ref["kind"] == "characters"]
    assert len(refs) == 2
    assert refs[0]["id"] == refs[1]["id"]
    assert [ref["image_url"] for ref in refs] == ["look0.png", "look1.png"]
    assert refs[0]["look_id"] != refs[1]["look_id"]
    assert segment["tail_character_looks"][refs[0]["id"]] == refs[1]["look_id"]
    assert f"尾镜造型参考：图{refs[1]['number']}（莱拉 · 礼服）" in segment["screenplay_text"]
    assert "工装" in segment["screenplay_text"] and "礼服" in segment["screenplay_text"]
    assert segment["shots"][0]["asset_reference_numbers"][0] == refs[0]["number"]
    assert segment["shots"][1]["asset_reference_numbers"][0] == refs[1]["number"]


def test_changing_bound_look_invalidates_only_affected_segment(production):
    script = adopt(production)
    add_images(script)
    script.production_settings["max_segment_seconds"] = 5
    segments = production.plan_production_segments(script.id)
    segments[0]["adopted_at"] = segments[1]["adopted_at"] = 123
    second_before = copy.deepcopy(segments[1])
    frame = script.frames[0]
    production.update_frame(script.id, frame.id, character_look_ids={script.characters[0].id: script.characters[0].looks[1].id}, source_revision=frame.source_revision)
    assert "adopted_at" not in segments[0]
    assert segments[1] == second_before
    assert next(ref for ref in segments[0]["asset_refs"] if ref["kind"] == "characters")["image_url"] == "look1.png"


def test_explicit_look_missing_image_never_uses_other_clothes(production):
    from src.apps.comic_gen.production_assets import character_reference
    script = adopt(production)
    add_images(script)
    character = script.characters[0]
    character.image_url = "legacy-other-clothes.png"
    character.looks[1].reference_sheet.image_variants = []
    character.looks[1].reference_sheet.selected_image_id = None
    assert character_reference(character, character.looks[1].id)["image_url"] is None
    with pytest.raises(ValueError, match="指定"):
        character_reference(character)


def test_prompt_task_does_not_write_after_shared_identity_changes(production):
    from src.apps.comic_gen.production_assets import asset_description
    script = adopt(production)
    character, look = script.characters[0], script.characters[0].looks[0]
    task_id = production.create_prompt_generation_task(script.id, character.id, "character", character.name,
        asset_description(character, look), "rules", "text", look_id=look.id)
    def generate(*args):
        assert "皮靴" in args[2] and "9527" in args[2]
        character.description_version += 1
        return "旧身份的提示词"
    production.script_processor.generate_asset_prompt = generate
    production.process_prompt_generation_task(task_id)
    assert look.prompt_generation_status == "stale"
    assert not look.reference_sheet.image_prompt


def test_select_delete_and_favorite_are_confined_to_one_look(production):
    script = adopt(production)
    add_images(script)
    character = script.characters[0]
    first, second = character.looks
    production.toggle_variant_favorite(script.id, character.id, "character", "image0", True, look_id=first.id)
    assert first.reference_sheet.image_variants[0].is_favorited
    with pytest.raises(ValueError):
        production.select_asset_variant(script.id, character.id, "character", "image0", "reference_sheet", second.id)
    production.delete_asset_variant(script.id, character.id, "character", "image0", first.id)
    assert not first.reference_sheet.image_variants
    assert second.reference_sheet.selected_image_id == "image1"


def test_failed_adoption_does_not_leave_partial_assets(production, monkeypatch):
    script = production.get_script("project")
    task = production.queue_production_asset_extraction(script.id)
    production.process_production_asset_extraction_task(script.id, task["task_id"])
    preview = script.production_asset_preview
    monkeypatch.setattr(production, "save_production_project", Mock(side_effect=OSError("disk full")))
    with pytest.raises(OSError, match="disk full"):
        production.apply_production_assets(script.id, preview["source_revision"], preview["screenplay_revision"])
    assert production.get_script("project") is script
    assert not script.characters and not script.frames


def test_identity_enrichment_invalidates_every_look_prompt(production):
    script = adopt(production)
    for look in script.characters[0].looks:
        look.prompt_generation_status = "completed"
    data = extraction()
    data["characters"][0]["description"] += "眼神冷冽。"
    production.script_processor.llm.chat.return_value = json.dumps(data, ensure_ascii=False)
    updated = adopt(production)
    assert all(look.prompt_generation_status == "stale" for look in updated.characters[0].looks)


def test_favorite_does_not_invalidate_segments(production, monkeypatch):
    script = adopt(production)
    add_images(script)
    character = script.characters[0]
    invalidate = Mock()
    monkeypatch.setattr(production, "_persist_production_asset_update", invalidate)
    production.toggle_variant_favorite(script.id, character.id, "character", "image0", True, look_id=character.looks[0].id)
    invalidate.assert_not_called()


@pytest.mark.parametrize("stale", [False, True])
def test_look_image_job_uses_identity_reference_and_isolates_late_results(production, stale):
    from src.apps.comic_gen.models import ImageVariant
    from src.apps.comic_gen.production_assets import create_look_image_task, process_look_image_task

    script = adopt(production)
    add_images(script)
    character = script.characters[0]
    first, second = character.looks
    second.reference_sheet.image_variants = []
    second.reference_sheet.selected_image_id = None
    second.reference_sheet.image_prompt = "皇女穿白色礼服，保留9527烙印。"
    _, task_id = create_look_image_task(production, script.id, character.id, second.id,
        {"model_name": "qwen-image", "aspect_ratio": "9:16", "prompt": second.reference_sheet.image_prompt})

    def generate(candidate, **kwargs):
        assert kwargs["reference_image_url"] == first.reference_sheet.image_variants[0].url
        assert "白色礼服" in candidate.description and "9527" in candidate.description
        candidate.reference_sheet.image_variants.append(ImageVariant(id="new-dress", url="dress.png"))
        candidate.reference_sheet.selected_image_id = "new-dress"
        if stale:
            character.description_version += 1

    production.asset_generator.generate_character.side_effect = generate
    process_look_image_task(production, production.asset_generation_tasks[task_id])
    assert first.reference_sheet.selected_image_id == "image0"
    assert second.reference_sheet.image_variants[0].id == "new-dress"
    assert second.reference_sheet.selected_image_id == (None if stale else "new-dress")
    assert second.production_image_task["status"] == ("stale" if stale else "completed")


def test_global_asset_is_local_override_without_mutating_library(production):
    from src.apps.comic_gen.models import Character

    production.library_store.characters.append(Character(id="global-princess", name="莱拉", description="全局角色", description_source="manual"))
    script = adopt(production)
    assert script.characters[0].id == "global-princess"
    assert production.library_store.characters[0].looks == []
    updated = adopt(production)
    assert len(updated.characters) == 1
    assert updated.characters[0].id == "global-princess"


def test_prompt_generation_and_manual_save_persist_on_selected_look(production):
    from src.apps.comic_gen.production_assets import asset_description

    script = adopt(production)
    character = script.characters[0]
    look = character.looks[1]
    production.script_processor.generate_asset_prompt = Mock(return_value="皇女白色礼服完整设计")
    task_id = production.create_prompt_generation_task(script.id, character.id, "character", character.name,
        asset_description(character, look), "rules", "text", look_id=look.id)
    production.process_prompt_generation_task(task_id)
    assert look.prompt_generation_status == "completed", look.prompt_generation_error
    assert look.reference_sheet.image_prompt == "皇女白色礼服完整设计"
    production.save_production_asset_prompt(script.id, character.id, "character", "人工修改礼服", "manual", look.id)
    assert look.reference_sheet.image_prompt_source == "manual"
    assert not character.looks[0].reference_sheet.image_prompt
