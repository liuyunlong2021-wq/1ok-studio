"""Validate newly generated shots before replacing a saved storyboard."""
import re


class StoryboardContractError(RuntimeError):
    pass


SHOT_SIZES = {"大特写", "特写", "近景", "中景", "全景", "远景", "大远景"}
CAMERA_ANGLES = {"平视", "俯视", "仰视", "鸟瞰", "蚁视", "过肩", "荷兰角", "主观视角"}
TIME_RANGE = re.compile(r"【(\d+:\d+(?:\.\d+)?)-(\d+:\d+(?:\.\d+)?)】")
SOURCE_LINE = re.compile(r"^([^：:（）()\[\]【】△#]{1,30}?)(?:[（(].*?[）)])?\s*[：:]\s*(.*)$")


def storyboard_duration(frames):
    """Sum saved shot budgets; never invent a duration for legacy empty fields."""
    if not frames:
        raise ValueError("请先选择镜头")
    total = 0
    for frame in frames:
        if type(frame.duration) is not int or frame.duration <= 0:
            raise ValueError("所选镜头缺少有效时长，请先在分镜中补齐")
        total += frame.duration
    return total


def _name(value):
    return value.strip().casefold()


def _asset_id(name, assets, label):
    if not isinstance(name, str):
        raise StoryboardContractError(f"{label}引用必须是名称字符串")
    if not name.strip():
        return None
    # Exact names take precedence over aliases, never substring matching.
    matches = [a for a in assets if _name(a["name"]) == _name(name)]
    if not matches:
        matches = [a for a in assets if _name(name) in {_name(v) for v in a.get("aliases", [])}]
    ids = {a["id"] for a in matches}
    if len(ids) != 1:
        raise StoryboardContractError(f"{label}“{name}”{'存在歧义' if ids else '未匹配资产'}，请核对名称或别名")
    return next(iter(ids))


def _spoken_text(value):
    value = value.strip()
    if value.startswith(("（", "(")):
        value = re.sub(r"^[（(].*?[）)]\s*", "", value, count=1)
    if len(value) >= 2 and (value[0], value[-1]) in {('“', '”'), ('「', '」'), ('"', '"')}:
        value = value[1:-1]
    return value


def _source_dialogue(text):
    """Recognize the editor's inline and two-line screenplay dialogue formats."""
    result, pending = [], None
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith(("△", "【", "场", "镜头", "#")):
            pending = None
            continue
        match = SOURCE_LINE.match(line)
        if match:
            speaker, value = match.groups()
            if speaker.strip() in {"人物", "场景", "地点", "时间", "道具", "音效", "音乐"}:
                pending = None
                continue
            pending = speaker.strip()
            if value.strip():
                result.append((pending, _spoken_text(value)))
                pending = None
        elif pending and line.startswith(("（", "(", "“", '"', "「")):
            result.append((pending, _spoken_text(line)))
            pending = None
        else:
            pending = None
    return result


def validate_storyboard_frames(frames, entities, source_text):
    if not isinstance(frames, list) or not frames:
        raise StoryboardContractError("分镜必须是非空 frames 数组")
    bound, actual = [], []
    previous_end = None
    for index, frame in enumerate(frames, 1):
        prefix = f"第{index}镜："
        try:
            if not isinstance(frame, dict):
                raise StoryboardContractError("镜头必须是对象")
            required = {"scene_ref_name", "character_ref_names", "prop_ref_names", "action_summary", "visual_description", "shot_size", "camera_angle", "camera_movement", "dialogue", "speaker", "duration"}
            missing = required - frame.keys()
            if missing:
                raise StoryboardContractError("缺少字段：" + "、".join(sorted(missing)))
            for key in ("action_summary", "visual_description", "camera_movement"):
                if not isinstance(frame.get(key), str) or not frame[key].strip():
                    raise StoryboardContractError(f"缺少 {key}，请补齐镜头内容和规格")
            if not isinstance(frame.get("shot_size"), str) or frame["shot_size"] not in SHOT_SIZES:
                raise StoryboardContractError("缺少或不支持的景别")
            if not isinstance(frame.get("camera_angle"), str) or frame["camera_angle"] not in CAMERA_ANGLES:
                raise StoryboardContractError("缺少或不支持的机位")
            duration = frame.get("duration")
            if type(duration) is not int or duration <= 0:
                raise StoryboardContractError("时长必须为正整数秒")
            refs = {"scene_id": _asset_id(frame.get("scene_ref_name", ""), entities.get("scenes", []), "场景") or ""}
            for field, group, label in (("character_ref_names", "characters", "角色"), ("prop_ref_names", "props", "道具")):
                names = frame.get(field)
                if not isinstance(names, list) or any(not isinstance(v, str) or not v.strip() for v in names):
                    raise StoryboardContractError(f"{field} 必须为名称数组")
                refs["character_ids" if group == "characters" else "prop_ids"] = list(dict.fromkeys(_asset_id(v, entities.get(group, []), label) for v in names))
            dialogue, speaker = frame.get("dialogue"), frame.get("speaker")
            if dialogue is not None and not isinstance(dialogue, str):
                raise StoryboardContractError("对白必须为字符串或 null")
            if speaker is not None and not isinstance(speaker, str):
                raise StoryboardContractError("说话人必须为字符串或 null")
            if dialogue and dialogue.strip():
                if not isinstance(speaker, str) or not speaker.strip():
                    raise StoryboardContractError("有对白但没有说话人")
                actual.append((speaker, dialogue))
            elif speaker:
                raise StoryboardContractError("无对白时说话人必须为空")
            timeline = TIME_RANGE.findall(frame["visual_description"])
            if timeline:
                def seconds(value):
                    minute, second = value.split(":")
                    if float(second) >= 60:
                        raise StoryboardContractError("时间码的秒数必须小于60")
                    return int(minute) * 60 + float(second)
                start, end = map(seconds, timeline[0])
                tolerance = 1 if any("." in value for value in timeline[0]) else 0
                if end <= start or abs(end - start - duration) > tolerance:
                    raise StoryboardContractError("镜头时间码与时长不一致")
                if previous_end is not None and start != previous_end:
                    raise StoryboardContractError("时间码存在重叠或空档")
                beat_end = start
                for a, b in timeline[1:]:
                    beat_start, next_end = seconds(a), seconds(b)
                    if not start <= beat_start < next_end <= end:
                        raise StoryboardContractError("镜内节拍超出镜头时间范围")
                    if beat_start < beat_end:
                        raise StoryboardContractError("镜内节拍时间重叠或倒退")
                    beat_end = next_end
                previous_end = end
            else:
                raise StoryboardContractError("完整描述缺少镜头时间码")
            bound.append(refs)
        except StoryboardContractError as error:
            raise StoryboardContractError(prefix + str(error)) from error

    source = _source_dialogue(source_text)
    if source:
        # Collapse consecutive fragments from the same speaker so natural
        # cross-shot dialogue is allowed while speaker/order changes are not.
        def groups(lines):
            values = []
            for speaker, line in lines:
                matches = [a for a in entities.get("characters", []) if _name(speaker) in {_name(a["name"]), *(_name(v) for v in a.get("aliases", []))}]
                name = matches[0]["id"] if len(matches) == 1 else _name(speaker)
                if values and values[-1][0] == name:
                    values[-1] = (name, values[-1][1] + line)
                else:
                    values.append((name, line))
            return values
        if groups(source) != groups(actual):
            raise StoryboardContractError("对白覆盖校验失败：原台词、标点、顺序或说话人有变化，请逐字保留；跨镜片段须拼回原句")
    return bound


def storyboard_image_prompt(frame, prompt=None):
    """Keep a still image's camera specification at the provider boundary."""
    content = prompt or frame.image_prompt or frame.visual_description or frame.action_description
    marker = "\n\n# 分镜关键帧规格\n"
    content = content.split(marker, 1)[0]
    specs = [f"景别：{frame.shot_size}" if frame.shot_size else "",
             f"机位：{frame.camera_angle}" if frame.camera_angle else "",
             f"运镜上下文：{frame.camera_movement}" if frame.camera_movement else "",
             f"构图：{frame.composition}" if frame.composition else ""]
    specification = "；".join(value for value in specs if value)
    return f"{content}{marker}单幅静态分镜关键帧。{specification}。时间与运动描述作为上下文，选取一个可见瞬间，不画多格、字幕或时间码。"
