"""队列卡片上的时间：提交 / 开始 / 结束 + 用时。

动机很具体：一次「后台成功、界面失败」，用户手上只有一句「未知错误」，
没法拿任何时间点去后端日志里对。所以每条任务必须落三个时间读数，
失败的那条也要有结束时间，取消同样算结束。
"""

import time

import pytest

from src.apps.comic_gen import api as api_mod
from src.apps.comic_gen.models import Script, VideoTask

PROJECT_ID = "test-project"
TASK_ID = "task-local-1"


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
        title="时间线测试",
        original_text="demo",
        frames=[],
        video_tasks=[task],
        created_at=now,
        updated_at=now,
    )


def _wire(monkeypatch, script: Script):
    pipeline = api_mod.pipeline
    monkeypatch.setattr(pipeline, "get_script", lambda sid: script if sid == PROJECT_ID else None)
    monkeypatch.setattr(pipeline, "scripts", {PROJECT_ID: script})
    monkeypatch.setattr(pipeline, "_save_data", lambda: None)
    monkeypatch.setattr(pipeline, "_download_temp_image", lambda url: None, raising=False)
    return pipeline


def test_create_video_task_records_a_submit_time():
    """新建任务就必须有时间 —— 这是「排了多久」的起点，界面第一行就显示它。"""
    task = VideoTask(
        id="t1", project_id=PROJECT_ID, image_url="a.png", prompt="x",
        model="海seedance2.5", duration=5,
    )
    assert task.created_at > 0
    assert task.started_at == 0.0, "还没被处理，不该有开始时间"
    assert task.finished_at == 0.0, "还没跑完，不该有结束时间"


def test_failure_records_the_full_timeline(monkeypatch):
    """失败也要有开始与结束时间 —— 出问题时才知道「排了多久 / 跑了多久」。"""
    from unittest.mock import MagicMock

    script = _script(status="processing")
    pipeline = _wire(monkeypatch, script)

    fake_model = MagicMock()
    fake_model.generate.side_effect = RuntimeError("上游 502")
    monkeypatch.setattr(pipeline, "_jiucaihezi_video_model", fake_model, raising=False)

    before = time.time()
    pipeline.process_video_task(PROJECT_ID, TASK_ID)
    after = time.time()

    task = script.video_tasks[0]
    assert task.status == "failed"
    assert before <= task.started_at <= after, "开始时间没落"
    assert before <= task.finished_at <= after, "结束时间没落 —— 界面上算不出用时"
    assert task.finished_at >= task.started_at


def test_success_records_the_finish_time(monkeypatch):
    from unittest.mock import MagicMock

    script = _script(status="processing")
    pipeline = _wire(monkeypatch, script)

    fake_model = MagicMock()
    fake_model.generate.return_value = ("output/video/test.mp4", 1.0)
    monkeypatch.setattr(pipeline, "_jiucaihezi_video_model", fake_model, raising=False)

    pipeline.process_video_task(PROJECT_ID, TASK_ID)

    task = script.video_tasks[0]
    assert task.status == "completed"
    assert task.started_at > 0 and task.finished_at >= task.started_at


def test_cancel_marks_a_finish_time(monkeypatch):
    """取消 = 这条跑完了（不再等），所以要有结束时间，否则卡片上一直算着「已等」。"""
    script = _script(status="processing", started_at=time.time() - 60)
    pipeline = _wire(monkeypatch, script)
    started = script.video_tasks[0].started_at

    assert pipeline.mark_video_task_failed(PROJECT_ID, TASK_ID, "Canceled by user")

    task = script.video_tasks[0]
    assert task.status == "failed"
    assert task.started_at == started, "取消不该抹掉开始时间"
    assert task.finished_at > 0, "取消后没有了结时间，界面上「已等」会一直涨"
    assert task.error == "Canceled by user"


def test_completed_task_is_not_downgraded_by_a_late_cancel(monkeypatch):
    """已经成功的任务被「取消」碰到时不能翻成失败，也不能改掉完成时间。"""
    script = _script(status="completed", finished_at=123.0)
    pipeline = _wire(monkeypatch, script)

    assert pipeline.mark_video_task_failed(PROJECT_ID, TASK_ID, "Canceled by user") is False

    task = script.video_tasks[0]
    assert task.status == "completed"
    assert task.finished_at == 123.0


def test_resume_clears_the_stale_finish_time(monkeypatch):
    """回捞后任务回到「正在跑」，上一次的结束时间必须清掉，否则用时是错的。"""
    import os
    from unittest.mock import MagicMock

    from src.models import jiucaihezi

    stale_finish = time.time() - 60
    script = _script(
        status="failed", error="下载被拦了一下", provider_task_id="task_GATEWAY123",
        started_at=time.time() - 300, finished_at=stale_finish,
    )
    pipeline = _wire(monkeypatch, script)
    started = script.video_tasks[0].started_at

    # 回捞只查网关，不再提交一次（会重复计费），所以假实现里没有 generate。
    monkeypatch.setattr(pipeline, "_jiucaihezi_video_model", MagicMock(), raising=False)
    monkeypatch.setattr(jiucaihezi, "query_video_task", lambda task_id: {"status": "completed"})
    monkeypatch.setattr(jiucaihezi, "VIDEO_POLL_INTERVAL", 0)

    def fake_download(task_id, output_path):
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        with open(output_path, "wb") as handle:
            handle.write(b"fake-mp4")
        return output_path

    monkeypatch.setattr(jiucaihezi, "download_video_content", fake_download)

    pipeline.process_video_task(PROJECT_ID, TASK_ID, resume=True)

    task = script.video_tasks[0]
    assert task.status == "completed", task.error
    assert task.started_at == started, "续跑该保留最早那次开始时间"
    assert task.finished_at > stale_finish, "结束时间要更新成本次的"


@pytest.mark.parametrize("status", ["pending", "processing"])
def test_orphan_recovery_also_closes_the_timeline(monkeypatch, status):
    """重启后端时被中断的任务会被判失败 —— 判失败就得给了结时间，
    否则界面上那条卡片会一直算着「已等 N 分」，看着像还在跑。"""
    script = _script(status=status)
    pipeline = _wire(monkeypatch, script)

    pipeline._recover_orphan_tasks()

    task = script.video_tasks[0]
    assert task.status == "failed"
    assert task.finished_at > 0, "被中断的任务没有了结时间，界面会一直显示「已等」"
