import hashlib
import json
import time

from fastapi.testclient import TestClient

from src.apps.comic_gen import api as api_mod
from src.apps.comic_gen.models import ArtDirection, Scene, Script
from src.apps.comic_gen.production_workflow import PRODUCTION_WORKFLOW_ID, production_segment_revision, production_settings_revision, style_revision


def _production_script():
    script = Script(id="production-api", title="手动六步", original_text="剧本", created_at=time.time(), updated_at=time.time())
    script.production_workflow = PRODUCTION_WORKFLOW_ID
    skill_content = "按本项目模板生成视频提示词"
    skill_hash = hashlib.sha256(skill_content.encode()).hexdigest()
    script.production_settings = {
        "revision": "settings-r1", "aspect_ratio": "9:16", "motion_skill_id": "motion-1",
        "motion_skill_hash": skill_hash, "motion_skill_name": "测试 Skill",
    }
    style = {"name": "电影感", "positive_prompt": "冷色电影光", "negative_prompt": "不做卡通"}
    script.art_direction = ArtDirection(selected_style_id="cinematic", style_config=style)
    script.production_style_revision = style_revision(script.art_direction)
    script.production_style_confirmed_at = time.time()
    script.scenes = [Scene(id="scene-1", name="旧宅", description="深夜的旧宅客厅")]
    script.production_segments = [{
        "id": "segment-1", "index": 1, "duration_story": 3, "duration_total": 4, "tail_seconds": 1,
        "synopsis": "甲愤怒地质问妻子乙，乙沉默承受线索被发现",
        "entry_state": "甲在门口，乙在桌旁", "exit_state": "甲在左，乙在右，相距两米",
        "source_shot_numbers": [1], "source_frame_ids": ["frame-1"],
        "asset_refs": [{"kind": "scenes", "id": "scene-1", "number": 1, "name": "旧宅", "image_url": "output/scene.png"}],
        "style": {"name": "电影感", "positive_prompt": "冷色电影光", "negative_prompt": "不做卡通"},
        "shots": [{"local_number": 1, "start": 0, "end": 3, "body": "剧情镜头"}],
        "screenplay_text": "四段式段包", "adopted_at": time.time(),
    }]
    script.production_settings["revision"] = production_settings_revision(script.production_settings, script.production_style_revision)
    script.production_segments[0]["settings_revision"] = script.production_settings["revision"]
    script.production_segments[0]["revision"] = production_segment_revision(script.production_segments[0])
    return script


def _client(monkeypatch, script):
    monkeypatch.setattr(api_mod.pipeline, "scripts", {script.id: script})
    monkeypatch.setattr(api_mod.pipeline, "get_script", lambda script_id: script if script_id == script.id else None)
    monkeypatch.setattr(api_mod.pipeline, "get_series", lambda _series_id: None)
    monkeypatch.setattr(api_mod.pipeline, "get_effective_prompt", lambda *args: "风格优先的资产提示词 Skill")
    monkeypatch.setattr(api_mod.pipeline, "get_effective_polish_model", lambda _script: "test-text")
    monkeypatch.setattr(api_mod.pipeline, "save_production_project", lambda _script_id: script)
    return TestClient(api_mod.app)


def test_asset_prompt_generation_is_queued_and_returns_202(monkeypatch):
    script = _production_script()
    client = _client(monkeypatch, script)
    calls = []
    monkeypatch.setattr(api_mod.pipeline.script_processor, "generate_asset_prompt", lambda *args: calls.append(args) or "旧宅概念图提示词")

    response = client.post(f"/projects/{script.id}/production/assets/scene-1/image-prompt/generate")

    assert response.status_code == 202
    assert response.json()["task_id"].startswith("prompt_")
    assert script.scenes[0].image_prompt == "旧宅概念图提示词"
    assert script.scenes[0].prompt_generation_status == "completed"
    assert calls


def test_engineering_generation_is_queued_and_returns_202(monkeypatch):
    script = _production_script()
    script.original_text = "完整原始剧本"
    client = _client(monkeypatch, script)
    skill = {"id": "builtin-engineering", "name": "工程台本", "content": "保留剧情、原台词并按镜头输出"}
    monkeypatch.setattr(api_mod, "_read_script_skills", lambda kind: [skill] if kind == "script" else [])
    screenplay = "镜头一【00:00-00:03】\n角色走进房间。"
    monkeypatch.setattr(api_mod.LLMAdapter, "chat", lambda *args, **kwargs: screenplay)

    response = client.post(f"/projects/{script.id}/production/engineering/generate")

    assert response.status_code == 202
    assert response.json()["task_id"] == script.production_engineering_task["task_id"]
    assert script.production_engineering_task["status"] == "completed"
    assert script.production_engineering_draft["text"] == screenplay
    assert script.engineering_script["shots"][0]["number"] == 1


def test_asset_extraction_preview_is_queued_and_returns_202(monkeypatch):
    script = _production_script()
    client = _client(monkeypatch, script)
    task = {"task_id": "extract-1", "status": "queued"}
    scheduled = []
    monkeypatch.setattr(api_mod.pipeline, "queue_production_asset_extraction", lambda _script_id: task)
    monkeypatch.setattr(api_mod.pipeline, "process_production_asset_extraction_task", lambda *args: scheduled.append(args))

    response = client.post(f"/projects/{script.id}/production/assets/preview")

    assert response.status_code == 202
    assert response.json() == task
    assert scheduled == [(script.id, task["task_id"])]


def test_voice_design_generation_is_queued_and_returns_202(monkeypatch):
    script = _production_script()
    client = _client(monkeypatch, script)
    task = {"task_id": "voice-1", "status": "queued", "reused": False}
    scheduled = []
    monkeypatch.setattr(api_mod.pipeline, "queue_production_voice_design", lambda *_args: task)
    monkeypatch.setattr(api_mod, "_run_production_voice_design_task", lambda *args: scheduled.append(args))

    response = client.post(f"/projects/{script.id}/production/assets/character-1/voice-design/generate")

    assert response.status_code == 202
    assert response.json() == {"task_id": task["task_id"], "status": "queued"}
    assert scheduled == [(script.id, "character-1", task["task_id"])]


def test_segment_prompt_generation_is_queued_and_returns_202(monkeypatch):
    script = _production_script()
    client = _client(monkeypatch, script)
    content = "按本项目模板生成视频提示词"
    skill = {"id": "motion-1", "name": "测试 Skill", "content": content, "updated_at": "r1"}
    monkeypatch.setattr(api_mod, "_read_script_skills", lambda kind: [skill] if kind == "motion" else [])
    monkeypatch.setattr(api_mod.LLMAdapter, "chat", lambda *args, **kwargs: "段视频提示词")

    response = client.post(
        f"/projects/{script.id}/production/segments/segment-1/prompt/generate",
        json={"segment_revision": script.production_segments[0]["revision"]},
    )

    assert response.status_code == 202
    assert response.json()["task_id"].startswith("production_prompt_")
    assert script.production_segments[0]["prompt_generation_status"] == "completed"
    assert script.production_segments[0]["prompt_draft"] == "段视频提示词"


def test_asset_task_response_redacts_signed_artifact_location(monkeypatch):
    monkeypatch.setattr(api_mod.pipeline, "_asset_image_artifact_resumable", lambda _artifact: True)
    signed_url = "https://cdn.example/image.png?signature=signed-secret"
    response = api_mod.signed_response({"asset": {"production_image_task": {
        "task_id": "image-task", "phase": "download_pending",
        "artifacts": [{"variant_id": "v1", "status": "pending_download", "content_type": "image/png",
                       "url": signed_url, "path": "/private/assets/image.png"}],
    }}})

    body = response.body.decode()
    task = json.loads(body)["asset"]["production_image_task"]
    assert task["can_resume"] is True
    assert task["artifacts"] == [{"variant_id": "v1", "status": "pending_download", "content_type": "image/png"}]
    assert "signed-secret" not in body
    assert "/private/assets/image.png" not in body


def test_resume_asset_image_endpoint_only_queues_existing_task(monkeypatch):
    script = _production_script()
    client = _client(monkeypatch, script)
    queued = {"task_id": "image-task", "status": "processing", "phase": "downloading", "reused": False, "can_resume": False}
    calls = []
    monkeypatch.setattr(api_mod.pipeline, "queue_asset_image_recovery", lambda script_id, task_id: queued)
    monkeypatch.setattr(api_mod.pipeline, "process_asset_image_recovery", lambda task_id: calls.append(task_id))

    response = client.post(f"/projects/{script.id}/asset_tasks/image-task/resume")

    assert response.status_code == 200
    assert response.json() == {key: queued[key] for key in ("task_id", "status", "phase", "reused", "can_resume")}
    assert calls == ["image-task"]


def test_segment_drafts_are_generated_in_background_from_one_text_model_call(monkeypatch):
    script = _production_script()
    script.production_segments[0].update(synopsis="", exit_state="")
    script.production_segments[0]["revision"] = production_segment_revision(script.production_segments[0])
    client = _client(monkeypatch, script)
    calls = []

    class FakeAdapter:
        def chat(self, messages, model=None, response_format=None):
            calls.append((messages, model))
            return json.dumps({"segments": [{"id": "segment-1", "synopsis": "甲愤怒地质问妻子乙，乙沉默承受", "exit_state": "甲在画左面向右，乙在画右，相距两米"}]}, ensure_ascii=False)

    monkeypatch.setattr(api_mod, "LLMAdapter", FakeAdapter)
    response = client.post(f"/projects/{script.id}/production/segments/drafts/generate")

    assert response.status_code == 202
    assert len(calls) == 1 and calls[0][1] == "test-text"
    assert "剧情镜头" in calls[0][0][-1]["content"]
    assert script.production_segments[0]["synopsis"] == "甲愤怒地质问妻子乙，乙沉默承受"
    assert script.production_segment_draft_task["status"] == "completed"
