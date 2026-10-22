"""Contracts shared by the manually driven production workflow."""

import hashlib
import json
from typing import Any, Optional

from ...utils.model_catalog import load_generated_model_catalog
from .engineering_script import BEAT, _seconds

PRODUCTION_WORKFLOW_ID = "engineering_segments_v1"
TAIL_SECONDS = 1
MAX_STANDALONE_EPISODE_SECONDS = 30
VOICE_DESIGN_KEYS = ("年龄感", "音高", "明暗", "厚薄", "共鸣", "气息", "颗粒感", "口音", "稳定表达习惯")


def source_revision(text: str) -> str:
    normalized = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def style_revision(art_direction: Any) -> str:
    payload = art_direction.model_dump() if hasattr(art_direction, "model_dump") else art_direction
    encoded = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def production_settings_revision(settings: dict, confirmed_style_revision: str) -> str:
    keys = ("aspect_ratio", "image_model", "video_model", "motion_skill_id", "motion_skill_revision", "motion_skill_hash", "max_segment_seconds", "tail_seconds", "bgm")
    payload = {key: settings.get(key) for key in keys}
    payload["style_revision"] = confirmed_style_revision
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()

def validate_production_video_model(model_id: str) -> None:
    models = load_generated_model_catalog().get("models", {})
    key = (model_id or "").split("#", 1)[0].split("/", 1)[-1]
    model = models.get(key)
    if not model or "r2v" not in (model.get("capabilities") or []):
        raise ValueError("请选择目录中可用的参考生视频通道")


def segment_duration_choices() -> list[int]:
    return list(range(2, 31))


def validate_segment_maximum(duration: int) -> None:
    if type(duration) is not int:
        raise ValueError("分段总时长必须为整数秒")
    if duration < 2:
        raise ValueError("分段总时长至少为2秒，其中最后1秒固定留给全景尾镜")
    if duration > 30:
        raise ValueError("本流程单段总时长上限为30秒（含末尾全景）")


def validate_production_episode_duration(series_id: Optional[str], segments: list[dict]) -> None:
    if not series_id and sum(segment.get("duration_total", 0) for segment in segments) > MAX_STANDALONE_EPISODE_SECONDS:
        raise ValueError("单集剧成片总时长不能超过30秒（含每段结尾全景）")


def _timecode(seconds: int) -> str:
    return f"{seconds // 60:02d}:{seconds % 60:02d}"


def plan_production_segments(shots: list[dict], max_total_seconds: int, tail_seconds: int = TAIL_SECONDS) -> list[dict]:
    """Split confirmed engineering shots without cutting a shot or adding tail to its source."""
    if type(max_total_seconds) is not int or type(tail_seconds) is not int or tail_seconds < 1:
        raise ValueError("分段时长设置无效")
    budget = max_total_seconds - tail_seconds
    if budget < 1:
        raise ValueError("分段时长必须大于末尾全景时长")
    if not shots:
        raise ValueError("请先确认工程剧本")

    groups: list[list[dict]] = []
    current: list[dict] = []
    current_duration = 0
    current_scene = None
    for shot in shots:
        duration = shot["end"] - shot["start"]
        if duration <= 0 or duration > budget:
            raise ValueError(f"镜头{shot['number']}时长超过剧情预算{budget}秒；请先回工程剧本拆镜")
        scene = shot.get("scene") or ""
        scene_changed = bool(current and scene and current_scene and scene != current_scene)
        if current and (scene_changed or current_duration + duration > budget):
            groups.append(current)
            current, current_duration = [], 0
        current.append(shot)
        current_duration += duration
        current_scene = scene
    if current:
        groups.append(current)

    result = []
    for index, group in enumerate(groups, 1):
        start = group[0]["start"]
        duration = sum(shot["end"] - shot["start"] for shot in group)
        local_shots = []
        for local_number, shot in enumerate(group, 1):
            local_start, local_end = shot["start"] - start, shot["end"] - start
            body = shot["body"]
            # Beat markers in the source use the episode time axis; segment copies restart at 00:00.
            def localize(match):
                first = _seconds(match.group(1)) - start
                last = _seconds(match.group(2)) - start if match.group(2) else None
                range_text = f"-{_timecode(last)}" if last is not None else ""
                return f"【{_timecode(first)}{range_text}】"
            body = BEAT.sub(localize, body)
            local_shots.append({
                "number": shot["number"],
                "local_number": local_number,
                "scene": shot.get("scene") or "",
                "start": local_start,
                "end": local_end,
                "body": body,
                "visual": shot["visual"],
                "speaker": shot.get("speaker"),
            })
        result.append({
            "id": f"segment-{index:03d}-{group[0]['number']}-{group[-1]['number']}",
            "index": index,
            "source_shot_numbers": [shot["number"] for shot in group],
            "duration_story": duration,
            "duration_total": duration + tail_seconds,
            "tail_seconds": tail_seconds,
            "shots": local_shots,
            "synopsis": "",
            "entry_state": "",
            "exit_state": "",
            "prompt_draft": "",
            "adopted_prompt": "",
            "prompt_skill": {},
        })
    return result


def render_production_segment(segment: dict) -> str:
    asset_lines = []
    for kind, label in (("characters", "角色"), ("scenes", "场景"), ("props", "道具")):
        assets = [asset for asset in segment.get("asset_refs", []) if asset.get("kind") == kind]
        if not assets:
            continue
        values = []
        for asset in assets:
            look_label = f" · {asset['look_name']}" if asset.get("look_name") else ""
            value = f"图{asset['number']} {asset['name']}{look_label}：{asset.get('description') or '无描述'}"
            if kind == "characters":
                voice = asset.get("voice_design") or {}
                value += "；九维声音：" + "，".join(f"{key}{voice.get(key, '未设计')}" for key in (
                    "年龄感", "音高", "明暗", "厚薄", "共鸣", "气息", "颗粒感", "口音", "稳定表达习惯",
                ))
            values.append(value)
        asset_lines.append(f"{label}：" + "；".join(values))

    style = segment.get("style") or {}
    screenplay = []
    for shot in segment.get("shots", []):
        scene = shot.get("scene")
        if scene and (not screenplay or screenplay[-1] != scene):
            screenplay.append(scene)
        screenplay.extend([
            f"镜头{shot['local_number']}【{_timecode(shot['start'])}-{_timecode(shot['end'])}】",
            *( ["本镜参考：" + "、".join(f"图{number}" for number in shot["asset_reference_numbers"])] if shot.get("asset_reference_numbers") else []),
            shot["body"],
        ])
    final_number = len(segment.get("shots", [])) + 1
    start, end = segment["duration_story"], segment["duration_total"]
    character_count = len(set(segment.get("tail_character_ids") or []))
    scale = {0: "空场景全景", 1: "单人全景", 2: "双人全景", 3: "三人全景"}.get(character_count, "多人全景")
    positions = segment.get("exit_state") or "请填写结尾全景中每个人物的左右、前后、朝向及持物关系"
    tail_looks = segment.get("tail_character_looks") or {}
    tail_references = [f"图{ref['number']}（{ref['name']} · {ref.get('look_name') or '默认造型'}）"
                       for ref in segment.get("asset_refs", [])
                       if ref.get("kind") == "characters" and ref.get("id") in tail_looks and ref.get("look_id") == tail_looks[ref["id"]]]
    screenplay.extend([
        f"镜头{final_number}【{_timecode(start)}-{_timecode(end)}】",
        f"【{scale}，固定镜头，平视机位，构图：{positions}】",
        *(["尾镜造型参考：" + "、".join(tail_references)] if tail_references else []),
        "△最后1秒保持人物空间关系与场景地标，不新增对白或动作。",
    ])
    return "\n".join([
        "一、分段简介",
        "分段简介：" + (segment.get("synopsis") or "请填写主体、人物关系、情绪与内容概述。"),
        "",
        "二、参考资产",
        *(asset_lines or ["本段无已绑定参考资产。"]),
        "",
        "三、确认风格",
        f"{style.get('name') or '未命名风格'}：{style.get('positive_prompt') or ''}",
        f"负向约束：{style.get('negative_prompt') or '无'}。明确不含BGM。",
        "",
        "四、本段工程剧本",
        f"开场承接：{segment.get('entry_state') or '首段按工程剧本首镜开场；请补充位置、朝向、距离、视线与持物。'}",
        *screenplay,
    ])


def production_segment_revision(segment: dict) -> str:
    keys = (
        "id", "source_revision", "style_revision", "settings_revision", "source_shot_numbers", "duration_total",
        "synopsis", "entry_state", "exit_state", "asset_refs", "tail_character_ids", "tail_character_looks", "style", "shots",
    )
    payload = {key: segment.get(key) for key in keys}
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
