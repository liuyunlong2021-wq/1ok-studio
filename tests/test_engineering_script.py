from src.apps.comic_gen.engineering_script import parse_engineering_script


def test_accepts_side_body_camera_position_on_chinese_numbered_shot():
    plan = parse_engineering_script(
        "镜头七【00:00-00:04】\n"
        "【单人中景，手持镜头，侧身机位，竖屏偏右构图】\n"
        "人物侧身站立。"
    )

    assert plan["shots"][0]["number"] == 7
    assert plan["shots"][0]["camera_angle"] == "侧身机位"


def test_production_parse_splits_by_timecode_without_camera_spec_validation():
    plan = parse_engineering_script(
        "镜头二十五【01:12-01:15】\n角色在光芒中抬头。",
        validate_specs=False,
    )

    assert plan["shots"][0]["number"] == 25
    assert plan["shots"][0]["start"] == 72
    assert plan["shots"][0]["end"] == 75
