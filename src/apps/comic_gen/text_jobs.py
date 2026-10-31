"""文本模型后台任务：POST 立刻返回 job_id，线程里调 LLM，前端轮询。

为什么不让接口同步等：网关前有 Cloudflare，约 100 秒收不到字节就 524，长文本一次
请求可以等到 3 分钟以上；同步接口期间界面没有任何反馈，失败时才一次性报错，看起来
就是「没反应」。后台任务把「等」和「请求」解耦：前端每隔几秒轮询，随时能看到
排队/生成中/重试中/失败原因。

任务只保存在进程内存里（与 Motion 提示词任务同一约定）：重启即丢，调用方重新发起。
"""
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Dict, Optional

MAX_JOBS = 50
JOB_TTL_SECONDS = 3600
PUBLIC_FIELDS = ("job_id", "status", "result", "model", "error", "attempt", "note")

_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="text-job")
_jobs: Dict[str, Dict[str, Any]] = {}
_lock = threading.Lock()


def _prune() -> None:
    now = time.time()
    finished = [k for k, v in _jobs.items() if v["status"] in ("done", "failed") and now - v["updated_at"] > JOB_TTL_SECONDS]
    for key in finished:
        _jobs.pop(key, None)
    overflow = len(_jobs) - MAX_JOBS
    if overflow > 0:
        oldest = sorted((v["updated_at"], k) for k, v in _jobs.items() if v["status"] in ("done", "failed"))
        for _, key in oldest[:overflow]:
            _jobs.pop(key, None)


def submit(work: Callable[[Callable[[Dict[str, Any]], None]], Dict[str, Any]]) -> Dict[str, Any]:
    """提交任务。`work(progress)` 返回 {"result": str, "model": str}；抛异常即失败。"""
    job_id = f"textjob_{uuid.uuid4().hex[:12]}"
    job = {"job_id": job_id, "status": "queued", "result": "", "model": "", "error": "", "attempt": 1, "note": "", "updated_at": time.time()}
    with _lock:
        _prune()
        _jobs[job_id] = job

    def progress(event: Dict[str, Any]) -> None:
        job["attempt"] = event.get("attempt", job["attempt"])
        job["note"] = f"网关暂时失败，正在换用 {event.get('model')} 重试：{event.get('reason', '')}"
        job["updated_at"] = time.time()

    def run() -> None:
        job["status"] = "running"
        job["updated_at"] = time.time()
        try:
            outcome = work(progress)
            job.update(status="done", result=outcome.get("result", ""), model=outcome.get("model", ""), error="", note="")
        except Exception as exc:  # noqa: BLE001 — 任何失败都要落到任务状态里，不能吞掉
            job.update(status="failed", error=str(exc), note="")
        job["updated_at"] = time.time()

    _executor.submit(run)
    return snapshot(job)


def snapshot(job: Dict[str, Any]) -> Dict[str, Any]:
    return {key: job.get(key) for key in PUBLIC_FIELDS}


def get(job_id: str) -> Optional[Dict[str, Any]]:
    job = _jobs.get(job_id)
    return snapshot(job) if job else None
