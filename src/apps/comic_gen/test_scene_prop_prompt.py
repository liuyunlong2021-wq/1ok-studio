"""场景/道具生图：必须用写好的提示词，且不许把角色风格里的「人」带进来。"""
from unittest.mock import Mock, patch

from src.apps.comic_gen.assets import (
    AssetGenerator,
    _negative_without_people,
    strip_character_clauses,
)
from src.apps.comic_gen.models import Scene, Script
from src.apps.comic_gen.pipeline import ComicGenPipeline

# 取「高精度3D半写实动漫」预设的正提示词：整段都在写皮肤/发丝/眼睛/时装，没有环境词。
BJD_STYLE = (
    "high-precision 3D semi-realistic anime render, BJD ball-jointed-doll aesthetic, "
    "porcelain-smooth skin with subsurface scattering, individually modeled hair strands, "
    "layered glossy eyes with sharp catchlights, saturated color-blocked streetwear styling, "
    "soft even studio lighting with clean gradient falloff, high-poly surface with no noise"
)


def test_strip_character_clauses_keeps_light_and_medium():
    kept = strip_character_clauses(BJD_STYLE)

    assert "skin" not in kept and "hair" not in kept and "eyes" not in kept
    assert "doll" not in kept and "streetwear" not in kept
    assert "3D semi-realistic anime render" in kept
    assert "studio lighting" in kept
    # 边界词不该误伤：surface 里没有独立单词 face。
    assert "high-poly surface with no noise" in kept


def test_negative_without_people_yields_to_explicit_request():
    assert "people" in _negative_without_people("")
    assert "people" in _negative_without_people("blurry, low quality")
    assert _negative_without_people("人群中景") == "人群中景"


def test_generate_scene_uses_written_prompt_and_blocks_people(tmp_path):
    generator = AssetGenerator({"output_dir": str(tmp_path)})
    generator.model = Mock()
    generator.model.generate.return_value = (str(tmp_path / "scene.png"), None)
    scene = Scene(id="s1", name="汉朝街道", description="市集摊贩与人群")
    scene.image_prompt = "16:9空镜概念图，空间结构清楚，画面不出现人物。"

    generator.generate_scene(scene, positive_prompt=BJD_STYLE, size="1024*576")

    sent = generator.model.generate.call_args[0][0]
    assert sent.startswith("16:9空镜概念图")
    assert "不出现人物" in sent
    assert "skin" not in sent and "streetwear" not in sent
    assert scene.image_asset.variants[0].prompt_used == sent
    assert "people" in generator.model.generate.call_args.kwargs["negative_prompt"]


def test_generate_scene_accepts_prompt_from_workbench(tmp_path):
    generator = AssetGenerator({"output_dir": str(tmp_path)})
    generator.model = Mock()
    generator.model.generate.return_value = (str(tmp_path / "scene.png"), None)
    scene = Scene(id="s1", name="汉朝街道", description="市集摊贩与人群")

    generator.generate_scene(scene, positive_prompt="", size="1024*576", prompt="空镜：土路与木构房舍")

    sent = generator.model.generate.call_args[0][0]
    assert sent.startswith("空镜：土路与木构房舍")
    assert "Scene Concept Art" not in sent


def _pipeline(tmp_path) -> ComicGenPipeline:
    with patch("src.apps.comic_gen.pipeline.AssetGenerator"), \
         patch("src.apps.comic_gen.pipeline.ScriptProcessor"), \
         patch("src.apps.comic_gen.pipeline.StoryboardGenerator"), \
         patch("src.apps.comic_gen.pipeline.VideoGenerator"), \
         patch("src.apps.comic_gen.pipeline.AudioGenerator"), \
         patch("src.apps.comic_gen.pipeline.ExportManager"):
        p = ComicGenPipeline()
    p.data_file = str(tmp_path / "projects.json")
    p.series_data_file = str(tmp_path / "series.json")
    p.scripts = {}
    p.series_store = {}
    p._save_data = Mock()
    return p


def test_generate_asset_hands_scene_prompt_to_generator(tmp_path):
    pipeline = _pipeline(tmp_path)
    scene = Scene(id="s1", name="汉朝街道", description="市集摊贩与人群")
    pipeline.scripts["p1"] = Script(id="p1", title="t", original_text="", created_at=1.0, updated_at=1.0, scenes=[scene])

    pipeline.generate_asset("p1", "s1", "scene", prompt="空镜：土路与木构房舍")

    assert pipeline.asset_generator.generate_scene.call_args.kwargs["prompt"] == "空镜：土路与木构房舍"


def test_scene_prompt_contract_drops_character_style(tmp_path):
    pipeline = _pipeline(tmp_path)
    script = Script(
        id="p1", title="t", original_text="", created_at=1.0, updated_at=1.0,
        art_direction={"selected_style_id": "x", "style_config": {"positive_prompt": BJD_STYLE}},
    )

    scene_contract = pipeline.get_effective_prompt("scene_prompt", script)
    character_contract = pipeline.get_effective_prompt("character_prompt", script)

    assert "skin" not in scene_contract and "streetwear" not in scene_contract
    assert "不得描写人物外观" in scene_contract
    assert "画面以空景为主" in scene_contract
    assert "画面只呈现单件道具" not in scene_contract
    # 角色阶段不受影响，仍拿原风格。
    assert "skin" in character_contract


def test_prop_prompt_contract_rules_out_hands_and_figures(tmp_path):
    pipeline = _pipeline(tmp_path)
    script = Script(
        id="p1", title="t", original_text="", created_at=1.0, updated_at=1.0,
        art_direction={"selected_style_id": "x", "style_config": {"positive_prompt": BJD_STYLE}},
    )

    prop_contract = pipeline.get_effective_prompt("prop_prompt", script)

    assert "画面只呈现单件道具" in prop_contract
    assert "skin" not in prop_contract
