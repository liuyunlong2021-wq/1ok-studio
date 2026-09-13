"""Regression: a save must not be skipped because another thread touched the store.

Every handler is a sync ``def``, so FastAPI runs them on anyio's threadpool and
they overlap freely. ``_save_data`` serialized ``self.scripts`` inside
``self._save_lock``, but the callers that *change* that dict mutate it **outside**
the lock — three separate places:

  * ``create_project``      -> ``self.scripts[script.id] = script``
  * ``reparse_project``     -> ``self.scripts[script_id] = new_script``
  * ``DELETE /projects/{id}`` -> ``del pipeline.scripts[script_id]``

So a project created (or deleted) while a background task was mid-save raised
``RuntimeError: dictionary changed size during iteration``, which ``_save_data``
caught with a blanket ``except Exception`` and logged as a generic write failure.
The whole save was silently skipped — the change only reached disk on some later
save, and never at all if the process died first.

Fix: snapshot the item list before serializing. The dict-size check can no longer
fire, and "the new entry isn't in *this* snapshot" is a legitimate outcome that
the next save picks up.

``ComicGenPipeline`` is built with ``object.__new__`` (same convention as
``test_data_root_safety.py``) so ``__init__``'s side effects — Demucs warmup,
orphan-task recovery — never touch a real data root.
"""

import json
import logging
import threading
import time

import pytest

from src.apps.comic_gen.models import Script
from src.apps.comic_gen.pipeline import ComicGenPipeline


def _bare_pipeline(tmp_path):
    pipeline = object.__new__(ComicGenPipeline)
    pipeline.data_file = str(tmp_path / "projects.json")
    pipeline.series_data_file = str(tmp_path / "series.json")
    pipeline.library_data_file = str(tmp_path / "library_assets.json")
    pipeline.scripts = {}
    pipeline.series_store = {}
    pipeline._save_lock = threading.RLock()
    return pipeline


def _script(sid: str) -> Script:
    now = time.time()
    return Script(id=sid, title=sid, original_text="", created_at=now, updated_at=now)


class _SaveFailureWatch(logging.Handler):
    """Captures _save_data's swallowed-failure log line.

    Match on the shared prefix — the series/library savers log
    "Failed to save series data" / "Failed to save library data", and a
    narrower match silently lets those through (which it did: the series
    test passed even with the bug still in place).
    """

    def __init__(self):
        super().__init__()
        self.messages = []

    def emit(self, record):
        message = record.getMessage()
        if "Failed to save" in message:
            self.messages.append(message)


@pytest.fixture
def save_failures():
    watch = _SaveFailureWatch()
    logger = logging.getLogger("src.apps.comic_gen.pipeline")
    logger.addHandler(watch)
    try:
        yield watch
    finally:
        logger.removeHandler(watch)


def test_save_survives_a_mutation_during_serialization(tmp_path, save_failures):
    """The exact interleaving: another thread inserts a project mid-save.

    Injected rather than raced so the test is deterministic — the point is that
    the window exists at all, and a timer-based test would just flake.
    """
    pipeline = _bare_pipeline(tmp_path)
    for i in range(5):
        pipeline.scripts[f"seed-{i}"] = _script(f"seed-{i}")

    injected = []
    original_dict = Script.dict

    def dict_with_concurrent_insert(self, *args, **kwargs):
        if not injected:
            # Stand-in for create_project running on another threadpool worker.
            injected.append(True)
            pipeline.scripts["concurrent-new"] = _script("concurrent-new")
        return original_dict(self, *args, **kwargs)

    Script.dict = dict_with_concurrent_insert
    try:
        pipeline._save_data()
    finally:
        Script.dict = original_dict

    assert injected, "注入没触发，这个测试就白跑了"
    assert not save_failures.messages, f"保存被跳过了: {save_failures.messages}"

    # 快照可以不含并发插入的那条（下次保存自然带上），但已有的必须都在。
    on_disk = json.loads((tmp_path / "projects.json").read_text(encoding="utf-8"))
    assert {f"seed-{i}" for i in range(5)} <= set(on_disk)


def test_save_survives_a_deletion_during_serialization(tmp_path, save_failures):
    """Same window, other direction: DELETE /projects/{id} mid-save.

    快照是删除之前取的，所以被删的那条可能还在这一版文件里 —— 这是允许的
    （下一次保存就没了）。要紧的是：保存不能因此被整个跳过。
    """
    pipeline = _bare_pipeline(tmp_path)
    for i in range(5):
        pipeline.scripts[f"seed-{i}"] = _script(f"seed-{i}")

    deleted = []
    original_dict = Script.dict

    def dict_with_concurrent_delete(self, *args, **kwargs):
        if not deleted:
            deleted.append(True)
            del pipeline.scripts["seed-4"]
        return original_dict(self, *args, **kwargs)

    Script.dict = dict_with_concurrent_delete
    try:
        pipeline._save_data()
    finally:
        Script.dict = original_dict

    assert deleted
    assert not save_failures.messages, f"保存被跳过了: {save_failures.messages}"

    on_disk = json.loads((tmp_path / "projects.json").read_text(encoding="utf-8"))
    assert {"seed-0", "seed-1", "seed-2", "seed-3"} <= set(on_disk)

    # 再来一次：这次没人在改，删除必须落盘。
    pipeline._save_data()
    on_disk = json.loads((tmp_path / "projects.json").read_text(encoding="utf-8"))
    assert "seed-4" not in on_disk


def test_series_save_survives_a_mutation_during_serialization(tmp_path, save_failures):
    """series.json has the same shape, so it gets the same guard."""
    from src.apps.comic_gen.models import Series

    pipeline = _bare_pipeline(tmp_path)
    now = time.time()
    pipeline.series_store = {
        "s-1": Series(id="s-1", title="t", description="", created_at=now, updated_at=now),
    }

    injected = []
    original_dump = Series.model_dump

    def dump_with_concurrent_insert(self, *args, **kwargs):
        if not injected:
            injected.append(True)
            pipeline.series_store["s-2"] = Series(
                id="s-2", title="t2", description="", created_at=now, updated_at=now,
            )
        return original_dump(self, *args, **kwargs)

    Series.model_dump = dump_with_concurrent_insert
    try:
        pipeline._save_series_data()
    finally:
        Series.model_dump = original_dump

    assert injected
    assert not save_failures.messages
