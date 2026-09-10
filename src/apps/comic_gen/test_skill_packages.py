import io
import zipfile

import pytest

from src.apps.comic_gen.skill_packages import SkillPackageError, SkillPackageStore
from src.apps.comic_gen.models import ArtDirection, PromptConfig, Script
from src.apps.comic_gen.pipeline import ComicGenPipeline


def _zip(files):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for path, content in files.items():
            archive.writestr(path, content)
    return buffer.getvalue()


def test_import_and_compile_referenced_skill(tmp_path):
    store = SkillPackageStore(str(tmp_path))
    metadata = store.import_upload(
        "character.zip",
        _zip({
            "character/SKILL.md": "Use the reference: references/style.md",
            "character/references/style.md": "Use controlled 3D semi-realistic lighting.",
        }),
    )
    compiled = store.compile(metadata["id"])
    assert "controlled 3D semi-realistic" in compiled
    assert metadata["validation"]["errors"] == []


def test_single_markdown_is_imported_as_package(tmp_path):
    store = SkillPackageStore(str(tmp_path))
    metadata = store.import_upload("SKILL.md", b"Single-file skill rule")
    assert metadata["entry"] == "SKILL.md"
    assert "Single-file skill rule" in store.compile(metadata["id"])


def test_missing_reference_is_rejected(tmp_path):
    store = SkillPackageStore(str(tmp_path))
    with pytest.raises(SkillPackageError, match="缺少引用文件"):
        store.import_upload("bad.zip", _zip({"SKILL.md": "See references/missing.md"}))


def test_path_traversal_is_rejected(tmp_path):
    store = SkillPackageStore(str(tmp_path))
    with pytest.raises(SkillPackageError):
        store.import_upload("bad.zip", _zip({"SKILL.md": "ok", "../escape.md": "bad"}))


def test_prompt_config_keeps_skill_bindings():
    config = PromptConfig(skill_bindings={"storyboard_polish": "skillpkg_" + "a" * 32})
    assert config.model_dump()["skill_bindings"]["storyboard_polish"].startswith("skillpkg_")


def test_effective_skill_includes_references_and_project_style(tmp_path):
    pipeline = ComicGenPipeline.__new__(ComicGenPipeline)
    pipeline.skill_packages = SkillPackageStore(str(tmp_path))
    package = pipeline.skill_packages.create({
        "SKILL.md": "Follow references/style.md",
        "references/style.md": "REFERENCE-RULE",
    }, "storyboard.zip")
    episode = Script(
        id="episode", title="T", original_text="",
        created_at=1, updated_at=1,
        prompt_config=PromptConfig(skill_bindings={"storyboard_polish": package["id"]}),
        art_direction=ArtDirection(
            selected_style_id="style",
            style_config={"positive_prompt": "STYLE-CONTRACT"},
        ),
    )

    effective = pipeline.get_effective_prompt("storyboard_polish", episode)

    assert "REFERENCE-RULE" in effective
    assert "STYLE-CONTRACT" in effective


def test_episode_skill_binding_wins_over_series_and_legacy_text(tmp_path):
    pipeline = ComicGenPipeline.__new__(ComicGenPipeline)
    pipeline.skill_packages = SkillPackageStore(str(tmp_path))
    episode_package = pipeline.skill_packages.create({"SKILL.md": "EPISODE-SKILL"}, "ep.md")
    episode = Script(
        id="episode", title="T", original_text="",
        created_at=1, updated_at=1,
        prompt_config=PromptConfig(
            character_prompt="LEGACY-TEXT",
            skill_bindings={"character_prompt": episode_package["id"]},
        ),
    )
    effective = pipeline.get_effective_prompt("character_prompt", episode)
    assert "EPISODE-SKILL" in effective
    assert "LEGACY-TEXT" not in effective
