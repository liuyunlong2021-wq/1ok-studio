"""整集生成的分段方案（`segment_plan`）契约测试。

守三件事：
1. 切点只落在镜头边界、不切开镜头、不超模型上限；
2. 用户手调过的段（`manual`）在自动重排时作为锚点保留；
3. 接续句只在「边界没变」时沿用，边界变了就留空（不猜）。

跑：python -m pytest tests/test_segment_plan.py
"""
import pytest

from src.apps.comic_gen.models import Script, Segment, StoryboardFrame
from src.apps.comic_gen import segment_plan


def _script(durations, ids=None):
    ids = ids or [f"shot-{i}" for i in range(1, len(durations) + 1)]
    return Script(
        id="p1",
        title="t",
        original_text="t",
        frames=[
            StoryboardFrame(id=frame_id, scene_id="scene-1", duration=duration)
            for frame_id, duration in zip(ids, durations)
        ],
        created_at=0.0,
        updated_at=0.0,
    )


# ─── plan_segments：纯切分 ────────────────────────────────────────────────────

def test_packs_shots_until_the_target_is_reached():
    assert segment_plan.plan_segments([4, 4, 4], 12, (1, 15)) == [[0, 1, 2]]


def test_never_exceeds_the_model_ceiling():
    # 12 + 4 = 16 > 15，所以第 4 镜必须另起一段（而不是凑到 16 秒）。
    assert segment_plan.plan_segments([4, 4, 4, 4], 12, (1, 15)) == [[0, 1, 2], [3]]


def test_short_tail_merges_back_into_the_previous_segment():
    # 尾巴 3 秒低于下限 10，但并进前一段正好 15（= 上限），所以并。
    assert segment_plan.plan_segments([12, 3], 12, (10, 15)) == [[0, 1]]


def test_short_tail_that_cannot_merge_is_reported():
    # 尾巴 3 秒 < 10，并进前一段会到 17 > 15 → 报错，而不是悄悄提交一个非法时长。
    with pytest.raises(ValueError, match="低于模型下限"):
        segment_plan.plan_segments([10, 4, 10, 3], 10, (10, 15))


def test_single_shot_longer_than_the_ceiling_names_that_shot():
    with pytest.raises(ValueError, match="第1镜时长 20 秒超过模型上限"):
        segment_plan.plan_segments([20], 12, (1, 15))


def test_whole_episode_shorter_than_the_floor_is_rejected():
    with pytest.raises(ValueError, match="低于模型下限"):
        segment_plan.plan_segments([5], 12, (10, 15))


def test_target_below_the_model_floor_is_rejected():
    # 固定 30 秒的模型（dola / 海seedance 那类）：段长目标 12 秒根本不可能成立。
    with pytest.raises(ValueError, match="低于模型下限"):
        segment_plan.plan_segments([30], 12, (30, 30))


def test_missing_duration_names_the_shot():
    with pytest.raises(ValueError, match="第2镜缺少有效时长"):
        segment_plan.plan_segments([5, 0], 12, (1, 15))


def test_empty_selection_is_rejected():
    with pytest.raises(ValueError, match="请先选择镜头"):
        segment_plan.plan_segments([], 12, (1, 15))


# ─── build_segments：手调锚点与接续句 ─────────────────────────────────────────

def test_builds_segments_with_summed_durations():
    segments = segment_plan.build_segments(_script([4, 4, 4, 4]), target=12, bounds=(1, 15))
    assert [(s.index, s.duration, s.frame_ids) for s in segments] == [
        (1, 12, ["shot-1", "shot-2", "shot-3"]),
        (2, 4, ["shot-4"]),
    ]
    assert all(s.manual is False for s in segments)


def test_manual_segment_survives_replanning_as_an_anchor():
    script = _script([4, 4, 4, 4])
    script.segments = [
        Segment(index=1, frame_ids=["shot-2", "shot-3"], duration=8, manual=True),
    ]
    segments = segment_plan.build_segments(script, target=12, bounds=(1, 15))
    # 手调的两镜原样保留，它前后各自重排。
    assert [s.frame_ids for s in segments] == [["shot-1"], ["shot-2", "shot-3"], ["shot-4"]]
    assert [s.manual for s in segments] == [False, True, False]


def test_anchor_dropped_when_a_frame_is_gone():
    script = _script([4, 4, 4])
    script.segments = [
        Segment(index=1, frame_ids=["shot-1", "shot-9"], duration=8, manual=True),
    ]
    # 锚点里的镜头不在了 → 锚作废，全量重排（而不是吃掉邻居的一半）。
    segments = segment_plan.build_segments(script, target=12, bounds=(1, 15))
    assert [s.frame_ids for s in segments] == [["shot-1", "shot-2", "shot-3"]]
    assert all(s.manual is False for s in segments)


def test_exit_state_kept_only_when_boundaries_are_unchanged():
    script = _script([4, 4, 4, 4])
    script.segments = [
        Segment(index=1, frame_ids=["shot-1"], duration=4, exit_state="A 在画面左侧"),
    ]
    segments = segment_plan.build_segments(script, target=12, bounds=(1, 15))
    # 边界从 [shot-1] 变成 [shot-1,shot-2,shot-3] → 接续句作废，留空等重新生成。
    assert segments[0].exit_state == ""

    script.segments = [
        Segment(index=1, frame_ids=["shot-1", "shot-2", "shot-3"], duration=12, exit_state="A 在画面左侧"),
        Segment(index=2, frame_ids=["shot-4"], duration=4),
    ]
    segments = segment_plan.build_segments(script, target=12, bounds=(1, 15))
    assert segments[0].exit_state == "A 在画面左侧"


# ─── 过期判定与自动重排 ───────────────────────────────────────────────────────

def test_fresh_segments_are_not_stale():
    script = _script([4, 4])
    script.segments = segment_plan.build_segments(script, target=12, bounds=(1, 15))
    assert segment_plan.segments_stale(script) is False


def test_adding_a_shot_makes_it_stale():
    script = _script([4, 4])
    script.segments = segment_plan.build_segments(script, target=12, bounds=(1, 15))
    script.frames.append(StoryboardFrame(id="shot-3", scene_id="scene-1", duration=4))
    assert segment_plan.segments_stale(script) is True


def test_changing_a_duration_makes_it_stale():
    script = _script([4, 4])
    script.segments = segment_plan.build_segments(script, target=12, bounds=(1, 15))
    script.frames[0].duration = 7
    assert segment_plan.segments_stale(script) is True


def test_ensure_segments_replans_only_when_stale():
    script = _script([4, 4, 4, 4])
    assert segment_plan.ensure_segments(script, target=12) is True
    assert len(script.segments) > 0
    # 再调一次：没变就不该动（否则每次读都重排，手调边界会被反复抹掉）。
    assert segment_plan.ensure_segments(script) is False

    script.frames[0].duration = 9
    assert segment_plan.ensure_segments(script) is True
    # 目标段长会写回，供 UI 显示
    assert script.segment_target_seconds == 12


def test_ensure_segments_leaves_an_empty_project_alone():
    assert segment_plan.ensure_segments(_script([])) is False


# ─── continuity_for：起点继承取哪一段 ────────────────────────────────────────

def test_first_segment_has_nothing_to_inherit():
    segments = [Segment(index=1, frame_ids=["a"], exit_state="不该被自己继承")]
    assert segment_plan.continuity_for(segments, ["a"]) == ""


def test_second_segment_inherits_the_previous_exit_state():
    segments = [
        Segment(index=1, frame_ids=["a"], exit_state="A 在画面左侧中景"),
        Segment(index=2, frame_ids=["b"], exit_state=""),
    ]
    assert segment_plan.continuity_for(segments, ["b"]) == "A 在画面左侧中景"


def test_unknown_frames_have_nothing_to_inherit():
    segments = [Segment(index=1, frame_ids=["a"], exit_state="x")]
    assert segment_plan.continuity_for(segments, ["zzz"]) == ""
    assert segment_plan.continuity_for([], ["a"]) == ""


# ─── duration_bounds：时长上下限取自目录 ──────────────────────────────────────

def test_unknown_model_falls_back_to_conservative_bounds():
    assert segment_plan.duration_bounds("no-such-model") == segment_plan.FALLBACK_BOUNDS


def test_known_model_bounds_come_from_the_catalog_and_are_usable():
    lo, hi = segment_plan.duration_bounds("jiucaihezi/jc-minimax-h3-ref2v#r2v")
    assert 1 <= lo <= hi
    # 带前缀/后缀的写法要归一化到同一个模型
    assert (lo, hi) == segment_plan.duration_bounds("jc-minimax-h3-ref2v")
