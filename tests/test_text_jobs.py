"""文本后台任务与 standardize_script 的 job 契约（不联网）。

Run: `.venv/bin/python -m pytest tests/test_text_jobs.py -q`
"""
import time

from fastapi.testclient import TestClient

from src.apps.comic_gen import api as api_mod
from src.apps.comic_gen import text_jobs
from src.apps.comic_gen.llm_adapter import LLMAdapter
from src.apps.comic_gen.models import Script


def _wait(job_id, timeout=3.0):
    end = time.time() + timeout
    while time.time() < end:
        job = text_jobs.get(job_id)
        if job["status"] in ("done", "failed"):
            return job
        time.sleep(0.02)
    raise AssertionError("job did not finish")


def test_job_runs_in_background_and_exposes_result():
    job = text_jobs.submit(lambda progress: {"result": "结果", "model": "m"})
    assert job["status"] in ("queued", "running", "done")
    done = _wait(job["job_id"])
    assert (done["status"], done["result"], done["model"]) == ("done", "结果", "m")


def test_job_failure_is_recorded_not_swallowed():
    def boom(progress):
        raise RuntimeError("网关挂了")

    done = _wait(text_jobs.submit(boom)["job_id"])
    assert done["status"] == "failed" and "网关挂了" in done["error"]


def test_progress_note_names_the_retry_model():
    def work(progress):
        progress({"state": "retrying", "attempt": 2, "model": "gpt-6.1-sol", "reason": "524"})
        return {"result": "x", "model": ""}

    done = _wait(text_jobs.submit(work)["job_id"])
    assert done["attempt"] == 2 and done["status"] == "done"


def test_standardize_script_returns_202_job_and_poll_gives_text(monkeypatch):
    script = Script(id="p1", title="t", original_text="原文", created_at=time.time(), updated_at=time.time())
    monkeypatch.setattr(api_mod.pipeline, "get_script", lambda sid: script if sid == "p1" else None)
    monkeypatch.setattr(api_mod.pipeline, "get_effective_polish_model", lambda _s: "claude-sonnet-5-5")
    monkeypatch.setattr(LLMAdapter, "chat", lambda self, messages, model=None, response_format=None, progress=None: " 新稿 ")
    client = TestClient(api_mod.app)

    started = client.post("/projects/p1/standardize_script", json={"text": "原文", "instruction": "润色"})
    assert started.status_code == 202
    job_id = started.json()["job_id"]
    done = _wait(job_id)
    polled = client.get(f"/projects/p1/standardize_script/{job_id}").json()
    assert done["status"] == "done" and polled["result"] == "新稿" and polled["model"] == "claude-sonnet-5-5"


def test_standardize_script_failure_keeps_readable_reason(monkeypatch):
    script = Script(id="p1", title="t", original_text="原文", created_at=time.time(), updated_at=time.time())
    monkeypatch.setattr(api_mod.pipeline, "get_script", lambda sid: script)
    monkeypatch.setattr(api_mod.pipeline, "get_effective_polish_model", lambda _s: "")

    def fail(self, messages, model=None, response_format=None, progress=None):
        raise RuntimeError("文本生成失败：网关等待上游文本响应超时（HTTP 504）")

    monkeypatch.setattr(LLMAdapter, "chat", fail)
    client = TestClient(api_mod.app)
    job_id = client.post("/projects/p1/standardize_script", json={"text": "原文", "instruction": "润色"}).json()["job_id"]
    done = _wait(job_id)
    assert done["status"] == "failed" and "标准化失败" in done["error"] and "504" in done["error"]


def test_unknown_job_is_404():
    assert TestClient(api_mod.app).get("/projects/p1/standardize_script/textjob_nope").status_code == 404
