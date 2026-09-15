"""全局文本模型 —— 守住「改一次，全局生效」这条结构。

`output/settings.json` 是文本模型的唯一真值来源。这个文件挡两类回归：

1. 有人又把文本模型做回「每个项目/系列各存一份」—— 那正是「在设置里改了、
   项目里还是老模型」的成因；
2. 收敛点（`pipeline.get_effective_polish_model`）绕开全局设置去读别的地方。
"""

import json
import time
from unittest.mock import patch

import pytest

from src.apps.comic_gen.models import ModelSettings, PromptConfig, Script
from src.apps.comic_gen.pipeline import ComicGenPipeline
from src.utils.global_settings import (
    SETTINGS_FILE,
    get_active_text_model,
    get_global_text_model,
    set_global_text_model,
)
from src.utils.model_catalog import get_default_model_settings

CATALOG_DEFAULT = get_default_model_settings().text_model


def _read() -> dict:
    with open(SETTINGS_FILE, "r", encoding="utf-8") as handle:
        return json.load(handle)


def _write(payload: dict) -> None:
    with open(SETTINGS_FILE, "w", encoding="utf-8") as handle:
        json.dump(payload, handle)


# ---------------------------------------------------------------------------
# 1. 存储层
# ---------------------------------------------------------------------------

def test_missing_file_falls_back_to_catalog_default():
    """文件不存在 = 用目录默认值，所以上线那一刻行为没变，不需要迁移。"""
    assert get_global_text_model() == CATALOG_DEFAULT


def test_round_trip():
    assert set_global_text_model("gemini-3.8-flash") == "gemini-3.8-flash"
    assert get_global_text_model() == "gemini-3.8-flash"


def test_blank_reverts_to_catalog_default():
    set_global_text_model("gemini-3.8-flash")
    assert set_global_text_model("   ") == CATALOG_DEFAULT


def test_corrupt_file_falls_back_instead_of_raising():
    """设置文件只决定用哪个模型，读坏了最多回落默认值，不该把生成打挂。"""
    with open(SETTINGS_FILE, "w", encoding="utf-8") as handle:
        handle.write("{ not json at all")
    assert get_global_text_model() == CATALOG_DEFAULT


def test_writing_keeps_other_keys():
    """settings.json 以后会长别的设置，写文本模型不能顺手抹掉它们。"""
    _write({"keep_me": 42})
    set_global_text_model("gemini-3.8-flash")
    assert _read() == {"keep_me": 42, "text_model": "gemini-3.8-flash"}


def test_without_credentials_returns_empty(monkeypatch):
    """没有韭菜盒子凭证时回空串，让 LLMAdapter 走自己的 DashScope 链路。"""
    monkeypatch.delenv("JIUCAIHEZI_API_KEY", raising=False)
    set_global_text_model("gemini-3.8-flash")
    assert get_active_text_model() == ""

    monkeypatch.setenv("JIUCAIHEZI_API_KEY", "test-key")
    assert get_active_text_model() == "gemini-3.8-flash"


# ---------------------------------------------------------------------------
# 2. 收敛点
# ---------------------------------------------------------------------------

@pytest.fixture
def pipeline(tmp_path):
    with patch("src.apps.comic_gen.pipeline.ScriptProcessor"), \
         patch("src.apps.comic_gen.pipeline.AssetGenerator"), \
         patch("src.apps.comic_gen.pipeline.StoryboardGenerator"), \
         patch("src.apps.comic_gen.pipeline.VideoGenerator"), \
         patch("src.apps.comic_gen.pipeline.AudioGenerator"), \
         patch("src.apps.comic_gen.pipeline.ExportManager"):
        p = ComicGenPipeline()
    p.data_file = str(tmp_path / "projects.json")
    p.series_data_file = str(tmp_path / "series.json")
    p.scripts = {}
    p.series_store = {}
    return p


def _make_script(**overrides) -> Script:
    now = time.time()
    defaults = dict(id="s1", title="Episode 1", original_text="text", created_at=now, updated_at=now)
    defaults.update(overrides)
    return Script(**defaults)


def test_stale_per_project_text_model_is_ignored(pipeline, monkeypatch):
    """项目里存着的 text_model / polish_model 都不该再被读。

    这是最容易漏的一处：两个字段在存量 JSON 里都还在，谁顺手读一下,
    「全局改一次全都跟着走」就又断了。
    """
    monkeypatch.setenv("JIUCAIHEZI_API_KEY", "test-key")
    set_global_text_model("gemini-3.8-flash")
    script = _make_script(
        model_settings=ModelSettings(text_model="some-other-model"),
        prompt_config=PromptConfig(polish_model="another-stale-model"),
    )
    assert pipeline.get_effective_polish_model(script) == "gemini-3.8-flash"


def test_changing_the_global_applies_without_resaving_the_project(pipeline, monkeypatch):
    """改全局 → 同一个 script 对象立刻换模型，不用重存项目、不用重启。"""
    monkeypatch.setenv("JIUCAIHEZI_API_KEY", "test-key")
    script = _make_script()

    set_global_text_model("gemini-3.8-flash")
    assert pipeline.get_effective_polish_model(script) == "gemini-3.8-flash"

    set_global_text_model("claude-sonnet-5")
    assert pipeline.get_effective_polish_model(script) == "claude-sonnet-5"
