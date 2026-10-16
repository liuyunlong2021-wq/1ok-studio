import pytest

from src.apps.comic_gen.production_workflow import (
    plan_production_segments,
    render_production_segment,
    segment_duration_choices,
    validate_segment_maximum,
)


def _shot(number, start, end, scene="场1-1 室内 - 夜", body="【近景，固定镜头，平视机位，构图：人物居中】△人物停顿。"):
    return {
        "number": number,
        "start": start,
        "end": end,
        "scene": scene,
        "body": body,
        "visual": body,
        "speaker": None,
    }


def test_h3_duration_choices_include_tail_cap_and_fixed_30_second_seedance_is_ineligible():
    assert segment_duration_choices("jc-minimax-h3-ref2v") == list(range(2, 28))
    assert segment_duration_choices("海seedance2.5") == []
    validate_segment_maximum("jc-minimax-h3-ref2v", 27)
    with pytest.raises(ValueError, match="更换支持可变时长"):
        validate_segment_maximum("海seedance2.5", 29)


def test_segment_planner_never_splits_shots_and_adds_one_second_tail_budget():
    shots = [_shot(1, 0, 3), _shot(2, 3, 5), _shot(3, 5, 8)]

    segments = plan_production_segments(shots, max_total_seconds=6)

    assert [segment["source_shot_numbers"] for segment in segments] == [[1, 2], [3]]
    assert [(segment["duration_story"], segment["duration_total"]) for segment in segments] == [(5, 6), (3, 4)]
    assert all(segment["duration_total"] <= 6 for segment in segments)


def test_segment_planner_prefers_scene_changes_and_rebases_local_timecodes():
    shots = [
        _shot(1, 10, 12, body="【00:10-00:11】近景，固定镜头，平视机位，构图：人物居中\n△人物停顿。"),
        _shot(2, 12, 14, scene="场1-2 街道 - 夜"),
    ]

    segments = plan_production_segments(shots, max_total_seconds=8)

    assert [segment["source_shot_numbers"] for segment in segments] == [[1], [2]]
    assert segments[0]["shots"][0]["body"].startswith("【00:00-00:01】")
    assert segments[1]["shots"][0]["start"] == 0


def test_segment_planner_rejects_a_shot_that_cannot_fit_without_cutting_it():
    with pytest.raises(ValueError, match="请先回工程剧本拆镜"):
        plan_production_segments([_shot(1, 0, 6)], max_total_seconds=6)


@pytest.mark.parametrize(
    ("characters", "expected"),
    [(0, "空场景全景"), (1, "单人全景"), (2, "双人全景"), (3, "三人全景"), (4, "多人全景")],
)
def test_segment_tail_uses_only_characters_present_in_the_last_shot(characters, expected):
    segment = {
        "duration_story": 3,
        "duration_total": 4,
        "exit_state": "站位保持不变",
        "shots": [{"local_number": 1, "start": 0, "end": 3, "body": "剧情镜头"}],
        "asset_refs": [{"kind": "characters", "id": f"c{i}", "number": i + 1, "name": f"角色{i}"} for i in range(6)],
        "tail_character_ids": [f"c{i}" for i in range(characters)],
    }

    screenplay = render_production_segment(segment)

    assert f"【{expected}，固定镜头" in screenplay
