"""Engineering-only asset extraction contracts and character look resolution."""
import copy
import time
import uuid
from typing import Optional

from pydantic import BaseModel, Field

from .models import AssetUnit, Character, CharacterLook, ImageVariant, Prop, Scene


class Evidence(BaseModel):
    shot_number: Optional[int] = None
    quote: str = Field(min_length=1)


class ExtractedEntity(BaseModel):
    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    description: str
    aliases: list[str] = Field(default_factory=list)
    extraction_evidence: list[Evidence] = Field(default_factory=list)
    extraction_unknowns: list[str] = Field(default_factory=list)


class ExtractedCharacter(ExtractedEntity):
    age: Optional[str] = None
    gender: Optional[str] = None
    clothing: Optional[str] = None
    looks: list[ExtractedEntity] = Field(default_factory=list)


class ExtractedScene(ExtractedEntity):
    time_of_day: Optional[str] = None
    lighting_mood: Optional[str] = None


class LookBinding(BaseModel):
    character_id: str
    look_id: Optional[str] = None


class ShotBinding(BaseModel):
    shot_number: int
    scene_id: Optional[str] = None
    characters: list[LookBinding]
    prop_ids: list[str]


class ProductionAssetExtraction(BaseModel):
    characters: list[ExtractedCharacter]
    scenes: list[ExtractedScene]
    props: list[ExtractedEntity]
    shot_bindings: list[ShotBinding]

    def validate_screenplay(self, screenplay):
        from .engineering_script import parse_engineering_script

        plan = parse_engineering_script(screenplay, validate_specs=False)
        shots = {shot["number"]: shot for shot in plan["shots"]}
        entities, identifiers = {}, set()
        for kind in ("characters", "scenes", "props"):
            collection = getattr(self, kind)
            entities[kind] = {item.id: item for item in collection}
            for entity in collection:
                for item in [entity, *getattr(entity, "looks", [])]:
                    if item.id in identifiers:
                        raise ValueError("资产或造型 ID 重复")
                    identifiers.add(item.id)
                    for evidence in item.extraction_evidence:
                        source = plan["preamble"] if evidence.shot_number is None else shots.get(evidence.shot_number, {}).get("source_text", "")
                        if not evidence.quote.strip() or evidence.quote not in source:
                            raise ValueError(f"{item.name}的来源引文或镜头不在工程剧本中")
        if len(self.shot_bindings) != len(shots) or {row.shot_number for row in self.shot_bindings} != set(shots):
            raise ValueError("资产绑定必须完整覆盖工程剧本的每个镜头")
        for row in self.shot_bindings:
            if row.scene_id and row.scene_id not in entities["scenes"]:
                raise ValueError("场景引用不存在")
            if len({ref.character_id for ref in row.characters}) != len(row.characters):
                raise ValueError("同镜头人物引用重复")
            for ref in row.characters:
                character = entities["characters"].get(ref.character_id)
                if not character or (ref.look_id and ref.look_id not in {look.id for look in character.looks}):
                    raise ValueError("人物或造型引用不属于对应角色")
                if not character.looks:
                    raise ValueError("可见角色至少需要一套已知或未注明造型")
            if any(identifier not in entities["props"] for identifier in row.prop_ids):
                raise ValueError("道具引用不存在")
        return self


def get_look(character, look_id=None):
    if look_id:
        look = next((item for item in character.looks if item.id == look_id), None)
        if not look:
            raise ValueError("指定造型不存在或不属于该角色")
        return look
    if len(character.looks) > 1:
        raise ValueError(f"请为“{character.name}”指定镜头使用的造型")
    return character.looks[0] if character.looks else character


def asset_description(asset, look=None):
    parts = [asset.description]
    for field, label in (("age", "年龄"), ("gender", "性别"), ("time_of_day", "时间"), ("lighting_mood", "光线")):
        if getattr(asset, field, None):
            parts.append(f"{label}：{getattr(asset, field)}")
    if look is not None and look is not asset:
        parts.append(f"本次造型：{look.name}\n{look.description}")
    elif getattr(asset, "clothing", None):
        parts.append(f"服装：{asset.clothing}")
    return "\n".join(filter(None, parts))


def selected_image(asset):
    unit = getattr(asset, "reference_sheet", None)
    if unit:
        match = next((item for item in unit.image_variants if item.id == unit.selected_image_id), None)
        if match:
            return match.url
    return getattr(asset, "image_url", None) or getattr(asset, "full_body_image_url", None)


def default_look(character):
    if not character.looks:
        unit = copy.deepcopy(character.reference_sheet or AssetUnit())
        if not unit.image_variants and character.full_body_asset:
            unit.image_variants = copy.deepcopy(character.full_body_asset.variants)
            unit.selected_image_id = character.full_body_asset.selected_id
        unit.image_prompt = unit.image_prompt or character.full_body_prompt
        character.looks.append(CharacterLook(id=str(uuid.uuid4()), name="默认造型", description=character.clothing or "", reference_sheet=unit,
                                             image_url=character.image_url or character.full_body_image_url))
    return character.looks[0]


def merge_extracted(target, incoming, script_id, revision):
    """Preserve human edits and media; update extracted facts from this episode."""
    extracted_fields = ("age", "gender", "clothing", "time_of_day", "lighting_mood")
    changed = target.description != incoming.description or any(
        hasattr(target, field) and getattr(incoming, field, None) and getattr(target, field) != getattr(incoming, field)
        for field in extracted_fields
    )
    target.extracted_description = incoming.description
    if not getattr(target, "locked", False) and target.description_source == "extracted" and changed:
        target.description = incoming.description
        target.description_version += 1
        target.prompt_generation_status = "stale"
        for look in getattr(target, "looks", []):
            look.prompt_generation_status = "stale"
    incoming_evidence = [{**item, "script_id": script_id, "screenplay_revision": revision} for item in incoming.extraction_evidence]
    target.extraction_evidence = [item for item in target.extraction_evidence if item.get("script_id") and item["script_id"] != script_id] + incoming_evidence
    target.extraction_unknowns = list(incoming.extraction_unknowns)
    if hasattr(target, "aliases"):
        target.aliases = list(dict.fromkeys([*target.aliases, *incoming.aliases]))
    for field in extracted_fields:
        if hasattr(target, field) and getattr(incoming, field, None) and not getattr(target, "locked", False) and target.description_source == "extracted":
            setattr(target, field, getattr(incoming, field))


def reference_key(reference):
    return (reference["id"], reference.get("look_id"))


def resolve_target(pipeline, script, asset_id, asset_type, look_id=None):
    if not script:
        raise ValueError("项目不存在")
    owner, source = pipeline._find_asset_with_source(script, asset_id, asset_type)
    if not owner:
        raise ValueError("资产不存在")
    if look_id and asset_type != "character":
        raise ValueError("只有角色可以指定造型")
    target = get_look(owner, look_id) if look_id else owner
    return owner, target, source


def require_editable(owner, target, source):
    if source == "global":
        raise ValueError("全局资产只读，请先复制到本项目")
    if owner.locked or getattr(target, "locked", False):
        raise ValueError("资产或造型已锁定")


def character_reference(character, look_id=None):
    look = get_look(character, look_id)
    unit = getattr(look, "reference_sheet", None)
    return {
        "look_id": look.id if look is not character else None,
        "look_name": look.name if look is not character else "默认造型",
        "description": asset_description(character, look)[:240],
        "image_url": selected_image(look),
        "selected_image_id": unit.selected_image_id if unit else None,
        "voice_design": copy.deepcopy(character.voice_design),
    }


def frame_references(pipeline, frame, assets_by_id):
    references = []
    ordered = [(value, "characters") for value in frame.character_ids] + ([(frame.scene_id, "scenes")] if frame.scene_id else []) + [(value, "props") for value in frame.prop_ids]
    for asset_id, kind in ordered:
        if asset_id not in assets_by_id:
            raise ValueError("工程镜头引用的资产不存在，请重新提取")
        asset = assets_by_id[asset_id]
        reference = {"id": asset_id, "kind": kind, "name": asset.name}
        if kind == "characters":
            reference.update(character_reference(asset, frame.character_look_ids.get(asset_id)))
        else:
            reference.update(description=(asset.image_prompt or asset.description or "")[:240], voice_design={}, image_url=pipeline._production_asset_image(asset, kind))
        references.append(reference)
    return references


def refresh_bound_segments(pipeline, script, frame_id):
    from .production_workflow import production_segment_revision, render_production_segment

    assets = {asset.id: asset for collection in pipeline.resolve_episode_assets(script).values() for asset in collection}
    frames = {frame.id: frame for frame in script.frames}
    numbers = {reference_key(ref): ref["number"] for segment in script.production_segments for ref in segment.get("asset_refs", [])}
    for segment in script.production_segments:
        if frame_id not in segment.get("source_frame_ids", []):
            continue
        refs = {}
        for source_frame_id in segment["source_frame_ids"]:
            frame = frames[source_frame_id]
            frame_refs = frame_references(pipeline, frame, assets)
            for ref in frame_refs:
                key = reference_key(ref)
                if key not in numbers:
                    numbers[key] = max(numbers.values(), default=0) + 1
                refs[key] = {**ref, "number": numbers[key]}
            shot = next((shot for shot in segment["shots"] if shot["number"] == frame.source_shot_number), None)
            if shot:
                shot["asset_reference_numbers"] = [numbers[reference_key(ref)] for ref in frame_refs]
        segment["asset_refs"] = list(refs.values())
        last = frames[segment["source_frame_ids"][-1]]
        segment["tail_character_looks"] = {ref["id"]: ref.get("look_id") for ref in frame_references(pipeline, last, assets) if ref["kind"] == "characters"}
        for key in ("adopted_at", "prompt_adopted_at", "adopted_prompt_revision", "prompt_draft_revision", "prompt_task_snapshot", "prompt_task_id"):
            segment.pop(key, None)
        segment.update(prompt_generation_status="stale", prompt_generation_error="镜头造型已修改，请重新采用本段并生成提示词", adopted_prompt="", prompt_draft="")
        segment["screenplay_text"] = render_production_segment(segment)
        segment["revision"] = production_segment_revision(segment)
        script.production_selected_video_tasks.pop(segment["id"], None)
        script.production_settings.pop("segments_adopted_at", None)


def mutate_reference(pipeline, script, asset_id, asset_type, look_id, operation, variant_id=None, value=None):
    owner, target, source = resolve_target(pipeline, script, asset_id, asset_type, look_id)
    require_editable(owner, target, source)
    unit = target.reference_sheet
    previous_selection = (unit.selected_image_id, selected_image(target))
    if operation == "upload":
        variant = ImageVariant(id=str(uuid.uuid4()), url=value, is_uploaded_source=True, upload_type="reference_sheet")
        unit.image_variants.append(variant)
        unit.selected_image_id = variant.id
    else:
        variant = next((item for item in unit.image_variants if item.id == variant_id), None)
        if not variant:
            raise ValueError("当前造型中不存在该图片版本")
        if operation == "select":
            unit.selected_image_id = variant.id
        elif operation == "delete":
            unit.image_variants.remove(variant)
            if unit.selected_image_id == variant.id:
                unit.selected_image_id = unit.image_variants[0].id if unit.image_variants else None
        elif operation == "favorite":
            variant.is_favorited = value
    target.image_url = selected_image_from_unit(unit)
    unit.image_updated_at = time.time()
    if previous_selection != (unit.selected_image_id, selected_image(target)):
        pipeline._persist_production_asset_update(script, source, asset_id, owner, look_id)
    else:
        pipeline._save_prompt_asset_mutation(script, source)
    return script


def selected_image_from_unit(unit):
    return next((item.url for item in unit.image_variants if item.id == unit.selected_image_id), None)


def create_look_image_task(pipeline, script_id, asset_id, look_id, params):
    from .production_workflow import PRODUCTION_WORKFLOW_ID, style_revision

    script = pipeline.get_script(script_id)
    if not script or script.production_workflow != PRODUCTION_WORKFLOW_ID:
        raise ValueError("新制作流程项目不存在")
    owner, look, source = resolve_target(pipeline, script, asset_id, "character", look_id)
    require_editable(owner, look, source)
    settings = script.production_settings
    if not script.production_style_confirmed_at or script.production_style_revision != style_revision(script.art_direction) or not settings.get("revision"):
        raise ValueError("请先确认当前风格与制作设置")
    if params["model_name"] != settings.get("image_model") or params["aspect_ratio"] != settings.get("aspect_ratio"):
        raise ValueError("生图模型或画幅与已确认制作设置不一致")
    prompt = (params.get("prompt") or "").strip()
    if not prompt or len(prompt) > 12000 or prompt != (look.reference_sheet.image_prompt or "").strip():
        raise ValueError("请先保存当前造型提示词（1–12000字符）")
    if look.production_image_task.get("status") in ("queued", "processing"):
        raise ValueError("该造型图片仍在生成中")
    task_id = str(uuid.uuid4())
    params = copy.deepcopy(params)
    params["reference_image_url"] = next((selected_image(item) for item in owner.looks if item.id != look_id and selected_image(item)), None) or selected_image(owner)
    job = {"task_id": task_id, "status": "queued", "script_id": script_id, "asset_id": asset_id, "look_id": look_id,
           "asset_type": "character", "description_version": look.description_version, "identity_version": owner.description_version,
           "settings_revision": settings["revision"], "style_revision": script.production_style_revision,
           "screenplay_revision": script.engineering_script.get("revision"),
           "prompt": prompt, "created_at": time.time(), "error": "", "phase": "queued",
           "client_request_id": str(uuid.uuid4()), "provider_task_id": None,
           "provider_request_id": None, "artifacts": [], "adoption": "pending"}
    task = {**job, "params": params}
    pipeline._archive_production_image_task(look)
    look.production_image_task = copy.deepcopy(job)
    pipeline._save_prompt_asset_mutation(script, source)
    pipeline.asset_generation_tasks[task_id] = task
    return script, task_id


def process_look_image_task(pipeline, task):
    from .assets import ASPECT_RATIO_TO_SIZE
    from .models import GenerationStatus
    from .production_workflow import style_revision

    script = pipeline.get_script(task["script_id"])
    owner, look, source = resolve_target(pipeline, script, task["asset_id"], "character", task["look_id"])
    job = look.production_image_task

    def current():
        return (job.get("task_id") == task["task_id"] and task["description_version"] == look.description_version
                and task["identity_version"] == owner.description_version and not owner.locked and not look.locked
                and task["settings_revision"] == script.production_settings.get("revision")
                and task["style_revision"] == script.production_style_revision == style_revision(script.art_direction)
                and task["screenplay_revision"] == script.engineering_script.get("revision")
                and task["prompt"] == (look.reference_sheet.image_prompt or "").strip())

    try:
        if not current():
            task.update(status="stale", phase="failed", error="人物、造型或制作设置已变化")
            return
        task["status"] = "processing"
        task["phase"] = job["phase"] = "generating"
        pipeline._save_prompt_asset_mutation(script, source)

        def on_artifact(artifact):
            pipeline._record_asset_image_artifact(task["task_id"], artifact)

        candidate = look.model_copy(deep=True)
        candidate.name = f"{owner.name} · {look.name}"
        candidate.description = asset_description(owner, look)
        before_ids = {variant.id for variant in look.reference_sheet.image_variants}
        settings = task["params"]
        style = script.art_direction.style_config or {}
        pipeline.asset_generator.generate_character(candidate, generation_type="reference_sheet", prompt=task["prompt"],
            positive_prompt=style.get("positive_prompt", ""), negative_prompt=style.get("negative_prompt", ""),
            batch_size=settings.get("batch_size", 1), model_name=settings["model_name"],
            size=ASPECT_RATIO_TO_SIZE.get(settings["aspect_ratio"], "576*1024"), reference_image_url=settings.get("reference_image_url"),
            on_artifact=on_artifact)
        script = pipeline.get_script(task["script_id"])
        owner, look, source = resolve_target(pipeline, script, task["asset_id"], "character", task["look_id"])
        job = look.production_image_task
        existing_ids = before_ids | {variant.id for variant in look.reference_sheet.image_variants}
        look.reference_sheet.image_variants.extend(variant for variant in candidate.reference_sheet.image_variants if variant.id not in existing_ids)
        if current():
            selection_changed = not look.reference_sheet.selected_image_id and bool(candidate.reference_sheet.selected_image_id)
            if selection_changed:
                look.reference_sheet.selected_image_id = candidate.reference_sheet.selected_image_id
            look.image_url = selected_image_from_unit(look.reference_sheet)
            look.status = GenerationStatus.COMPLETED
            task["status"] = "completed"
            task["phase"] = "completed"
            task["adoption"] = "adopted" if selection_changed else "candidate"
            for artifact in job.get("artifacts", []):
                artifact["status"] = "downloaded"
            if selection_changed:
                pipeline._persist_production_asset_update(script, source, owner.id, owner, look.id)
        else:
            task.update(status="stale", phase="completed", error="造型已变化，图片候选已保留但未采用")
    except Exception as error:
        artifacts = look.production_image_task.get("artifacts", [])
        recoverable = any(pipeline._asset_image_artifact_resumable(item) for item in artifacts)
        message = pipeline._asset_image_error(error) if any(item.get("url") or item.get("path") for item in artifacts) else str(error)
        task.update(status="failed", error=message)
        task["phase"] = "download_pending" if recoverable else ("failed" if artifacts else "unconfirmed")
    finally:
        task["finished_at"] = time.time()
        if job.get("task_id") == task["task_id"]:
            job.update(status=task["status"], phase=task.get("phase", job.get("phase")), error=task.get("error", ""), finished_at=task["finished_at"])
        pipeline._save_prompt_asset_mutation(script, source)


def merge_extraction(pipeline, script, series, preview):
    """Work on staged owners so invalid bindings never partially mutate the project."""
    from .engineering_script import apply_engineering_sync, preview_engineering_sync

    resolved = pipeline.resolve_episode_assets(script, series)
    identifiers, look_ids = {}, {}
    models = {"characters": Character, "scenes": Scene, "props": Prop}
    for field, model in models.items():
        mutable = {item.id for item in getattr(script, field)} | {item.id for item in getattr(series, field)} if series else {item.id for item in getattr(script, field)}
        for raw in preview[field]:
            incoming = model.model_validate(raw)
            matches = [item for item in resolved[field] if incoming.name.strip().lower() in pipeline._asset_name_keys(item)]
            if len(matches) > 1:
                raise ValueError(f"资产“{incoming.name}”命中多个既有资产")
            target = matches[0] if matches else None
            if target and target.id not in mutable:
                target = target.model_copy(deep=True)
                # Keep the library ID as a local override so re-extraction resolves the same asset.
                getattr(script, field).append(target)
            elif not target:
                target = incoming.model_copy(deep=True)
                target.id = str(uuid.uuid4())
                if field == "characters":
                    target.looks = []
                getattr(series or script, field).append(target)
                resolved[field].append(target)
            identifiers[incoming.id] = target.id
            merge_extracted(target, incoming, script.id, preview["screenplay_revision"])
            if field != "characters":
                continue
            if not target.looks and (selected_image(target) or target.full_body_asset.variants or target.full_body_prompt):
                default_look(target)
            for extracted_look in incoming.looks:
                matches = [look for look in target.looks if look.id == extracted_look.id or look.name.strip() == extracted_look.name.strip()]
                if len(matches) > 1:
                    raise ValueError(f"{target.name}的造型名称有歧义")
                look = matches[0] if matches else None
                if look is None:
                    if target.locked:
                        raise ValueError(f"{target.name}已锁定，不能新增造型")
                    look = extracted_look.model_copy(deep=True)
                    look.id = str(uuid.uuid4())
                    target.looks.append(look)
                merge_extracted(look, extracted_look, script.id, preview["screenplay_revision"])
                look_ids[(incoming.id, extracted_look.id)] = look.id

    resolved = pipeline.resolve_episode_assets(script, series)
    sync, _ = preview_engineering_sync(script, resolved)
    apply_engineering_sync(script, resolved, sync["token"])
    frames = {frame.source_shot_number: frame for frame in script.frames}
    if {row["shot_number"] for row in preview["shot_bindings"]} != set(frames) or len(preview["shot_bindings"]) != len(frames):
        raise ValueError("资产镜头绑定未覆盖当前工程剧本")
    for row in preview["shot_bindings"]:
        frame = frames[row["shot_number"]]
        frame.scene_id = identifiers[row["scene_id"]] if row["scene_id"] else ""
        frame.character_ids = [identifiers[ref["character_id"]] for ref in row["characters"]]
        frame.character_look_ids = {
            identifiers[ref["character_id"]]: look_ids[(ref["character_id"], ref["look_id"])]
            for ref in row["characters"] if ref.get("look_id")
        }
        frame.prop_ids = [identifiers[value] for value in row["prop_ids"]]
    if script.production_segments:
        script.production_segment_archives.append({"created_at": time.time(), "reason": "asset_bindings_changed", "segments": copy.deepcopy(script.production_segments)})
    script.production_segments = []
    script.production_selected_video_tasks = {}
    script.production_settings.pop("segments_adopted_at", None)
    script.production_settings["assets_screenplay_revision"] = preview["screenplay_revision"]
    script.production_asset_preview = {}
    script.updated_at = time.time()
    return script, series
