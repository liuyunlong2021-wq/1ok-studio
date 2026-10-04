"""Read confirmed engineering screenplays without creating shots or estimating time."""
import hashlib
import json
import re
import time
import uuid

from .models import StoryboardFrame

TIME = r"\d{1,3}:\d{2}"
HEADER = re.compile(rf"^镜头\s*([0-9一二三四五六七八九十百零〇两]+)\s*[【\[]\s*({TIME})\s*[-—–]\s*({TIME})\s*[】\]]\s*$")
SCENE = re.compile(r"^场(?:景)?\s*\d+[-－]\d+")
BEAT = re.compile(rf"【({TIME})(?:[-—–]({TIME}))?】")


def normalize_screenplay(text):
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    # Compatibility with the old editor that split the first colon as dialogue.
    text = re.sub(r"([【\[]\d{1,3})\s*\n\s*(\d{2}\s*[-—–]\s*\d{1,3}:\d{2}[】\]])", r"\1:\2", text)
    return "\n".join(line.rstrip() for line in text.splitlines()).strip()


def screenplay_revision(text):
    return hashlib.sha256(normalize_screenplay(text).encode()).hexdigest()


def _number(value):
    if value.isdigit():
        return int(value)
    digits = dict(zip("零〇一二三四五六七八九两", (0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 2)))
    total = current = 0
    for char in value:
        if char in digits:
            current = digits[char]
        else:
            total += (current or 1) * {"十": 10, "百": 100}[char]
            current = 0
    return total + current


def _seconds(value):
    minute, second = map(int, value.split(":"))
    if second >= 60:
        raise ValueError("时间码秒数必须小于60")
    return minute * 60 + second


def _dialogue(lines):
    spoken, speakers, descriptions = [], [], []
    pending = None
    for line in lines:
        value = line.strip()
        match = re.match(r"^([^【】：:（）()]{1,30}?)(?:[（(].*?[）)])?[：:]\s*(.*)$", value)
        if match:
            pending, rest = match.groups()
            if rest.strip():
                value = rest.strip()
            else:
                continue
        quote = re.match(r"^(?:[（(].*?[）)]\s*)?[“\"](.*)[”\"]\s*$", value)
        if pending and quote:
            speakers.append(pending.strip())
            spoken.append(quote.group(1))
            pending = None
        elif pending and match and value:
            speakers.append(pending.strip())
            spoken.append(value)
            pending = None
        else:
            if pending:
                raise ValueError(f"{pending}的台词缺少引号或正文，请按工程台本格式补齐")
            descriptions.append(line)
    if pending:
        raise ValueError(f"{pending}的台词缺少正文")
    if len(set(speakers)) > 1:
        raise ValueError("同一镜出现多个说话人，请回剧本阶段调整镜头")
    return "\n".join(spoken) or None, speakers[0] if speakers else None, "\n".join(descriptions)


def parse_engineering_script(text):
    normalized = normalize_screenplay(text)
    shots, preamble, current, scene = [], [], None, ""

    def finish():
        if current is None:
            return
        body = "\n".join(current.pop("lines")).strip()
        number = current["number"]
        spec_match = next((m for m in re.finditer(r"【([^】]+)】", body) if "景" in m.group(1) or "特写" in m.group(1)), None)
        if not spec_match:
            raise ValueError(f"镜头{number}缺少【景别、运镜、机位、构图】规格")
        spec = spec_match.group(1)
        size_match = re.search(r"大特写|手部特写|中近景|大全景|大远景|远景|特写|近景|中景|全景", spec)
        if not size_match:
            raise ValueError(f"镜头{number}的景别无法识别，请使用工程台本的标准景别")
        size = size_match.group()
        parts = [part.strip() for part in re.split(r"[，,；;]", spec)]
        angle_tokens = ("过肩", "肩后", "鸟瞰", "航拍", "蚁视", "贴地", "荷兰角", "第一人称", "主观", "仰视", "低角度", "俯视", "平视", "侧面", "斜机位", "内侧机位")
        angle = next((part for part in sorted(parts, key=lambda part: "机位" not in part) if any(token in part for token in angle_tokens)), None)
        movement = next((part.strip() for part in re.split(r"[，,；;]", spec) if re.search(r"固定|静止|手持|推|拉|摇|移|跟|环绕|俯冲|FPV|航拍|子弹时间|变速|变焦|一镜到底", part)), None)
        if not angle or not movement or "构图" not in spec:
            raise ValueError(f"镜头{number}的运镜、机位或构图不完整，请在剧本中补齐")
        movement = re.sub(r"^(?:单人|双人|多人)?(?:大特写|手部特写|中近景|大全景|大远景|远景|特写|近景|中景|全景)", "", movement).replace("镜头", "").strip()
        previous_beat = current["start"]
        for beat in BEAT.finditer(body):
            start = _seconds(beat.group(1))
            end = _seconds(beat.group(2)) if beat.group(2) else start
            if not current["start"] <= start <= end <= current["end"] or start < previous_beat:
                raise ValueError(f"镜头{number}的表演节拍越界、重叠或倒退")
            previous_beat = end
        try:
            dialogue, speaker, visual = _dialogue(body.splitlines())
        except ValueError as error:
            raise ValueError(f"镜头{number}：{error}") from error
        current.update(body=body, visual=visual, shot_size=size, camera_angle=angle, camera_movement=movement,
                       composition=next(part.strip() for part in re.split(r"[，,]", spec) if "构图" in part), dialogue=dialogue, speaker=speaker,
                       source_text=(current["scene"] + "\n" if current["scene"] else "") + current["header"] + "\n" + body)
        shots.append(current.copy())

    for raw in normalized.splitlines():
        line = re.sub(r"^(?:#+\s*|\*\*)", "", raw.strip()).removesuffix("**")
        header = HEADER.match(line)
        if header:
            finish()
            label, start, end = header.groups()
            number = _number(label)
            if number <= 0:
                raise ValueError("镜头编号必须大于0")
            current = {"number": number, "header": line, "start": _seconds(start), "end": _seconds(end), "scene": scene, "lines": []}
            if current["end"] <= current["start"]:
                raise ValueError(f"镜头{number}结束时间必须晚于起点")
            if shots and (current["start"] != shots[-1]["end"] or number != shots[-1]["number"] + 1):
                raise ValueError(f"镜头{number}与前镜编号或时间码不连续，请回剧本调整")
        elif line.startswith("镜头"):
            raise ValueError(f"镜头标题格式有误：{line}。请使用 镜头一【00:00-00:04】（整秒）")
        elif SCENE.match(line):
            finish()
            current = None
            scene = line
        elif current is not None:
            current["lines"].append(raw)
        elif not shots and not scene:
            preamble.append(raw)
    finish()
    if not shots:
        raise ValueError("当前剧本没有带时间码的工程镜头，请先用工程台本 Skill 调整并确认节奏")
    return {"text": normalized, "revision": screenplay_revision(normalized), "shots": shots,
            "preamble": "\n".join(preamble).strip(), "duration": shots[-1]["end"] - shots[0]["start"]}


def engineering_status(script):
    plan = script.engineering_script
    return {"confirmed": bool(plan), "current": bool(plan and plan["revision"] == screenplay_revision(script.original_text)),
            "revision": plan["revision"] if plan else None, "count": len(plan["shots"]) if plan else 0,
            "duration": plan["duration"] if plan else 0, "synced": bool(plan and script.storyboard_source_revision == plan["revision"])}


def require_synced_engineering(script):
    if script.storyboard_source_revision:
        status = engineering_status(script)
        if not status["current"] or not status["synced"]:
            raise ValueError("工程台本已修改，请先在剧本页确认，再到分镜页预览同步")


def _source_body(value):
    return "\n".join(line for line in (value or "").splitlines() if not HEADER.match(line))


def _bind(text, assets):
    matches, warnings, occupied = [], [], []
    names = sorted({name for asset in assets for name in [asset.name, *(asset.aliases or [])] if name}, key=len, reverse=True)
    for name in names:
        occurrences = [m.span() for m in re.finditer(re.escape(name), text) if not any(a <= m.start() and m.end() <= b for a, b in occupied)]
        if not occurrences:
            continue
        candidates = [asset for asset in assets if asset.name == name] or [asset for asset in assets if name in (asset.aliases or [])]
        occupied.extend(occurrences)
        if len(candidates) != 1:
            warnings.append(f"资产名称“{name}”存在歧义，请手动绑定")
        elif candidates[0].id not in matches:
            matches.append(candidates[0].id)
    return matches, warnings


def preview_engineering_sync(script, assets):
    plan = script.engineering_script
    if not engineering_status(script)["current"]:
        raise ValueError("工程台本尚未确认或正文已修改，请先回剧本确认当前版本")
    existing = {frame.source_shot_number: frame for frame in script.frames if frame.source_shot_number is not None}
    if len(existing) != sum(frame.source_shot_number is not None for frame in script.frames):
        raise ValueError("已有分镜的工程镜头编号重复，请先处理重复镜头")
    # Match unchanged content before shot numbers, so inserting a shot does not
    # attach another shot's media merely because subsequent numbers shifted.
    mapped, used = {}, set()
    for shot in plan["shots"]:
        matches = [frame for frame in existing.values() if _source_body(frame.source_text) == _source_body(shot["source_text"])]
        if len(matches) == 1 and matches[0].id not in used:
            mapped[shot["number"]] = matches[0]
            used.add(matches[0].id)
    for shot in plan["shots"]:
        old = existing.get(shot["number"])
        if shot["number"] not in mapped and old and old.id not in used:
            mapped[shot["number"]] = old
            used.add(old.id)
    proposed, changes, warnings = [], [], []
    for shot in plan["shots"]:
        old = mapped.get(shot["number"])
        scene_ids, scene_warnings = _bind(shot["scene"], assets["scenes"])
        char_ids, char_warnings = _bind(shot["visual"] + "\n" + (shot["speaker"] or ""), assets["characters"])
        prop_ids, prop_warnings = _bind(shot["visual"], assets["props"])
        issues = scene_warnings + char_warnings + prop_warnings
        if len(scene_ids) != 1:
            issues.append("场景未唯一匹配，请在分镜中手动绑定")
        for issue in issues:
            warnings.append(f"镜头{shot['number']}：{issue}")
        visual = shot["header"] + "\n" + shot["visual"]
        if shot == plan["shots"][0] and plan["preamble"]:
            visual = plan["preamble"] + "\n" + visual
        summary = re.sub(r"【[^】]+】", "", shot["visual"]).strip()
        fields = dict(source_shot_number=shot["number"], source_start=shot["start"], source_end=shot["end"], source_text=shot["source_text"],
                      source_revision=plan["revision"], duration=shot["end"] - shot["start"], action_description=summary[:200], visual_description=visual,
                      shot_size=shot["shot_size"], camera_angle=shot["camera_angle"], camera_movement=shot["camera_movement"], composition=shot["composition"], dialogue=shot["dialogue"], speaker=shot["speaker"])
        if old:
            if _source_body(old.source_text) != _source_body(shot["source_text"]):
                fields.update(scene_id=scene_ids[0] if len(scene_ids) == 1 else "", character_ids=char_ids, prop_ids=prop_ids)
            # Keep deliberate manual bindings when the source text is unchanged.
            changed = any(getattr(old, key) != value for key, value in fields.items() if key != "source_revision")
            frame = old.model_copy(deep=True)
            for key, value in fields.items():
                setattr(frame, key, value)
            if changed:
                frame.review_required = True
                for key in ("image_prompt", "image_prompt_cn", "image_prompt_en", "video_prompt", "assembled_prompt", "camera_movement_structured", "blocking", "dialogue_structured", "audio_note", "lighting"):
                    setattr(frame, key, None)
        else:
            changed = True
            frame = StoryboardFrame(id=str(uuid.uuid5(uuid.NAMESPACE_URL, f"{script.id}/{plan['revision']}/{shot['number']}")),
                                    scene_id=scene_ids[0] if len(scene_ids) == 1 else "", character_ids=char_ids, prop_ids=prop_ids, **fields)
        proposed.append(frame)
        changes.append({"kind": "updated" if old and changed else "unchanged" if old else "added", "number": shot["number"], "frame_id": frame.id,
                        "before_duration": old.duration if old else None, "duration": frame.duration, "before": old.source_text or old.action_description if old else "",
                        "after": shot["source_text"], "media_kept": bool(old and (old.image_url or old.rendered_image_url or old.selected_video_id or old.video_url or (old.image_asset and old.image_asset.variants) or (old.rendered_image_asset and old.rendered_image_asset.variants))), "bindings": {"characters": frame.character_ids, "scene": frame.scene_id, "props": frame.prop_ids}})
    keep_ids = {frame.id for frame in proposed}
    for frame in script.frames:
        if frame.id not in keep_ids:
            changes.append({"kind": "removed", "number": frame.source_shot_number, "frame_id": frame.id, "before": frame.source_text or frame.action_description, "after": "", "before_duration": frame.duration, "duration": None, "media_kept": True})
    digest = {"revision": plan["revision"], "before": [frame.model_dump() for frame in script.frames], "after": [frame.model_dump() for frame in proposed]}
    token = hashlib.sha256(json.dumps(digest, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    return {"token": token, "revision": plan["revision"], "count": len(proposed), "duration": plan["duration"], "changes": changes, "warnings": warnings}, proposed


def apply_engineering_sync(script, assets, token):
    preview, frames = preview_engineering_sync(script, assets)
    if preview["token"] != token:
        raise ValueError("台本、资产或分镜已变化，请重新预览后同步")
    changed = any(item["kind"] != "unchanged" for item in preview["changes"])
    if script.frames and changed:
        script.storyboard_archives.append({"created_at": time.time(), "source_revision": script.storyboard_source_revision,
                                           "frames": [frame.model_dump() for frame in script.frames]})
    script.frames = frames
    script.storyboard_source_revision = preview["revision"]
    script.updated_at = time.time()
    return script
