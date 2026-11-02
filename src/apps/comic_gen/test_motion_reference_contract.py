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
            # R2V budgets come from saved shots; these fixed-duration channels need 30s.
            frames=[
                StoryboardFrame(id="shot-1", scene_id="scene-1", duration=15),
                StoryboardFrame(id="shot-2", scene_id="scene-1", duration=15),
            ],
            created_at=time.time(),
            updated_at=time.time(),
        )
        self.pipeline = ComicGenPipeline.__new__(ComicGenPipeline)
        self.pipeline.get_script = lambda _script_id: self.script
        self.pipeline._save_data = lambda: None



if __name__ == "__main__":
    unittest.main()
