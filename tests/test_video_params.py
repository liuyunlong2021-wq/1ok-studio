"""Tests for model-adaptive video parameters feature.

Covers:
- VideoTask model new fields (models.py)
- CreateVideoTaskRequest new fields (api.py)
- Pipeline routing of new params to Kling/Vidu adapters
"""
import pytest
from pydantic import ValidationError


# ── models.py: VideoTask 新字段 ──────────────────────────────────────────

class TestVideoTaskModel:
    """Verify that VideoTask accepts the new Kling/Vidu fields."""

    def _make_task(self, **overrides):
        from src.apps.comic_gen.models import VideoTask
        defaults = dict(
            id="t-1",
            project_id="p-1",
            image_url="https://example.com/img.png",
            prompt="A cinematic shot",
        )
        defaults.update(overrides)
        return VideoTask(**defaults)

    def test_default_new_fields_are_none(self):
        task = self._make_task()
        assert task.mode is None
        assert task.sound is None
        assert task.cfg_scale is None
        assert task.vidu_audio is None
        assert task.movement_amplitude is None

    def test_kling_fields(self):
        task = self._make_task(mode="pro", sound="on", cfg_scale=0.7)
        assert task.mode == "pro"
        assert task.sound == "on"
        assert task.cfg_scale == pytest.approx(0.7)

    def test_vidu_fields(self):
        task = self._make_task(vidu_audio=True, movement_amplitude="large")
        assert task.vidu_audio is True
        assert task.movement_amplitude == "large"

    def test_all_fields_together(self):
        task = self._make_task(
            mode="std", sound="off", cfg_scale=0.3,
            vidu_audio=False, movement_amplitude="small",
        )
        assert task.mode == "std"
        assert task.sound == "off"
        assert task.cfg_scale == pytest.approx(0.3)
        assert task.vidu_audio is False
        assert task.movement_amplitude == "small"

    def test_backwards_compatible_without_new_fields(self):
        """Existing code that doesn't pass new fields should still work."""
        task = self._make_task(
            duration=10, seed=42, resolution="1080p",
            generate_audio=True, prompt_extend=False,
            negative_prompt="blurry", model="wan2.6-i2v",
            shot_type="multi", generation_mode="i2v",
        )
        assert task.duration == 10
        assert task.model == "wan2.6-i2v"
        # New fields default to None
        assert task.mode is None
        assert task.vidu_audio is None


# ── api.py: CreateVideoTaskRequest 新字段 ────────────────────────────────

class TestCreateVideoTaskRequest:
    """Verify the API request model accepts new params."""

    def _make_request(self, **overrides):
        import sys, importlib
        # 需要直接 import api 模块中的 request model
        from src.apps.comic_gen.api import CreateVideoTaskRequest
        defaults = dict(
            image_url="https://example.com/img.png",
            prompt="test prompt",
        )
        defaults.update(overrides)
        return CreateVideoTaskRequest(**defaults)

    def test_defaults(self):
        req = self._make_request()
        assert req.mode is None
        assert req.sound is None
        assert req.cfg_scale is None
        assert req.vidu_audio is None
        assert req.movement_amplitude is None

    def test_kling_params(self):
        req = self._make_request(mode="pro", sound="on", cfg_scale=0.8)
        assert req.mode == "pro"
        assert req.sound == "on"
        assert req.cfg_scale == pytest.approx(0.8)

    def test_vidu_params(self):
        req = self._make_request(vidu_audio=False, movement_amplitude="medium")
        assert req.vidu_audio is False
        assert req.movement_amplitude == "medium"


# ── kling.py: generate() 接受并传入 sound / cfg_scale ───────────────────

