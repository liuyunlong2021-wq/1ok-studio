"""Skill Package 内置来源（随包分发的 skills/）测试。

背景：Skill 以前只能靠"上传"进 `output/skill_packages`，实测每台机器都得重传一次。
现在 `skills/<name>/SKILL.md` 会跟着 sidecar 一起打包（build_sidecar.sh 的
`--add-data "skills:skills"`），由 `SkillPackageStore` 以只读内置包的形式暴露：
id 形如 `builtin:<目录名>`，不复制进用户数据目录，所以升级 App 即刷新，不会留下旧副本。

这里最需要守住的是路径推算：`BUILTIN_ROOT = Path(__file__).resolve().parents[3] / "skills"`。
仓库里它是 <root>/skills，PyInstaller 下是 <_MEIPASS>/skills。最后一条用例直接对着真实
仓库根断言，防止这个推算被改动后静默变成"零内置包"。

Run: `.venv/bin/python -m pytest tests/test_skill_packages_builtin.py -q`
"""

import json
from pathlib import Path

import pytest

from src.apps.comic_gen.skill_packages import (
    BUILTIN_ROOT,
    SkillPackageError,
    SkillPackageStore,
)

REPO_ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def store(tmp_path):
    """Store backed by a throwaway uploads dir and a throwaway builtin dir."""
    builtin = tmp_path / "skills"
    (builtin / "alpha-skill").mkdir(parents=True)
    (builtin / "alpha-skill" / "SKILL.md").write_text(
        '---\nname: alpha-skill\ndescription: d\n---\n\n# Rule\n\nalpha rule body\n\n'
        "细节见 references/extra.md\n",
        encoding="utf-8",
    )
    (builtin / "alpha-skill" / "references").mkdir()
    (builtin / "alpha-skill" / "references" / "extra.md").write_text(
        "extra body\n", encoding="utf-8"
    )
    (builtin / "beta-skill").mkdir()
    (builtin / "beta-skill" / "SKILL.md").write_text(
        '# No frontmatter\n\nbeta body\n', encoding="utf-8"
    )
    # 不是 skill 的东西不该被列出来
    (builtin / "not-a-skill").mkdir()
    (builtin / "not-a-skill" / "README.md").write_text("nope\n", encoding="utf-8")
    return SkillPackageStore(root=str(tmp_path / "uploads"), builtin_root=builtin)


def test_list_returns_builtins_with_names_and_flags(store):
    packages = {pkg["id"]: pkg for pkg in store.list()}

    assert set(packages) == {"builtin:alpha-skill", "builtin:beta-skill"}
    assert packages["builtin:alpha-skill"]["builtin"] is True
    assert packages["builtin:alpha-skill"]["name"] == "alpha-skill"
    # 没有 frontmatter 时退回目录名，不能是空字符串
    assert packages["builtin:beta-skill"]["name"] == "beta-skill"


def test_describe_and_compile_resolve_a_builtin(store):
    metadata = store.describe("builtin:alpha-skill")
    assert metadata["entry"] == "SKILL.md"
    assert metadata["validation"]["errors"] == []
    assert {f["path"] for f in metadata["files"]} == {
        "SKILL.md",
        "references/extra.md",
    }

    compiled = store.compile("builtin:alpha-skill")
    assert "alpha rule body" in compiled
    # 被 SKILL.md 引用的文件要一起编译进来，否则 references 等于没带
    assert "extra body" in compiled


def test_builtins_are_read_only(store):
    with pytest.raises(SkillPackageError, match="内置 Skill"):
        store.delete("builtin:alpha-skill")
    assert store.builtin_root.is_dir()


def test_unknown_or_malformed_builtin_ids_are_rejected(store):
    with pytest.raises(SkillPackageError):
        store.get("builtin:does-not-exist")
    with pytest.raises(SkillPackageError):
        store.get("builtin:../escape")
    with pytest.raises(SkillPackageError):
        store.get("builtin:Bad_Name")
    with pytest.raises(SkillPackageError):
        store.get("skillpkg_not-hex")


def test_uploaded_packages_still_list_alongside_builtins(store):
    created = store.create({"SKILL.md": "# Mine\n\nmine body\n"}, "mine.zip")
    packages = {pkg["id"]: pkg for pkg in store.list()}

    assert created["id"] in packages
    assert packages[created["id"]]["builtin"] is False
    assert packages[created["id"]]["name"] == "mine"  # 无 frontmatter → 退回源文件名
    assert len(packages) == 3
    # 上传的包仍然可以删除
    store.delete(created["id"])
    assert len(store.list()) == 2


def test_malformed_uploaded_package_is_skipped_not_fatal(store, tmp_path):
    bad = tmp_path / "uploads" / ("skillpkg_" + "a" * 32)
    bad.mkdir(parents=True)
    (bad / "package.json").write_text("{ not json", encoding="utf-8")

    assert len(store.list()) == 2  # 内置两个仍在，坏的被跳过


def test_repo_builtin_root_resolves_to_the_bundled_skills_directory():
    """防止 `parents[3]` 偏移算错，让整个内置来源静默变成空列表。"""
    assert BUILTIN_ROOT == REPO_ROOT / "skills", (
        f"BUILTIN_ROOT 指向了 {BUILTIN_ROOT}，打包后会读不到 skills/"
    )

    shipped = SkillPackageStore(root="/nonexistent").list()
    assert "builtin:storyboard-inline-camera" in {pkg["id"] for pkg in shipped}

    skill_md = (BUILTIN_ROOT / "storyboard-inline-camera" / "SKILL.md").read_text(
        encoding="utf-8"
    )
    assert json.dumps(skill_md)  # 能被编码，没有坏字节
