"""本地素材流程回归 —— 不碰任何外部服务。

验证 ``process_video_task`` 的本地侧约定：

- 视频任务创建时把输入图快照进 ``output/video_inputs/``，任务记录只存这个快照
  引用，不直接依赖用户本地路径；
- 项目里存的素材引用（character / scene / frame 的 image_url）在生成后保持原样 ——
  请求侧的临时变换（上传到网关、签名 URL）绝不回写项目数据。

原来这个文件跑的是 wanx / DashScope 适配器，它已随家族收敛删除；现在驱动唯一
在架的韭菜盒子适配器。
"""
import base64
import time
from pathlib import Path

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
