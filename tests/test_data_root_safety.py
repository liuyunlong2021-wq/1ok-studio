"""Regression tests for the data-root drift that split projects across two roots.

Background: every runtime path in the backend is relative (`output/projects.json`,
`output/assets/...`, the `/files` StaticFiles mounts), so which physical data
root you got used to follow the launcher's cwd:

  * ``npm run dev`` / ``start_backend.sh`` / ``tauri dev`` -> ``<repo>/output``
  * packaged app (``sidecar_entry.py``) -> ``~/.1okstudio/output``

Projects created under one launcher were invisible under the other. Worse, a
truncated ``projects.json`` was logged and treated as "no projects", and the next
save wrote that emptiness back over the real data.

The tests below build a *bare* ``ComicGenPipeline`` via ``object.__new__`` so the
real ``__init__`` side effects (Demucs warmup thread, orphan-task recovery) can
never touch a real data root.
"""

import json
import os
from pathlib import Path
from unittest.mock import patch

import pytest

from src.apps.comic_gen.pipeline import ComicGenPipeline, _atomic_write_json, _load_json_store
from src.utils import ensure_user_data_dir, get_user_data_dir


# ---------------------------------------------------------------------------
# ensure_user_data_dir — one data root for every launcher
# ---------------------------------------------------------------------------
def test_ensure_user_data_dir_creates_dir_and_chdirs(tmp_path):
    original_cwd = os.getcwd()
    target = tmp_path / "data-root"
    try:
        with patch.dict(os.environ, {"ONEOKSTUDIO_DATA_DIR": str(target)}):
            assert get_user_data_dir() == str(target)
            returned = ensure_user_data_dir()
            assert returned == str(target)
            assert target.is_dir()
            assert os.path.realpath(os.getcwd()) == os.path.realpath(str(target))
    finally:
        os.chdir(original_cwd)


# ---------------------------------------------------------------------------
# _load_json_store — corruption must never look like "no data"
# ---------------------------------------------------------------------------
def test_load_json_store_returns_none_when_absent(tmp_path):
    assert _load_json_store(str(tmp_path / "projects.json"), "projects.json") is None


def test_load_json_store_raises_and_preserves_truncated_file(tmp_path):
    store = tmp_path / "projects.json"
    store.write_text('{"abc": {"title": "三国", "fr', encoding="utf-8")

    with pytest.raises(RuntimeError, match="could not be parsed"):
        _load_json_store(str(store), "projects.json")

    # Original untouched, and a copy kept for recovery.
    assert store.exists()
    assert store.read_text(encoding="utf-8").startswith('{"abc"')
    preserved = list(tmp_path.glob("projects.json.corrupt-*"))
    assert len(preserved) == 1
    assert preserved[0].read_text(encoding="utf-8") == store.read_text(encoding="utf-8")


def test_pipeline_does_not_treat_truncated_projects_as_empty(tmp_path):
    store = tmp_path / "projects.json"
    store.write_text('[{"title": "三国"', encoding="utf-8")

    pipeline = object.__new__(ComicGenPipeline)
    pipeline.data_file = str(store)

    with pytest.raises(RuntimeError, match="NOT overwritten"):
        pipeline._load_data()

    assert store.read_text(encoding="utf-8") == '[{"title": "三国"'


# ---------------------------------------------------------------------------
# _atomic_write_json — no partial files, previous version kept
# ---------------------------------------------------------------------------
def test_atomic_write_json_keeps_backup_and_leaves_no_tempfile(tmp_path):
    store = tmp_path / "projects.json"

    _atomic_write_json(str(store), {"v": 1})
    assert json.loads(store.read_text(encoding="utf-8")) == {"v": 1}
    # First write has nothing to back up yet.
    assert not (tmp_path / "projects.json.bak").exists()

    _atomic_write_json(str(store), {"v": 2})
    assert json.loads(store.read_text(encoding="utf-8")) == {"v": 2}
    assert json.loads((tmp_path / "projects.json.bak").read_text(encoding="utf-8")) == {"v": 1}
    assert not (tmp_path / "projects.json.tmp").exists()


def test_save_data_is_round_trippable_through_the_loader(tmp_path):
    store = tmp_path / "projects.json"

    pipeline = object.__new__(ComicGenPipeline)
    pipeline.data_file = str(store)
    pipeline.scripts = {}
    pipeline._save_lock = __import__("threading").RLock()

    pipeline._save_data()
    assert json.loads(store.read_text(encoding="utf-8")) == {}
    assert pipeline._load_data() == {}
