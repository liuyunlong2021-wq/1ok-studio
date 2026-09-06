import os
import sys

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "../../..")))

from src.apps.comic_gen.models import GlobalAssetLibrary, Prop, Scene, Script, Series, StoryboardFrame
from src.apps.comic_gen.pipeline import ComicGenPipeline


def _pipeline(script, series):
    pipeline = object.__new__(ComicGenPipeline)
    pipeline.scripts = {script.id: script}
    pipeline.series_store = {series.id: series}
    pipeline.library_store = GlobalAssetLibrary()
    pipeline._save_data = lambda: None
    pipeline._save_series_data = lambda: None
    pipeline._save_library_data = lambda: None
    return pipeline


def test_delete_shared_scene_from_series():
    scene = Scene(id="scene-1", name="old", description="d")
    frame = StoryboardFrame(id="frame-1", scene_id=scene.id)
    script = Script(id="ep1", title="e", original_text="", series_id="series-1", frames=[frame], created_at=0, updated_at=0)
    series = Series(id="series-1", title="s", scenes=[scene], created_at=0, updated_at=0)
    pipeline = _pipeline(script, series)

    pipeline.delete_scene("ep1", "scene-1")

    assert series.scenes == []
    assert frame.scene_id == ""
    try:
        pipeline.delete_scene("ep1", "scene-1")
    except ValueError:
        pass
    else:
        raise AssertionError("Deleting an absent scene must fail")


def test_delete_shared_prop_from_series():
    prop = Prop(id="prop-1", name="old", description="d")
    frame = StoryboardFrame(id="frame-1", scene_id="scene-1", prop_ids=[prop.id])
    script = Script(id="ep1", title="e", original_text="", series_id="series-1", frames=[frame], created_at=0, updated_at=0)
    series = Series(id="series-1", title="s", props=[prop], created_at=0, updated_at=0)
    pipeline = _pipeline(script, series)

    pipeline.delete_prop("ep1", "prop-1")

    assert series.props == []
    assert frame.prop_ids == []


if __name__ == "__main__":
    test_delete_shared_scene_from_series()
    test_delete_shared_prop_from_series()
