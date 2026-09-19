import time
import unittest

from .models import Script, StoryboardFrame
from .pipeline import ComicGenPipeline


class MotionReferenceContractTest(unittest.TestCase):
    def setUp(self):
        self.script = Script(
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
        self.pipeline = ComicGenPipeline.__new__(ComicGenPipeline)
        self.pipeline.get_script = lambda _script_id: self.script
        self.pipeline._save_data = lambda: None

    def test_seedance_reference_contract(self):
        """海通道（海seedance2.5）：固定 30 秒 / 720p，参考图 1-9 张。"""
        with self.assertRaisesRegex(ValueError, "1-9 reference images"):
            self.pipeline.create_video_task(
                "project-1", "", "prompt", model="海seedance2.5",
                generation_mode="r2v",
                reference_image_urls=[f"https://x/{index}.png" for index in range(10)],
                source_frame_ids=["shot-1", "shot-2"],
            )

        _, task_id = self.pipeline.create_video_task(
            "project-1", "", "prompt", duration=5, resolution="1080p",
            model="海seedance2.5", generation_mode="r2v",
            reference_image_urls=["https://x/1.png"],
            source_frame_ids=["shot-1", "shot-2"],
            skill_id="skill-1", skill_name="分镜 Skill",
        )
        task = next(item for item in self.script.video_tasks if item.id == task_id)
        # 扁平中文 id 也必须被目录家族判定认出来，不能被 R2V 自动切换改写。
        self.assertEqual(task.model, "海seedance2.5")
        self.assertEqual(task.duration, 30)
        self.assertEqual(task.resolution, "720p")
        self.assertEqual(task.source_frame_ids, ["shot-1", "shot-2"])
        self.assertEqual(task.skill_name, "分镜 Skill")

    def test_dola_channel_shares_the_same_contract(self):
        """dola 通道（2026-09-19 拿回）：同样固定 30 秒 / 720p，参考图同为 1-9 张 ——
        特判原来写死了「海seedance2.5」，只加目录条目会静默漏掉它。
        """
        with self.assertRaisesRegex(ValueError, "1-9 reference images"):
            self.pipeline.create_video_task(
                "project-1", "", "prompt", model="dola-seedance2.5",
                generation_mode="r2v",
                reference_image_urls=[f"https://x/{index}.png" for index in range(10)],
                source_frame_ids=["shot-1", "shot-2"],
            )

        _, task_id = self.pipeline.create_video_task(
            "project-1", "", "prompt", duration=5, resolution="1080p",
            model="dola-seedance2.5", generation_mode="r2v",
            reference_image_urls=["https://x/1.png"],
            source_frame_ids=["shot-1", "shot-2"],
        )
        task = next(item for item in self.script.video_tasks if item.id == task_id)
        self.assertEqual(task.model, "dola-seedance2.5")
        self.assertEqual(task.duration, 30)
        self.assertEqual(task.resolution, "720p")


if __name__ == "__main__":
    unittest.main()
