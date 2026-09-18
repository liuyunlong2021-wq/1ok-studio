"""视频任务的「回捞」：后端重启 / 轮询超时 / 产物下载被拦之后，能不能把已经生成好的
视频拿回来。

背景（2026-09-17 用户报的「后台明明成功了，界面显示失败」）：
  1. 上游任务号从来没被存下来（`provider_task_id` 字段存在但没人写），所以失败之后
     连「按 id 再问一次」都做不到；
  2. 失败时也不写 `task.error`，界面只能显示「未知错误，请重试」；
  3. 产物下载一次不成就把任务判死 —— 实测那种 403 是瞬时的。

这三条都要有护栏，不然下次还是同一个坑。
"""
import time
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from src.apps.comic_gen import api as api_mod
from src.apps.comic_gen.models import Script, VideoTask
from src.models import jiucaihezi


PROJECT_ID = "test-project"
TASK_ID = "task-local-1"
GATEWAY_TASK_ID = "task_GATEWAY1234567890"


def _script(**task_overrides) -> Script:
    now = time.time()
    task = VideoTask(
        id=TASK_ID,
        project_id=PROJECT_ID,
        frame_id="frame-1",
        image_url="assets/input.png",
        prompt="人物向前走",
        model="海seedance2.5",
        duration=5,
        **task_overrides,
    )
    return Script(
        id=PROJECT_ID,
        title="回捞测试",
        original_text="demo",
        frames=[],
        video_tasks=[task],
        created_at=now,
        updated_at=now,
    )


def _client(monkeypatch, script: Script) -> TestClient:
    monkeypatch.setattr(api_mod.pipeline, "get_script", lambda sid: script if sid == PROJECT_ID else None)
    monkeypatch.setattr(api_mod.pipeline, "_save_data", lambda: None)
    monkeypatch.setattr(api_mod.pipeline, "scripts", {PROJECT_ID: script})
    return TestClient(api_mod.app)


def _patch_jiucaihezi(monkeypatch, *, status_payload=None, query=None, download=None):
    """把网关那一侧全换成可控的假实现（不联网、不计费）。"""
    monkeypatch.setattr(
        jiucaihezi, "query_video_task",
        query or (lambda task_id: status_payload or {"status": "completed"}),
    )
    if download is not None:
        monkeypatch.setattr(jiucaihezi, "download_video_content", download)
    # 轮询间隔是 10 秒，测试里必须拿掉，否则一条用例就在那儿干等。
    monkeypatch.setattr(jiucaihezi, "VIDEO_POLL_INTERVAL", 0)


# ---------------------------------------------------------------------------
# 1. 提交时把上游任务号落盘
# ---------------------------------------------------------------------------

def test_submit_persists_the_provider_task_id(monkeypatch):
    """`on_task_id` 一被调用就要写进任务 —— 这是回捞的唯一凭据。

    以前这个字段从没被写过，所以失败之后无从查起。
    """
    script = _script(status="processing")
    pipeline = api_mod.pipeline
    monkeypatch.setattr(pipeline, "get_script", lambda sid: script if sid == PROJECT_ID else None)
    monkeypatch.setattr(pipeline, "_save_data", lambda: None)

    fake_model = MagicMock()

    def fake_generate(**kwargs):
        kwargs["on_task_id"](GATEWAY_TASK_ID)       # 真实实现一拿到号就回调
        return "output/video/test.mp4", 1.0

    fake_model.generate.side_effect = fake_generate
    monkeypatch.setattr(pipeline, "_jiucaihezi_video_model", fake_model, raising=False)
    monkeypatch.setattr(pipeline, "_download_temp_image", lambda url: None, raising=False)

    pipeline.process_video_task(PROJECT_ID, TASK_ID)

    task = script.video_tasks[0]
    assert task.provider_task_id == GATEWAY_TASK_ID, "上游任务号没落盘"
    assert task.provider_name == "jiucaihezi"


# ---------------------------------------------------------------------------
# 2. 回捞：按已有任务号续跑，绝不重新提交
# ---------------------------------------------------------------------------

def test_resume_adopts_an_upstream_result_without_resubmitting(monkeypatch):
    """回捞成功 = 任务变 completed + 有产物，且**没有**再提交一次。"""
    script = _script(status="failed", error="下载被拦了一下", provider_task_id=GATEWAY_TASK_ID)
    pipeline = api_mod.pipeline
    monkeypatch.setattr(pipeline, "get_script", lambda sid: script if sid == PROJECT_ID else None)
    monkeypatch.setattr(pipeline, "_save_data", lambda: None)

    submitted = MagicMock()
    monkeypatch.setattr(pipeline, "_jiucaihezi_video_model", submitted, raising=False)

    import os
    def fake_download(task_id, output_path):
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        with open(output_path, "wb") as handle:
            handle.write(b"fake-mp4")
        return output_path

    _patch_jiucaihezi(monkeypatch, status_payload={"status": "completed"}, download=fake_download)

    pipeline.process_video_task(PROJECT_ID, TASK_ID, resume=True)

    task = script.video_tasks[0]
    assert task.status == "completed", task.error
    assert task.video_url and task.video_url.endswith(".mp4")
    assert task.error is None
    submitted.generate.assert_not_called()  # ← 关键：回捞绝不重新提交（会重复计费）


def test_resume_reports_the_upstream_failure_reason(monkeypatch):
    """上游说失败 → 把上游的原因带回来，而不是一句「未知错误」。"""
    script = _script(status="failed", provider_task_id=GATEWAY_TASK_ID)
    pipeline = api_mod.pipeline
    monkeypatch.setattr(pipeline, "get_script", lambda sid: script if sid == PROJECT_ID else None)
    monkeypatch.setattr(pipeline, "_save_data", lambda: None)
    _patch_jiucaihezi(monkeypatch, status_payload={"status": "failed", "error": {"message": "内容审核未通过"}})

    pipeline.process_video_task(PROJECT_ID, TASK_ID, resume=True)

    assert script.video_tasks[0].status == "failed"
    assert "内容审核未通过" in (script.video_tasks[0].error or "")


def test_resume_endpoint_rejects_a_task_without_a_provider_id(monkeypatch):
    """没有上游任务号的任务无法回捞 —— 要说清楚，而不是转圈。"""
    script = _script(status="failed")
    client = _client(monkeypatch, script)

    response = client.post(f"/projects/{PROJECT_ID}/video_tasks/{TASK_ID}/resume")

    assert response.status_code == 400, response.text
    assert "任务号" in response.json()["detail"]


def test_resume_endpoint_queues_the_task_and_flips_it_back_to_processing(monkeypatch):
    """端点只负责排队：把后台任务换成记录器，断言它带着 resume=True 被排上。

    （不能让它真跑：TestClient 会等 BackgroundTasks 跑完，那就真去轮询网关了。）
    """
    script = _script(status="failed", error="下载被拦了一下", provider_task_id=GATEWAY_TASK_ID)
    client = _client(monkeypatch, script)
    queued = []
    monkeypatch.setattr(api_mod, "process_video_task",
                        lambda sid, tid, resume=False: queued.append((sid, tid, resume)))

    response = client.post(f"/projects/{PROJECT_ID}/video_tasks/{TASK_ID}/resume")

    assert response.status_code == 200, response.text
    assert queued == [(PROJECT_ID, TASK_ID, True)], "回捞必须以 resume=True 排队"
    assert response.json()["provider_task_id"] == GATEWAY_TASK_ID
    assert response.json()["status"] == "processing", "点完要立刻回到「生成中」，别再显示失败"


# ---------------------------------------------------------------------------
# 3. 失败原因必须落在任务上（以前是空的 → 界面「未知错误，请重试」）
# ---------------------------------------------------------------------------

def test_failure_stores_the_reason_and_points_at_the_rescue(monkeypatch):
    script = _script(status="processing")
    pipeline = api_mod.pipeline
    monkeypatch.setattr(pipeline, "get_script", lambda sid: script if sid == PROJECT_ID else None)
    monkeypatch.setattr(pipeline, "_save_data", lambda: None)
    monkeypatch.setattr(pipeline, "_download_temp_image", lambda url: None, raising=False)

    fake_model = MagicMock()

    def fake_generate(**kwargs):
        kwargs["on_task_id"](GATEWAY_TASK_ID)
        raise RuntimeError("Jiucaihezi video content download failed (403): request blocked")

    fake_model.generate.side_effect = fake_generate
    monkeypatch.setattr(pipeline, "_jiucaihezi_video_model", fake_model, raising=False)

    pipeline.process_video_task(PROJECT_ID, TASK_ID)

    task = script.video_tasks[0]
    assert task.status == "failed"
    assert "403" in (task.error or ""), "失败原因丢了，界面只剩「未知错误」"
    assert GATEWAY_TASK_ID in (task.error or ""), "要告诉用户还有回捞这条路"


# ---------------------------------------------------------------------------
# 4. 后端重启后的提示：有任务号就别催用户重新生成
# ---------------------------------------------------------------------------

def test_orphan_recovery_keeps_the_provider_id_and_says_it_is_resumable(monkeypatch):
    resumable = _script(status="processing", provider_task_id=GATEWAY_TASK_ID)
    hopeless = VideoTask(
        id="task-local-2", project_id=PROJECT_ID, image_url="a.png",
        prompt="x", status="processing", model="海seedance2.5",
    )
    resumable.video_tasks.append(hopeless)
    pipeline = api_mod.pipeline
    monkeypatch.setattr(pipeline, "scripts", {PROJECT_ID: resumable})

    pipeline._recover_orphan_tasks()

    a, b = resumable.video_tasks
    assert a.provider_task_id == GATEWAY_TASK_ID, "任务号不能被回收逻辑清掉"
    assert "回捞" in (a.error or ""), "有任务号就该提示回捞，而不是让人重新生成"
    assert b.provider_task_id is None and "Retry" in (b.error or "")


# ---------------------------------------------------------------------------
# 5. 下载重试：瞬时故障不该把任务判死
# ---------------------------------------------------------------------------

def test_download_retries_before_giving_up(monkeypatch):
    attempts = []

    def flaky(task_id, output_path):
        attempts.append(task_id)
        raise RuntimeError("Jiucaihezi video content download failed (403)")

    monkeypatch.setattr(jiucaihezi, "_download_video_content", flaky)
    monkeypatch.setattr(jiucaihezi.time, "sleep", lambda _s: None)

    with pytest.raises(RuntimeError) as excinfo:
        jiucaihezi.download_video_content(GATEWAY_TASK_ID, "/tmp/never.mp4", attempts=3)

    assert len(attempts) == 3, "没有重试"
    assert GATEWAY_TASK_ID in str(excinfo.value), "报错里要带上上游任务号，否则查不出是哪个任务"


def test_orphan_recovery_backfills_a_reason_for_old_failures(monkeypatch):
    """旧版本失败时不留原因 → 界面显示「未知错误，请重试」，用户无从判断。

    这类记录补一句能说清的话（顺手说明上游任务号也没保存），别再归到「未知」。
    """
    script = _script(status="failed", error=None)
    pipeline = api_mod.pipeline
    monkeypatch.setattr(pipeline, "scripts", {PROJECT_ID: script})

    pipeline._recover_orphan_tasks()

    reason = script.video_tasks[0].error or ""
    assert reason, "失败原因仍然是空的 —— 界面还会显示「未知错误」"
    assert "重新生成" in reason
