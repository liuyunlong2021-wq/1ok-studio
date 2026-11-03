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


def test_prose_line_starting_with_jingtou_is_body_not_a_bad_header():
    from src.apps.comic_gen.engineering_script import parse_engineering_script
    text = "镜头一【00:00-00:04】\n【中景，固定镜头，平视机位，构图居中】\n镜头跟随他的视线缓缓拉起——黑土延伸向远处。"
    shots = parse_engineering_script(text)["shots"]
    assert "镜头跟随他的视线" in shots[0]["body"]


def test_timestamp_script_folds_into_whole_second_shots_for_production():
    from src.apps.comic_gen.engineering_script import parse_engineering_script
    text = "0.0–1.4s：甲转身。\n\n1.4–3.5s：乙开口。\n\n3.5–6.5s：丙落地。"
    plan = parse_engineering_script(text, validate_specs=False)
    assert [(s["start"], s["end"]) for s in plan["shots"]] == [(0, 1), (1, 4), (4, 7)]
    assert plan["duration"] == 7 and "甲转身" in plan["shots"][0]["body"]


def test_timestamp_segments_are_localized_to_segment_axis():
    from src.apps.comic_gen.engineering_script import parse_engineering_script
    from src.apps.comic_gen.production_workflow import plan_production_segments
    text = "0.0–3.0s：甲。\n\n3.0–6.0s：乙。\n\n6.0–9.0s：丙。"
    shots = parse_engineering_script(text, validate_specs=False)["shots"]
    segments = plan_production_segments(shots, 7)
    assert len(segments) == 2
    assert segments[1]["shots"][0]["body"].startswith("0.0–3.0s：")


def test_adaptation_script_with_asset_header_pipe_stamps_and_dialogue():
    from src.apps.comic_gen.production_workflow import plan_production_segments
    text = (
        "角色：李长青\n场景：黑土地平原边缘\n道具：劣质锄头\n\n"
        "0.0–3.0s｜李长青把劣质锄头横到胸前。\n\n"
        "3.0–6.0s｜硬切到蓝色光点特写，李长青皱眉。\n"
        "李长青（低声恐惧颤音）：“不能继续留在这里了。”\n\n"
        "6.0–9.0s｜李长青转身跑开。"
    )
    plan = parse_engineering_script(text, validate_specs=False)
    assert plan["preamble"].startswith("角色：李长青")
    assert [(s["start"], s["end"]) for s in plan["shots"]] == [(0, 3), (3, 6), (6, 9)]
    assert "不能继续留在这里了" in plan["shots"][1]["body"]
    segments = plan_production_segments(plan["shots"], 7)
    assert segments[1]["shots"][0]["body"].startswith("0.0–3.0s：")
