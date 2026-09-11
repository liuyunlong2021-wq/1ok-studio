"""视频模型路由回归测试。

背景（2026-09-11 线上故障）：项目里存的是 legacy 扁平 id `dola-seedance2.5`，
R2V 自动切换分支用 `model.startswith("jiucaihezi/")` 判断供应商，扁平 id 匹配不上
任何分支 → 落到 `else: model = "wan2.7-r2v"`，于是用户明明选了韭菜盒子，请求却被
发给 DashScope，报 `Invalid API-key provided`。

这个测试断言的是 **task.model**（不是 duration）——旧测试只断言 duration，
而 duration 是在自动切换之前就算好的，所以它漏掉了这个 bug。

跑法：
    python -m pytest src/apps/comic_gen/test_video_model_routing.py
"""
import time

from src.apps.comic_gen.models import Script, StoryboardFrame
from src.apps.comic_gen.pipeline import ComicGenPipeline


def _pipeline_with_script() -> ComicGenPipeline:
    script = Script(
        id="project-1",
        title="test",
        original_text="test",
        frames=[
            StoryboardFrame(id="shot-1", scene_id="scene-1"),
            StoryboardFrame(id="shot-2", scene_id="scene-1"),
        ],
        created_at=time.time(),
        updated_at=time.time(),
    )
    pipeline = ComicGenPipeline.__new__(ComicGenPipeline)
    pipeline.get_script = lambda _script_id: script
    pipeline._save_data = lambda: None
    return pipeline


def _task_of(pipeline, task_id):
    script = pipeline.get_script("project-1")
    return next(item for item in script.video_tasks if item.id == task_id)


def test_legacy_flat_jiucaihezi_id_is_not_switched_to_wan():
    """dola-seedance2.5（扁平 id）必须保持原样，不能被换成 wan2.7-r2v。"""
    pipeline = _pipeline_with_script()

    _, task_id = pipeline.create_video_task(
        "project-1", "", "prompt", model="dola-seedance2.5", generation_mode="r2v",
        reference_image_urls=["https://x/1.png"], source_frame_ids=["shot-1", "shot-2"],
    )

    task = _task_of(pipeline, task_id)
    assert task.model == "dola-seedance2.5", f"legacy 韭菜盒子 id 被换成了 {task.model}"
    assert task.duration == 30
    assert task.resolution == "720p"


def test_prefixed_jiucaihezi_id_is_not_switched():
    """带前缀的写法同样不能被切换。"""
    pipeline = _pipeline_with_script()

    _, task_id = pipeline.create_video_task(
        "project-1", "", "prompt", model="jiucaihezi/dola-seedance2.5", generation_mode="r2v",
        reference_image_urls=["https://x/1.png"], source_frame_ids=["shot-1"],
    )

    task = _task_of(pipeline, task_id)
    assert task.model == "jiucaihezi/dola-seedance2.5"


def test_other_family_still_auto_switches_to_its_r2v_sibling():
    """非韭菜盒子的 i2v 选择仍然按原逻辑切到同族 r2v（不能被这次改动破坏）。"""
    pipeline = _pipeline_with_script()

    _, task_id = pipeline.create_video_task(
        "project-1", "", "prompt", model="happyhorse-1.1-i2v", generation_mode="r2v",
        reference_image_urls=["https://x/1.png"], source_frame_ids=["shot-1"],
    )

    task = _task_of(pipeline, task_id)
    assert task.model == "happyhorse-1.1-r2v"
