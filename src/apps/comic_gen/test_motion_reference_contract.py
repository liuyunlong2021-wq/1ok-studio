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
        with self.assertRaisesRegex(ValueError, "1-9 reference images"):
            self.pipeline.create_video_task(
                "project-1", "", "prompt", model="jiucaihezi/dola-seedance2.5-r2v",
                generation_mode="r2v", reference_image_urls=[f"https://x/{i}.png" for i in range(10)],
                source_frame_ids=["shot-1", "shot-2"],
            )

        _, task_id = self.pipeline.create_video_task(
            "project-1", "", "prompt", duration=5, resolution="1080p",
            model="jiucaihezi/dola-seedance2.5-r2v", generation_mode="r2v",
            reference_image_urls=["https://x/1.png"], source_frame_ids=["shot-1", "shot-2"],
            skill_id="skill-1", skill_name="分镜 Skill",
        )
        task = next(item for item in self.script.video_tasks if item.id == task_id)
        self.assertEqual(task.duration, 30)
        self.assertEqual(task.resolution, "720p")
        self.assertEqual(task.source_frame_ids, ["shot-1", "shot-2"])
        self.assertEqual(task.skill_name, "分镜 Skill")


if __name__ == "__main__":
    unittest.main()
