"""整集自动生成的分段方案。

分镜的时间码本身就是一条连续轴（`storyboard_contract` 强制连续、无重叠、无空档），
所以分段只需要每镜的时长，切点也只落在镜头边界上。

三个层次，从纯到不纯：

- `plan_segments` —— 纯贪心切分，只有下标，最好测。
- `build_segments` —— 变成 `Segment`，并保留用户手调过的段（锚点）与未变动段的接续句。
- `ensure_segments` —— 过期判定 + 自动重排。

**过期判定故意放在读取端惰性做**，不去每个「分镜被修改」的写入点挂钩子：分镜的写入
路径不止一处（工程台本同步、手工增删镜、改时长），逐个挂必漏，比对只有一处判断。
"""

from typing import Dict, List, Optional, Sequence, Tuple

from ...utils.model_catalog import load_generated_model_catalog
from .models import Script, Segment, StoryboardFrame

DEFAULT_TARGET_SECONDS = 12
# 目录没声明时长时的兜底上下限。宁可保守：给大了会拿到上游的报错，给小了只是分段多一点。
FALLBACK_BOUNDS = (1, 15)


def _normalize_model_id(model_id: Optional[str]) -> str:
    return (model_id or "").split("/", 1)[-1].split("#", 1)[0]


def duration_bounds(model_id: Optional[str]) -> Tuple[int, int]:
    """模型的时长上下限，取自模型目录（事实源与前端一致，不另写一份）。"""
    spec = load_generated_model_catalog()["models"].get(_normalize_model_id(model_id), {})
    timing = spec.get("duration") or {}
    kind = timing.get("type")
    if kind == "slider":
        return int(timing["min"]), int(timing["max"])
    if kind == "buttons":
        options = [int(value) for value in timing.get("options") or []]
        if options:
            return min(options), max(options)
    if kind == "fixed":
        value = int(timing.get("value") or 0)
        if value:
            return value, value
    return FALLBACK_BOUNDS


def plan_segments(
    durations: Sequence[int], target: int, bounds: Tuple[int, int]
) -> List[List[int]]:
    """按镜头边界贪心切段，返回每段的镜头下标（保序、覆盖全部）。

    规则：不切开一个镜头；累加到「再加一镜就超上限」或「已经达到段长目标」为止；
    末尾一段不足下限时先尝试并进前一段。
    """
    lo, hi = bounds
    if not durations:
        raise ValueError("请先选择镜头")
    if target < lo:
        raise ValueError(f"段长目标 {target} 秒低于模型下限 {lo} 秒，请调高目标或换模型")
    for position, duration in enumerate(durations, 1):
        if type(duration) is not int or duration <= 0:
            raise ValueError(f"第{position}镜缺少有效时长，请先在分镜中补齐")
        if duration > hi:
            raise ValueError(
                f"第{position}镜时长 {duration} 秒超过模型上限 {hi} 秒，请先把这一镜拆开"
            )

    groups: List[List[int]] = []
    current: List[int] = []
    total = 0
    for index, duration in enumerate(durations):
        if current and (total + duration > hi or total >= target):
            groups.append(current)
            current, total = [], 0
        current.append(index)
        total += duration
    if current:
        groups.append(current)

    if len(groups) > 1 and sum(durations[i] for i in groups[-1]) < lo:
        merged = groups[-2] + groups[-1]
        if sum(durations[i] for i in merged) <= hi:
            groups[-2:] = [merged]

    for position, group in enumerate(groups, 1):
        total = sum(durations[i] for i in group)
        if total < lo:
            raise ValueError(
                f"第{position}段只凑到 {total} 秒，低于模型下限 {lo} 秒：请调高段长目标或换模型"
            )
    return groups


def _segment(
    index: int,
    frame_ids: List[str],
    by_id: Dict[str, StoryboardFrame],
    kept_exit: Dict[tuple, str],
    manual: bool,
) -> Segment:
    return Segment(
        index=index,
        frame_ids=list(frame_ids),
        duration=sum((by_id[fid].duration or 0) for fid in frame_ids if fid in by_id),
        # 边界没变的段沿用原来的接续句；边界变了就留空，等重新生成（不猜）。
        exit_state=kept_exit.get(tuple(frame_ids), ""),
        manual=manual,
    )


def build_segments(
    script: Script,
    *,
    target: Optional[int] = None,
    bounds: Optional[Tuple[int, int]] = None,
    previous: Optional[Sequence[Segment]] = None,
) -> List[Segment]:
    """把当前分镜切成 `Segment` 列表。

    保留两类东西：用户手调过的段（`manual=True`，作为锚点原样保留，只在它周围重排）、
    以及边界未变动段的接续句。
    """
    frames = list(script.frames or [])
    if not frames:
        return []
    target = target or script.segment_target_seconds or DEFAULT_TARGET_SECONDS
    if bounds is None:
        bounds = duration_bounds(getattr(script.model_settings, "r2v_model", None))

    by_id = {frame.id: frame for frame in frames}
    ids = [frame.id for frame in frames]
    previous = list(previous if previous is not None else (script.segments or []))
    kept_exit = {tuple(segment.frame_ids): segment.exit_state for segment in previous if segment.exit_state}

    # 锚点：手调过的段，且它的镜头**全部还在**当前分镜里（少一个就作废，避免锚点吃掉邻居）。
    anchors: Dict[str, List[str]] = {}
    for segment in previous:
        if not segment.manual:
            continue
        kept = [frame_id for frame_id in segment.frame_ids if frame_id in by_id]
        if kept and len(kept) == len(segment.frame_ids):
            anchors[kept[0]] = kept

    result: List[Segment] = []
    free: List[str] = []
    claimed: set = set()

    def flush_free() -> None:
        if not free:
            return
        durations = [by_id[frame_id].duration for frame_id in free]
        for group in plan_segments(durations, target, bounds):
            result.append(
                _segment(len(result) + 1, [free[i] for i in group], by_id, kept_exit, manual=False)
            )
        free.clear()

    index = 0
    while index < len(ids):
        frame_id = ids[index]
        anchor = anchors.get(frame_id)
        if anchor and not (set(anchor) & claimed):
            flush_free()
            claimed.update(anchor)
            result.append(_segment(len(result) + 1, anchor, by_id, kept_exit, manual=True))
            index = ids.index(anchor[-1]) + 1
        else:
            free.append(frame_id)
            index += 1
    flush_free()
    return result


def segments_stale(script: Script) -> bool:
    """段方案与当前分镜对不上（增删镜、改时长、换顺序都算）。"""
    by_id = {frame.id: frame for frame in script.frames or []}
    flat = [frame_id for segment in script.segments or [] for frame_id in segment.frame_ids]
    if flat != [frame.id for frame in script.frames or []]:
        return True
    for segment in script.segments or []:
        total = sum((by_id[frame_id].duration or 0) for frame_id in segment.frame_ids)
        if segment.duration != total:
            return True
    return False


def ensure_segments(script: Script, *, target: Optional[int] = None) -> bool:
    """分镜阶段/生成前统一入口：过期就自动重排。返回 `script.segments` 是否被改动。"""
    if not (script.frames or []):
        return False
    if target:
        script.segment_target_seconds = target
    if script.segments and not segments_stale(script):
        return False
    script.segments = build_segments(script, previous=script.segments)
    return True


def continuity_for(segments: Optional[Sequence[Segment]], frame_ids: Sequence[str]) -> str:
    """`frame_ids` 所在段的**上一段**的接续句；找不到就返回空串。"""
    if not frame_ids or not segments:
        return ""
    head = frame_ids[0]
    for index, segment in enumerate(segments):
        if head in (segment.frame_ids or []):
            return segments[index - 1].exit_state if index else ""
    return ""
