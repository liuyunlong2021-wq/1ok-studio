import json
import io
import pytest
from PIL import Image
import time
import os
import subprocess
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from src.apps.comic_gen.models import ArtDirection, Character, ImageAsset, ImageVariant, Scene, Script, StoryboardFrame, VideoTask
from src.apps.comic_gen.pipeline import ComicGenPipeline
from src.apps.comic_gen.production_workflow import PRODUCTION_WORKFLOW_ID, production_segment_revision, production_settings_revision, source_revision, style_revision


@pytest.fixture
def production_pipeline(tmp_path):
    with patch("src.apps.comic_gen.pipeline.ScriptProcessor"), \
         patch("src.apps.comic_gen.pipeline.AssetGenerator"), \
         patch("src.apps.comic_gen.pipeline.StoryboardGenerator"), \
         patch("src.apps.comic_gen.pipeline.VideoGenerator"), \
         patch("src.apps.comic_gen.pipeline.AudioGenerator"), \
         patch("src.apps.comic_gen.pipeline.ExportManager"):
        pipeline = ComicGenPipeline()
    pipeline.data_file = str(tmp_path / "projects.json")
    pipeline.series_data_file = str(tmp_path / "series.json")
    pipeline.library_data_file = str(tmp_path / "library.json")
    pipeline.scripts = {}
    pipeline.series_store = {}
    return pipeline


def _segment_script():
    script = Script(id="production-project", title="一段", original_text="原始输入", created_at=time.time(), updated_at=time.time())
    script.production_workflow = PRODUCTION_WORKFLOW_ID
    script.production_style_revision = "style-r1"
    script.production_style_confirmed_at = 10
    script.production_settings = {
        "confirmed_at": 10,
        "video_model": "jc-minimax-h3-ref2v",
        "max_segment_seconds": 8,
        "motion_skill_id": "motion-skill",
        "motion_skill_name": "电影分镜 Skill",
        "motion_skill_hash": "skill-hash",
    }
    script.production_settings["revision"] = production_settings_revision(script.production_settings, "style-r1")
    script.production_engineering_source_revision = source_revision(script.original_text)
    script.production_engineering_style_revision = "style-r1"
    script.engineering_script = {"revision": "screenplay-r1", "duration": 4, "shots": [{"number": 1}]}
    script.storyboard_source_revision = "screenplay-r1"
    script.frames = [StoryboardFrame(id="frame-1", source_shot_number=1, scene_id="scene-1")]
    segment = {
        "id": "segment-001-1-1", "index": 1, "source_revision": "screenplay-r1", "style_revision": "style-r1",
        "source_shot_numbers": [1], "duration_story": 4, "duration_total": 5, "synopsis": "甲找到线索后决定当面质问乙",
        "entry_state": "甲位于门口，面向房间内的乙", "exit_state": "甲在左，乙在右，两人相距两米",
        "settings_revision": script.production_settings["revision"],
        "asset_refs": [{"image_url": "https://assets.example/ref.png"}], "style": {"name": "电影感"}, "shots": [],
        "adopted_at": 11, "source_frame_ids": ["frame-1"], "adopted_prompt": "持续镜头提示词",
    }
    segment["revision"] = production_segment_revision(segment)
    segment["adopted_prompt_revision"] = segment["revision"]
    script.production_segments = [segment]
    script.production_settings["segments_adopted_at"] = 11
    return script


def test_segment_video_task_keeps_tail_duration_and_records_immutable_inputs(production_pipeline):
    script = _segment_script()
    production_pipeline.scripts[script.id] = script

    updated, task_id = production_pipeline.create_video_task(
        script.id, image_url="", prompt="持续镜头提示词", duration=5,
        model="jc-minimax-h3-ref2v", generation_mode="r2v",
        reference_image_urls=["https://assets.example/ref.png"], source_frame_ids=["frame-1"],
        skill_id="motion-skill", skill_name="电影分镜 Skill",
        segment_id="segment-001-1-1", segment_revision=script.production_segments[0]["revision"],
    )

    task = next(item for item in updated.video_tasks if item.id == task_id)
    assert task.duration == 5  # 4 seconds of story plus the 1-second tail wide.
    assert task.generate_audio is False
    assert task.reference_audio_urls == []
    assert task.segment_id == "segment-001-1-1"
    assert task.segment_revision == script.production_segments[0]["revision"]
    assert task.input_snapshot_revision


def test_segment_video_task_rejects_prompt_or_segment_revision_drift(production_pipeline):
    script = _segment_script()
    production_pipeline.scripts[script.id] = script

    with pytest.raises(ValueError, match="分段或提示词已变化"):
        production_pipeline.create_video_task(
            script.id, image_url="", prompt="改过但未采用", duration=5,
            model="jc-minimax-h3-ref2v", generation_mode="r2v",
            reference_image_urls=["https://assets.example/ref.png"], source_frame_ids=["frame-1"],
            segment_id="segment-001-1-1", segment_revision="stale-revision",
        )


def test_standalone_episode_has_no_total_duration_cap(production_pipeline):
    script = _segment_script()
    script.series_id = None
    script.production_segments[0]["duration_total"] = 193
    production_pipeline.scripts[script.id] = script

    # Only per-segment limits apply; a long standalone episode reaches the selection check.
    with pytest.raises(ValueError, match="每个分段都必须明确选择"):
        production_pipeline._merge_production_segments(script)


def test_production_asset_prompt_task_becomes_stale_if_confirmed_settings_change(production_pipeline):
    script = _segment_script()
    scene = Scene(id="scene-1", name="旧宅", description="深夜的旧宅客厅")
    script.scenes = [scene]
    production_pipeline.scripts[script.id] = script
    settings_revision = script.production_settings["revision"]

    task_id = production_pipeline.create_prompt_generation_task(
        script.id, scene.id, "scene", scene.name, scene.description,
        "风格优先", "text-model", aspect_ratio="9:16",
        production_settings_revision_snapshot=settings_revision,
    )
    script.production_settings["revision"] = "new-settings"
    with patch.object(production_pipeline.script_processor, "generate_asset_prompt", return_value="迟到的旧风格提示词") as generate:
        production_pipeline.process_prompt_generation_task(task_id)

    assert generate.call_count == 0
    assert scene.image_prompt == ""
    assert scene.prompt_generation_status == "stale"


def test_production_asset_extraction_is_async_and_persists_its_preview(production_pipeline):
    script = _segment_script()
    script.engineering_script["text"] = "工程剧本全文"
    production_pipeline.scripts[script.id] = script
    parsed = SimpleNamespace(characters=[], scenes=[Scene(id="scene-new", name="新场景", description="雨夜巷口")], props=[], shot_bindings=[])
    with patch.object(production_pipeline.script_processor, "extract_production_assets", return_value=parsed):
        task = production_pipeline.queue_production_asset_extraction(script.id)
        production_pipeline.process_production_asset_extraction_task(script.id, task["task_id"])

    assert script.production_asset_extraction_task["status"] == "completed"
    assert script.production_asset_preview["extraction_task_id"] == task["task_id"]
    persisted = json.loads(Path(production_pipeline.data_file).read_text())[script.id]
    assert persisted["production_asset_preview"]["scenes"][0]["name"] == "新场景"


def test_production_asset_extraction_drops_results_after_settings_change(production_pipeline, monkeypatch):
    script = _segment_script()
    script.engineering_script["text"] = "工程剧本全文"
    production_pipeline.scripts[script.id] = script
    parsed = SimpleNamespace(characters=[], scenes=[], props=[], shot_bindings=[])

    def change_settings_during_parse(*_args, **_kwargs):
        script.production_settings["revision"] = "changed-settings"
        return parsed

    monkeypatch.setattr(production_pipeline.script_processor, "extract_production_assets", change_settings_during_parse)
    task = production_pipeline.queue_production_asset_extraction(script.id)
    production_pipeline.process_production_asset_extraction_task(script.id, task["task_id"])

    assert script.production_asset_extraction_task["status"] == "failed"
    assert not script.production_asset_preview


def test_voice_design_task_is_persisted_and_invalidates_segments_on_adoption(production_pipeline):
    script = _segment_script()
    script.art_direction = ArtDirection(selected_style_id="cinematic", style_config={"name": "电影感"})
    script.production_style_revision = style_revision(script.art_direction)
    script.production_settings["revision"] = production_settings_revision(script.production_settings, script.production_style_revision)
    script.production_segments[0]["settings_revision"] = script.production_settings["revision"]
    character = Character(id="character-1", name="甲", description="沉稳的中年人")
    script.characters = [character]
    segment = script.production_segments[0]
    segment["asset_refs"] = [{"kind": "characters", "id": character.id, "number": 1, "name": character.name, "description": character.description, "voice_design": {}, "image_url": "character.png"}]
    segment["revision"] = production_segment_revision(segment)
    segment["adopted_at"] = 12
    old_revision = segment["revision"]
    script.production_settings["segments_adopted_at"] = 12
    script.production_selected_video_tasks[segment["id"]] = "old-video"
    production_pipeline.scripts[script.id] = script
    design = {key: f"甲的{key}" for key in ("年龄感", "音高", "明暗", "厚薄", "共鸣", "气息", "颗粒感", "口音", "稳定表达习惯")}

    task = production_pipeline.queue_production_voice_design(script.id, character.id)
    assert production_pipeline.mark_production_voice_design_running(script.id, character.id, task["task_id"])
    assert production_pipeline.complete_production_voice_design(script.id, character.id, task["task_id"], design)

    assert character.voice_design_task["status"] == "completed"
    assert character.voice_design == design
    assert segment["revision"] != old_revision
    assert "adopted_at" not in segment
    assert segment["prompt_generation_status"] == "stale"
    assert segment["id"] not in script.production_selected_video_tasks
    assert "segments_adopted_at" not in script.production_settings


def test_production_image_task_persists_inputs_and_invalidates_segment_on_new_image(production_pipeline, monkeypatch):
    script = _segment_script()
    script.art_direction = ArtDirection(selected_style_id="cinematic", style_config={"name": "电影感"})
    script.production_style_revision = style_revision(script.art_direction)
    script.production_settings.update(image_model="test-image", aspect_ratio="9:16")
    script.production_settings["revision"] = production_settings_revision(script.production_settings, script.production_style_revision)
    scene = Scene(id="scene-1", name="旧宅", description="深夜客厅")
    scene.image_prompt = "旧宅场景"
    script.scenes = [scene]
    segment = script.production_segments[0]
    segment["settings_revision"] = script.production_settings["revision"]
    segment["asset_refs"] = [{"kind": "scenes", "id": scene.id, "number": 1, "name": scene.name, "description": scene.description, "image_url": "old.png"}]
    segment["revision"] = production_segment_revision(segment)
    segment["adopted_at"] = 12
    old_revision = segment["revision"]
    script.production_settings["segments_adopted_at"] = 12
    script.production_selected_video_tasks[segment["id"]] = "old-video"
    production_pipeline.scripts[script.id] = script

    _updated, task_id = production_pipeline.create_asset_generation_task(
        script.id, scene.id, "scene", prompt="旧宅场景", model_name="test-image", aspect_ratio="9:16",
    )
    assert json.loads(Path(production_pipeline.data_file).read_text())[script.id]["scenes"][0]["production_image_task"]["status"] == "queued"
    monkeypatch.setattr(production_pipeline, "generate_asset", lambda *_args, **_kwargs: setattr(scene, "image_url", "new.png") or script)
    production_pipeline.process_asset_generation_task(task_id)

    assert scene.production_image_task["status"] == "completed"
    assert segment["revision"] != old_revision
    assert segment["asset_refs"][0]["image_url"] == "new.png"
    assert "adopted_at" not in segment
    assert segment["id"] not in script.production_selected_video_tasks


def test_download_pending_image_resumes_original_artifact_without_regeneration(production_pipeline, monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    script = _segment_script()
    script.art_direction = ArtDirection(selected_style_id="cinematic", style_config={"name": "电影感"})
    script.production_style_revision = style_revision(script.art_direction)
    script.production_settings.update(image_model="test-image", aspect_ratio="9:16")
    script.production_settings["revision"] = production_settings_revision(script.production_settings, script.production_style_revision)
    segment_revision = script.production_segments[0]["revision"]
    scene = Scene(id="scene-recovery", name="旧宅", description="深夜客厅", image_prompt="旧宅场景")
    scene.image_asset.variants.append(ImageVariant(id="manual-image", url="assets/scenes/manual.png"))
    script.scenes = [scene]
    production_pipeline.scripts[script.id] = script
    production_pipeline.asset_generator.output_dir = str(tmp_path / "output" / "assets")
    _updated, task_id = production_pipeline.create_asset_generation_task(
        script.id, scene.id, "scene", prompt="旧宅场景", model_name="test-image", aspect_ratio="9:16",
    )
    artifact_path = Path(production_pipeline.asset_generator.output_dir) / "scenes" / "scene-recovery.png"
    generation_calls = []

    def generate_then_lose_download(*_args, **kwargs):
        generation_calls.append(True)
        kwargs["on_artifact"]({
            "variant_id": "paid-variant-1", "output_path": str(artifact_path),
            "url": "https://cdn.example/paid.png?signature=private", "content_type": "image/png",
        })
        raise RuntimeError("simulated download interruption")

    monkeypatch.setattr(production_pipeline, "generate_asset", generate_then_lose_download)
    production_pipeline.process_asset_generation_task(task_id)
    status = production_pipeline.get_asset_generation_task_status(task_id)
    assert status["phase"] == "download_pending"
    assert status["can_resume"] is True
    assert status["artifacts"] == [{"variant_id": "paid-variant-1", "status": "pending_download", "content_type": "image/png"}]

    image = io.BytesIO()
    Image.new("RGB", (1, 1), (12, 34, 56)).save(image, format="PNG")
    image_bytes = image.getvalue()

    def download_existing(url, path, **_kwargs):
        assert url == "https://cdn.example/paid.png?signature=private"
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).write_bytes(image_bytes)
        scene.image_asset.selected_id = "manual-image"
        scene.image_url = "assets/scenes/manual.png"

    monkeypatch.setattr("src.models.jiucaihezi._download", download_existing)
    queued = production_pipeline.queue_asset_image_recovery(script.id, task_id)
    assert queued["reused"] is False
    assert production_pipeline.queue_asset_image_recovery(script.id, task_id)["reused"] is True
    production_pipeline.process_asset_image_recovery(task_id)

    assert len(generation_calls) == 1
    assert scene.production_image_task["phase"] == "completed"
    assert scene.image_asset.selected_id == "manual-image"
    assert [item.id for item in scene.image_asset.variants] == ["paid-variant-1", "manual-image"]
    assert scene.image_url == "assets/scenes/manual.png"
    assert scene.production_image_task["adoption"] == "candidate"
    assert script.production_segments[0]["revision"] == segment_revision


def test_production_image_task_does_not_call_provider_after_settings_change(production_pipeline, monkeypatch):
    script = _segment_script()
    script.art_direction = ArtDirection(selected_style_id="cinematic", style_config={"name": "电影感"})
    script.production_style_revision = style_revision(script.art_direction)
    script.production_settings.update(image_model="test-image", aspect_ratio="9:16")
    script.production_settings["revision"] = production_settings_revision(script.production_settings, script.production_style_revision)
    scene = Scene(id="scene-1", name="旧宅", description="深夜客厅")
    scene.image_prompt = "旧宅场景"
    script.scenes = [scene]
    production_pipeline.scripts[script.id] = script
    _updated, task_id = production_pipeline.create_asset_generation_task(
        script.id, scene.id, "scene", prompt="旧宅场景", model_name="test-image", aspect_ratio="9:16",
    )
    production_pipeline.generate_asset = lambda *_args: pytest.fail("stale image task must not call the provider")
    script.production_settings["revision"] = "changed-settings"

    production_pipeline.process_asset_generation_task(task_id)

    assert scene.production_image_task["status"] == "stale"
    assert scene.status.value == "pending"


def test_segment_prompt_job_cannot_overwrite_after_segment_revision_changes(production_pipeline):
    script = _segment_script()
    production_pipeline.scripts[script.id] = script
    segment = script.production_segments[0]
    segment_revision = segment["revision"]
    skill = {"id": "motion-skill", "hash": "skill-hash", "name": "电影分镜 Skill", "revision": "builtin"}

    task_id = production_pipeline.queue_production_segment_prompt(script.id, segment["id"], skill)
    production_pipeline.update_production_segment(script.id, segment["id"], "甲愤怒地质问妻子乙，乙沉默承受线索被发现", "甲在左侧", "乙在右侧")
    completed = production_pipeline.complete_production_segment_prompt(
        script.id, segment["id"], task_id, segment_revision,
        script.production_settings["revision"], skill, "旧版本提示词",
    )

    assert completed is False
    assert segment.get("adopted_prompt", "") == ""
    assert segment["prompt_generation_status"] == "stale"


def test_engineering_job_cannot_overwrite_after_source_revision_changes(production_pipeline):
    script = _segment_script()
    script.production_engineering_draft = {"text": "用户已有草稿", "source_revision": source_revision(script.original_text)}
    production_pipeline.scripts[script.id] = script

    task = production_pipeline.queue_production_engineering(script.id)
    assert production_pipeline.mark_production_engineering_running(script.id, task["task_id"])
    production_pipeline.update_production_source(script.id, "修改后的原始剧本")

    completed = production_pipeline.complete_production_engineering(script.id, task["task_id"], "迟到的工程剧本", "test-model")

    assert completed is False
    assert script.production_engineering_task["status"] == "stale"
    assert script.production_engineering_draft["text"] == "用户已有草稿"


def test_generated_engineering_is_automatically_adopted_by_timecode(production_pipeline):
    script = _segment_script()
    script.art_direction = ArtDirection(selected_style_id="cinematic", style_config={"name": "电影感"})
    script.production_style_revision = style_revision(script.art_direction)
    script.production_settings["revision"] = production_settings_revision(script.production_settings, script.production_style_revision)
    script.engineering_script = {}
    script.production_segments = []
    production_pipeline.scripts[script.id] = script
    task = production_pipeline.queue_production_engineering(script.id)
    assert production_pipeline.mark_production_engineering_running(script.id, task["task_id"])

    text = "镜头二十五【00:00-00:03】\n角色在光芒中抬头。"
    assert production_pipeline.complete_production_engineering(script.id, task["task_id"], text, "test-model")

    assert script.production_engineering_task["status"] == "completed"
    assert script.engineering_script["shots"][0]["number"] == 25
    assert script.engineering_script["shots"][0]["camera_movement"] == "固定"


def test_production_merge_requires_one_explicit_completed_task_per_segment(production_pipeline):
    script = _segment_script()
    script.production_segments.append({"id": "segment-002-2-2", "index": 2, "revision": "segment-r2", "adopted_at": 11})
    script.production_selected_video_tasks["segment-001-1-1"] = "task-1"
    script.video_tasks = [VideoTask(
        id="task-1", project_id=script.id, segment_id="segment-001-1-1", segment_revision=script.production_segments[0]["revision"],
        image_url="", prompt="ok", status="completed", duration=5, video_url="videos/one.mp4",
    )]
    production_pipeline.scripts[script.id] = script

    with pytest.raises(ValueError, match="每个分段都必须明确选择当前版本的已完成成片"):
        production_pipeline.merge_videos(script.id)


def test_production_merge_save_failure_preserves_previous_result_and_removes_partial_output(production_pipeline, tmp_path, monkeypatch):
    script = _segment_script()
    input_dir = tmp_path / "output" / "videos"
    input_dir.mkdir(parents=True)
    source = input_dir / "segment.mp4"
    source.write_bytes(b"input")
    previous = input_dir / "previous.mp4"
    previous.write_bytes(b"old-merged")
    script.merged_video_url = "videos/previous.mp4"
    task = VideoTask(
        id="chosen", project_id=script.id, segment_id=script.production_segments[0]["id"],
        segment_revision=script.production_segments[0]["revision"], input_snapshot_revision="snapshot",
        image_url="", prompt="ok", status="completed", duration=5, video_url="videos/segment.mp4",
    )
    script.video_tasks = [task]
    script.production_selected_video_tasks = {script.production_segments[0]["id"]: task.id}
    production_pipeline.scripts[script.id] = script

    def safe_path(base, relative):
        mapped_base = tmp_path / base
        mapped_base.mkdir(parents=True, exist_ok=True)
        return str(mapped_base / relative)

    monkeypatch.setattr("src.apps.comic_gen.pipeline._safe_resolve_path", safe_path)
    monkeypatch.setattr("src.apps.comic_gen.pipeline.get_ffmpeg_path", lambda: "/fake/ffmpeg")

    def fake_run(command, **_kwargs):
        open(command[-1], "wb").write(b"partial")
        return None

    monkeypatch.setattr("src.apps.comic_gen.pipeline.subprocess.run", fake_run)
    monkeypatch.setattr(production_pipeline, "save_production_project", lambda _script_id: (_ for _ in ()).throw(OSError("disk full")))

    with pytest.raises(OSError, match="disk full"):
        production_pipeline.merge_videos(script.id)

    assert script.merged_video_url == "videos/previous.mp4"
    assert previous.read_bytes() == b"old-merged"
    assert list(input_dir.glob("merged_*.mp4")) == []


def _two_segment_script():
    script = _segment_script()
    second = {**script.production_segments[0], "id": "segment-002-2-2", "index": 2, "source_shot_numbers": [2], "synopsis": "", "exit_state": "", "entry_state": ""}
    first = script.production_segments[0]
    first.update(synopsis="", exit_state="")
    for segment in (first, second):
        segment["revision"] = production_segment_revision(segment)
    script.production_segments = [first, second]
    return script


def _drafts():
    return [
        {"id": "segment-001-1-1", "synopsis": "甲愤怒地质问妻子乙，乙沉默承受", "exit_state": "甲在画左面向右，乙在画右背对窗户，相距两米"},
        {"id": "segment-002-2-2", "synopsis": "乙终于开口反驳，甲愣在原地", "exit_state": "乙走到画面中央，甲仍在画左，两人侧身相对"},
    ]


def test_segment_drafts_fill_synopsis_and_tail_positions_and_chain_entries(production_pipeline):
    script = _two_segment_script()
    production_pipeline.scripts[script.id] = script
    task = production_pipeline.queue_production_segment_drafts(script.id)
    assert production_pipeline.mark_production_segment_drafts_running(script.id, task["task_id"])

    assert production_pipeline.complete_production_segment_drafts(script.id, task["task_id"], _drafts())

    first, second = production_pipeline.get_script(script.id).production_segments
    assert first["synopsis"] == "甲愤怒地质问妻子乙，乙沉默承受"
    assert first["entry_state"] == "甲位于门口，面向房间内的乙"
    assert second["entry_state"] == first["exit_state"]
    assert "乙走到画面中央" in second["screenplay_text"]
    assert not first.get("adopted_at") and first["revision"] == production_segment_revision(first)
    assert "segments_adopted_at" not in script.production_settings
    assert script.production_segment_draft_task["status"] == "completed"


def test_segment_drafts_do_not_overwrite_segments_edited_while_generating(production_pipeline):
    script = _two_segment_script()
    production_pipeline.scripts[script.id] = script
    task = production_pipeline.queue_production_segment_drafts(script.id)
    production_pipeline.mark_production_segment_drafts_running(script.id, task["task_id"])
    production_pipeline.update_production_segment(script.id, "segment-002-2-2", "用户自己写的简介内容", "", "用户自己写的结尾站位")

    assert not production_pipeline.complete_production_segment_drafts(script.id, task["task_id"], _drafts())

    second = script.production_segments[1]
    assert second["synopsis"] == "用户自己写的简介内容"
    assert script.production_segment_draft_task["status"] == "stale"


def test_segment_drafts_reject_incomplete_model_output(production_pipeline):
    script = _two_segment_script()
    production_pipeline.scripts[script.id] = script
    task = production_pipeline.queue_production_segment_drafts(script.id)
    production_pipeline.mark_production_segment_drafts_running(script.id, task["task_id"])

    with pytest.raises(ValueError, match="第2段"):
        production_pipeline.complete_production_segment_drafts(script.id, task["task_id"], _drafts()[:1])
    with pytest.raises(ValueError, match="已在后台生成"):
        production_pipeline.queue_production_segment_drafts(script.id)
