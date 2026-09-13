"""process_video_task 的本地侧契约回归 —— 不碰任何外部服务。

验证：

- 视频任务创建时把输入图快照进 ``output/video_inputs/``，任务记录只存这个快照
  引用，不直接依赖用户本地路径；
- 项目里存的素材引用（character / scene / frame 的 image_url）在生成后保持原样 ——
  请求侧的临时变换（上传到网关、签名 URL）绝不回写项目数据；
- 音频三态（mute / ai / custom）把正确的 ``audio_url`` 交给视频适配器，「AI 配音」
  走 seed-audio-1.0 生成、且生成失败时不白付一次视频费用。

原来这个文件跑的是 wanx / DashScope 适配器，它已随家族收敛删除；现在驱动唯一
在架的韭菜盒子适配器。
"""
import base64
import time
from pathlib import Path
from unittest.mock import patch

import pytest

from src.apps.comic_gen.models import Character, Scene, Script, StoryboardFrame
from src.apps.comic_gen.pipeline import ComicGenPipeline


PNG_1X1_BASE64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+"
    "X2VINQAAAABJRU5ErkJggg=="
)


def _write_output_png(rel_path: str) -> str:
    file_path = Path("output") / rel_path
    file_path.parent.mkdir(parents=True, exist_ok=True)
    file_path.write_bytes(base64.b64decode(PNG_1X1_BASE64))
    return str(file_path)


class _RecordingVideoModel:
    """替代 JiucaiheziVideoModel：只记录调用参数，不联网。"""

    def __init__(self):
        self.calls = []

    def generate(self, prompt, output_path, **kwargs):
        self.calls.append({"prompt": prompt, "output_path": output_path, **kwargs})
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        Path(output_path).write_bytes(b"video")
        return output_path, 0.1


def _build_pipeline(script: Script, video_model) -> ComicGenPipeline:
    pipeline = ComicGenPipeline.__new__(ComicGenPipeline)
    pipeline.scripts = {script.id: script}
    pipeline._save_data = lambda: None
    pipeline._jiucaihezi_video_model = video_model
    pipeline.get_script = lambda script_id: pipeline.scripts.get(script_id)
    return pipeline


def _build_script() -> Script:
    now = time.time()
    character = Character(
        id="char-local",
        name="Local Hero",
        description="A character from local-only flow",
        image_url="uploads/local_only_uploaded.png",
    )
    scene = Scene(
        id="scene-local",
        name="Local Scene",
        description="A scene generated in local-only flow",
        image_url="assets/scenes/local_only_generated.png",
    )
    frame = StoryboardFrame(
        id="frame-local",
        scene_id=scene.id,
        character_ids=[character.id],
        prop_ids=[],
        rendered_image_url="storyboard/local_only_frame.png",
    )
    return Script(
        id="script-local-only",
        title="Local-Only",
        original_text="demo",
        characters=[character],
        scenes=[scene],
        frames=[frame],
        created_at=now,
        updated_at=now,
    )


def test_video_task_snapshots_local_input_and_preserves_project_refs():
    _write_output_png("uploads/local_only_uploaded.png")
    _write_output_png("assets/scenes/local_only_generated.png")
    _write_output_png("storyboard/local_only_frame.png")

    video_model = _RecordingVideoModel()
    script = _build_script()
    pipeline = _build_pipeline(script, video_model)

    _, task_id = pipeline.create_video_task(
        script_id=script.id,
        image_url=script.frames[0].rendered_image_url,
        prompt="Pan and zoom on the character",
        model="dola-seedance2.5",
    )
    task = next(t for t in script.video_tasks if t.id == task_id)

    # 输入图快照进 video_inputs/，任务记录只存快照引用。
    assert task.image_url.startswith("video_inputs/")
    snapshot = Path("output") / task.image_url
    assert snapshot.exists()

    pipeline.process_video_task(script.id, task_id)

    assert task.status == "completed"
    assert task.video_url.startswith("video/video_")

    # 适配器拿到的是快照文件的绝对路径，不是用户原始引用。
    assert len(video_model.calls) == 1
    call = video_model.calls[0]
    assert call["model_name"] == "dola-seedance2.5"
    assert Path(call["img_path"]).resolve() == snapshot.resolve()

    # 请求侧的变换不回写项目数据。
    assert script.characters[0].image_url == "uploads/local_only_uploaded.png"
    assert script.scenes[0].image_url == "assets/scenes/local_only_generated.png"
    assert script.frames[0].rendered_image_url == "storyboard/local_only_frame.png"


# ---------------------------------------------------------------------------
# 音频三态（VideoSidebar: custom / ai / mute）
# ---------------------------------------------------------------------------

def _submit(pipeline, script, **overrides):
    """建一个任务并跑完，返回 (task, 记录到的适配器调用)。"""
    kwargs = {
        "script_id": script.id,
        "image_url": script.frames[0].rendered_image_url,
        "prompt": "Pan and zoom on the character",
        "model": "dola-seedance2.5",
    }
    kwargs.update(overrides)
    _, task_id = pipeline.create_video_task(**kwargs)
    task = next(t for t in script.video_tasks if t.id == task_id)
    pipeline.process_video_task(script.id, task_id)
    return task, pipeline._jiucaihezi_video_model.calls[-1]


def _ready_pipeline():
    _write_output_png("storyboard/local_only_frame.png")
    video_model = _RecordingVideoModel()
    script = _build_script()
    return script, _build_pipeline(script, video_model)


def test_ai_sound_mode_generates_audio_then_feeds_it_to_the_video_model():
    script, pipeline = _ready_pipeline()

    with patch("src.models.jiucaihezi.generate_audio") as gen_audio:
        task, call = _submit(pipeline, script, generate_audio=True)

    assert task.status == "completed"
    gen_audio.assert_called_once()
    assert gen_audio.call_args.kwargs["prompt"] == "Pan and zoom on the character"
    # 没有参考音频 → 纯文生音频；有参考音频时由调用方传进来。
    assert gen_audio.call_args.kwargs["reference_audio_urls"] == []
    # 生成到哪，就交给视频适配器哪个文件。
    assert call["audio_url"] == gen_audio.call_args.kwargs["output_path"]
    assert call["audio_url"].startswith("output/audio/ai_sound_")
    assert call["audio_url"].endswith(".mp3")


def test_ai_sound_mode_passes_reference_audio_when_present():
    script, pipeline = _ready_pipeline()

    with patch(
        "src.models.jiucaihezi.generate_audio",
        return_value="output/audio/ai_sound_task.mp3",
    ) as gen_audio:
        _submit(
            pipeline,
            script,
            generate_audio=True,
            reference_audio_urls=["https://cdn.example/voice.wav"],
        )

    assert gen_audio.call_args.kwargs["reference_audio_urls"] == [
        "https://cdn.example/voice.wav"
    ]


def test_custom_audio_url_skips_audio_generation():
    script, pipeline = _ready_pipeline()

    with patch("src.models.jiucaihezi.generate_audio") as gen_audio:
        _, call = _submit(
            pipeline,
            script,
            audio_url="https://cdn.example/mine.mp3",
        )

    gen_audio.assert_not_called()
    assert call["audio_url"] == "https://cdn.example/mine.mp3"


def test_mute_mode_sends_no_audio():
    script, pipeline = _ready_pipeline()

    with patch("src.models.jiucaihezi.generate_audio") as gen_audio:
        _, call = _submit(pipeline, script)

    gen_audio.assert_not_called()
    assert call["audio_url"] is None


def test_ai_sound_failure_fails_the_task_before_paying_for_video():
    script, pipeline = _ready_pipeline()

    with patch(
        "src.models.jiucaihezi.generate_audio",
        side_effect=RuntimeError("该模型未开通"),
    ):
        _, task_id = pipeline.create_video_task(
            script_id=script.id,
            image_url=script.frames[0].rendered_image_url,
            prompt="Pan and zoom on the character",
            model="dola-seedance2.5",
            generate_audio=True,
        )
        pipeline.process_video_task(script.id, task_id)

    task = next(t for t in script.video_tasks if t.id == task_id)
    assert task.status == "failed"
    # 音频先于视频：失败时视频适配器根本不该被调用。
    assert pipeline._jiucaihezi_video_model.calls == []
