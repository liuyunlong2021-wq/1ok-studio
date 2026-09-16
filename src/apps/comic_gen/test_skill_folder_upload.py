"""整目录上传 Skill 的回归测试。

浏览器选文件夹时给的相对路径是 `my-skill/SKILL.md`、`my-skill/references/a.md`，
而 Skill 包要求入口 SKILL.md 落在根目录 —— 这一层壳必须被剥掉，且不能被剥错
（剥过头会把 references 丢掉，剥不够会让 create() 找不到 SKILL.md）。
"""

import json

import pytest

from src.apps.comic_gen.skill_packages import SkillPackageError, SkillPackageStore


def _folder(store, files, source_name=""):
    entries = [(path, content.encode()) for path, content in files.items()]
    return store.import_upload_folder(entries, source_name)


def test_folder_upload_strips_top_level_directory(tmp_path):
    store = SkillPackageStore(str(tmp_path))
    metadata = _folder(store, {
        "jc-character-prompt/SKILL.md": "Follow references/prompt-format.md",
        "jc-character-prompt/references/prompt-format.md": "FORMAT-RULE",
        "jc-character-prompt/README.md": "readme",
    })

    assert metadata["entry"] == "SKILL.md"
    assert {item["path"] for item in metadata["files"]} == {
        "SKILL.md",
        "README.md",
        "references/prompt-format.md",
    }
    assert metadata["validation"]["errors"] == []
    assert "FORMAT-RULE" in store.compile(metadata["id"])


def test_folder_upload_without_wrapper_directory(tmp_path):
    """用户直接选中 Skill 目录本身时，有些浏览器给不出顶层目录名。"""
    store = SkillPackageStore(str(tmp_path))
    metadata = _folder(store, {
        "SKILL.md": "Follow references/style.md",
        "references/style.md": "STYLE-RULE",
    })

    assert metadata["entry"] == "SKILL.md"
    assert "STYLE-RULE" in store.compile(metadata["id"])


def test_folder_upload_skips_non_text_and_hidden_files(tmp_path):
    """整目录里混着图片、.DS_Store 时应当安静跳过，而不是报错。"""
    store = SkillPackageStore(str(tmp_path))
    metadata = _folder(store, {
        "my-skill/SKILL.md": "rule",
        "my-skill/.DS_Store": "junk",
        "my-skill/cover.png": "not-text",
    })

    assert {item["path"] for item in metadata["files"]} == {"SKILL.md"}


def test_folder_upload_rejects_folder_without_skill_md(tmp_path):
    store = SkillPackageStore(str(tmp_path))
    with pytest.raises(SkillPackageError, match="缺少 SKILL.md"):
        _folder(store, {"my-skill/notes.md": "no entry here"})


def test_folder_upload_rejects_empty_folder(tmp_path):
    store = SkillPackageStore(str(tmp_path))
    with pytest.raises(SkillPackageError, match="没有可用的文本文件"):
        _folder(store, {"my-skill/cover.png": "not-text"})


def test_folder_upload_rejects_path_traversal(tmp_path):
    store = SkillPackageStore(str(tmp_path))
    with pytest.raises(SkillPackageError, match="非法路径"):
        _folder(store, {"../escape/SKILL.md": "bad"})


def test_missing_reference_error_tells_user_how_to_fix(tmp_path):
    """只传 SKILL.md 是最常见的误操作，报错必须指出下一步该怎么做。"""
    store = SkillPackageStore(str(tmp_path))
    with pytest.raises(SkillPackageError) as excinfo:
        _folder(store, {"SKILL.md": "Follow references/prompt-format.md"})

    message = str(excinfo.value)
    assert "缺少引用文件: references/prompt-format.md" in message
    assert "上传文件夹" in message


def test_folder_upload_derives_name_from_top_directory(tmp_path):
    """SKILL.md 里没有 name: 字段时，用文件夹名当兜底，而不是显示成 SKILL。"""
    store = SkillPackageStore(str(tmp_path))
    metadata = _folder(store, {"my-skill/SKILL.md": "rule without frontmatter"})

    assert metadata["name"] == "my-skill"
    assert metadata["source_name"] == "my-skill"


def test_folder_endpoint_pairs_files_with_paths(tmp_path, monkeypatch):
    """`paths` 与 `files` 靠顺序按位配对。

    这是整条链路里最容易悄悄错位的一环 —— 错位会把 A 的文件塞进 B 的路径，
    生成一个路径全乱却“看起来成功”的包，所以单独钉一个接口级测试。
    """
    from fastapi.testclient import TestClient

    from src.apps.comic_gen import api as api_mod

    store = SkillPackageStore(str(tmp_path))
    monkeypatch.setattr(api_mod.pipeline, "skill_packages", store)

    response = TestClient(api_mod.app).post(
        "/skill-packages/folder",
        files=[
            ("files", ("SKILL.md", b"Follow references/prompt-format.md")),
            ("files", ("prompt-format.md", b"FORMAT-RULE")),
        ],
        data={"paths": json.dumps(["my-skill/SKILL.md", "my-skill/references/prompt-format.md"])},
    )

    assert response.status_code == 200, response.text
    metadata = response.json()
    assert {item["path"] for item in metadata["files"]} == {"SKILL.md", "references/prompt-format.md"}
    assert metadata["validation"]["errors"] == []
    assert "FORMAT-RULE" in store.compile(metadata["id"])


def test_folder_endpoint_rejects_mismatched_paths(tmp_path, monkeypatch):
    """宁可拒绝也不猜：数量对不上时必须报错，而不是生成一个路径可疑的包。"""
    from fastapi.testclient import TestClient

    from src.apps.comic_gen import api as api_mod

    monkeypatch.setattr(api_mod.pipeline, "skill_packages", SkillPackageStore(str(tmp_path)))

    response = TestClient(api_mod.app).post(
        "/skill-packages/folder",
        files=[("files", ("SKILL.md", b"rule"))],
        data={"paths": json.dumps(["a/SKILL.md", "b/SKILL.md"])},
    )

    assert response.status_code == 400
    assert "数量不一致" in response.json()["detail"]


def test_folder_endpoint_rejects_broken_path_table(tmp_path, monkeypatch):
    """路径表不是 JSON 时给出可读的报错，而不是 500。"""
    from fastapi.testclient import TestClient

    from src.apps.comic_gen import api as api_mod

    monkeypatch.setattr(api_mod.pipeline, "skill_packages", SkillPackageStore(str(tmp_path)))

    response = TestClient(api_mod.app).post(
        "/skill-packages/folder",
        files=[("files", ("SKILL.md", b"rule"))],
        data={"paths": "not-json"},
    )

    assert response.status_code == 400
    assert "不是合法 JSON" in response.json()["detail"]

