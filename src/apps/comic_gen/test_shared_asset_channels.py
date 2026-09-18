"""Tests for One OK Studio Core shared-asset-pool *Wave A* (feeding channels):

  - library CRUD: create_library_asset (character/scene/prop) + list +
    update + delete (persisted to library_assets.json).
  - promote_asset_to_library: deep-copy from a project/series into the
    global pool with a fresh id; source asset left intact; 404 paths.
  - create_project(series_id=...): binds the new project as the next
    episode (episode_number = max + 1); series_id=None stays standalone.

Hermetic, mirroring test_shared_asset_pool.py: a bare ComicGenPipeline via
object.__new__ with only the attributes the exercised methods touch — no
real output/*.json is read or written (temp paths + a fake processor).

Design RFC: docs/plans/2026-06-18-lumenx-core-shared-asset-pool.md
"""

import os
import sys
import json
import threading

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../..")))

import pytest

from src.apps.comic_gen.pipeline import ComicGenPipeline
from src.apps.comic_gen.models import (
    Character,
    Scene,
    Prop,
    Script,
    Series,
    StoryboardFrame,
    GlobalAssetLibrary,
)


# --------------------------------------------------------------------------
# builders (only required fields; rest take schema defaults)
# --------------------------------------------------------------------------
def _char(cid, name=None):
    return Character(id=cid, name=name or cid, description=f"desc-{cid}")


def _scene(sid, name=None):
    return Scene(id=sid, name=name or sid, description=f"desc-{sid}")


def _prop(pid, name=None):
    return Prop(id=pid, name=name or pid, description=f"desc-{pid}")


def _script(sid="ep1", series_id=None, characters=None, scenes=None, props=None):
    return Script(
        id=sid,
        title=f"title-{sid}",
        original_text="once upon a time",
        series_id=series_id,
        characters=list(characters or []),
        scenes=list(scenes or []),
        props=list(props or []),
        created_at=0.0,
        updated_at=0.0,
    )


def _series(sid="S", characters=None, scenes=None, props=None):
    return Series(
        id=sid,
        title=f"series-{sid}",
        characters=list(characters or []),
        scenes=list(scenes or []),
        props=list(props or []),
        created_at=0.0,
        updated_at=0.0,
    )


class _FakeProcessor:
    """Stand-in for self.script_processor so create_project needs no LLM."""
    def __init__(self, sid="ep_new"):
        self._sid = sid

    def create_draft_script(self, title, text):
        return _script(sid=self._sid)

    def parse_novel(self, title, text):
        return _script(sid=self._sid)


def _bare_pipeline(tmp_path, library=None, series_store=None, scripts=None,
                   script_processor=None):
    """Bare ComicGenPipeline with temp persistence paths and only the
    attributes the exercised methods read/write."""
    p = object.__new__(ComicGenPipeline)
    p.library_store = library if library is not None else GlobalAssetLibrary()
    p.series_store = series_store if series_store is not None else {}
    p.scripts = scripts if scripts is not None else {}
    p._save_lock = threading.RLock()
    p.library_data_file = str(tmp_path / "library_assets.json")
    p.data_file = str(tmp_path / "projects.json")
    p.series_data_file = str(tmp_path / "series.json")
    if script_processor is not None:
        p.script_processor = script_processor
    return p


# --------------------------------------------------------------------------
# library CRUD
# --------------------------------------------------------------------------
def test_create_library_asset_all_types_persists(tmp_path):
    p = _bare_pipeline(tmp_path)

    # character WITH an image_url — exercises the AssetUnit/ImageVariant path
    # (the runtime-risky field names in create_library_asset).
    ch = p.create_library_asset("character", {"name": "Hero", "description": "d", "image_url": "output/assets/characters/x.png"})
    assert ch.id.startswith("char_") and ch.name == "Hero"
    sc = p.create_library_asset("scene", {"name": "Alley", "image_url": "output/assets/scenes/y.png"})
    assert sc.id.startswith("scene_") and sc.image_url == "output/assets/scenes/y.png"
    pr = p.create_library_asset("prop", {"name": "Gun"})
    assert pr.id.startswith("prop_")

    lib = p.list_library_assets()
    assert [c.id for c in lib.characters] == [ch.id]
    assert [s.id for s in lib.scenes] == [sc.id]
    assert [x.id for x in lib.props] == [pr.id]

    # persisted to the temp library file
    data = json.loads(open(p.library_data_file).read())
    assert data["characters"][0]["id"] == ch.id
    assert data["scenes"][0]["id"] == sc.id
    assert data["props"][0]["id"] == pr.id

    # invalid type rejected
    with pytest.raises(ValueError):
        p.create_library_asset("video", {"name": "nope"})


def test_create_library_character_tolerates_partial_payload(tmp_path):
    # Playground录入 calls this directly with a minimal payload.
    p = _bare_pipeline(tmp_path)
    ch = p.create_library_asset("character", {})
    assert ch.name == "未命名"


def test_update_and_delete_library_asset(tmp_path):
    lib = GlobalAssetLibrary(characters=[_char("c1", "old")])
    p = _bare_pipeline(tmp_path, library=lib)

    updated = p.update_library_asset("character", "c1", {"name": "new", "starred": True, "id": "HACK", "status": "X"})
    assert updated.name == "new" and updated.starred is True
    assert updated.id == "c1"  # id is protected from patch

    # delete
    p.delete_library_asset("character", "c1")
    assert p.list_library_assets().characters == []
    data = json.loads(open(p.library_data_file).read())
    assert data["characters"] == []

    # delete absent -> ValueError
    with pytest.raises(ValueError):
        p.delete_library_asset("character", "ghost")


def test_upload_variant_routes_to_series_shared_character(tmp_path):
    shared = _char("shared-char", "Shared Hero")
    episode = _script(sid="ep1", series_id="S")
    p = _bare_pipeline(
        tmp_path,
        series_store={"S": _series(sid="S", characters=[shared])},
        scripts={"ep1": episode},
    )

    p.add_uploaded_asset_variant(
        "ep1", "character", "shared-char", "full_body",
        "uploads/reference.png", "updated description",
    )

    assert shared.full_body_asset.selected_id
    variant = shared.full_body_asset.variants[0]
    assert variant.url == "uploads/reference.png"
    assert variant.is_uploaded_source is True
    assert json.loads(open(p.series_data_file).read())["S"]["characters"][0]["description"] == "updated description"


@pytest.mark.parametrize(
    ("asset_type", "asset_id", "collection"),
    [("scene", "shared-scene", "scenes"), ("prop", "shared-prop", "props")],
)
def test_upload_variant_routes_to_scene_and_prop_image_asset(tmp_path, asset_type, asset_id, collection):
    asset = _scene(asset_id) if asset_type == "scene" else _prop(asset_id)
    episode = _script(sid="ep1", series_id="S")
    series = _series(sid="S", **{collection: [asset]})
    p = _bare_pipeline(tmp_path, series_store={"S": series}, scripts={"ep1": episode})

    p.add_uploaded_asset_variant("ep1", asset_type, asset_id, "image", "uploads/reference.png")

    assert asset.image_url == "uploads/reference.png"
    assert asset.image_asset.selected_id == asset.image_asset.variants[0].id
    assert asset.image_asset.variants[0].url == "uploads/reference.png"
    saved_asset = json.loads(open(p.series_data_file).read())["S"][collection][0]
    assert saved_asset["image_asset"]["variants"][0]["url"] == "uploads/reference.png"


# --------------------------------------------------------------------------
# promote
# --------------------------------------------------------------------------
def test_promote_moves_asset_into_library_and_keeps_id(tmp_path):
    """提升 = 移动 + 沿用原 id。

    复制 + 新 id 会让合并（按 id 去重）在每个项目里多出一张同名卡；
    沿用 id 才能让已有的帧引用自动继续生效。
    """
    proj = _script(sid="p1", characters=[_char("pc", "proj-char")])
    ser = _series(sid="S", scenes=[_scene("ss", "ser-scene")])
    p = _bare_pipeline(tmp_path, scripts={"p1": proj}, series_store={"S": ser})

    promoted_c = p.promote_asset_to_library("project", "p1", "character", "pc")
    assert promoted_c.id == "pc"  # 沿用原 id
    assert promoted_c.name == "proj-char"
    assert [c.id for c in p.list_library_assets().characters] == ["pc"]
    assert proj.characters == []  # 源池那条被搬走，不是留一份副本

    promoted_s = p.promote_asset_to_library("series", "S", "scene", "ss")
    assert promoted_s.id == "ss" and promoted_s.name == "ser-scene"
    assert ser.scenes == []

    # 两个池子都落盘了
    assert json.loads(open(p.library_data_file).read())["scenes"][0]["id"] == "ss"
    assert json.loads(open(p.series_data_file).read())["S"]["scenes"] == []

    # 已在全局库里 -> 拒绝重复提升（不报错的话会变成两条同 id 记录）
    with pytest.raises(ValueError):
        p.promote_asset_to_library("series", "S", "scene", "ss")

    # 404-ish ValueErrors
    with pytest.raises(ValueError):
        p.promote_asset_to_library("project", "nope", "character", "pc")
    with pytest.raises(ValueError):
        p.promote_asset_to_library("project", "p1", "character", "ghost")
    with pytest.raises(ValueError):
        p.promote_asset_to_library("badkind", "p1", "character", "pc")


def test_delete_series_asset_finds_the_owning_episode(tmp_path):
    """删系列资产要认归属。

    资产躺在某一集的本地池里时，旧实现拿"该系列的第一集"去删，
    `_find_asset_with_source` 找不到就报 not found —— 在别的集里删一个
    本集新建的角色必然失败。
    """
    ep1 = _script(sid="ep1", series_id="S")
    ep2 = _script(sid="ep2", series_id="S", characters=[_char("c2", "ep2-only")])
    ser = _series(sid="S", characters=[_char("cs", "series-char")])
    # ep1 排在前面 —— 正是旧实现会误选的那一集
    p = _bare_pipeline(tmp_path, series_store={"S": ser}, scripts={"ep1": ep1, "ep2": ep2})

    p.delete_series_asset("S", "character", "c2")
    assert ep2.characters == []
    assert ep1.characters == []

    # 系列池那条同样删得掉（走任一集回落到系列池）
    p.delete_series_asset("S", "character", "cs")
    assert ser.characters == []

    with pytest.raises(ValueError):
        p.delete_series_asset("S", "character", "ghost")
    with pytest.raises(ValueError):
        p.delete_series_asset("nope", "character", "cs")


# --------------------------------------------------------------------------
# 跨集复用：候选清单 + 关联（合并）
# --------------------------------------------------------------------------
def _frame(fid, scene="", chars=None, props=None):
    return StoryboardFrame(
        id=fid, scene_id=scene, character_ids=list(chars or []), prop_ids=list(props or [])
    )


def test_asset_candidates_cover_three_layers_and_flag_siblings(tmp_path):
    """候选顺序 = 系列 → 全局 → 本集 → 其它集（后者需要先提升）。"""
    global_char = _char("gl", "全局角色")
    series_char = _char("sc", "系列角色")
    sibling_char = _char("sib", "第1集私有角色")
    mine = _char("mine", "本集角色")
    ep1 = _script(sid="ep1", series_id="S", characters=[sibling_char])
    ep2 = _script(sid="ep2", series_id="S", characters=[mine])
    p = _bare_pipeline(
        tmp_path,
        library=GlobalAssetLibrary(characters=[global_char]),
        series_store={"S": _series(sid="S", characters=[series_char])},
        scripts={"ep1": ep1, "ep2": ep2},
    )

    cands = p.list_asset_candidates("ep2", "character")
    by_id = {c["id"]: c for c in cands}

    assert [c["id"] for c in cands][:3] == ["sc", "gl", "mine"]
    assert by_id["sc"]["source"] == "series" and by_id["sc"]["needs_promote"] is False
    assert by_id["gl"]["source"] == "global"
    assert by_id["mine"]["source"] == "episode"
    assert by_id["mine"]["needs_promote"] is False
    # 同系列其它集的私有资产：帧引用解析不到，标出来让调用方先提升
    assert by_id["sib"]["needs_promote"] is True
    assert by_id["sib"]["owner_episode_id"] == "ep1"
    assert by_id["sib"]["owner_episode_title"] == "title-ep1"

    with pytest.raises(ValueError):
        p.list_asset_candidates("ep2", "video")
    with pytest.raises(ValueError):
        p.list_asset_candidates("nope", "character")


def test_link_local_asset_merges_into_series_asset_and_rewrites_frames(tmp_path):
    series_char = _char("sc", "刘备")
    ep = _script(sid="ep2", series_id="S", characters=[_char("local", "刘玄德")])
    ep.frames = [
        _frame("f1", scene="scene-1", chars=["local", "other"]),
        _frame("f2", scene="scene-1", chars=["other"]),
    ]
    p = _bare_pipeline(
        tmp_path,
        series_store={"S": _series(sid="S", characters=[series_char])},
        scripts={"ep2": ep},
    )

    p.link_local_asset("ep2", "character", "local", "sc")

    assert ep.characters == []                             # 本集那条被合并掉
    assert ep.frames[0].character_ids == ["sc", "other"]   # 帧引用改写
    assert ep.frames[1].character_ids == ["other"]          # 没引用到的不动


def test_link_local_asset_promotes_sibling_asset_to_series(tmp_path):
    """目标在同系列别的集里：先提升为系列资产（沿用原 id），再合并。"""
    ep1 = _script(sid="ep1", series_id="S", characters=[_char("sib", "第1集的刘备")])
    ep1.frames = [_frame("ep1f", scene="s1", chars=["sib"])]
    ep2 = _script(sid="ep2", series_id="S", characters=[_char("local", "刘备")])
    ep2.frames = [_frame("ep2f", scene="s2", chars=["local"])]
    ser = _series(sid="S")
    p = _bare_pipeline(tmp_path, series_store={"S": ser}, scripts={"ep1": ep1, "ep2": ep2})

    p.link_local_asset("ep2", "character", "local", "sib")

    assert [c.id for c in ser.characters] == ["sib"]   # 提升进系列池，id 不变
    assert ep1.characters == []                         # 从第 1 集摘掉
    assert ep1.frames[0].character_ids == ["sib"]       # 第 1 集仍解析得到（id 没变）
    assert ep2.characters == []
    assert ep2.frames[0].character_ids == ["sib"]


def test_link_local_asset_into_global_and_rejects_bad_input(tmp_path):
    ep = _script(sid="ep2", series_id="S", characters=[_char("local", "本集角色")])
    p = _bare_pipeline(
        tmp_path,
        library=GlobalAssetLibrary(characters=[_char("gl", "全局角色")]),
        series_store={"S": _series(sid="S")},
        scripts={"ep2": ep},
    )

    p.link_local_asset("ep2", "character", "local", "gl")
    assert ep.characters == []

    with pytest.raises(ValueError):
        p.link_local_asset("ep2", "character", "ghost", "gl")  # 本集没有这条
    with pytest.raises(ValueError):
        p.link_local_asset("ep2", "character", "gl", "gl")     # 不能关联到自己
    with pytest.raises(ValueError):
        p.link_local_asset("ep2", "character", "gl", "nope")   # 目标不存在


def test_fork_shared_asset_into_project(tmp_path):
    """取消关联：把共享那条在本集 fork 一份独立副本（新 id），共享那条不动。"""
    series_char = _char("sc", "刘备")
    ep = _script(sid="ep2", series_id="S")
    p = _bare_pipeline(
        tmp_path,
        series_store={"S": _series(sid="S", characters=[series_char])},
        scripts={"ep2": ep},
    )

    forked = p.fork_library_asset_to_project("ep2", "character", "sc")

    assert forked.id != "sc" and forked.name == "刘备"
    assert [c.id for c in ep.characters] == [forked.id]
    assert [c.id for c in p.series_store["S"].characters] == ["sc"]


# --------------------------------------------------------------------------
# 提取时的名册 + 同名复用
# --------------------------------------------------------------------------
def test_known_entity_roster_covers_three_layers(tmp_path):
    ep = _script(sid="ep2", series_id="S", characters=[_char("mine", "本集角色")])
    p = _bare_pipeline(
        tmp_path,
        library=GlobalAssetLibrary(characters=[_char("gl", "全局角色")]),
        series_store={"S": _series(sid="S", characters=[_char("sc", "系列角色")])},
        scripts={"ep2": ep},
    )

    roster = p._known_entity_roster(ep)

    assert {e["name"] for e in roster} == {"全局角色", "系列角色", "本集角色"}
    assert all(e["type"] == "characters" for e in roster)
    assert all(e["description"] for e in roster)


def test_reuse_shared_entities_drops_local_duplicate(tmp_path):
    """同名复用：系列/全局已有的，本集不再存副本。

    只写 `extracted_description`，不动 `description` —— 后者是生图依据，
    改它会把用户已经生成好的图标记成过期。
    """
    series_char = _char("sc", "刘备")
    series_char.description = "用户手改过的描述"
    series_char.description_source = "manual"
    duplicate = _char("new", "刘备")          # 第 2 集提取出来的同名实体
    duplicate.description = "剧本新描述"
    fresh = _char("fresh", "关羽")            # 真·新实体，应该留在本集
    parsed = _script(
        sid="ep2", series_id="S",
        characters=[duplicate, fresh],
        scenes=[_scene("s1", "涿县城门口")],
    )
    p = _bare_pipeline(
        tmp_path,
        library=GlobalAssetLibrary(characters=[_char("gl", "全局角色")]),
        series_store={"S": _series(sid="S", characters=[series_char])},
        scripts={"ep2": _script(sid="ep2", series_id="S")},
    )

    p._reuse_shared_entities(parsed, p.series_store["S"])

    assert [c.id for c in parsed.characters] == ["fresh"]        # 刘备那份本集不存
    assert series_char.description == "用户手改过的描述"          # 共享那条的描述不动
    assert series_char.extracted_description == "剧本新描述"      # 提取到的原文描述留下来
    assert [s.id for s in parsed.scenes] == ["s1"]               # 场景没有同名共享 → 留下


def test_reuse_shared_entities_matches_global_layer_too(tmp_path):
    parsed = _script(sid="ep2", characters=[_char("new", "全局角色")])
    p = _bare_pipeline(
        tmp_path,
        library=GlobalAssetLibrary(characters=[_char("gl", "全局角色")]),
        scripts={"ep2": _script(sid="ep2")},
    )

    p._reuse_shared_entities(parsed, None)

    assert parsed.characters == []


# --------------------------------------------------------------------------
# 别名：关联一次 = 记住这个叫法
# --------------------------------------------------------------------------
def test_asset_name_keys_include_aliases():
    char = _char("c1", "刘备")
    char.aliases = ["刘玄德", "  ", "玄德公"]

    assert ComicGenPipeline._asset_name_keys(char) == {"刘备", "刘玄德", "玄德公"}


def test_link_records_alias_so_next_episode_reuses_it(tmp_path):
    """关联一次就把被合并的名字记成别名 —— 第 3 集再提取到「刘玄德」直接复用。"""
    series_char = _char("sc", "刘备")
    ep2 = _script(sid="ep2", series_id="S", characters=[_char("local", "刘玄德")])
    p = _bare_pipeline(
        tmp_path,
        series_store={"S": _series(sid="S", characters=[series_char])},
        scripts={"ep2": ep2},
    )

    p.link_local_asset("ep2", "character", "local", "sc")
    assert series_char.aliases == ["刘玄德"]

    # 第 3 集又提取出「刘玄德」：别名命中，不再建副本
    parsed = _script(sid="ep3", series_id="S", characters=[_char("new", "刘玄德")])
    p._reuse_shared_entities(parsed, p.series_store["S"])
    assert parsed.characters == []

    # 再关联一次同一个叫法，不能叠出第二条别名
    ep3 = _script(sid="ep3", series_id="S", characters=[_char("l3", "刘玄德")])
    p.scripts["ep3"] = ep3
    p.link_local_asset("ep3", "character", "l3", "sc")
    assert series_char.aliases == ["刘玄德"]


def test_set_asset_aliases_routes_to_owning_layer(tmp_path):
    ep_char = _char("mine", "本集角色")
    series_char = _char("sc", "系列角色")
    ep = _script(sid="ep2", series_id="S", characters=[ep_char])
    p = _bare_pipeline(
        tmp_path,
        series_store={"S": _series(sid="S", characters=[series_char])},
        scripts={"ep2": ep},
    )

    # 去重 + 去空白，本体名不会进别名表
    p.set_asset_aliases("ep2", "character", "mine", ["小名", "  小名 ", "本集角色", "   "])
    assert ep_char.aliases == ["小名"]

    # 系列池那条要写回系列层（这里断言的是内存对象，落盘由 _save_after_asset_mutation 负责）
    p.set_asset_aliases("ep2", "character", "sc", ["绰号"])
    assert series_char.aliases == ["绰号"]

    p.set_asset_aliases("ep2", "character", "mine", [])
    assert ep_char.aliases == []

    with pytest.raises(ValueError):
        p.set_asset_aliases("ep2", "character", "ghost", ["x"])


# --------------------------------------------------------------------------
# create_project(series_id) — episode binding + back-compat
# --------------------------------------------------------------------------
def test_create_project_binds_episode_when_series_id(tmp_path):
    ser = _series(sid="S")
    p = _bare_pipeline(tmp_path, series_store={"S": ser},
                       script_processor=_FakeProcessor(sid="ep_new"))

    script = p.create_project("New Ep", "text", skip_analysis=True, workflow_mode="r2v", series_id="S")
    assert script.series_id == "S"
    assert script.episode_number == 1  # first episode -> max(0)+1
    assert "ep_new" in p.scripts


def test_create_project_standalone_when_no_series_id(tmp_path):
    p = _bare_pipeline(tmp_path, script_processor=_FakeProcessor(sid="ep_solo"))
    script = p.create_project("Solo", "text", skip_analysis=True, workflow_mode="r2v")
    assert script.series_id is None
    assert "ep_solo" in p.scripts


def test_create_project_bad_series_raises(tmp_path):
    p = _bare_pipeline(tmp_path, script_processor=_FakeProcessor(sid="ep_bad"))
    with pytest.raises(ValueError):
        p.create_project("X", "text", skip_analysis=True, series_id="missing")
