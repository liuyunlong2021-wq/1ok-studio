from typing import Dict, Any, List, Optional, Tuple
import hashlib
import json
import os
import re
import shutil
import time
import uuid
import subprocess
import threading
import platform
import sys
from urllib.parse import quote, urlparse
from .models import (
    AudioTake,
    EpisodeAudioPlan,
    Script,
    GenerationStatus,
    VideoTask,
    Character,
    ReferenceAudioVariant,
    MAX_VARIANTS_PER_ASSET,
    Scene,
    StoryboardFrame,
    Series,
    PromptConfig,
    ArtDirection,
    GlobalAssetLibrary,
)
from .llm import ScriptProcessor
from .assets import AssetGenerator
from .storyboard import StoryboardGenerator
from .video import VideoGenerator
from .audio import AudioGenerator
from .export import ExportManager
from .skill_packages import SkillPackageStore
from ...utils import get_logger
from ...utils.system_check import get_ffmpeg_path, get_ffmpeg_install_instructions
from ...utils.model_catalog import get_catalog_accessor, get_default_model_settings, is_minimax_h3_model
from ...utils.global_settings import get_active_text_model
from ...utils.media_refs import media_ref, to_media_ref
from ...models.jiucaihezi import AUDIO_MAX_INPUT_CHARS, AUDIO_MAX_REFERENCE_AUDIOS

logger = get_logger(__name__)

#: 文本模型没配置时的统一报错。产品只有韭菜盒子一条通道，所以这里直接点名它 ——
#: 旧文案写的是 "missing DASHSCOPE_API_KEY"，让用户跑去配一个产品根本不用的 key。
NOT_CONFIGURED_MESSAGE = "文本模型未配置：请在「设置」里填写韭菜盒子 API Key"

#: 角色工作台右列「音色提示词」成品的防跑飞上限。
#:
#: 它不是喂模型的输入，而是给人看、拿去任何声音模型用的一段话，所以不再是 500
#: （那个数是 CosyVoice 的 voice_prompt 上限，管的是中列那段九维档案）。
#: 单人九维 + 两句台词正常在 400-800 字；超过这个数基本就是模型跑飞了。
VOICE_PROMPT_ARTIFACT_MAX_CHARS = 1600


def _probe_audio_duration_ms(path: str) -> Optional[int]:
    """用 ffprobe 读音频时长（毫秒）。读不到就 None。

    时间轴是给人看的参考：没有时长只是不画刻度，不该让整个生成失败。
    ffprobe 随 ffmpeg 一起装，而 ffmpeg 本来就是本应用的依赖（合成需要）。
    """
    try:
        ffmpeg = get_ffmpeg_path()
        ffprobe = os.path.join(os.path.dirname(ffmpeg or ""), "ffprobe")
        if not os.path.exists(ffprobe):
            ffprobe = shutil.which("ffprobe") or ffprobe
        result = subprocess.run(
            [ffprobe, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", path],
            capture_output=True, text=True, timeout=15,
        )
        return int(float((result.stdout or "").strip()) * 1000)
    except Exception:
        logger.debug("ffprobe unavailable for %s; duration left unknown", path)
        return None


def _atomic_write_json(path: str, payload: Any) -> None:
    """Write JSON via tmp+rename, keeping the previous good file as ``.bak``.

    A plain ``open(path, "w")`` truncates before writing, so any interruption
    (Ctrl-C, ``uvicorn --reload``, OOM) left a half-written file behind. Rename
    is atomic on POSIX, so a reader sees either the complete old file or the
    complete new one, never a partial one.
    """
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    tmp_path = f"{path}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
    if os.path.exists(path):
        try:
            shutil.copy2(path, f"{path}.bak")
        except OSError as exc:
            logger.warning("Could not refresh backup for %s: %s", path, exc)
    os.replace(tmp_path, path)


def _load_json_store(path: str, label: str) -> Optional[Any]:
    """Read a JSON store, refusing to report corruption as "no data".

    Returns ``None`` when the file genuinely does not exist. Raises when it
    exists but cannot be parsed. The earlier behaviour -- log and return an
    empty store -- made a truncated file look like a fresh install, and the
    next save wrote that emptiness back over the real data.
    """
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (ValueError, OSError) as exc:
        preserved = f"{path}.corrupt-{time.strftime('%Y%m%d-%H%M%S')}"
        try:
            shutil.copy2(path, preserved)
        except OSError:
            preserved = path
        backup = f"{path}.bak"
        hint = f"the last good version is at {backup}" if os.path.exists(backup) else "no .bak backup exists"
        raise RuntimeError(
            f"{label} could not be parsed ({exc}). It was NOT overwritten; a copy is at "
            f"{preserved}, and {hint}. Restore or remove the file and restart."
        ) from exc


def _is_jiucaihezi_family_model(model_id: Optional[str]) -> bool:
    """模型是否由韭菜盒子提供（兼容扁平 id，如 海seedance2.5）。

    pipeline 里多处用 `model.startswith("jiucaihezi/")` 判断供应商，但目录里韭菜盒子
    的 R2V 模型 id 就是扁平形式（海seedance2.5 / minimax_h3_image_audio_to_video_v2_15s），
    前缀判断会漏掉它们 —— 漏掉的后果是 R2V 自动切换分支静默把模型改写成
    happyhorse / kling / pixverse 这些已删除 provider 的 id，请求被交给一个不存在的通道。

    所以目录读不出来时**直接抛**，不退回前缀判断：那只会给出「不是韭菜盒子」这个
    确定错误的答案，比失败更难查。
    """
    if not model_id:
        return False
    canonical = get_catalog_accessor().resolve_legacy_to_canonical(model_id) or model_id
    return canonical.startswith("jiucaihezi/")

# --- Security helpers ---

# Allowed pattern for IDs used in file paths (UUID hex + hyphens)
_SAFE_ID_RE = re.compile(r'^[a-zA-Z0-9_\-]+$')


def _validate_safe_id(value: str, label: str = "id") -> str:
    """Ensure a value is safe to embed in file paths / command args (UUID-like)."""
    if not value or not _SAFE_ID_RE.match(value):
        raise ValueError(f"Invalid {label}: contains unsafe characters")
    return value


def _safe_resolve_path(base_dir: str, untrusted_rel: str) -> str:
    """Resolve *untrusted_rel* under *base_dir* and ensure the result stays inside it.

    Prevents path-traversal attacks (e.g. ``../../etc/passwd``).
    Returns the resolved absolute path; raises ValueError on escape attempts.
    """
    base = os.path.realpath(base_dir)
    resolved = os.path.realpath(os.path.join(base, untrusted_rel))
    if not resolved.startswith(base + os.sep):
        raise ValueError(f"Path escapes base directory: {untrusted_rel}")
    return resolved


class LibraryAssetInUseError(Exception):
    """Raised when a global library asset cannot be hard-deleted because it is
    still referenced by one or more storyboard frames (design Q2 reference
    integrity). Carries the referrers so the API can surface them (HTTP 409).

    ``references`` is a list of dicts, each:
        {"owner_kind": "project"|"series", "owner_id": str,
         "owner_title": Optional[str], "frame_id": str}
    """

    def __init__(self, asset_type: str, asset_id: str, references: List[Dict[str, Any]]):
        self.asset_type = asset_type
        self.asset_id = asset_id
        self.references = references
        super().__init__(
            f"Library {asset_type} {asset_id} is referenced by "
            f"{len(references)} storyboard frame(s); refusing to delete "
            f"(pass force=True to delete anyway)."
        )


class ComicGenPipeline:
    def __init__(self, config: Dict[str, Any] = None):
        self.config = config or {}
        self.script_processor = ScriptProcessor()
        self.asset_generator = AssetGenerator(self.config.get('assets'))
        self.storyboard_generator = StoryboardGenerator(self.config.get('storyboard'))
        self.video_generator = VideoGenerator(self.config.get('video'))
        self.audio_generator = AudioGenerator(self.config.get('audio'))
        self.export_manager = ExportManager(self.config.get('export'))
        self.skill_packages = SkillPackageStore("output/skill_packages")
        
        self.data_file = "output/projects.json"
        self.series_data_file = "output/series.json"
        self.library_data_file = "output/library_assets.json"
        self._save_lock = threading.RLock()  # Reentrant lock to prevent concurrent file writes
        self.scripts: Dict[str, Script] = self._load_data()
        self.series_store: Dict[str, Series] = self._load_series_data()
        # Project-independent global asset library (lowest resolver layer).
        self.library_store: GlobalAssetLibrary = self._load_library_data()
        self._repair_series_bindings()

        # Extraction preview cache: {project_id: (timestamp, Script)}
        self._extraction_cache: Dict[str, tuple] = {}

        # Task management for async asset generation
        # Format: { task_id: { status: str, progress: int, error: str, script_id: str, asset_id: str, created_at: float } }
        self.asset_generation_tasks: Dict[str, Dict[str, Any]] = {}
        self.video_generation_tasks: Dict[str, Dict[str, Any]] = {}
        self.prompt_generation_tasks: Dict[str, Dict[str, Any]] = {}
        self._prompt_generation_slots = threading.BoundedSemaphore(2)
        # 声音设计（导演稿 / 全集声音）的在跑任务表。状态本身落在 script.audio_plan
        # 的字段上（会被持久化），这里只放后台执行需要的东西：参考音解析结果等。
        self.audio_plan_tasks: Dict[str, Dict[str, Any]] = {}
        # Temporary cache for file import previews (import_id -> text)
        self._import_cache: Dict[str, str] = {}
        # 视频适配器缓存（目录里只有韭菜盒子一家）
        self._jiucaihezi_video_model = None

        # Recover orphan async tasks. FastAPI BackgroundTasks live in
        # process memory — any restart between submit + execute leaves
        # them permanently `pending` (or `processing` if interrupted
        # mid-call) on disk. We mark such tasks `failed` with a clear
        # reason so the user sees a Retry affordance instead of an
        # eternal spinner. We do NOT auto-resume because re-running a
        # half-completed video task could double-charge providers.
        try:
            self._recover_orphan_tasks()
        except Exception as exc:  # pragma: no cover — defensive
            logger.warning("Orphan task recovery failed: %s", exc)

    _ORPHAN_RECOVERY_REASON = (
        "Backend was restarted while this task was running. Click Retry to run it again."
    )
    #: 有上游任务号时用这条：号还在，就能接着等结果，不必重新生成（会重复计费）。
    _ORPHAN_RESUMABLE_REASON = (
        "后端在这个任务跑的时候重启了。上游任务号已保存 —— 点「继续回捞」接着等结果，"
        "不要重新生成（重新生成会再付一次费）。"
    )

    def _recover_orphan_tasks(self) -> None:
        """Sweep persisted state for video tasks left in pending/processing.

        FastAPI's BackgroundTasks queue lives entirely in process memory:
        if uvicorn restarts (dev --reload, OOM, OS reboot, ctrl-C) every
        queued processor is gone but the task records on disk still say
        "pending" or "processing". The frontend then shows an eternal
        spinner and the user has no recovery path.

        策略分两种：
        - 任务上存了上游任务号 → 标 failed、但提示语说明**可以接着回捞**（不联网，
          不重复提交；重新生成才会再付一次费）。
        - 没有上游任务号 → 只能重新生成，给原来的重试提示。

        Asset / motion-ref tasks live in transient in-process dicts
        (self.asset_generation_tasks etc.) and never persist, so they
        die naturally with the process and don't need recovery.
        """
        STUCK = ("pending", "processing")
        recovered = 0
        #: 旧版本失败时不写原因，界面只能显示「未知错误，请重试」。补一句能说清的话，
        #: 别让人以为是自己的操作问题。
        no_reason = (
            "这次失败没留下原因（当时的版本没有记录失败原因，也没保存上游任务号），"
            "只能重新生成。"
        )

        for script in self.scripts.values():
            tasks = getattr(script, "video_tasks", None) or []
            for task in tasks:
                if getattr(task, "status", None) in STUCK:
                    task.status = "failed"
                    # 判失败 = 这条跑完了，界面上不能一直算着「已等 N 分」。
                    if not getattr(task, "finished_at", 0.0):
                        task.finished_at = time.time()
                    if not getattr(task, "error", None):
                        try:
                            task.error = (
                                self._ORPHAN_RESUMABLE_REASON
                                if getattr(task, "provider_task_id", None)
                                else self._ORPHAN_RECOVERY_REASON
                            )
                        except Exception:
                            pass
                    recovered += 1
                elif getattr(task, "status", None) == "failed" and not getattr(task, "error", None):
                    try:
                        task.error = no_reason
                    except Exception:
                        pass
            for collection in (script.characters, script.scenes, script.props):
                for asset in collection:
                    if getattr(asset, "prompt_generation_status", None) in STUCK:
                        asset.prompt_generation_status = "failed"
                        asset.prompt_generation_error = self._ORPHAN_RECOVERY_REASON
                        recovered += 1

            # 声音设计：导演稿生成与每一版音频都可能是被重启打断的那个。
            plan = getattr(script, "audio_plan", None)
            if plan is not None:
                if getattr(plan, "script_status", None) in STUCK:
                    plan.script_status = "failed"
                    plan.script_error = self._ORPHAN_RECOVERY_REASON
                    plan.script_task_id = None
                    recovered += 1
                for take in getattr(plan, "takes", None) or []:
                    if getattr(take, "status", None) in STUCK:
                        take.status = "failed"
                        if not getattr(take, "error", None):
                            take.error = self._ORPHAN_RECOVERY_REASON
                        recovered += 1

        if recovered > 0:
            try:
                self._save_data()
            except Exception:
                logger.warning("Orphan recovery: failed to persist sweep")
            logger.warning(
                "Orphan task recovery: marked %d stuck task(s) as failed.",
                recovered,
            )
        else:
            logger.debug("Orphan task recovery: no stuck tasks found.")

    _MAX_LABEL_LEN = 20

    def annotate_video_task(
        self,
        script_id: str,
        task_id: str,
        is_starred: Optional[bool] = None,
        label: Optional[str] = None,
        clear_label: bool = False,
    ) -> Optional["VideoTask"]:
        """Set the user's review annotations on a video task. Two fields,
        both optional so callers can update either independently:
          - is_starred: shortlist flag, multi-select per shot
          - label: short free-text note (≤20 chars). Pass clear_label=True
            to explicitly remove the label (None on its own means "don't
            change").
        Returns the updated VideoTask, or None if script/task not found
        (caller can decide whether that's a 404)."""
        with self._save_lock:
            script = self.scripts.get(script_id)
            if not script:
                return None
            tasks = getattr(script, "video_tasks", None) or []
            task = next((t for t in tasks if getattr(t, "id", None) == task_id), None)
            if not task:
                return None
            if is_starred is not None:
                task.is_starred = bool(is_starred)
            if clear_label:
                task.label = None
            elif label is not None:
                trimmed = label.strip()[: self._MAX_LABEL_LEN]
                task.label = trimmed or None
            try:
                self._save_data()
            except Exception:
                logger.warning("annotate_video_task: save failed")
            return task

    _T2I_HISTORY_LIMIT = 10
    _MAX_GENERATE_COUNT = 6
    _WORKBENCH_TAB_VALUES = ("t2i_i2v", "direct_r2v")

    def update_frame_workbench(
        self,
        script_id: str,
        frame_id: str,
        workbench_tab_mode: Optional[str] = None,
        t2i_image_urls: Optional[List[str]] = None,
        t2i_selected_index: Optional[int] = None,
        workbench_generate_count: Optional[int] = None,
    ) -> Optional["StoryboardFrame"]:
        """Persist Storyboard R2V workbench state onto a frame.

        Each field is optional; only the ones the caller passes get
        written. The four fields cover everything the per-shot panel
        carries that needs to survive refresh/cross-device:
          - workbench_tab_mode: 't2i_i2v' | 'direct_r2v'
          - t2i_image_urls: full ordered history (caller is the source
            of truth, server clamps to _T2I_HISTORY_LIMIT FIFO)
          - t2i_selected_index: active首帧 index, clamped to range
          - workbench_generate_count: per-shot batch size, clamped to
            [1, _MAX_GENERATE_COUNT]

        Returns the updated StoryboardFrame, or None if the
        script/frame can't be found (caller maps to 404).
        Unknown enum values for workbench_tab_mode are rejected with
        ValueError so a typo doesn't silently persist garbage."""
        with self._save_lock:
            script = self.scripts.get(script_id)
            if not script:
                return None
            frames = getattr(script, "frames", None) or []
            frame = next((f for f in frames if getattr(f, "id", None) == frame_id), None)
            if not frame:
                return None
            if workbench_tab_mode is not None:
                if workbench_tab_mode not in self._WORKBENCH_TAB_VALUES:
                    raise ValueError(
                        f"workbench_tab_mode must be one of {self._WORKBENCH_TAB_VALUES}, "
                        f"got {workbench_tab_mode!r}",
                    )
                frame.workbench_tab_mode = workbench_tab_mode
            if t2i_image_urls is not None:
                # Filter empties + cap FIFO so the client can't grow the
                # list unbounded by repeated calls. The client also caps
                # at the same limit, but defense in depth.
                cleaned = [u for u in t2i_image_urls if isinstance(u, str) and u.strip()]
                if len(cleaned) > self._T2I_HISTORY_LIMIT:
                    cleaned = cleaned[-self._T2I_HISTORY_LIMIT:]
                frame.t2i_image_urls = cleaned
            if t2i_selected_index is not None:
                # Clamp against the resulting URL list, not whatever was
                # there before — t2i_image_urls may have been written
                # this same call.
                urls = frame.t2i_image_urls or []
                if not urls:
                    frame.t2i_selected_index = 0
                else:
                    frame.t2i_selected_index = max(0, min(int(t2i_selected_index), len(urls) - 1))
            if workbench_generate_count is not None:
                frame.workbench_generate_count = max(
                    1, min(int(workbench_generate_count), self._MAX_GENERATE_COUNT)
                )
            frame.updated_at = time.time()
            try:
                self._save_data()
            except Exception:
                logger.warning("update_frame_workbench: save failed")
            return frame

    def upload_t2i_frame(
        self,
        script_id: str,
        frame_id: str,
        file_path: str,
    ) -> Optional["StoryboardFrame"]:
        """Append an uploaded image to a frame's T2I history and auto-select it.

        Mirrors `update_frame_workbench`'s clamping rules (≤ _T2I_HISTORY_LIMIT
        FIFO; t2i_selected_index → index of the newly appended URL). Caller is
        expected to have already saved the file under output/uploads/ and pass
        the relative URL path the frontend can resolve via /files.

        Returns the updated frame, or None if script/frame can't be found.
        """
        with self._save_lock:
            script = self.scripts.get(script_id)
            if not script:
                return None
            frames = getattr(script, "frames", None) or []
            frame = next((f for f in frames if getattr(f, "id", None) == frame_id), None)
            if not frame:
                return None
            current = list(getattr(frame, "t2i_image_urls", None) or [])
            current.append(file_path)
            # Same FIFO cap as update_frame_workbench so uploads can't grow
            # the history unbounded either.
            if len(current) > self._T2I_HISTORY_LIMIT:
                current = current[-self._T2I_HISTORY_LIMIT:]
            frame.t2i_image_urls = current
            # Newly uploaded image becomes the active首帧 — Issue 10 design
            # requires the upload immediately unlocks Step 2.
            frame.t2i_selected_index = len(current) - 1
            frame.updated_at = time.time()
            try:
                self._save_data()
            except Exception:
                logger.warning("upload_t2i_frame: save failed")
            return frame

    def mark_video_task_failed(
        self, script_id: str, task_id: str, error_message: str
    ) -> bool:
        """Belt-and-suspenders setter used by BG-task wrappers when an
        exception escapes the pipeline's own try/except. Writes
        status='failed' + error so the UI never sees an eternal
        spinner. Also used by the cancel endpoint. Returns True when a
        task was found and marked."""
        with self._save_lock:
            script = self.scripts.get(script_id)
            if not script:
                return False
            tasks = getattr(script, "video_tasks", None) or []
            task = next((t for t in tasks if getattr(t, "id", None) == task_id), None)
            if not task:
                return False
            if getattr(task, "status", None) == "completed":
                # Already successfully completed — don't downgrade on a
                # spurious wrapper exception or a late cancel.
                return False
            task.status = "failed"
            # 结束时间也要落：取消/包装异常都算这一条跑完了，界面上要能显示用了多久。
            if not getattr(task, "finished_at", 0.0):
                task.finished_at = time.time()
            try:
                if not getattr(task, "error", None):
                    task.error = error_message
            except Exception:
                pass
            try:
                self._save_data()
            except Exception:
                logger.warning("mark_video_task_failed: save failed")
            return True

    def export_project(self, script_id: str, options: Dict[str, Any]) -> str:
        """Step 7: Export project to final video."""
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
            
        export_url = self.export_manager.render_project(script, options)
        return export_url

    def get_script(self, script_id: str) -> Optional[Script]:
        return self.scripts.get(script_id)

    def _load_data(self) -> Dict[str, Script]:
        data = _load_json_store(self.data_file, "projects.json")
        if data is None:
            return {}
        return {k: Script(**v) for k, v in data.items()}

    def _save_data(self):
        """Save data with thread lock to prevent concurrent write issues.

        先取 items 的快照再序列化。调用方是在这个锁**外面**改 self.scripts 的
        （create_project / reparse_project / delete_project），序列化途中字典
        尺寸一变就抛 "dictionary changed size during iteration"，而下面那个
        except 会把它当成普通写盘失败吞掉 —— 结果整次保存被静默跳过。
        快照在 GIL 下是一条不可打断的 C 级循环，拿不到变更就是一种合法结果：
        下一次保存自然会带上。
        """
        with self._save_lock:
            try:
                _atomic_write_json(
                    self.data_file,
                    {k: v.dict() for k, v in list(self.scripts.items())},
                )
            except Exception as e:
                logger.error(f"Failed to save data: {e}")

    def _repair_series_bindings(self):
        """Repair episodes listed in series.episode_ids that have series_id=None."""
        repaired = False
        for series_id, series in self.series_store.items():
            for ep_id in series.episode_ids:
                script = self.scripts.get(ep_id)
                if script and not script.series_id:
                    script.series_id = series_id
                    if not script.episode_number:
                        script.episode_number = series.episode_ids.index(ep_id) + 1
                    repaired = True
                    logger.info(f"Repaired series binding: episode {ep_id} → series {series_id}")
        if repaired:
            self._save_data()

    def create_project(self, title: str, text: str, skip_analysis: bool = False, workflow_mode: str = "i2v_legacy", series_id: Optional[str] = None, prompt_config: Optional[Dict[str, Any]] = None) -> Script:
        """Step 1: Parse novel and create project.

        When `series_id` is provided the new project is bound as the next
        episode of that existing series (episode_number = current max
        episode number in the series + 1) via the same
        `add_episode_to_series` mechanism used elsewhere. When `series_id`
        is None the behavior is the original standalone-project path,
        bit-for-bit unchanged.
        """
        if skip_analysis:
            script = self.script_processor.create_draft_script(title, text)
        else:
            series = self.series_store.get(series_id) if series_id else None
            initial_config = PromptConfig(**(prompt_config or {}))
            model = get_active_text_model()
            custom_extraction = ""
            package_id = (initial_config.skill_bindings or {}).get("entity_extraction")
            if package_id:
                custom_extraction = self.skill_packages.compile(package_id)
            elif initial_config.entity_extraction:
                custom_extraction = initial_config.entity_extraction
            elif series:
                bindings = getattr(series.prompt_config, "skill_bindings", {}) or {}
                package_id = bindings.get("entity_extraction")
                custom_extraction = (
                    self.skill_packages.compile(package_id)
                    if package_id
                    else getattr(series.prompt_config, "entity_extraction", "")
                )
            script = self.script_processor.parse_novel(title, text, custom_extraction, model)

        if prompt_config:
            script.prompt_config = PromptConfig(**prompt_config)

        script.workflow_mode = workflow_mode
        self.scripts[script.id] = script
        self._save_data()

        # Optional series binding (T9). Reuses add_episode_to_series so the
        # episode_ids / series_id / episode_number wiring matches every
        # other "attach episode to series" path. add_episode_to_series
        # mutates the in-memory script in place (same object reference) and
        # persists both projects.json and series.json.
        if series_id:
            series = self.series_store.get(series_id)
            if not series:
                raise ValueError("Series not found")
            existing = self.get_series_episodes(series_id)
            max_ep = max([ep.episode_number for ep in existing if ep.episode_number] or [0])
            self.add_episode_to_series(series_id, script.id, episode_number=max_ep + 1)
        return script
    
    def extract_preview(self, script_id: str, text: str) -> Script:
        """Run entity extraction without saving. Cache result for subsequent apply."""
        existing_script = self.scripts.get(script_id)
        if not existing_script:
            raise ValueError("Script not found")
        series = self.get_series(existing_script.series_id) if existing_script.series_id else None
        custom_extraction = self.get_effective_prompt("entity_extraction", existing_script, series)
        model = self.get_effective_polish_model(existing_script)
        new_script = self.script_processor.parse_novel(
            existing_script.title, text, custom_extraction, model,
            known_entities=self._known_entity_roster(existing_script),
        )
        self._stamp_extracted_descriptions(new_script)
        self._extraction_cache[script_id] = (time.time(), new_script)
        return new_script

    def _known_entity_roster(self, script: Script) -> List[Dict[str, str]]:
        """本集已经能看到的资产名册（集内 + 系列 + 全局库），喂给实体提取。

        作用是让模型**沿用已有的名字**。名册越准，事后要靠名字匹配去猜的
        机会就越少（“没胡子的少年（张飞）”这类漂移是事后无法可靠救回来的）。
        """
        resolved = self.resolve_episode_assets(script)
        roster: List[Dict[str, str]] = []
        for key in self._ASSET_LAYER_KEYS:
            for asset in resolved.get(key, []):
                roster.append({
                    "type": key,
                    "name": asset.name or "",
                    "description": getattr(asset, "description", "") or "",
                })
        return roster

    def _reuse_shared_entities(self, parsed: Script, series: Optional[Series]) -> None:
        """同名复用：刚提取出来的实体里，已存在于**系列池 / 全局库**的，本集不再建副本。

        为什么：合并读取是按 **id** 去重的，不按名字。第 2 集再把「刘备」存一份本地
        副本，项目里就会出现两张同名的卡，用户每集都得手动关联一次。直接引用共享
        那条，图和描述就跟着复用（这才是“做一次全系列能用”）。

        代价：本集不能单独改这条的名字/描述 —— 需要单独改就用「在本集独立一份」（fork）。

        只写 `extracted_description`，**不动** `description`：后者是生图依据，
        改它会把已经生成好的图标记成过期。
        """
        for field in self._ASSET_LAYER_KEYS:
            shared: List[Any] = []
            if series:
                shared.extend(getattr(series, field))
            shared.extend(getattr(self.library_store, field))
            if not shared:
                continue
            by_name: Dict[str, Any] = {}
            for shared_asset in shared:
                for key in self._asset_name_keys(shared_asset):
                    by_name.setdefault(key, shared_asset)
            kept = []
            for entity in getattr(parsed, field):
                # 名字或别名命中 → 复用共享那条（别名让上一集关联过的叫法自动生效）
                match = by_name.get((entity.name or "").strip().lower()) if entity.name else None
                if match is None:
                    kept.append(entity)
                    continue
                if getattr(entity, "description", ""):
                    match.extracted_description = entity.description
            setattr(parsed, field, kept)

    def reparse_project(self, script_id: str, text: str, reuse_existing: bool = True) -> Script:
        """Re-parse the text for an existing project, replacing all entities.

        reuse_existing: 同名实体已在系列池/全局库时，本集不再建副本
        （见 `_reuse_shared_entities`）。默认开：第 2 集提取出「刘备」不该再存一份，
        否则项目里就是两张同名的卡。传 False 恢复旧行为。
        """
        existing_script = self.scripts.get(script_id)
        if not existing_script:
            raise ValueError("Script not found")
        series = self.get_series(existing_script.series_id) if existing_script.series_id else None

        # Use cached extraction if available (from extract_preview)
        cached = self._extraction_cache.pop(script_id, None)
        if cached and (time.time() - cached[0]) < 300:
            new_script = cached[1]
        else:
            custom_extraction = self.get_effective_prompt("entity_extraction", existing_script, series)
            model = self.get_effective_polish_model(existing_script)
            new_script = self.script_processor.parse_novel(
                existing_script.title, text, custom_extraction, model,
                known_entities=self._known_entity_roster(existing_script),
            )
        self._stamp_extracted_descriptions(new_script, existing_script)
        if reuse_existing:
            self._reuse_shared_entities(new_script, series)
        
        # Preserve the original script ID and timestamps
        new_script.id = existing_script.id
        new_script.created_at = existing_script.created_at
        new_script.updated_at = time.time()
        
        # Preserve project-level settings
        new_script.art_direction = existing_script.art_direction
        new_script.model_settings = existing_script.model_settings
        new_script.style_preset = existing_script.style_preset
        new_script.style_prompt = existing_script.style_prompt
        new_script.merged_video_url = existing_script.merged_video_url
        new_script.workflow_mode = existing_script.workflow_mode
        # Preserve series binding — the freshly parsed Script defaults
        # series_id/episode_number to None, which would orphan an episode
        # mid-reparse and break the Reconcile suggestions endpoint
        # (it returns [] for any project without a series_id). Same for
        # prompt_config, default_generation_mode, bgm_url, mix_settings —
        # all project-level fields unrelated to entity extraction.
        # custom_voices 已经随「音色选择」一起收掉了（产品只有一个音频通道），
        # 系列池里只留角色本体的参考音。
        new_script.series_id = existing_script.series_id
        new_script.episode_number = existing_script.episode_number
        new_script.prompt_config = existing_script.prompt_config
        new_script.default_generation_mode = existing_script.default_generation_mode
        new_script.bgm_url = existing_script.bgm_url
        new_script.mix_settings = existing_script.mix_settings
        
        # Replace the script in memory
        self.scripts[script_id] = new_script
        self._save_data()
        return new_script

    @staticmethod
    def _stamp_extracted_descriptions(script: Script, previous: Optional[Script] = None) -> None:
        previous_by_key = {}
        if previous:
            for items, kind in ((previous.characters, "character"), (previous.scenes, "scene"), (previous.props, "prop")):
                for item in items:
                    previous_by_key[(kind, item.name.strip().lower())] = item
        for items, kind in ((script.characters, "character"), (script.scenes, "scene"), (script.props, "prop")):
            for item in items:
                old = previous_by_key.get((kind, item.name.strip().lower()))
                item.extracted_description = item.description or ""
                if old and getattr(old, "description_source", "extracted") != "extracted":
                    item.description = old.description
                    item.description_source = old.description_source
                    item.description_updated_at = old.description_updated_at
                else:
                    item.description_source = "extracted"
                    item.description_updated_at = time.time()


    def generate_assets(self, script_id: str) -> Script:
        """Step 2: Generate character and scene assets (Batch)."""
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
            
        logger.info(f"Generating assets for script {script.id}")
        
        # Sort characters: Base characters first (those without base_character_id)
        sorted_chars = sorted(script.characters, key=lambda c: 0 if not c.base_character_id else 1)

        for char in sorted_chars:
            self.generate_asset(script_id, char.id, "character")
            
        for scene in script.scenes:
            self.generate_asset(script_id, scene.id, "scene")
            
        for prop in script.props:
            self.generate_asset(script_id, prop.id, "prop")
            
        self._save_data()
        return script

    def generate_asset(self, script_id: str, asset_id: str, asset_type: str, style_preset: str = None, reference_image_url: str = None, style_prompt: str = None, generation_type: str = "all", prompt: str = None, apply_style: bool = True, negative_prompt: str = None, batch_size: int = 1, model_name: str = None, aspect_ratio: str = None) -> Script:
        """Step 2: Generate a specific asset (character/scene/prop).
        If style_preset is None, uses the project's global style."""
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
        
        # Get effective model names from project settings if not overridden
        t2i_model = model_name or script.model_settings.t2i_model
        i2i_model = script.model_settings.i2i_model
        
        # Get effective size based on asset type (aspect_ratio param overrides model_settings)
        from .assets import ASPECT_RATIO_TO_SIZE
        effective_aspect = aspect_ratio or self.get_effective_asset_aspect_ratio(script, asset_type)

        if asset_type == "character":
            default_size = "576*1024"
        elif asset_type == "scene":
            default_size = "1024*576"
        else:
            default_size = "1024*1024"

        effective_size = ASPECT_RATIO_TO_SIZE.get(effective_aspect, default_size)
        
        # Determine effective style: Art Direction > passed style > legacy style
        effective_positive_prompt = ""
        effective_negative_prompt = negative_prompt or ""

        # Resolve art_direction: episode own > series inherited
        resolved_art_direction = script.art_direction
        if not resolved_art_direction and script.series_id:
            series = self.series_store.get(script.series_id)
            if series and series.art_direction:
                resolved_art_direction = series.art_direction
        if isinstance(resolved_art_direction, dict):
            resolved_art_direction = ArtDirection(**resolved_art_direction)

        if apply_style:
            if resolved_art_direction and resolved_art_direction.style_config:
                effective_positive_prompt = resolved_art_direction.style_config.get('positive_prompt', '')
                global_neg = resolved_art_direction.style_config.get('negative_prompt', '')
                if global_neg:
                    effective_negative_prompt = f"{effective_negative_prompt}, {global_neg}" if effective_negative_prompt else global_neg
            elif style_prompt:
                effective_positive_prompt = style_prompt
            elif style_preset:
                effective_positive_prompt = f"{style_preset} style"
            elif script.style_preset:
                effective_positive_prompt = f"{script.style_preset} style"
                if script.style_prompt:
                    effective_positive_prompt += f", {script.style_prompt}"
        
        asset_list = []
        target_asset = None

        if asset_type == "character":
            asset_list = script.characters
        elif asset_type == "scene":
            asset_list = script.scenes
        elif asset_type == "prop":
            asset_list = script.props
        else:
            raise ValueError(f"Invalid asset_type: {asset_type}")

        target_asset = next((a for a in asset_list if a.id == asset_id), None)
        # Fallback: /projects/{id} returns merged characters (episode +
        # series + library, see get_project), so the frontend can pass a
        # series-level asset id for an episode-scoped request. Look it up
        # on the parent series if not on the episode itself.
        asset_is_series_level = False
        if not target_asset and script.series_id:
            series = self.series_store.get(script.series_id)
            if series:
                series_list = (
                    series.characters if asset_type == "character"
                    else series.scenes if asset_type == "scene"
                    else series.props
                )
                target_asset = next((a for a in series_list if a.id == asset_id), None)
                if target_asset:
                    asset_is_series_level = True
        if not target_asset:
            raise ValueError(f"{asset_type.capitalize()} {asset_id} not found")

        target_asset.status = GenerationStatus.PROCESSING
        self._save_data()
        if asset_is_series_level:
            self._save_series_data()
        
        try:
            # Generate with Art Direction style injected
            if asset_type == "character":
                # Pass generation_type and specific prompt if available
                # If prompt is provided (from Workbench), use it directly. 
                # Otherwise, asset_generator will construct it using effective_positive_prompt.
                # Note: If prompt is provided, we might still want to append style if it's not included?
                # For now, let's assume the Workbench passes the FULL prompt or we pass style separately.
                # The asset_generator.generate_character expects 'prompt' as the specific prompt.
                # If 'prompt' is None, it constructs one.
                # We should pass effective_positive_prompt as 'positive_prompt' (style suffix) to be appended if needed.
                self.asset_generator.generate_character(
                    target_asset, 
                    generation_type=generation_type, 
                    prompt=prompt, 
                    positive_prompt=effective_positive_prompt, # Used as style suffix if prompt is auto-generated
                    negative_prompt=effective_negative_prompt,
                    batch_size=batch_size,
                    model_name=t2i_model,
                    i2i_model_name=i2i_model,
                    size=effective_size
                )
            elif asset_type == "scene":
                self.asset_generator.generate_scene(target_asset, effective_positive_prompt, effective_negative_prompt, batch_size=batch_size, model_name=t2i_model, size=effective_size)
            elif asset_type == "prop":
                self.asset_generator.generate_prop(target_asset, effective_positive_prompt, effective_negative_prompt, batch_size=batch_size, model_name=t2i_model, size=effective_size)
                
            target_asset.status = GenerationStatus.COMPLETED
        except Exception as e:
            target_asset.status = GenerationStatus.FAILED
            raise e
        finally:
            self._save_data()
            # If the asset lives on the parent series (not the episode),
            # _save_data() (which persists scripts/episodes) won't capture
            # the variant changes — persist the series too, otherwise the
            # generated image disappears on the next reload.
            if asset_is_series_level:
                self._save_series_data()

        return script

    def create_asset_generation_task(self, script_id: str, asset_id: str, asset_type: str,
                                      style_preset: str = None, reference_image_url: str = None,
                                      style_prompt: str = None, generation_type: str = "all",
                                      prompt: str = None, apply_style: bool = True,
                                      negative_prompt: str = None, batch_size: int = 1,
                                      model_name: str = None, aspect_ratio: str = None) -> Tuple[Script, str]:
        """Creates an async asset generation task and returns (script, task_id) immediately."""
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
        
        # Find the asset and set to PROCESSING
        asset_list = []
        if asset_type == "character":
            asset_list = script.characters
        elif asset_type == "scene":
            asset_list = script.scenes
        elif asset_type == "prop":
            asset_list = script.props
        else:
            raise ValueError(f"Invalid asset_type: {asset_type}")

        target_asset = next((a for a in asset_list if a.id == asset_id), None)
        # Fallback to parent series for series-level assets (see generate_asset
        # for rationale — /projects returns merged characters).
        asset_is_series_level = False
        if not target_asset and script.series_id:
            series = self.series_store.get(script.series_id)
            if series:
                series_list = (
                    series.characters if asset_type == "character"
                    else series.scenes if asset_type == "scene"
                    else series.props
                )
                target_asset = next((a for a in series_list if a.id == asset_id), None)
                if target_asset:
                    asset_is_series_level = True
        if not target_asset:
            raise ValueError(f"{asset_type.capitalize()} {asset_id} not found")

        target_asset.status = GenerationStatus.PROCESSING
        if asset_is_series_level:
            self._save_series_data()
        
        # Create task
        task_id = str(uuid.uuid4())
        self.asset_generation_tasks[task_id] = {
            "status": "pending",  # pending -> processing -> completed/failed
            "progress": 0,
            "error": None,
            "script_id": script_id,
            "asset_id": asset_id,
            "asset_type": asset_type,
            "created_at": time.time(),
            # Store all params for later processing
            "params": {
                "style_preset": style_preset,
                "reference_image_url": reference_image_url,
                "style_prompt": style_prompt,
                "generation_type": generation_type,
                "prompt": prompt,
                "apply_style": apply_style,
                "negative_prompt": negative_prompt,
                "batch_size": batch_size,
                "model_name": model_name,
                "aspect_ratio": aspect_ratio,
            }
        }
        
        self._save_data()
        return script, task_id

    def process_asset_generation_task(self, task_id: str):
        """Processes an asset generation task in the background."""
        task = self.asset_generation_tasks.get(task_id)
        if not task:
            logger.error(f"Task {task_id} not found")
            return

        task["status"] = "processing"

        try:
            params = task["params"]
            if task.get("is_series"):
                # Series asset generation — operate on series_store
                self._process_series_asset_task(task, params)
            else:
                # Project asset generation — existing logic
                self.generate_asset(
                    task["script_id"],
                    task["asset_id"],
                    task["asset_type"],
                    params["style_preset"],
                    params["reference_image_url"],
                    params["style_prompt"],
                    params["generation_type"],
                    params["prompt"],
                    params["apply_style"],
                    params["negative_prompt"],
                    params["batch_size"],
                    params["model_name"],
                    params.get("aspect_ratio"),
                )
            task["status"] = "completed"
            task["progress"] = 100
            logger.info(f"Task {task_id} completed successfully")
        except Exception as e:
            task["status"] = "failed"
            task["error"] = str(e)
            logger.error(f"Task {task_id} failed: {e}")

    def _process_series_asset_task(self, task: Dict, params: Dict):
        """Process a Series asset generation task."""
        series_id = task["script_id"]  # stored as script_id for compatibility
        series = self.series_store.get(series_id)
        if not series:
            raise ValueError("Series not found")

        asset_id = task["asset_id"]
        asset_type = task["asset_type"]
        positive_prompt = params.get("effective_positive_prompt", "")
        negative_prompt = params.get("effective_negative_prompt", "")
        t2i_model = params.get("t2i_model", "wan2.6-t2i")
        effective_size = params.get("effective_size", "576*1024")
        batch_size = params.get("batch_size", 1)
        generation_type = params.get("generation_type", "all")
        prompt = params.get("prompt")
        reference_image_url = params.get("reference_image_url")

        if asset_type == "character":
            target = next((c for c in series.characters if c.id == asset_id), None)
            if not target:
                raise ValueError(f"Character {asset_id} not found in series")
            self.asset_generator.generate_character(
                target, generation_type=generation_type, prompt=prompt or "",
                positive_prompt=positive_prompt, negative_prompt=negative_prompt,
                batch_size=batch_size, model_name=t2i_model, size=effective_size,
            )
        elif asset_type == "scene":
            target = next((s for s in series.scenes if s.id == asset_id), None)
            if not target:
                raise ValueError(f"Scene {asset_id} not found in series")
            self.asset_generator.generate_scene(
                target, positive_prompt=positive_prompt, negative_prompt=negative_prompt,
                batch_size=batch_size, model_name=t2i_model, size=effective_size,
            )
        elif asset_type == "prop":
            target = next((p for p in series.props if p.id == asset_id), None)
            if not target:
                raise ValueError(f"Prop {asset_id} not found in series")
            self.asset_generator.generate_prop(
                target, positive_prompt=positive_prompt, negative_prompt=negative_prompt,
                batch_size=batch_size, model_name=t2i_model, size=effective_size,
            )
        else:
            raise ValueError(f"Unknown asset type: {asset_type}")

        self._save_series_data()

    def get_asset_generation_task_status(self, task_id: str) -> Optional[Dict[str, Any]]:
        """Returns the status of an asset generation task."""
        # Check image tasks first
        task = self.asset_generation_tasks.get(task_id)
        if not task:
            # Then check video tasks
            task = self.video_generation_tasks.get(task_id)
            
        if not task:
            return None
        
        return {
            "task_id": task_id,
            "status": task["status"],
            "progress": task.get("progress", 0),
            "error": task.get("error"),
            "asset_id": task.get("asset_id"),
            "asset_type": task.get("asset_type"),
            "script_id": task.get("script_id"),
            "created_at": task.get("created_at")
        }

    def get_effective_asset_aspect_ratio(self, script: Script, asset_type: str) -> str:
        """资产画幅的唯一解析处。

        出图和提示词必须用同一个值。以前出图走这段逻辑，而提示词那条路**完全没带
        画幅**，模型就自己挑（Skill 里 16:9 排在前面）——于是出 9:16 的图、提示词
        却写着「16:9横屏」。
        """
        if asset_type == "character":
            return script.model_settings.character_aspect_ratio
        if asset_type == "scene":
            return script.model_settings.scene_aspect_ratio
        if asset_type == "prop":
            return script.model_settings.prop_aspect_ratio
        # 与出图路径的历史默认保持一致
        return "9:16"

    def create_prompt_generation_task(
        self, script_id: str, asset_id: str, asset_type: str,
        name: str, description: str, custom_prompt: str, model: str, style_prompt: str = "",
        aspect_ratio: str = "",
    ) -> str:
        """Persist a lightweight prompt job on its asset and return immediately."""
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Project not found")
        asset, source = self._find_asset_with_source(script, asset_id, asset_type)
        if not asset:
            raise ValueError("Asset not found")
        if getattr(asset, "prompt_generation_status", "idle") in ("queued", "processing"):
            return str(asset.prompt_generation_task_id)

        task_id = f"prompt_{uuid.uuid4().hex}"
        task = {
            "task_id": task_id, "script_id": script_id, "asset_id": asset_id,
            "asset_type": asset_type, "name": name, "description": description,
            "description_version": int(getattr(asset, "description_version", 1) or 1),
            "custom_prompt": custom_prompt, "model": model, "style_prompt": style_prompt,
            "aspect_ratio": aspect_ratio,
            "status": "queued", "error": None, "created_at": time.time(),
        }
        self.prompt_generation_tasks[task_id] = task
        asset.prompt_generation_status = "queued"
        asset.prompt_generation_task_id = task_id
        asset.prompt_generation_error = None
        asset.prompt_generation_started_at = time.time()
        self._save_after_asset_mutation(source)
        return task_id

    def process_prompt_generation_task(self, task_id: str) -> None:
        task = self.prompt_generation_tasks.get(task_id)
        if not task:
            return
        with self._prompt_generation_slots:
            script = self.scripts.get(task["script_id"])
            if not script:
                return
            asset, source = self._find_asset_with_source(script, task["asset_id"], task["asset_type"])
            if not asset or getattr(asset, "prompt_generation_task_id", None) != task_id:
                return
            task["status"] = "processing"
            asset.prompt_generation_status = "processing"
            self._save_after_asset_mutation(source)
            try:
                prompt = self.script_processor.generate_asset_prompt(
                    task["asset_type"], task["name"], task["description"],
                    task["custom_prompt"], task["model"], task["style_prompt"],
                    task.get("aspect_ratio", ""),
                )
                # Do not overwrite a prompt generated for an older description.
                if int(getattr(asset, "description_version", 1) or 1) != task["description_version"]:
                    asset.prompt_generation_status = "stale"
                    asset.prompt_generation_error = "描述已变更，请重新生成提示词"
                    task["status"] = "stale"
                else:
                    if task["asset_type"] == "character":
                        asset.full_body_prompt = prompt
                    else:
                        asset.image_prompt = prompt
                    asset.prompt_generation_status = "completed"
                    asset.prompt_generation_error = None
                    task["status"] = "completed"
            except Exception as exc:
                logger.exception("Prompt task %s failed", task_id)
                task["status"] = "failed"
                task["error"] = str(exc)
                asset.prompt_generation_status = "failed"
                asset.prompt_generation_error = str(exc)
            finally:
                self._save_after_asset_mutation(source)

    def create_motion_ref_task(self, script_id: str, asset_id: str, asset_type: str, 
                                prompt: Optional[str] = None, audio_url: Optional[str] = None, 
                                duration: int = 5, batch_size: int = 1) -> Tuple[Script, str]:
        """Creates an async motion reference generation task."""
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
            
        task_id = str(uuid.uuid4())
        self.video_generation_tasks[task_id] = {
            "status": "pending",
            "progress": 0,
            "error": None,
            "script_id": script_id,
            "asset_id": asset_id,
            "asset_type": asset_type,
            "created_at": time.time(),
            "params": {
                "prompt": prompt,
                "audio_url": audio_url,
                "duration": duration,
                "batch_size": batch_size
            }
        }
        
        self._save_data()
        return script, task_id

    def process_motion_ref_task(self, script_id: str, task_id: str):
        """Processes a video generation task in the background."""
        task = self.video_generation_tasks.get(task_id)
        if not task:
            logger.error(f"Video task {task_id} not found")
            return
            
        task["status"] = "processing"
        
        try:
            params = task["params"]
            # Call the synchronous generate_motion_ref method
            self.generate_motion_ref(
                script_id=script_id,
                asset_id=task["asset_id"],
                asset_type=task["asset_type"],
                prompt=params["prompt"],
                audio_url=params["audio_url"],
                duration=params["duration"],
                batch_size=params["batch_size"]
            )
            task["status"] = "completed"
            task["progress"] = 100
            logger.info(f"Video task {task_id} completed successfully")
        except Exception as e:
            task["status"] = "failed"
            task["error"] = str(e)
            logger.error(f"Video task {task_id} failed: {e}")

    def sync_descriptions_from_script_entities(self, script_id: str) -> Script:
        """
        Syncs entity descriptions from ScriptProcessor parsed entities.
        This clears saved prompts so the UI will regenerate them from the current description.
        
        Note: This only updates prompts, not generated images/videos.
        """
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
        
        # Clear saved prompts for all characters so UI will regenerate from description
        for character in script.characters:
            character.full_body_prompt = None
            character.three_view_prompt = None
            character.headshot_prompt = None
            character.video_prompt = None
        
        # Scenes and props might also have prompts to clear (if applicable)
        for scene in script.scenes:
            if hasattr(scene, 'prompt'):
                scene.prompt = None
        
        for prop in script.props:
            if hasattr(prop, 'prompt'):
                prop.prompt = None
        
        self._save_data()
        logger.info(f"Descriptions synced for script {script_id}: cleared prompts for {len(script.characters)} characters, {len(script.scenes)} scenes, {len(script.props)} props")
        return script

    def add_character(self, script_id: str, name: str, description: str) -> Script:
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
        
        new_char = Character(
            id=f"char_{uuid.uuid4().hex[:8]}",
            name=name,
            description=description
        )
        script.characters.append(new_char)
        self._save_data()
        return script

    def delete_character(self, script_id: str, char_id: str) -> Script:
        return self._delete_asset(script_id, "character", char_id)

    def add_scene(self, script_id: str, name: str, description: str) -> Script:
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
        
        new_scene = Scene(
            id=f"scene_{uuid.uuid4().hex[:8]}",
            name=name,
            description=description
        )
        script.scenes.append(new_scene)
        self._save_data()
        return script

    def delete_scene(self, script_id: str, scene_id: str) -> Script:
        return self._delete_asset(script_id, "scene", scene_id)

    def delete_prop(self, script_id: str, prop_id: str) -> Script:
        return self._delete_asset(script_id, "prop", prop_id)

    def delete_series_asset(self, series_id: str, asset_type: str, asset_id: str) -> Script:
        series = self.series_store.get(series_id)
        if not series:
            raise ValueError("Series not found")
        field = {"character": "characters", "scene": "scenes", "prop": "props"}.get(asset_type)
        if not field:
            raise ValueError(f"Invalid asset type: {asset_type}")

        episodes = [s for s in self.scripts.values() if s.series_id == series_id]
        # 资产可能在**某一集**的本地池里。以前这里拿“该系列的第一集”去删，
        # 资产属于别的集时 _find_asset_with_source 找不到，就报 not found ——
        # 所以要先找出真正持有它的那一集。
        holder = next(
            (ep for ep in episodes if any(a.id == asset_id for a in getattr(ep, field))),
            None,
        )
        if holder:
            return self._delete_asset(holder.id, asset_type, asset_id)
        if episodes:
            # 不在任何一集的本地池 → 应在系列池。走任一集同一条路径，
            # 顺便把全系列分镜里指向它的引用一并清掉。
            return self._delete_asset(episodes[0].id, asset_type, asset_id)

        # 系列一集都没建 → 没地方挂帧引用，直接删系列池。
        if not any(item.id == asset_id for item in getattr(series, field)):
            raise ValueError(f"Asset {asset_id} of type {asset_type} not found in series")
        setattr(series, field, [item for item in getattr(series, field) if item.id != asset_id])
        self._save_series_data()
        return series

    def _delete_asset(self, script_id: str, asset_type: str, asset_id: str) -> Script:
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
        target, source = self._find_asset_with_source(script, asset_id, asset_type)
        if target is None or source == "global":
            raise ValueError(f"Asset {asset_id} of type {asset_type} not found in project")

        if asset_type == "character":
            field = "characters"
        elif asset_type == "scene":
            field = "scenes"
        elif asset_type == "prop":
            field = "props"
        else:
            raise ValueError(f"Invalid asset type: {asset_type}")

        owner = script if source == "script" else self.series_store.get(script.series_id)
        items = getattr(owner, field)
        setattr(owner, field, [item for item in items if item.id != asset_id])

        # Remove stale storyboard references from affected episodes.
        scripts = [script] if source == "script" else [s for s in self.scripts.values() if s.series_id == script.series_id]
        for item in scripts:
            for frame in item.frames:
                if asset_type == "scene" and frame.scene_id == asset_id:
                    frame.scene_id = ""
                elif asset_type == "character" and asset_id in frame.character_ids:
                    frame.character_ids.remove(asset_id)
                elif asset_type == "prop" and asset_id in frame.prop_ids:
                    frame.prop_ids.remove(asset_id)

        self._save_after_asset_mutation(source)
        if source == "series":
            self._save_data()
        return script
    
    def _find_asset_with_source(
        self, script: "Script", asset_id: str, asset_type: str
    ) -> Tuple[Optional[object], Optional[str]]:
        """Locate an asset by (id, type) in either the episode's local
        list OR the parent series' shared pool. Returns
        (asset, source) where source ∈ {"script", "series", "global"} so the
        caller can mutate the right object and save the right side.

        Episode-local always wins (the user explicitly forked this
        asset to override the series version). Falls back to series
        only when the id isn't local. Returns (None, None) when the
        asset doesn't exist in either container — caller should 404.
        """
        if asset_type == "character":
            ep_list = script.characters
        elif asset_type == "scene":
            ep_list = script.scenes
        elif asset_type == "prop":
            ep_list = script.props
        else:
            return None, None
        local = next((a for a in ep_list if a.id == asset_id), None)
        if local is not None:
            return local, "script"
        # Fall back to series shared pool if this episode belongs to
        # a series.
        if script.series_id:
            series = self.series_store.get(script.series_id)
            if series:
                if asset_type == "character":
                    sh_list = series.characters
                elif asset_type == "scene":
                    sh_list = series.scenes
                else:  # prop
                    sh_list = series.props
                shared = next((a for a in sh_list if a.id == asset_id), None)
                if shared is not None:
                    return shared, "series"
            # Series miss → fall through to the global library below.
        # Fall back to the project-independent global asset library
        # (lowest layer). Empty by default, so this is a no-op until
        # the global pool is populated.
        if asset_type == "character":
            gl_list = self.library_store.characters
        elif asset_type == "scene":
            gl_list = self.library_store.scenes
        else:  # prop
            gl_list = self.library_store.props
        glob = next((a for a in gl_list if a.id == asset_id), None)
        if glob is not None:
            return glob, "global"
        return None, None

    def _save_after_asset_mutation(self, source: str) -> None:
        """Persist after mutating an asset; pick the right save path
        based on which container the asset lives in (episode vs series
        vs global library)."""
        if source == "series":
            self._save_series_data()
        elif source == "global":
            self._save_library_data()
        else:
            self._save_data()

    def toggle_asset_lock(self, script_id: str, asset_id: str, asset_type: str) -> Script:
        """Toggle the locked status of an asset. Works on both
        episode-local and series-shared assets (A2 decision: default
        write to series, since locking a shared character should
        affect all episodes that use it)."""
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")

        target_asset, source = self._find_asset_with_source(script, asset_id, asset_type)
        if not target_asset:
            raise ValueError(f"Asset {asset_id} of type {asset_type} not found")

        # Toggle the locked status
        target_asset.locked = not target_asset.locked
        self._save_after_asset_mutation(source)
        return script

    def toggle_asset_starred(self, script_id: str, asset_id: str, asset_type: str) -> Script:
        """Toggle the starred (asset-library shortlist) status of an asset.
        Mirrors toggle_asset_lock — works on both episode-local and
        series-shared assets via _find_asset_with_source."""
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")

        target_asset, source = self._find_asset_with_source(script, asset_id, asset_type)
        if not target_asset:
            raise ValueError(f"Asset {asset_id} of type {asset_type} not found")

        target_asset.starred = not target_asset.starred
        self._save_after_asset_mutation(source)
        return script

    def toggle_project_starred(self, script_id: str) -> Script:
        """Toggle the user-starred (featured shortlist) flag on a project.
        Starred projects get the amber-halation 'featured' treatment in the
        gallery. Mirrors toggle_asset_starred but at the Script level. The
        read-modify-write is wrapped in _save_lock so the toggle is atomic."""
        with self._save_lock:
            script = self.scripts.get(script_id)
            if not script:
                raise ValueError("Script not found")
            script.starred = not script.starred
            self._save_data()
            return script

    def toggle_frame_lock(self, script_id: str, frame_id: str) -> Script:
        """Toggle the locked status of a frame."""
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
            
        target_frame = next((f for f in script.frames if f.id == frame_id), None)
        if not target_frame:
            raise ValueError(f"Frame {frame_id} not found")
            
        # Toggle the locked status
        target_frame.locked = not target_frame.locked
        self._save_data()
        return script

    def update_asset_image(self, script_id: str, asset_id: str, asset_type: str, image_url: str) -> Script:
        """Updates the image URL of an asset manually. Per A2 decision,
        series-shared assets are updated in place (shared semantics);
        episode-local assets are updated locally."""
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")

        target_asset, source = self._find_asset_with_source(script, asset_id, asset_type)
        if not target_asset:
            raise ValueError(f"Asset {asset_id} of type {asset_type} not found")

        target_asset.image_url = image_url
        # For characters, also update avatar if it's not set or if we want to sync them
        # For now, let's assume the uploaded image is the main reference.
        # If it's a character, we might want to set avatar_url to the same image for simplicity
        if asset_type == "character":
            target_asset.avatar_url = image_url

        self._save_after_asset_mutation(source)
        return script

    def update_asset_description(self, script_id: str, asset_id: str, asset_type: str, description: str) -> Script:
        """Updates the description of an asset."""
        target, _ = self._find_asset_with_source(self.scripts.get(script_id), asset_id, asset_type)
        version = int(getattr(target, "description_version", 1) or 1) + 1 if target else 1
        return self.update_asset_attributes(script_id, asset_id, asset_type, {"description": description, "description_source": "manual", "description_updated_at": time.time(), "description_version": version})

    def update_asset_attributes(self, script_id: str, asset_id: str, asset_type: str, attributes: Dict[str, Any]) -> Script:
        """Updates arbitrary attributes of an asset. Routes the write
        to either the episode-local or the parent series' shared copy
        depending on which container owns the asset (A2 decision)."""
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")

        target_asset, source = self._find_asset_with_source(script, asset_id, asset_type)
        if not target_asset:
            raise ValueError(f"Asset {asset_id} of type {asset_type} not found")

        # Update attributes
        for key, value in attributes.items():
            if hasattr(target_asset, key):
                setattr(target_asset, key, value)
            else:
                logger.warning(f"Attribute {key} not found in {asset_type} model")

        self._save_after_asset_mutation(source)
        return script

    def add_uploaded_asset_variant(
        self, 
        script_id: str, 
        asset_type: str, 
        asset_id: str, 
        upload_type: str, 
        image_url: str, 
        description: Optional[str] = None
    ) -> Script:
        """
        Adds an uploaded image as a new variant to an asset.
        The uploaded image is marked with is_uploaded_source=True.
        
        Args:
            script_id: The project ID
            asset_type: "character", "scene", or "prop"
            asset_id: The asset ID
            upload_type: "full_body", "head_shot", "three_views", or "image"
            image_url: Media ref of the uploaded image, relative to output/
            description: Optional modified description for reverse generation
        """
        from .models import ImageVariant, AssetUnit
        
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
        
        target_asset, source = self._find_asset_with_source(script, asset_id, asset_type)
        if not target_asset:
            raise ValueError(f"Asset {asset_id} of type {asset_type} not found")
        
        # Create new variant with upload source flag
        new_variant = ImageVariant(
            id=str(uuid.uuid4()),
            url=image_url,
            prompt_used=description or target_asset.description,
            is_uploaded_source=True,
            upload_type=upload_type
        )
        
        # Update description if provided
        if description:
            target_asset.description = description
        
        # Add variant to the appropriate asset unit
        if asset_type == "character":
            # Map upload_type to the correct asset unit
            if upload_type == "full_body":
                target_unit = target_asset.full_body
            elif upload_type == "head_shot":
                target_unit = target_asset.head_shot
            elif upload_type == "three_views":
                target_unit = target_asset.three_views
            else:
                raise ValueError(f"Invalid upload_type for character: {upload_type}")
            
            # Ensure AssetUnit exists
            if target_unit is None:
                target_unit = AssetUnit()
                if upload_type == "full_body":
                    target_asset.full_body = target_unit
                elif upload_type == "head_shot":
                    target_asset.head_shot = target_unit
                elif upload_type == "three_views":
                    target_asset.three_views = target_unit
            
            # Add variant and select it
            target_unit.image_variants.append(new_variant)
            target_unit.selected_image_id = new_variant.id
            target_unit.image_updated_at = time.time()
            
            # === ALSO UPDATE LEGACY FIELDS for frontend compatibility ===
            # Create variant for legacy ImageAsset structure
            legacy_variant = ImageVariant(
                id=new_variant.id,
                url=image_url,
                prompt_used=description or target_asset.description,
                is_uploaded_source=True,
                upload_type=upload_type
            )
            
            if upload_type == "full_body":
                # Ensure full_body_asset exists
                if target_asset.full_body_asset is None:
                    from .models import ImageAsset
                    target_asset.full_body_asset = ImageAsset()
                target_asset.full_body_asset.variants.append(legacy_variant)
                target_asset.full_body_asset.selected_id = new_variant.id
                target_asset.full_body_image_url = image_url
            elif upload_type == "head_shot":
                # Ensure headshot_asset exists
                if target_asset.headshot_asset is None:
                    from .models import ImageAsset
                    target_asset.headshot_asset = ImageAsset()
                target_asset.headshot_asset.variants.append(legacy_variant)
                target_asset.headshot_asset.selected_id = new_variant.id
                target_asset.headshot_image_url = image_url
            elif upload_type == "three_views":
                # Ensure three_view_asset exists
                if target_asset.three_view_asset is None:
                    from .models import ImageAsset
                    target_asset.three_view_asset = ImageAsset()
                target_asset.three_view_asset.variants.append(legacy_variant)
                target_asset.three_view_asset.selected_id = new_variant.id
                target_asset.three_view_image_url = image_url
            
            logger.info(f"Added uploaded variant {new_variant.id} to character {asset_id} {upload_type}")
            
        elif asset_type in ["scene", "prop"]:
            # Scene and Prop use the legacy-compatible ImageAsset contract.
            if target_asset.image_asset is None:
                from .models import ImageAsset
                target_asset.image_asset = ImageAsset()
            target_asset.image_asset.variants.append(new_variant)
            target_asset.image_asset.selected_id = new_variant.id
            target_asset.image_url = image_url
            
            logger.info(f"Added uploaded variant {new_variant.id} to {asset_type} {asset_id}")
        
        self._save_after_asset_mutation(source)
        return script

    def update_project_style(self, script_id: str, style_preset: str, style_prompt: Optional[str] = None) -> Script:
        """Updates the global style settings for a project."""
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
            
        script.style_preset = style_preset
        script.style_prompt = style_prompt
        script.updated_at = time.time()
        self._save_data()
        return script
    
    def save_art_direction(self, script_id: str, selected_style_id: str, style_config: Dict[str, Any], custom_styles: List[Dict[str, Any]] = None, ai_recommendations: List[Dict[str, Any]] = None) -> Script:
        """Saves the Art Direction configuration."""
        from .models import ArtDirection
        
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
        
        # Create Art Direction object
        art_direction = ArtDirection(
            selected_style_id=selected_style_id,
            style_config=style_config,
            custom_styles=custom_styles or [],
            ai_recommendations=ai_recommendations or []
        )
        
        script.art_direction = art_direction
        script.updated_at = time.time()
        self._save_data()
        return script

    # === STORYBOARD DRAMATIZATION v2 ===

    def analyze_text_to_frames(self, script_id: str, text: str) -> Script:
        """
        Analyzes script text and generates storyboard frames using LLM.
        Replaces existing frames with newly generated ones.
        """
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
        
        logger.info(f"Analyzing text to frames for project {script_id}")

        # Resolve assets (merge Series + Episode if applicable)
        resolved = self.resolve_episode_assets(script)
        all_characters = resolved["characters"]
        all_scenes = resolved["scenes"]
        all_props = resolved["props"]

        # Build entities JSON from resolved characters, scenes, props
        # aliases 一并给出去：模型看到「刘备（别名：刘玄德）」之后，剧本里写哪个都认得。
        entities_json = {
            "characters": [
                {"id": c.id, "name": c.name, "description": c.description, "aliases": list(c.aliases or [])}
                for c in all_characters
            ],
            "scenes": [
                {"id": s.id, "name": s.name, "description": s.description, "aliases": list(s.aliases or [])}
                for s in all_scenes
            ],
            "props": [
                {"id": p.id, "name": p.name, "description": p.description, "aliases": list(p.aliases or [])}
                for p in all_props
            ],
        }

        # Resolve effective storyboard-extraction prompt (Episode → Series → built-in default).
        series = self.get_series(script.series_id) if getattr(script, "series_id", None) else None
        storyboard_extraction_prompt = self.get_effective_prompt("storyboard_extraction", script, series)

        # Call LLM to analyze text (may raise RuntimeError on parse failure)
        raw_frames = self.script_processor.analyze_to_storyboard(
            text,
            entities_json,
            custom_extraction_prompt=storyboard_extraction_prompt,
            model=self.get_effective_polish_model(script),
        )

        if not raw_frames:
            raise RuntimeError("AI 分镜分析未返回任何帧数据，请重试。")

        # Convert raw frame dicts to StoryboardFrame objects
        new_frames = []
        for idx, frame_data in enumerate(raw_frames):
            # Resolve scene ID by name（别名也算命中）
            scene_ref_name = (frame_data.get("scene_ref_name") or "").strip().lower()
            scene_id = None
            for scene in all_scenes:
                if any(
                    scene_ref_name == key or scene_ref_name in key
                    for key in self._asset_name_keys(scene)
                ):
                    scene_id = scene.id
                    break
            if not scene_id and all_scenes:
                scene_id = all_scenes[0].id  # Fallback to first scene
            elif not scene_id:
                scene_id = str(uuid.uuid4())  # Generate a placeholder ID

            # Resolve character IDs by names (case-insensitive, bidirectional contains)
            char_ref_names = frame_data.get("character_ref_names", [])
            character_ids = []
            for char_name in char_ref_names:
                cn = char_name.strip().lower()
                for char in all_characters:
                    if any(key == cn or cn in key or key in cn for key in self._asset_name_keys(char)):
                        character_ids.append(char.id)
                        break

            # Resolve prop IDs by names (case-insensitive, bidirectional contains)
            prop_ref_names = frame_data.get("prop_ref_names", [])
            prop_ids = []
            for prop_name in prop_ref_names:
                pn = prop_name.strip().lower()
                for prop in all_props:
                    if any(key == pn or pn in key or key in pn for key in self._asset_name_keys(prop)):
                        prop_ids.append(prop.id)
                        break
            
            frame = StoryboardFrame(
                id=str(uuid.uuid4()),
                scene_id=scene_id,
                character_ids=character_ids,
                prop_ids=prop_ids,
                action_description=frame_data.get("action_summary", frame_data.get("action_description", "")),
                visual_atmosphere=frame_data.get("visual_atmosphere"),
                visual_description=frame_data.get("visual_description"),
                shot_size=frame_data.get("shot_size"),
                camera_angle=frame_data.get("camera_angle", "平视"),
                camera_movement=frame_data.get("camera_movement"),
                dialogue=frame_data.get("dialogue"),
                speaker=frame_data.get("speaker"),
                duration=frame_data.get("duration"),
                status=GenerationStatus.PENDING
            )
            new_frames.append(frame)
        
        # Replace existing frames with new ones
        script.frames = new_frames
        script.updated_at = time.time()
        
        logger.info(f"Generated {len(new_frames)} frames from text analysis")
        self._save_data()
        return script

    def refine_frame(self, script_id: str, frame_id: str) -> Optional[StoryboardFrame]:
        """Phase 2: Refine a single coarse frame into a rich frame."""
        from .prompt_assembly import assemble_prompt, sync_dialogue_to_tts
        from .models import DialogueStructured, CameraMovementData, Blocking, AudioNote, LightingData, StageSubject

        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")

        frame = next((f for f in script.frames if f.id == frame_id), None)
        if not frame:
            raise ValueError(f"Frame {frame_id} not found")

        frame_idx = script.frames.index(frame)
        resolved = self.resolve_episode_assets(script)
        all_characters = resolved["characters"]
        all_scenes = resolved["scenes"]

        # Build coarse frame dict for LLM
        coarse = {
            "action_summary": frame.action_description,
            "shot_size": frame.shot_size,
            "camera_angle": frame.camera_angle,
            "camera_movement": frame.camera_movement,
            "dialogue": frame.dialogue,
            "speaker": frame.speaker,
            "duration": frame.duration,
            "character_names": [c.name for c in all_characters if c.id in frame.character_ids],
            "scene_name": next((s.name for s in all_scenes if s.id == frame.scene_id), None),
        }

        # Character/scene assets
        char_assets = [
            {"name": c.name, "description": c.description, "clothing": c.clothing or ""}
            for c in all_characters if c.id in frame.character_ids
        ]
        scene_assets = [
            {"name": s.name, "description": s.description}
            for s in all_scenes if s.id == frame.scene_id
        ]

        # Adjacent frame context
        prev_ctx = None
        if frame_idx > 0:
            pf = script.frames[frame_idx - 1]
            prev_ctx = f"Action: {pf.action_description}. Shot: {pf.shot_size}, {pf.camera_angle}."
        next_ctx = None
        if frame_idx < len(script.frames) - 1:
            nf = script.frames[frame_idx + 1]
            next_ctx = f"Action: {nf.action_description}. Shot: {nf.shot_size}, {nf.camera_angle}."

        result = self.script_processor.refine_frame_to_rich(
            coarse, char_assets, scene_assets, prev_ctx, next_ctx
        )
        if not result:
            return frame

        # Map result onto frame fields
        if result.get("visual_description"):
            from .prompt_assembly import inject_reference_tags
            frame.visual_description = inject_reference_tags(
                result["visual_description"], frame, all_characters, all_scenes
            )
        if result.get("shot_size"):
            frame.shot_size = result["shot_size"]
        if result.get("camera_angle"):
            frame.camera_angle = result["camera_angle"]
        if result.get("duration"):
            frame.duration = result["duration"]
        if result.get("transition_hint"):
            frame.transition_hint = result["transition_hint"]

        # Camera movement structured
        cm = result.get("camera_movement")
        if cm and isinstance(cm, dict) and cm.get("primary"):
            frame.camera_movement_structured = CameraMovementData(
                primary=cm["primary"],
                secondary=cm.get("secondary"),
                speed=cm.get("speed", "normal"),
                description=cm.get("description"),
            )

        # Blocking
        blk = result.get("blocking")
        if blk and isinstance(blk, dict) and blk.get("description"):
            stage_list = None
            if blk.get("stage") and isinstance(blk["stage"], list):
                stage_list = [
                    StageSubject(
                        ref=s.get("ref", ""),
                        zone=s.get("zone", "center"),
                        depth=s.get("depth", "mid"),
                        height=s.get("height"),
                        facing=s.get("facing"),
                        posture=s.get("posture"),
                    )
                    for s in blk["stage"] if isinstance(s, dict)
                ]
            frame.blocking = Blocking(
                description=blk["description"],
                stage=stage_list,
                camera_relation=blk.get("camera_relation"),
            )

        # Dialogue structured
        ds = result.get("dialogue_structured")
        if ds and isinstance(ds, dict) and ds.get("line"):
            frame.dialogue_structured = DialogueStructured(
                speaker=ds.get("speaker", frame.speaker or ""),
                line=ds["line"],
                emotion=ds.get("emotion"),
                delivery=ds.get("delivery"),
            )

        # Audio note
        an = result.get("audio_note")
        if an and isinstance(an, dict) and (an.get("sfx") or an.get("ambience")):
            frame.audio_note = AudioNote(
                sfx=an.get("sfx"),
                ambience=an.get("ambience"),
                bgm_note=an.get("bgm_note"),
            )

        # Lighting
        lt = result.get("lighting")
        if lt and isinstance(lt, dict) and (lt.get("description") or lt.get("direction")):
            frame.lighting = LightingData(
                direction=lt.get("direction"),
                quality=lt.get("quality"),
                color_temp=lt.get("color_temp"),
                description=lt.get("description"),
            )

        # Sync dialogue → TTS instructions & compute assembled prompt
        sync_dialogue_to_tts(frame)
        frame.assembled_prompt = assemble_prompt(frame, all_characters)
        frame.updated_at = time.time()

        self._save_data()
        return frame

    def refine_batch_generator(self, script_id: str):
        """Phase 2: Generator that yields SSE events while refining all frames."""
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")

        total = len(script.frames)
        success = 0
        failed = 0

        for idx, frame in enumerate(script.frames):
            yield ("frame_refine_start", {
                "frame_id": frame.id,
                "frame_index": idx,
                "total": total,
                "label": frame.action_description[:40] if frame.action_description else f"Frame {idx+1}",
            })
            try:
                self.refine_frame(script_id, frame.id)
                success += 1
                yield ("frame_refine_complete", {
                    "frame_id": frame.id,
                    "frame_index": idx,
                    "total": total,
                })
            except Exception as exc:
                failed += 1
                logger.error(f"[refine_batch] frame={frame.id} error={exc}")
                yield ("frame_refine_error", {
                    "frame_id": frame.id,
                    "frame_index": idx,
                    # Don't leak exception details to the client (CodeQL
                    # py/stack-trace-exposure); full error is in the log above.
                    "error": f"分镜优化失败（{type(exc).__name__}），详情请查看服务端日志",
                })

        yield ("batch_complete", {"total": total, "success": success, "failed": failed})

    def refine_frame_prompt(self, script_id: str, frame_id: str, raw_prompt: str, assets: List[Dict[str, Any]], feedback: str = "") -> Dict[str, Any]:
        """
        Refines a raw prompt into bilingual (CN/EN) prompts using LLM.
        Also updates the frame with the refined prompts.
        """
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")

        logger.debug(f"Refining prompt for frame {frame_id}")

        # Read custom prompt config with 3-level fallback (Episode → Series → default)
        series = self.series_store.get(script.series_id) if script.series_id else None
        custom_prompt = self.get_effective_prompt("storyboard_polish", script, series)
        # If it's the system default, pass empty so the LLM method uses its built-in default
        from .llm import DEFAULT_STORYBOARD_POLISH_PROMPT
        if custom_prompt == DEFAULT_STORYBOARD_POLISH_PROMPT:
            custom_prompt = ""

        # Call LLM to refine prompt
        result = self.script_processor.polish_storyboard_prompt(raw_prompt, assets, feedback, custom_prompt)
        
        # Find and update the frame
        frame_found = False
        for frame in script.frames:
            if frame.id == frame_id:
                frame.image_prompt_cn = result.get("prompt_cn")
                frame.image_prompt_en = result.get("prompt_en")
                frame.image_prompt = result.get("prompt_en")  # Also update legacy field
                frame.updated_at = time.time()
                frame_found = True
                break
        
        if frame_found:
            self._save_data()
        
        return {
            "prompt_cn": result.get("prompt_cn"),
            "prompt_en": result.get("prompt_en"),
            "frame_updated": frame_found
        }

    def generate_storyboard(self, script_id: str) -> Script:
        """Step 3: Generate storyboard images (Initial/Batch)."""
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
            
        resolved = self.resolve_episode_assets(script)
        script = self.storyboard_generator.generate_storyboard(
            script,
            characters=resolved["characters"],
            scenes=resolved["scenes"],
        )
        self._save_data()
        return script

    def update_frame(self, script_id: str, frame_id: str, **kwargs) -> Script:
        """Update frame data (prompt, scene_id, character_ids, etc.)."""
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
        
        frame = next((f for f in script.frames if f.id == frame_id), None)
        if not frame:
            raise ValueError(f"Frame {frame_id} not found")
        
        # Update only provided fields
        if kwargs.get('image_prompt') is not None:
            frame.image_prompt = kwargs['image_prompt']
        if kwargs.get('action_description') is not None:
            frame.action_description = kwargs['action_description']
        if kwargs.get('dialogue') is not None:
            frame.dialogue = kwargs['dialogue']
        if kwargs.get('camera_angle') is not None:
            frame.camera_angle = kwargs['camera_angle']
        if kwargs.get('scene_id') is not None:
            frame.scene_id = kwargs['scene_id']
        if kwargs.get('character_ids') is not None:
            frame.character_ids = kwargs['character_ids']
        if kwargs.get('duration') is not None:
            frame.duration = kwargs['duration']
        if kwargs.get('shot_size') is not None:
            frame.shot_size = kwargs['shot_size']
        if kwargs.get('camera_movement_description') is not None:
            if frame.camera_movement_structured:
                frame.camera_movement_structured.description = kwargs['camera_movement_description']
                frame.camera_movement_structured.primary = kwargs['camera_movement_description']
            else:
                from .models import CameraMovementData
                frame.camera_movement_structured = CameraMovementData(
                    primary=kwargs['camera_movement_description'],
                    speed="normal",
                    description=kwargs['camera_movement_description'],
                )
        if kwargs.get('transition_hint') is not None:
            frame.transition_hint = kwargs['transition_hint']
        
        self._save_data()
        return script

    def add_frame(self, script_id: str, scene_id: str = None, action_description: str = "", camera_angle: str = "medium_shot", insert_at: int = None) -> Script:
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
        
        new_frame = StoryboardFrame(
            id=f"frame_{uuid.uuid4().hex[:8]}",
            scene_id=scene_id or (script.scenes[0].id if script.scenes else ""),
            character_ids=[],
            action_description=action_description,
            camera_angle=camera_angle
        )
        
        if insert_at is not None and 0 <= insert_at <= len(script.frames):
            script.frames.insert(insert_at, new_frame)
        else:
            script.frames.append(new_frame)
            
        self._save_data()
        return script

    def copy_frame(self, script_id: str, frame_id: str, insert_at: int = None) -> Script:
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
            
        original_frame = next((f for f in script.frames if f.id == frame_id), None)
        if not original_frame:
            raise ValueError(f"Frame {frame_id} not found")
            
        # Create a deep copy with new ID
        new_frame = original_frame.copy()
        new_frame.id = f"frame_{uuid.uuid4().hex[:8]}"
        new_frame.updated_at = time.time()
        # Reset generation status and URLs for the copy? 
        # Usually copy implies copying content, but maybe we want to keep the image?
        # Let's keep the image/content but reset status if it was processing?
        # Actually, if we copy, we probably want the same image reference initially.
        # But we should reset the "locked" status maybe?
        new_frame.locked = False
        
        if insert_at is not None and 0 <= insert_at <= len(script.frames):
            script.frames.insert(insert_at, new_frame)
        else:
            # Insert after the original frame by default
            try:
                original_index = script.frames.index(original_frame)
                script.frames.insert(original_index + 1, new_frame)
            except ValueError:
                script.frames.append(new_frame)
                
        self._save_data()
        return script

    def delete_frame(self, script_id: str, frame_id: str) -> Script:
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
        
        script.frames = [f for f in script.frames if f.id != frame_id]
        self._save_data()
        return script

    def reorder_frames(self, script_id: str, frame_ids: List[str]) -> Script:
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
        
        frame_map = {f.id: f for f in script.frames}
        new_frames = []
        for fid in frame_ids:
            if fid in frame_map:
                new_frames.append(frame_map[fid])
        
        script.frames = new_frames
        self._save_data()
        return script

    def generate_motion_ref(
        self,
        script_id: str,
        asset_id: str,
        asset_type: str,  # 'full_body' | 'head_shot' for characters; 'scene' | 'prop' for scenes and props
        prompt: Optional[str] = None,
        audio_url: Optional[str] = None,
        duration: int = 5,
        batch_size: int = 1
    ) -> Script:
        """Generate Motion Reference video for an asset (Character Full Body/Headshot, Scene, or Prop).

        Args:
            script_id: ID of the project/script
            asset_id: ID of the asset (character, scene, or prop)
            asset_type: 'full_body' | 'head_shot' for characters; 'scene' or 'prop' for scenes and props
            prompt: Custom prompt for motion generation
            audio_url: URL of driving audio for lip-sync
            duration: Video duration in seconds (5 or 10)
            batch_size: Number of videos to generate
        """
        from .models import VideoVariant, AssetUnit, VideoTask

        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")

        # Find the target asset based on type
        target_asset = None
        asset_display_name = ""

        if asset_type in ["full_body", "head_shot"]:
            # Find the character
            target_asset = next((c for c in script.characters if c.id == asset_id), None)
            asset_display_name = "Character"
        elif asset_type == "scene":
            # Find the scene
            target_asset = next((s for s in script.scenes if s.id == asset_id), None)
            asset_display_name = "Scene"
        elif asset_type == "prop":
            # Find the prop
            target_asset = next((p for p in script.props if p.id == asset_id), None)
            asset_display_name = "Prop"
        else:
            raise ValueError(f"Invalid asset_type: {asset_type}. Must be 'full_body', 'head_shot', 'scene', or 'prop'")

        if not target_asset:
            raise ValueError(f"{asset_display_name} {asset_id} not found")

        # Get the appropriate AssetUnit or image URL based on the asset type
        asset_unit = None  # For characters with AssetUnit
        generated_videos = []  # Store generated videos

        if asset_type in ["full_body", "head_shot"]:
            # Handle character asset
            asset_unit = getattr(target_asset, asset_type, None)
            # Get source image from the AssetUnit or legacy field
            if asset_unit and asset_unit.selected_image_id:
                source_img = next(
                    (v for v in asset_unit.image_variants if v.id == asset_unit.selected_image_id),
                    None
                )
                source_image_url = source_img.url if source_img else (
                    target_asset.full_body_image_url if asset_type == "full_body" else target_asset.headshot_image_url
                )
            else:
                source_image_url = (
                    target_asset.full_body_image_url if asset_type == "full_body"
                    else target_asset.headshot_image_url
                )

            # Default prompt for character
            if not prompt:
                if audio_url:
                    prompt = f"{asset_type.replace('_', ' ').title()} character reference video. {target_asset.description}. The character is speaking naturally matching the audio, with accurate lip-sync and facial expressions. Stable camera, high quality, 4k."
                else:
                    prompt = f"{asset_type.replace('_', ' ').title()} character reference video. {target_asset.description}. Looking around, breathing, slight movement, subtle gestures. Stable camera, high quality, 4k."
        else:
            # Handle scene or prop assets
            source_image_url = target_asset.image_url
            # Default prompt for scene and prop
            if not prompt:
                if asset_type == "scene":
                    if audio_url:
                        prompt = f"Cinematic scene video reference of {target_asset.name}. {target_asset.description}. Ambient motion, lighting changes, natural elements moving, birds, clouds. Soundscape matching the audio. High quality, 4k."
                    else:
                        prompt = f"Cinematic scene video reference of {target_asset.name}. {target_asset.description}. Ambient motion, lighting changes, natural elements moving, birds, clouds. Slow pan across the scene. High quality, 4k."
                else:  # prop
                    if audio_url:
                        prompt = f"Cinematic prop video reference of {target_asset.name}. {target_asset.description}. Rotating object, detailed textures visible, ambient motion, subtle movements matching audio. High quality, 4k."
                    else:
                        prompt = f"Cinematic prop video reference of {target_asset.name}. {target_asset.description}. Rotating object, detailed textures visible, ambient motion, subtle movements. High quality, 4k."

        # Check if source image exists
        if not source_image_url:
            raise ValueError(f"No source image available for {asset_type}. Please generate a static image first.")

        # Generate videos based on the asset type
        for i in range(batch_size):
            try:
                # Call video generator (I2V)
                video_result = self.video_generator.generate_i2v(
                    image_url=source_image_url,
                    prompt=prompt,
                    duration=duration,
                    audio_url=audio_url
                )

                if video_result and video_result.get("video_url"):
                    if asset_type in ["full_body", "head_shot"]:
                        # For characters, create VideoVariant in AssetUnit
                        video_variant = VideoVariant(
                            id=f"video_{uuid.uuid4().hex[:8]}",
                            url=video_result["video_url"],
                            prompt_used=prompt,
                            audio_url=audio_url,
                            source_image_id=None  # Don't set this to avoid complications
                        )
                        asset_unit.video_variants.append(video_variant)

                        # Auto-select the first generated video
                        if not asset_unit.selected_video_id:
                            asset_unit.selected_video_id = video_variant.id

                        generated_videos.append(video_variant)
                        logger.info(f"Generated motion ref video: {video_variant.id}")
                    else:
                        # For scenes and props, create VideoTask and add to asset's video_assets
                        video_task = VideoTask(
                            id=f"video_{uuid.uuid4().hex[:8]}",
                            project_id=script_id,
                            asset_id=asset_id,
                            image_url=source_image_url,
                            prompt=prompt,
                            status="completed",  # Since generation is done in this step
                            video_url=video_result["video_url"],
                            duration=duration,
                            created_at=time.time(),
                            generate_audio=bool(audio_url),
                            model="wan2.6-i2v",
                            generation_mode="i2v"  # Image to video (motion reference)
                        )

                        # Add to the asset's video_assets
                        target_asset.video_assets.append(video_task)
                        generated_videos.append(video_task)
                        logger.info(f"Generated motion ref video for {asset_type}: {video_task.id}")
            except Exception as e:
                logger.error(f"Failed to generate motion ref video for {asset_type}: {e}")

        # For character assets, update the AssetUnit
        if asset_type in ["full_body", "head_shot"]:
            # Ensure AssetUnit exists
            if asset_unit is None:
                asset_unit = AssetUnit()
                setattr(target_asset, asset_type, asset_unit)

            asset_unit.video_prompt = prompt
            asset_unit.video_updated_at = time.time()
        # For scene and prop assets, the video tasks are already added in the generation loop above

        if batch_size > 0 and not generated_videos:
            raise RuntimeError(f"Failed to generate any motion reference videos for {asset_type}")

        self._save_data()
        return script

    def generate_storyboard_render(self, script_id: str, frame_id: str, composition_data: Optional[Dict[str, Any]], prompt: str, batch_size: int = 1) -> Script:
        """Step 3b: Render a specific frame from composition data."""
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
            
        frame = next((f for f in script.frames if f.id == frame_id), None)
        if not frame:
            raise ValueError(f"Frame {frame_id} not found")
            
        frame.status = GenerationStatus.PROCESSING
        if composition_data:
            frame.composition_data = composition_data
        frame.image_prompt = prompt
        self._save_data()
        
        try:
            # Extract reference image URL from composition data if available
            ref_image_url = None
            ref_image_urls = []
            
            if composition_data:
                ref_image_url = composition_data.get('reference_image_url')
                ref_image_urls = composition_data.get('reference_image_urls', [])
            
            ref_image_paths = []
            
            # Resolve multiple paths
            for url in ref_image_urls:
                if not url:
                    continue
                if url.startswith("http"):
                    ref_image_paths.append(url)
                else:
                    potential_path = _safe_resolve_path("output", url)
                    if os.path.exists(potential_path):
                        ref_image_paths.append(potential_path)
            
            # Also handle single path if provided (legacy support)
            if ref_image_url and ref_image_url not in ref_image_urls:
                if ref_image_url.startswith("http"):
                    if ref_image_url not in ref_image_paths:
                        ref_image_paths.append(ref_image_url)
                else:
                    potential_path = _safe_resolve_path("output", ref_image_url)
                    if os.path.exists(potential_path):
                        if potential_path not in ref_image_paths:
                            ref_image_paths.append(potential_path)
            
            # Use the first path as ref_image_path for legacy generator support if needed
            ref_image_path = ref_image_paths[0] if ref_image_paths else None
            
            # Use the prompt as-is from frontend (already contains style)
            final_prompt = prompt
            
            # Update frame with final prompt
            frame.image_prompt = final_prompt
            
            # Resolve assets across Episode → Series → Global layers so
            # shared/global characters & scenes are usable when rendering
            # this frame (frame id references are left unchanged).
            resolved = self.resolve_episode_assets(script)
            # Find scene for this frame
            scene = next((s for s in resolved["scenes"] if s.id == frame.scene_id), None)

            # Get effective size from storyboard_aspect_ratio
            from .assets import ASPECT_RATIO_TO_SIZE
            storyboard_aspect_ratio = script.model_settings.storyboard_aspect_ratio
            effective_size = ASPECT_RATIO_TO_SIZE.get(storyboard_aspect_ratio, "1024*576")  # Default to landscape
            
            # Use model from settings
            i2i_model = script.model_settings.i2i_model
            logger.info(f"Rendering frame {frame_id} using model {i2i_model} with {len(ref_image_paths)} reference images")
            if len(ref_image_urls) > 0:
                logger.debug(f"Original reference URLs from frontend: {ref_image_urls}")

            # Call generator
            self.storyboard_generator.generate_frame(
                frame,
                resolved["characters"],
                scene,
                ref_image_path=ref_image_path,
                ref_image_paths=ref_image_paths,
                prompt=final_prompt,
                batch_size=batch_size,
                size=effective_size,
                model_name=i2i_model
            )
            
            self._save_data()
            return script
        except Exception as e:
            frame.status = GenerationStatus.FAILED
            self._save_data()
            raise e
            # 1. Take the composition_data (positions of assets)
            # 2. Construct a composite image (ControlNet input)
            # 3. Call Img2Img with the composite + prompt
            
            logger.debug(f"Rendering frame {frame_id} with prompt: {prompt}")
            time.sleep(1.5) # Simulate processing
            
            # Mock Result
            mock_url = f"https://placehold.co/1280x720/2a2a2a/FFF?text=Rendered+Frame+{frame_id}"
            frame.rendered_image_url = mock_url
            frame.image_url = mock_url # Update main image too
            frame.status = GenerationStatus.COMPLETED
            
        except Exception as e:
            logger.error(f"Frame rendering failed: {e}")
            frame.status = GenerationStatus.FAILED
            
        self._save_data()
        return script

    def create_video_task(self, script_id: str, image_url: str, prompt: str, duration: int = 5, seed: int = None, resolution: str = "720p", generate_audio: bool = False, audio_url: str = None, prompt_extend: bool = True, negative_prompt: str = None, model: Optional[str] = None, frame_id: str = None, shot_type: str = "single", generation_mode: str = "i2v", reference_video_urls: list = None, reference_image_urls: list = None, source_frame_ids: list = None, skill_id: str = None, skill_name: str = None, ratio: str = None, watermark: Optional[bool] = None, mode: str = None, sound: str = None, cfg_scale: float = None, vidu_audio: bool = None, movement_amplitude: str = None, workbench_tab: Optional[str] = None, reference_audio_urls: list = None) -> Tuple[Script, str]:
        """Creates a new video generation task."""
        if not model:
            # 目录默认值，不写死 id —— 写死的 id 一旦下线就会指向不存在的模型。
            model = get_default_model_settings().i2v_model
        script = self.get_script(script_id)
        if not script:
            raise ValueError("Script not found")

        source_frame_ids = source_frame_ids or ([] if not frame_id else [frame_id])
        if source_frame_ids:
            frame_positions = {item.id: index for index, item in enumerate(script.frames)}
            if any(item not in frame_positions for item in source_frame_ids):
                raise ValueError("Selected storyboard frame does not exist")
            positions = [frame_positions[item] for item in source_frame_ids]
            if len(set(positions)) != len(positions) or positions != list(range(min(positions), max(positions) + 1)):
                raise ValueError("Selected storyboard frames must be consecutive and ordered")

        # Seedance 2.5（海通道，网关模型名就是「海seedance2.5」）：
        # 固定 30 秒 / 720p，参考图最多 9 张。
        is_jiucaihezi_seedance = isinstance(model, str) and model.endswith("海seedance2.5")
        if is_jiucaihezi_seedance:
            prompt = (prompt or "").strip()
            if not 1 <= len(prompt) <= 12000:
                raise ValueError("Seedance 2.5 prompt must contain 1-12000 characters")
            if generation_mode == "r2v" and not 1 <= len(reference_image_urls or []) <= 9:
                raise ValueError("Seedance 2.5 reference mode requires 1-9 reference images")
            if generation_mode == "r2v" and not source_frame_ids:
                raise ValueError("Seedance 2.5 reference mode requires storyboard frames")
            duration = 30
            resolution = "720p"
        if isinstance(model, str) and is_minimax_h3_model(model):
            prompt = (prompt or "").strip()
            if not 1 <= len(prompt) <= 12000:
                raise ValueError("MiniMax H3 prompt must contain 1-12000 characters")
            if len(reference_image_urls or []) > 9:
                raise ValueError("MiniMax H3 accepts at most 9 reference images")
            if len(reference_audio_urls or []) > 3:
                raise ValueError("MiniMax H3 accepts at most 3 reference audios")
            if not 1 <= duration <= 15:
                raise ValueError("MiniMax H3 duration must be between 1 and 15 seconds")
        
        task_id = str(uuid.uuid4())
        
        # R2V 模式：选中的不是 R2V 模型时，切到目录默认的 R2V 模型。
        if generation_mode == "r2v":
            # 两种情况都不动：
            # 1. 已经直接选了带 -r2v 后缀的模型；
            # 2. 选的是韭菜盒子自家的模型 —— 它的 R2V id 不一定带 -r2v 后缀
            #    （海seedance2.5 / minimax_h3_zm_u24 都是扁平 id），按后缀判断
            #    会把它当成没选 R2V 而覆盖掉。
            # 其余（空、或 happyhorse / kling / pixverse / vidu / seedance 这类
            # 已下线 provider 的旧 id）一律落到目录默认值，不按族名改写成某个写死的
            # 模型名：那些 id 全都已经不存在了，改写只会把请求发给不存在的通道。
            if not (model and model.endswith("-r2v")) and not _is_jiucaihezi_family_model(model):
                model = get_default_model_settings().r2v_model

        # Defensive guard against model⇄mode⇄refs mismatch. Every R2V
        # model needs reference inputs; without them the underlying
        # provider call raises mid-generation, the BG task crashes,
        # and the user sees nothing but a spinner. Catch the
        # inconsistency at task-creation time so the frontend gets a
        # clean 400 instead of a permanently-failed task.
        #
        # was: `needs_video_refs = model == "wan2.6-r2v"` —— 只有那个已下线的模型
        # 取参考视频，现在所有 R2V 模型都取参考图，所以那个分支已删除。
        #
        # ponytail: 已知天花板 —— 判据是 `-r2v` 后缀，而韭菜盒子的 R2V id 是扁平的
        # （海seedance2.5 / minimax_h3_zm_u24），所以这个校验对它们**不生效**。
        # 不能简单换成 `generation_mode == "r2v"`：MiniMax H3 允许只带参考音频，
        # 那样会把合法流程拦成 400。要收紧得先确认各模型的最低参考素材要求。
        is_r2v_model = isinstance(model, str) and model.endswith("-r2v")
        if is_r2v_model and not (reference_image_urls or []):
            raise ValueError(
                f"Model '{model}' is reference-to-video and requires image references, "
                "but none were provided. Attach reference images (use @ in the prompt "
                "to reference characters / scenes / props) or switch to an I2V model."
            )

        # Snapshot the input image to ensure consistency
        snapshot_url = image_url
        try:
            # Resolve source path
            if image_url and not image_url.startswith("http"):
                # Assume relative to output dir
                src_path = _safe_resolve_path("output", image_url)
                if os.path.exists(src_path) and os.path.isfile(src_path):
                    # Create snapshot dir
                    snapshot_dir = os.path.join("output", "video_inputs")
                    os.makedirs(snapshot_dir, exist_ok=True)

                    # Define snapshot path
                    ext = os.path.splitext(os.path.basename(image_url))[1] or ".png"
                    _validate_safe_id(task_id, "task_id")
                    snapshot_filename = f"{task_id}{ext}"
                    snapshot_path = _safe_resolve_path(snapshot_dir, snapshot_filename)
                    
                    # Copy file
                    import shutil
                    shutil.copy2(src_path, snapshot_path)
                    
                    # Update URL to relative path
                    snapshot_url = f"video_inputs/{snapshot_filename}"
        except Exception as e:
            logger.error(f"Failed to snapshot input image: {e}")
            # Fallback to original URL

        # Enrich prompt with dialogue cue when a frame has dialogue text.
        # This gives the video model explicit mouth-movement instructions.
        if frame_id and prompt:
            frame = next((f for f in script.frames if f.id == frame_id), None)
            if frame:
                from .prompt_assembly import enrich_prompt_with_dialogue
                prompt = enrich_prompt_with_dialogue(prompt, frame)

        task = VideoTask(
            id=task_id,
            project_id=script_id,
            frame_id=frame_id,
            image_url=snapshot_url,
            prompt=prompt,
            status="pending",
            duration=duration,
            seed=seed,
            resolution=resolution,
            generate_audio=generate_audio,
            audio_url=audio_url,
            prompt_extend=prompt_extend,
            negative_prompt=negative_prompt,
            model=model,
            shot_type=shot_type,
            generation_mode=generation_mode,
            reference_video_urls=reference_video_urls or [],
            reference_image_urls=reference_image_urls or [],
            reference_audio_urls=reference_audio_urls or [],
            source_frame_ids=source_frame_ids,
            skill_id=skill_id,
            skill_name=skill_name,
            ratio=ratio,
            watermark=watermark,
            mode=mode,
            sound=sound,
            cfg_scale=cfg_scale,
            vidu_audio=vidu_audio,
            movement_amplitude=movement_amplitude,
            workbench_tab=workbench_tab,
            created_at=time.time()
        )

        if not script.video_tasks:
            script.video_tasks = []
        script.video_tasks.append(task)

        self._save_data()
        return script, task_id

    def extract_last_frame(self, script_id: str, frame_id: str, video_task_id: str) -> Script:
        """Extract the last frame from a video task and add it as a variant of the frame's rendered_image_asset."""
        from .models import ImageVariant, ImageAsset

        script = self.get_script(script_id)
        if not script:
            raise ValueError("Script not found")

        frame = next((f for f in script.frames if f.id == frame_id), None)
        if not frame:
            raise ValueError("Frame not found")

        # Find the video task
        video_task = next((t for t in script.video_tasks if t.id == video_task_id), None)
        if not video_task or video_task.status != "completed" or not video_task.video_url:
            raise ValueError("Video task not found or not completed")

        # Resolve video path (managed output/ files, temp downloads, or URLs)
        video_path = video_task.video_url
        if video_path.startswith("http"):
            # Download to temp file first
            video_path = self._download_temp_image(video_path)
        elif video_path.startswith("/"):
            # Legacy absolute path: must stay inside the managed output/ tree
            resolved = os.path.realpath(video_path)
            out_base = os.path.realpath("output")
            if not resolved.startswith(out_base + os.sep):
                raise ValueError(f"Video path outside managed output directory: {video_task.video_url}")
            video_path = resolved
        else:
            video_path = _safe_resolve_path("output", video_path)

        if not os.path.exists(video_path):
            raise ValueError(f"Video file not found: {video_path}")

        # Extract last frame using FFmpeg
        ffmpeg_path = get_ffmpeg_path()
        if not ffmpeg_path:
            raise RuntimeError("FFmpeg is required for frame extraction but was not found.")

        output_dir = os.path.join("output", "storyboard")
        os.makedirs(output_dir, exist_ok=True)
        # Use the store-backed frame.id (identical to the request frame_id by
        # the lookup above) so the ffmpeg arg carries no request-parameter taint.
        safe_frame_id = _validate_safe_id(frame.id, "frame_id")
        output_filename = f"frame_{safe_frame_id}_lastframe_{uuid.uuid4().hex[:8]}.jpg"
        output_path = _safe_resolve_path(output_dir, output_filename)

        cmd = [
            ffmpeg_path, "-sseof", "-0.1",
            "-i", video_path,
            "-frames:v", "1",
            "-q:v", "2",
            "-y", output_path
        ]

        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
            if result.returncode != 0:
                raise RuntimeError(f"FFmpeg error: {result.stderr}")
        except subprocess.TimeoutExpired:
            raise RuntimeError("FFmpeg frame extraction timed out")

        if not os.path.exists(output_path):
            raise RuntimeError("Failed to extract last frame from video")

        image_url = to_media_ref(os.path.relpath(output_path, "output"))

        # Create new variant
        variant = ImageVariant(
            id=str(uuid.uuid4()),
            url=image_url,
            prompt_used="Extracted last frame from video",
            is_uploaded_source=True,
            upload_type="image",
        )

        # Initialize rendered_image_asset if needed
        if not frame.rendered_image_asset:
            frame.rendered_image_asset = ImageAsset()

        frame.rendered_image_asset.variants.append(variant)
        frame.rendered_image_asset.selected_id = variant.id
        # Also update rendered_image_url so VideoCreator can pick it up
        frame.rendered_image_url = image_url

        script.updated_at = time.time()
        self._save_data()
        return script

    def upload_frame_image(self, script_id: str, frame_id: str, image_path: str) -> Script:
        """Upload an image as a variant of the frame's rendered_image_asset."""
        from .models import ImageVariant, ImageAsset

        # Validate that image_path is inside the output directory
        safe_path = _safe_resolve_path("output", os.path.relpath(image_path, "output") if os.path.isabs(image_path) else image_path)

        script = self.get_script(script_id)
        if not script:
            raise ValueError("Script not found")

        frame = next((f for f in script.frames if f.id == frame_id), None)
        if not frame:
            raise ValueError("Frame not found")

        image_url = to_media_ref(os.path.relpath(safe_path, "output"))

        # Create new variant
        variant = ImageVariant(
            id=str(uuid.uuid4()),
            url=image_url,
            prompt_used="User uploaded image",
            is_uploaded_source=True,
            upload_type="image",
        )

        if not frame.rendered_image_asset:
            frame.rendered_image_asset = ImageAsset()

        frame.rendered_image_asset.variants.append(variant)
        frame.rendered_image_asset.selected_id = variant.id
        # Also update rendered_image_url so VideoCreator can pick it up
        frame.rendered_image_url = image_url

        script.updated_at = time.time()
        self._save_data()
        return script

    def _generate_ai_sound(self, task: VideoTask) -> str:
        """「AI 配音」模式：用 ``seed-audio-1.0`` 生成音频，返回本地 mp3 路径。

        返回本地路径就够了 —— 视频适配器会把它传到网关换成公开 URL 再发给上游
        （与其它参考素材同一条转存通道）。

        参考音频可选：任务带了 ``reference_audio_urls`` 就作为参考发过去（最多 3
        段），没带就是纯文生音频。

        不吞异常：音频失败即任务失败，调用点还没有为视频付费。
        """
        from ...models.jiucaihezi import generate_audio

        audio_path = media_ref("output", "audio", f"ai_sound_{task.id}.mp3")
        generate_audio(
            prompt=task.prompt or "",
            output_path=audio_path,
            reference_audio_urls=task.reference_audio_urls or [],
        )
        logger.info("Generated AI sound for video task %s: %s", task.id, audio_path)
        return audio_path

    def _download_temp_image(self, url: str) -> str:
        """Downloads an image to a temporary file."""
        import requests
        import tempfile
        
        # If it's a local file path (relative to output)
        if not url.startswith("http"):
            local_path = _safe_resolve_path("output", url)
            if os.path.exists(local_path):
                return local_path
                
        # Download from URL
        try:
            response = requests.get(url, stream=True)
            response.raise_for_status()
            
            # Create temp file
            fd, path = tempfile.mkstemp(suffix=".png")
            with os.fdopen(fd, 'wb') as f:
                for chunk in response.iter_content(chunk_size=8192):
                    f.write(chunk)
            return path
        except Exception as e:
            logger.error(f"Failed to download image: {e}")
            raise
    def select_video_for_frame(self, script_id: str, frame_id: str, video_id: str) -> Script:
        """Manual select: user pins this video as the active take.

        Sets is_video_pinned=True so subsequent auto_select_latest_video
        calls (fired by polling completion) skip this frame and don't
        overwrite the user's hand-picked choice.
        """
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")

        frame = next((f for f in script.frames if f.id == frame_id), None)
        if not frame:
            raise ValueError("Frame not found")

        video = next((v for v in script.video_tasks if v.id == video_id), None)
        if not video:
            raise ValueError("Video task not found")

        frame.selected_video_id = video_id
        frame.video_url = video.video_url
        frame.is_video_pinned = True

        self._save_data()
        return script

    def auto_select_latest_video(self, script_id: str, frame_id: str) -> Script:
        """Auto select: pick the latest completed video task for this frame.

        Idempotent. Skips the update entirely if the frame is pinned by the
        user (is_video_pinned=True). Called by the frontend on every task
        completion poll — the pin check is what makes latest-wins respect
        user intent.
        """
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")

        frame = next((f for f in script.frames if f.id == frame_id), None)
        if not frame:
            raise ValueError("Frame not found")

        if frame.is_video_pinned:
            return script  # user has manually pinned — don't overwrite

        # Latest completed task wins. VideoTask carries created_at
        # (default_factory=time.time); we use it as the "completion order"
        # proxy. Backend doesn't track per-task completion time, but tasks
        # in the same batch are queued at roughly the same created_at and
        # complete in arrival order — close enough for "show me what just
        # came out" UX.
        frame_tasks = [
            t for t in script.video_tasks
            if t.frame_id == frame_id
            and t.status == GenerationStatus.COMPLETED
            and t.video_url
        ]
        if not frame_tasks:
            return script  # nothing to select yet

        latest = max(frame_tasks, key=lambda t: getattr(t, "created_at", 0) or 0)
        if frame.selected_video_id == latest.id and frame.video_url == latest.video_url:
            return script  # already selected — no-op

        frame.selected_video_id = latest.id
        frame.video_url = latest.video_url
        # is_video_pinned stays False — this is an auto-select

        self._save_data()
        return script

    def unpin_video(self, script_id: str, frame_id: str) -> Script:
        """Clear the manual pin so auto_select_latest_video resumes.

        Intentionally does NOT touch selected_video_id or video_url — the
        user keeps seeing the same take until the next generation runs
        and auto_select picks a newer one.
        """
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")

        frame = next((f for f in script.frames if f.id == frame_id), None)
        if not frame:
            raise ValueError("Frame not found")

        if not frame.is_video_pinned:
            return script  # already unpinned — no-op

        frame.is_video_pinned = False
        self._save_data()
        return script

    def _resolve_media_path(self, url: str, suffix: str = "") -> Optional[str]:
        """Resolve a media URL to a local file path.

        Handles three cases:
        1. Local relative path (e.g. 'video/xxx.mp4') → resolve under output/
        2. Full HTTP URL → download directly
        """
        if not url:
            return None

        # Case 1: Try as local path first
        if not url.startswith("http"):
            local_path = _safe_resolve_path("output", url)
            if os.path.exists(local_path):
                return local_path
            return None

        # Case 2: Download from HTTP URL
        import hashlib
        url_hash = hashlib.md5(url.split("?")[0].encode()).hexdigest()[:12]
        cache_dir = os.path.join("output", "cache")
        os.makedirs(cache_dir, exist_ok=True)
        cached = os.path.join(cache_dir, f"{url_hash}{suffix}")
        if os.path.exists(cached) and os.path.getsize(cached) > 0:
            return cached
        try:
            import requests
            resp = requests.get(url, stream=True, timeout=60)
            resp.raise_for_status()
            with open(cached, "wb") as f:
                for chunk in resp.iter_content(chunk_size=65536):
                    f.write(chunk)
            logger.info(f"[DUB] Downloaded remote media -> {cached}")
            return cached
        except Exception as e:
            logger.error(f"[DUB] Failed to download media: {e}")
            if os.path.exists(cached):
                os.remove(cached)
            return None

    def _separate_background_audio(self, video_path: str, work_dir: str) -> Optional[str]:
        """Extract audio from video and separate background (no_vocals) using Demucs.

        Returns the path to the background audio WAV file, or None if
        separation fails (caller falls back to simple replacement).
        """
        ffmpeg_path = get_ffmpeg_path()
        extracted_audio = os.path.join(work_dir, "original_audio.wav")

        # Step 1: Extract audio from video
        extract_cmd = [
            ffmpeg_path, "-y",
            "-i", video_path,
            "-vn", "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "2",
            extracted_audio,
        ]
        try:
            result = subprocess.run(extract_cmd, capture_output=True, timeout=30)
            if result.returncode != 0 or not os.path.exists(extracted_audio):
                logger.warning("[DUB] No audio track in source video, skipping separation")
                return None
        except Exception as e:
            logger.warning(f"[DUB] Audio extraction failed: {e}")
            return None

        # Check if extracted audio has any content (some videos are silent)
        if os.path.getsize(extracted_audio) < 1000:
            logger.info("[DUB] Source video has negligible audio, skipping separation")
            return None

        # Step 2: Run Demucs separation (two-stems: vocals + no_vocals)
        try:
            if getattr(sys, "frozen", False):
                # PyInstaller onedir layout is <resources>/1okstudio-backend/<exe>,
                # so the helper lives two levels up. Windows needs the .exe suffix;
                # without it the dub workflow silently fell back to plain
                # replacement instead of separating the vocals.
                helper = os.path.join(
                    os.path.dirname(os.path.dirname(sys.executable)),
                    "1okstudio-demucs.exe" if os.name == "nt" else "1okstudio-demucs",
                )
                result = subprocess.run(
                    [helper, "--input", extracted_audio, "--out", work_dir],
                    capture_output=True,
                    text=True,
                    timeout=300,
                )
                if result.returncode != 0:
                    raise RuntimeError(result.stderr.strip() or result.stdout.strip())
            else:
                import demucs.separate
                demucs.separate.main([
                    "--two-stems", "vocals",
                    "-n", "htdemucs",
                    "--out", work_dir,
                    extracted_audio,
                ])
        except Exception as e:
            logger.warning(f"[DUB] Demucs separation failed: {e}, falling back to simple replacement")
            return None

        # Demucs outputs to: {work_dir}/htdemucs/original_audio/no_vocals.wav
        bg_path = os.path.join(work_dir, "htdemucs", "original_audio", "no_vocals.wav")
        if not os.path.exists(bg_path):
            # Try alternate path structures
            for root, dirs, files in os.walk(work_dir):
                if "no_vocals.wav" in files:
                    bg_path = os.path.join(root, "no_vocals.wav")
                    break

        if os.path.exists(bg_path):
            logger.info(f"[DUB] Background audio separated successfully: {bg_path}")
            return bg_path

        logger.warning("[DUB] Demucs output not found, falling back to simple replacement")
        return None

    def _ensure_bg_audio_cached(self, frame, video_path: str, video_url: str) -> Optional[str]:
        """Ensure background audio is separated and cached for this frame's video.

        Returns absolute path to bg audio WAV, or None if video has no audio.
        Caches result to output/audio/bg_{frame_id}.wav — only re-runs Demucs
        if video source changed.
        """
        if frame.bg_audio_url and frame.bg_audio_source_video == video_url:
            cached_path = _safe_resolve_path("output", frame.bg_audio_url)
            if os.path.exists(cached_path):
                logger.info(f"[DUB] Background audio cache hit: {frame.bg_audio_url}")
                return cached_path

        import tempfile
        import shutil
        work_dir = tempfile.mkdtemp(prefix="demucs_")
        try:
            bg_path = self._separate_background_audio(video_path, work_dir)
            if not bg_path:
                frame.bg_audio_url = None
                frame.bg_audio_source_video = video_url
                return None

            cache_filename = f"bg_{frame.id}.wav"
            cache_path = _safe_resolve_path(os.path.join("output", "audio"), cache_filename)
            os.makedirs(os.path.dirname(cache_path), exist_ok=True)
            shutil.copy2(bg_path, cache_path)

            frame.bg_audio_url = f"audio/{cache_filename}"
            frame.bg_audio_source_video = video_url
            logger.info(f"[DUB] Background audio cached: {cache_filename}")
            return cache_path
        finally:
            shutil.rmtree(work_dir, ignore_errors=True)

    def preview_dub(self, script_id: str, frame_id: str, video_task_id: str, offset_ms: int = 0) -> "Script":
        """Generate a preview dubbed video (Demucs cached + fast adelay+amix+mux).

        Replaces any existing preview_video_url (lazy cleanup).
        Does NOT touch dubbed_video_url.
        """
        _validate_safe_id(script_id, "script_id")
        # Force numeric type so the adelay filter string is provably shell-safe.
        offset_ms = int(offset_ms)
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")

        frame = next((f for f in script.frames if f.id == frame_id), None)
        if not frame:
            raise ValueError(f"Frame {frame_id} not found")

        if not frame.audio_url:
            raise ValueError("Frame has no TTS audio (audio_url). Generate dialogue audio first.")

        video_task = next((t for t in script.video_tasks if t.id == video_task_id), None)
        if not video_task or not video_task.video_url:
            raise ValueError(f"Video task {video_task_id} not found or has no video_url")

        ffmpeg_path = get_ffmpeg_path()
        if not ffmpeg_path:
            raise RuntimeError("FFmpeg is required for audio dubbing but was not found.")

        video_path = self._resolve_media_path(video_task.video_url, suffix=".mp4")
        tts_path = self._resolve_media_path(frame.audio_url, suffix=".mp3")

        if not video_path or not os.path.exists(video_path):
            raise ValueError(f"Video file not found: {video_task.video_url}")
        if not tts_path or not os.path.exists(tts_path):
            raise ValueError(f"Audio file not found: {frame.audio_url}")
        if os.path.getsize(tts_path) < 1000:
            raise ValueError("TTS audio file is invalid or empty. Please regenerate dialogue audio.")

        # Delete old preview (lazy cleanup)
        if frame.preview_video_url:
            old_preview = _safe_resolve_path("output", frame.preview_video_url)
            if os.path.exists(old_preview):
                try:
                    os.remove(old_preview)
                except OSError:
                    pass

        # frame.id comes from the store (== frame_id), keeping ffmpeg args taint-free.
        output_filename = f"preview_{frame.id}_{int(time.time())}.mp4"
        output_path = _safe_resolve_path(os.path.join("output", "video"), output_filename)
        os.makedirs(os.path.dirname(output_path), exist_ok=True)

        # Ensure background audio is cached (Demucs runs only on first call or video change)
        bg_audio_path = self._ensure_bg_audio_cached(frame, video_path, video_task.video_url)

        import tempfile
        work_dir = tempfile.mkdtemp(prefix="dub_mix_")
        try:
            if bg_audio_path:
                mixed_audio = os.path.join(work_dir, "mixed.wav")
                delay_str = f"{offset_ms}|{offset_ms}"

                mix_cmd = [
                    ffmpeg_path, "-y",
                    "-i", bg_audio_path,
                    "-i", tts_path,
                    "-filter_complex",
                    f"[1:a]adelay={delay_str}[tts];[0:a][tts]amix=inputs=2:duration=first:weights=1 1[out]",
                    "-map", "[out]",
                    "-ac", "2", "-ar", "44100",
                    mixed_audio,
                ]

                logger.info(f"[DUB] Mixing TTS with background (adelay={offset_ms}ms)")
                subprocess.run(mix_cmd, check=True, capture_output=True, timeout=60)

                if not os.path.exists(mixed_audio):
                    raise RuntimeError("Audio mixing failed: output file not created")

                mux_cmd = [
                    ffmpeg_path, "-y",
                    "-i", video_path,
                    "-i", mixed_audio,
                    "-map", "0:v",
                    "-map", "1:a",
                    "-c:v", "copy",
                    "-c:a", "aac", "-b:a", "192k",
                    "-movflags", "+faststart",
                    output_path,
                ]
                subprocess.run(mux_cmd, check=True, capture_output=True, timeout=60)
            else:
                delay_str = f"{offset_ms}|{offset_ms}"
                cmd = [
                    ffmpeg_path, "-y",
                    "-i", video_path,
                    "-i", tts_path,
                    "-filter_complex",
                    f"[1:a]adelay={delay_str}[tts];[tts]apad[out]",
                    "-map", "0:v",
                    "-map", "[out]",
                    "-c:v", "copy",
                    "-c:a", "aac", "-b:a", "192k",
                    "-movflags", "+faststart",
                    output_path,
                ]
                logger.info(f"[DUB] Simple replacement with adelay={offset_ms}ms")
                subprocess.run(cmd, check=True, capture_output=True, timeout=120)

        except subprocess.CalledProcessError as e:
            stderr_msg = e.stderr.decode() if e.stderr else "No error output"
            logger.error(f"[DUB] FFmpeg failed: {stderr_msg[:400]}")
            raise RuntimeError(f"Audio dubbing failed: {stderr_msg[:200]}")
        finally:
            import shutil
            shutil.rmtree(work_dir, ignore_errors=True)

        if not os.path.exists(output_path):
            raise RuntimeError("Preview video was not created")

        frame.preview_video_url = f"video/{output_filename}"
        frame.dubbed_video_task_id = video_task_id
        frame.dub_offset_ms = offset_ms
        self._save_data()

        logger.info(f"[DUB] Preview generated: {output_filename}")
        return script

    def apply_dub(self, script_id: str, frame_id: str) -> "Script":
        """Promote preview_video_url to dubbed_video_url."""
        _validate_safe_id(script_id, "script_id")
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")

        frame = next((f for f in script.frames if f.id == frame_id), None)
        if not frame:
            raise ValueError(f"Frame {frame_id} not found")

        if not frame.preview_video_url:
            raise ValueError("No preview to apply. Generate a preview first.")

        # Delete old dubbed file
        if frame.dubbed_video_url:
            old_path = _safe_resolve_path("output", frame.dubbed_video_url)
            if os.path.exists(old_path):
                try:
                    os.remove(old_path)
                except OSError:
                    pass

        frame.dubbed_video_url = frame.preview_video_url
        frame.preview_video_url = None
        self._save_data()

        logger.info(f"[DUB] Applied: {frame.dubbed_video_url}")
        return script

    def revert_dub(self, script_id: str, frame_id: str) -> "Script":
        """Revert dubbing — clear dubbed and preview, keep bg cache."""
        _validate_safe_id(script_id, "script_id")
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")

        frame = next((f for f in script.frames if f.id == frame_id), None)
        if not frame:
            raise ValueError(f"Frame {frame_id} not found")

        for url_field in ("dubbed_video_url", "preview_video_url"):
            url = getattr(frame, url_field)
            if url:
                path = _safe_resolve_path("output", url)
                if os.path.exists(path):
                    try:
                        os.remove(path)
                    except OSError:
                        pass
                setattr(frame, url_field, None)

        frame.dub_offset_ms = 0
        frame.dubbed_video_task_id = None
        self._save_data()
        return script

    def merge_videos(self, script_id: str) -> Script:
        """Step 5b: Merge selected videos into a single file."""
        _validate_safe_id(script_id, "script_id")
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
        
        logger.info(f"[MERGE] Starting video merge for script {script_id}")
        
        # Check if ffmpeg is available (prioritize bundled version)
        ffmpeg_path = get_ffmpeg_path()
        if not ffmpeg_path:
            install_instructions = get_ffmpeg_install_instructions()
            error_msg = (
                "FFmpeg is required for video merging but was not found.\n\n"
                f"{install_instructions}\n\n"
                "After installation, restart the application."
            )
            logger.error(f"[MERGE] FFmpeg not found. {error_msg}")
            raise RuntimeError(error_msg)
        
        # Log ffmpeg version for debugging
        try:
            version_result = subprocess.run(
                [ffmpeg_path, "-version"],
                capture_output=True,
                text=True,
                timeout=5
            )
            if version_result.returncode == 0:
                version_line = version_result.stdout.split('\n')[0] if version_result.stdout else "Unknown"
                logger.debug(f"[MERGE] Using FFmpeg: {version_line}")
                logger.debug(f"[MERGE] FFmpeg path: {ffmpeg_path}")
            else:
                logger.warning(f"[MERGE] Could not get FFmpeg version (exit code {version_result.returncode})")
        except Exception as e:
            logger.warning(f"[MERGE] Could not get FFmpeg version: {e}")
            
        # Collect video paths
        video_paths = []
        for i, frame in enumerate(script.frames):
            logger.info(f"[MERGE] Processing frame {i+1}/{len(script.frames)}: {frame.id}")

            # Prefer dubbed version (TTS audio already overlaid with lip-sync offset)
            if frame.dubbed_video_url:
                dubbed_path = _safe_resolve_path("output", frame.dubbed_video_url)
                if os.path.exists(dubbed_path):
                    logger.debug(f"[MERGE]   -> Using dubbed video: {frame.dubbed_video_url}")
                    video_paths.append(frame.dubbed_video_url)
                    continue
                else:
                    logger.warning(f"[MERGE]   -> Dubbed video file missing: {dubbed_path}, falling back")

            if not frame.selected_video_id:
                # Try to find a default completed video
                default_video = next((v for v in script.video_tasks if v.frame_id == frame.id and v.status == "completed"), None)
                if default_video and default_video.video_url:
                    logger.debug(f"[MERGE]   -> Using default video: {default_video.video_url}")
                    video_paths.append(default_video.video_url)
                else:
                    logger.warning(f"[MERGE]   -> No video selected or available, skipping")
                continue
                
            video = next((v for v in script.video_tasks if v.id == frame.selected_video_id), None)
            if video and video.video_url:
                logger.debug(f"[MERGE]   -> Selected video: {video.video_url}")
                video_paths.append(video.video_url)
            else:
                logger.warning(f"[MERGE]   -> Selected video {frame.selected_video_id} not found or has no URL")
                
        if not video_paths:
            logger.error("[MERGE] No videos found to merge!")
            raise ValueError("No videos selected to merge. Please select videos for each frame first.")
        
        logger.info(f"[MERGE] Found {len(video_paths)} videos to merge")
            
        # Create file list for ffmpeg
        # script.id comes from the store (== script_id), keeping ffmpeg args taint-free.
        list_path = _safe_resolve_path("output", f"merge_list_{script.id}.txt")
        abs_video_paths = []

        with open(list_path, "w") as f:
            for path in video_paths:
                # Resolve to absolute path
                if not path.startswith("http"):
                    abs_path = _safe_resolve_path("output", path)
                    if os.path.exists(abs_path):
                        f.write(f"file '{abs_path}'\n")
                        abs_video_paths.append(abs_path)
                        logger.debug(f"[MERGE] Added to list: {abs_path}")
                    else:
                        logger.warning(f"[MERGE] Video file not found: {abs_path}")
                        
        if not abs_video_paths:
            logger.error("[MERGE] No valid video files found on disk!")
            raise ValueError("No valid video files found. The video files may have been deleted or moved.")
        
        logger.info(f"[MERGE] Merge list created with {len(abs_video_paths)} videos")

        # Output path
        output_filename = f"merged_{script.id}_{int(time.time())}.mp4"
        output_path = _safe_resolve_path(os.path.join("output", "video"), output_filename)
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        
        logger.debug(f"[MERGE] Output path: {output_path}")
        
        # Log video file details for debugging
        for i, path in enumerate(abs_video_paths):
            try:
                size_mb = os.path.getsize(path) / (1024 * 1024)
                logger.debug(f"[MERGE] Input video {i+1}: {os.path.basename(path)} ({size_mb:.2f} MB)")
            except Exception as e:
                logger.warning(f"[MERGE] Could not get size for video {i+1}: {e}")
        
        # Run ffmpeg
        # Use re-encoding for better compatibility (slower but more reliable)
        # -c:v libx264 -c:a aac ensures consistent output format
        cmd = [
            ffmpeg_path, "-y",  # Use the detected ffmpeg path
            "-f", "concat",
            "-safe", "0",
            "-i", list_path,
            "-c:v", "libx264",  # Re-encode video with H.264
            "-crf", "23",       # Quality (lower = better, 23 is default)
            "-preset", "fast",  # Encoding speed
            "-c:a", "aac",      # Re-encode audio with AAC
            "-b:a", "128k",     # Audio bitrate
            "-movflags", "+faststart",  # Web optimization
            output_path
        ]
        
        logger.debug(f"[MERGE] Running FFmpeg command: {' '.join(cmd)}")
        logger.debug(f"[MERGE] Platform: {platform.system()} {platform.release()}")
        
        try:
            result = subprocess.run(cmd, check=True, capture_output=True, timeout=600)  # 10 min timeout for re-encoding
            logger.debug(f"[MERGE] FFmpeg stdout: {result.stdout.decode()[:500] if result.stdout else 'empty'}")
            logger.info(f"[MERGE] FFmpeg completed successfully")
            
            # Update script with merged video path
            # Use 'videos/' (plural) to match the /files/videos route
            script.merged_video_url = f"videos/{output_filename}"

            # Verify file was created and log details
            if os.path.exists(output_path):
                file_size_mb = os.path.getsize(output_path) / (1024 * 1024)
                logger.info(f"[MERGE] ✅ Merged video created successfully: {output_filename} ({file_size_mb:.2f} MB)")
                logger.info(f"[MERGE] ✅ Video accessible at: /files/videos/{output_filename}")
            else:
                logger.error(f"[MERGE] ❌ Merged video file NOT found at: {output_path}")
                raise RuntimeError(f"Video merge completed but output file not found: {output_path}")

            # PR-3l · Pass 2: BGM mux. If script.bgm_url is set and the BGM
            # file exists, overlay it under the existing audio track at the
            # configured mix level. Dialogue stays on the original track of
            # the per-frame videos (sound-driven I2V already embedded it);
            # a future enhancement can swap to per-frame dialogue overlay.
            try:
                mixed_path = self._maybe_apply_bgm_mux(
                    script, output_path, ffmpeg_path,
                )
                if mixed_path:
                    # Replace the concat output with the mixed one (same filename)
                    os.replace(mixed_path, output_path)
                    logger.info(f"[MERGE] ✅ BGM mux applied — final file: {output_filename}")
            except Exception as bgm_err:
                # BGM is optional; log + carry on with the silent video
                logger.warning(f"[MERGE] BGM mux skipped due to error: {bgm_err}")

            self._save_data()

            # Cleanup list file
            if os.path.exists(list_path):
                os.remove(list_path)

            return script
        except subprocess.TimeoutExpired:
            logger.error("[MERGE] FFmpeg timed out after 600 seconds")
            raise RuntimeError("FFmpeg timed out. The videos may be too large.")
        except subprocess.CalledProcessError as e:
            stderr_msg = e.stderr.decode() if e.stderr else "No error output"
            stdout_msg = e.stdout.decode() if e.stdout else "No output"
            
            # Log full details for debugging
            logger.error(f"[MERGE] FFmpeg failed with exit code {e.returncode}")
            logger.error(f"[MERGE] FFmpeg command: {' '.join(cmd)}")
            logger.error(f"[MERGE] FFmpeg stderr: {stderr_msg}")
            logger.error(f"[MERGE] FFmpeg stdout: {stdout_msg}")
            logger.error(f"[MERGE] Video files attempted: {[os.path.basename(p) for p in abs_video_paths]}")
            
            # Extract user-friendly error message
            user_msg = self._extract_ffmpeg_error_message(stderr_msg, abs_video_paths)
            raise RuntimeError(user_msg)
    
    def _maybe_apply_bgm_mux(
        self,
        script: Script,
        video_path: str,
        ffmpeg_path: str,
    ) -> Optional[str]:
        """PR-3l · Overlay BGM at the configured mix level on top of the
        already-merged video. Returns the path of the new file, or None
        when no BGM is configured / the file is missing.

        Strategy: 2-input filter — amix the existing video audio (volume =
        dialogue_level/100) with the looped BGM (volume = bgm_level/100).
        SFX track will be added in a later pass when SFX files exist.
        """
        bgm_rel = (script.bgm_url or "").strip()
        if not bgm_rel:
            return None
        bgm_abs = _safe_resolve_path("output", bgm_rel)
        if not os.path.exists(bgm_abs):
            logger.info(f"[MERGE/BGM] preset file missing — {bgm_abs}; skipping mux")
            return None

        mix = script.mix_settings or {"dialogue": 100, "bgm": 35, "sfx": 60}
        dial = max(0, min(100, int(mix.get("dialogue", 100)))) / 100.0
        bgm_lvl = max(0, min(100, int(mix.get("bgm", 35)))) / 100.0

        mixed_path = video_path.replace(".mp4", "_mixed.mp4")
        # -stream_loop -1 loops BGM until shortest (the video) ends.
        # apad on the dialogue side avoids amix cutting early on silence.
        filter_complex = (
            f"[0:a]volume={dial:.3f},apad[a0];"
            f"[1:a]volume={bgm_lvl:.3f},aloop=loop=-1:size=2e9[a1];"
            f"[a0][a1]amix=inputs=2:duration=first:dropout_transition=0[aout]"
        )
        cmd = [
            ffmpeg_path, "-y",
            "-i", video_path,
            "-stream_loop", "-1", "-i", bgm_abs,
            "-filter_complex", filter_complex,
            "-map", "0:v", "-map", "[aout]",
            "-c:v", "copy",
            "-c:a", "aac", "-b:a", "192k",
            "-shortest",
            "-movflags", "+faststart",
            mixed_path,
        ]
        logger.info(f"[MERGE/BGM] muxing BGM dial={dial:.2f} bgm={bgm_lvl:.2f} — {os.path.basename(bgm_abs)}")
        try:
            subprocess.run(cmd, check=True, capture_output=True, timeout=300)
        except subprocess.CalledProcessError as e:
            stderr_msg = e.stderr.decode() if e.stderr else ""
            logger.warning(f"[MERGE/BGM] ffmpeg failed: {stderr_msg[:400]}")
            return None
        if not os.path.exists(mixed_path):
            logger.warning(f"[MERGE/BGM] mixed output not found: {mixed_path}")
            return None
        return mixed_path

    def _extract_ffmpeg_error_message(self, stderr: str, video_paths: List[str]) -> str:
        """
        Extract a user-friendly error message from ffmpeg stderr output.
        
        Args:
            stderr: The stderr output from ffmpeg
            video_paths: List of video file paths that were being processed
            
        Returns:
            A user-friendly error message
        """
        if not stderr:
            return "FFmpeg merge failed with no error output. Please check the log files."
        
        stderr_lower = stderr.lower()
        
        # Common error patterns with user-friendly messages
        if "no such file or directory" in stderr_lower:
            return (
                "One or more video files could not be found.\n"
                "The videos may have been deleted or moved.\n"
                "Please try regenerating the missing videos."
            )
        
        if "invalid data found" in stderr_lower or "invalid file" in stderr_lower or "moov atom not found" in stderr_lower:
            return (
                "One or more video files are corrupted or incomplete.\n"
                "This can happen if video generation was interrupted.\n"
                "Please try regenerating the affected videos."
            )
        
        if ("codec" in stderr_lower and ("not supported" in stderr_lower or "unknown" in stderr_lower)):
            return (
                "Video codec compatibility issue detected.\n"
                "The video format may not be supported by your FFmpeg installation.\n"
                "Try updating FFmpeg to the latest version."
            )
        
        if "permission denied" in stderr_lower or "access is denied" in stderr_lower:
            return (
                "Permission denied when accessing video files.\n"
                "Please check that the application has read/write permissions\n"
                "for the output directory."
            )
        
        if "disk full" in stderr_lower or "no space" in stderr_lower:
            return (
                "Insufficient disk space to create the merged video.\n"
                "Please free up some space and try again."
            )
        
        if "height not divisible" in stderr_lower or "width not divisible" in stderr_lower:
            return (
                "Video resolution compatibility issue.\n"
                "The videos have incompatible dimensions.\n"
                "This should not happen - please report this issue."
            )
        
        if "invalid argument" in stderr_lower:
            # Check if it's related to file list
            if any("filelist" in line.lower() or "concat" in line.lower() for line in stderr.split('\n')):
                return (
                    "FFmpeg could not read the video file list.\n"
                    "This might be a file path encoding issue.\n"
                    "Please ensure video filenames don't contain special characters."
                )
        
        # Fallback: extract the most relevant error line
        # Usually the last non-empty line before the final summary
        error_lines = [line.strip() for line in stderr.split('\n') if line.strip()]
        if error_lines:
            # Look for lines that seem like actual errors (contain "error", "failed", etc.)
            for line in reversed(error_lines):
                line_lower = line.lower()
                if any(keyword in line_lower for keyword in ['error', 'failed', 'invalid', 'cannot', 'unable']):
                    # Truncate if too long
                    if len(line) > 200:
                        line = line[:200] + "..."
                    return f"FFmpeg error: {line}\n\nPlease check the application logs for more details."
            
            # If no error keyword found, use last line
            last_line = error_lines[-1]
            if len(last_line) > 200:
                last_line = last_line[:200] + "..."
            return f"FFmpeg merge failed: {last_line}\n\nPlease check the application logs for more details."
        
        return "FFmpeg merge failed with unknown error. Please check the application logs for details."

    def create_asset_video_task(self, script_id: str, asset_id: str, asset_type: str, prompt: str, duration: int = 5, aspect_ratio: str = None) -> Tuple[Script, str]:
        """Creates a new video generation task for an asset (R2V)."""
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
            
        # Find asset
        target_asset = None
        if asset_type == "character":
            target_asset = next((c for c in script.characters if c.id == asset_id), None)
        elif asset_type == "scene":
            target_asset = next((s for s in script.scenes if s.id == asset_id), None)
        elif asset_type == "prop":
            target_asset = next((p for p in script.props if p.id == asset_id), None)
            
        if not target_asset:
            raise ValueError(f"Asset {asset_id} of type {asset_type} not found")
            
        # Use main image as reference
        image_url = target_asset.image_url
        if not image_url:
             # Try fallback for character
             if asset_type == "character":
                 image_url = target_asset.full_body_image_url or target_asset.avatar_url
        
        if not image_url:
            raise ValueError("Asset has no reference image")

        # Save prompt to asset
        if prompt:
            target_asset.video_prompt = prompt
            
        task_id = str(uuid.uuid4())
        
        # Create VideoTask
        task = VideoTask(
            id=task_id,
            project_id=script_id,
            asset_id=asset_id, # Link to asset
            image_url=image_url,
            prompt=prompt or f"Cinematic shot of {target_asset.name}",
            status="pending",
            duration=duration,
            model=script.model_settings.r2v_model if hasattr(script.model_settings, 'r2v_model') and script.model_settings.r2v_model else get_default_model_settings().r2v_model,
            generation_mode="r2v",
            created_at=time.time()
        )
        
        # Add to script.video_tasks for global tracking
        if not script.video_tasks:
            script.video_tasks = []
        script.video_tasks.append(task)
        
        # Add to asset's video_assets list
        if not target_asset.video_assets:
            target_asset.video_assets = []
        target_asset.video_assets.append(task)
        
        self._save_data()
        return script, task_id

    def get_video_task(self, script_id: str, task_id: str) -> Optional[VideoTask]:
        script = self.get_script(script_id)
        if not script:
            return None
        return next((t for t in script.video_tasks if t.id == task_id), None)

    def _remember_provider_task_id(self, script: Script, task: VideoTask, provider_task_id: str) -> None:
        """把上游任务号落到任务上（一拿到就写，不等跑完）。

        这是「回捞」的唯一凭据：轮询要几分钟，中间后端一重启（dev `--reload` 天天在
        发生）这个号就没了，只能重新生成 = 再付一次费。以前这个字段从没被写入过，
        所以失败之后连查都没得查。
        """
        task.provider_name = task.provider_name or "jiucaihezi"
        task.provider_task_id = provider_task_id
        self._save_data()

    def process_video_task(self, script_id: str, task_id: str, resume: bool = False):
        """跑一个视频任务。

        ``resume=True``：上游已经有这个任务了（``provider_task_id`` 有值），只续上
        轮询 + 补下载，**不重新提交**。这是「回捞」的实现 —— 重新提交会再付一次费。
        """
        script = self.get_script(script_id)
        if not script:
            logger.error(f"Script {script_id} not found for task {task_id}")
            return
            
        task = next((t for t in script.video_tasks if t.id == task_id), None)
        
        if not task:
            logger.error(f"Task {task_id} not found in script {script_id}")
            return

        if resume and not task.provider_task_id:
            logger.error(f"Task {task_id} has no provider task id — cannot resume")
            return

        try:
            # Update status to processing
            task.status = "processing"
            task.error = None
            # 第一次开始的时间留着不动（续跑时「已等多久」该算全程），
            # 但上一次的结束时间要清掉 —— 它现在是「正在跑」。
            if not task.started_at:
                task.started_at = time.time()
            task.finished_at = 0.0
            self._save_data()

            output_filename = f"video_{task_id}.mp4"
            output_path = os.path.join("output", "video", output_filename)
            os.makedirs(os.path.dirname(output_path), exist_ok=True)

            if resume:
                # 续跑：上游任务号在手，直接接着问。跳过音频/图片准备 —— 那些在第一次
                # 提交前就已经做过，重做只会再烧一次钱。
                from ...models.jiucaihezi import poll_video_task
                poll_video_task(task.provider_task_id, output_path)
            else:
                # Download image to temp file
                img_path = None
                if task.image_url:
                    img_path = self._download_temp_image(task.image_url)

                # Handle Audio Logic —— 前端 VideoSidebar 的三态：
                # 1. mute   audio_url=None, generate_audio=False
                # 2. ai     audio_url=None, generate_audio=True → 用 seed-audio-1.0 生成
                # 3. custom audio_url=URL → 直接当参考音频发给上游
                #
                # 音频生成是一个独立模型（seed-audio-1.0，POST /v1/audio/speech），
                # 不是视频模型上的开关。放在视频之前：音频失败就让任务失败，此时还
                # 没为视频付费。
                final_audio_url = task.audio_url or None
                if not final_audio_url and task.generate_audio:
                    final_audio_url = self._generate_ai_sound(task)

                # Image ref handed to the video adapter (local path or remote URL)
                img_url = task.image_url

                # 目录里只有韭菜盒子一家，所以视频只有一个适配器。
                #
                # 这里原来按 provider 分派到 wanx / mulerouter / kling / vidu 四个适配器，
                # 那些家族已随目录收敛删除。已下线的旧 task.model 不再有任何本地适配器
                # 可退 —— 交给网关按模型名报错，比在本地挑一个猜的适配器清楚。
                if self._jiucaihezi_video_model is None:
                    from ...models.jiucaihezi import JiucaiheziVideoModel
                    self._jiucaihezi_video_model = JiucaiheziVideoModel({})
                video_path, _ = self._jiucaihezi_video_model.generate(
                    prompt=task.prompt, output_path=output_path, img_url=img_url, img_path=img_path,
                    model_name=task.model, duration=task.duration, resolution=task.resolution,
                    audio_url=final_audio_url, reference_audio_urls=task.reference_audio_urls or [],
                    aspect_ratio=task.ratio or "16:9",
                    ref_image_urls=task.reference_image_urls or [],
                    # 上游任务号一到手就落盘，否则后端重启就彻底丢了。
                    on_task_id=lambda pid: self._remember_provider_task_id(script, task, pid),
                )
            
            task.video_url = to_media_ref(os.path.relpath(output_path, "output"))
            task.status = "completed"
            task.error = None
            task.finished_at = time.time()
            
            # Sync with asset if this is an asset video
            if task.asset_id:
                self._sync_asset_video_task(script, task)
            
        except Exception as e:
            logger.exception("Failed to process video task")
            logger.error(f"Video generation failed: {e}")
            task.status = "failed"
            task.finished_at = time.time()
            # 以前这里不写 error，前端只能显示「未知错误，请重试」—— 用户拿不到任何
            # 线索，我们事后也查不出。失败原因必须落到任务上。
            task.error = str(e) or e.__class__.__name__
            if task.provider_task_id:
                task.error += (
                    f"（上游任务号 {task.provider_task_id} 已保存："
                    "点「继续回捞」可以接着等结果，不用重新生成）"
                )
            if task.asset_id:
                self._sync_asset_video_task(script, task)
            
        self._save_data()

    def _sync_asset_video_task(self, script: Script, task: VideoTask):
        """Syncs the updated task status/url back to the asset's video_assets list."""
        target_asset = None
        # Search in all asset types
        for char in script.characters:
            if char.id == task.asset_id:
                target_asset = char
                break
        if not target_asset:
            for scene in script.scenes:
                if scene.id == task.asset_id:
                    target_asset = scene
                    break
        if not target_asset:
            for prop in script.props:
                if prop.id == task.asset_id:
                    target_asset = prop
                    break
        
        if target_asset:
            # Find and update the task in the asset's list
            for i, t in enumerate(target_asset.video_assets):
                if t.id == task.id:
                    target_asset.video_assets[i] = task
                    break
            else:
                # Not found, append it (shouldn't happen if created correctly, but good fallback)
                target_asset.video_assets.append(task)

    def delete_asset_video(self, script_id: str, asset_id: str, asset_type: str, video_id: str) -> Script:
        """Deletes a video from an asset."""
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
        
        # Find asset
        target_asset = None
        if asset_type == "character":
            target_asset = next((c for c in script.characters if c.id == asset_id), None)
        elif asset_type == "scene":
            target_asset = next((s for s in script.scenes if s.id == asset_id), None)
        elif asset_type == "prop":
            target_asset = next((p for p in script.props if p.id == asset_id), None)
        
        if not target_asset:
            raise ValueError(f"Asset {asset_id} of type {asset_type} not found")
        
        # Find the task first to get video_url for file deletion
        video_task_to_delete = None
        if script.video_tasks:
            video_task_to_delete = next((v for v in script.video_tasks if v.id == video_id), None)
        
        # Remove from asset's video_assets
        if target_asset.video_assets:
            original_len = len(target_asset.video_assets)
            target_asset.video_assets = [v for v in target_asset.video_assets if v.id != video_id]
            if len(target_asset.video_assets) == original_len and not video_task_to_delete:
                 # Only raise if not found in either place, or just log warning?
                 # If found in global list but not asset list, it's weird but we should proceed.
                 pass

        # Also remove from script.video_tasks
        if script.video_tasks:
            script.video_tasks = [v for v in script.video_tasks if v.id != video_id]
        
        # Try to delete the video file
        try:
            if video_task_to_delete and video_task_to_delete.video_url:
                video_path = os.path.join("output", video_task_to_delete.video_url)
                if os.path.exists(video_path):
                    os.remove(video_path)
                    logger.info(f"Deleted video file: {video_path}")
        except Exception as e:
            logger.warning(f"Failed to delete video file: {e}")
        
        self._save_data()
        return script

    def frame_speaker(self, script: Script, frame: 'StoryboardFrame') -> Optional[Character]:
        """这一帧是谁在说话 —— 对白音频要拿他的参考音。

        先认**说话人名字**（``frame.speaker`` / ``dialogue_structured.speaker``），
        认不出来才退回 ``character_ids[0]``。顺序不能反：一帧里常常站着好几个人
        （刘备 + 彪形大汉），``character_ids`` 首位往往不是开口的那个 ——
        按首位取参考音就是拿别人的嗓子念这一句。

        名字匹配只做「精确 → 包含」两级，跟别处的兑名一致；角色可能只活在系列池
        或全局库里，所以走三层合并而不是只看本集。
        """
        name = (frame.speaker or (
            frame.dialogue_structured.speaker if frame.dialogue_structured else None
        ) or "").strip().lower()
        if name:
            characters = [c for c, _ in self.resolve_episode_assets_with_source(script)["characters"]]
            exact = next((c for c in characters if c.name.strip().lower() == name), None)
            if exact:
                return exact
            loose = next(
                (c for c in characters
                 if name in c.name.strip().lower() or c.name.strip().lower() in name),
                None,
            )
            if loose:
                return loose
        if frame.character_ids:
            # 帧引用的是三层合并后的 id，角色可能只活在系列池里。
            return self._find_asset_with_source(script, frame.character_ids[0], "character")[0]
        return None

    def generate_audio(self, script_id: str) -> Script:
        """Step 5: Generate audio (Dialogue & SFX)."""
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
            
        logger.info(f"Generating audio for script {script.id}")
        
        for frame in script.frames:
            # Generate Dialogue
            if frame.dialogue:
                speaker = self.frame_speaker(script, frame)
                if speaker:
                    self.audio_generator.generate_dialogue(frame, speaker)
            
            # Generate SFX (Text-to-Audio)
            if frame.action_description:
                self.audio_generator.generate_sfx(frame)
                
            # Generate SFX (Video-to-Audio) - if video exists
            if frame.video_url:
                self.audio_generator.generate_sfx_from_video(frame)
                
            # Generate BGM
            # Simple logic: generate BGM for every frame (or scene start)
            self.audio_generator.generate_bgm(frame)
                
        self._save_data()
        return script

    def generate_dialogue_line(
        self,
        script_id: str,
        frame_id: str,
        instructions: Optional[str] = None,
    ) -> Script:
        """给某一帧生成对白音频。

        声音完全由这个角色的**参考音**决定（seed-audio-1.0 参考生音频），所以这里
        已经没有任何 speed/pitch/volume/音色参数 —— 角色有没有参考音由 audio 层
        报错，不在这一层静默失败。

        ``instructions`` 是情绪标签 + 自由文本，拼进提示词里当演绎要求。
        """
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")

        frame = next((f for f in script.frames if f.id == frame_id), None)
        if not frame:
            raise ValueError("Frame not found")

        dialogue_text = (
            (frame.dialogue_structured.line if frame.dialogue_structured else None)
            or frame.dialogue
        )
        if dialogue_text:
            speaker = self.frame_speaker(script, frame)
            if speaker:
                self.audio_generator.generate_dialogue(
                    frame, speaker, instructions=instructions
                )

        self._save_data()
        return script

    def get_script(self, script_id: str) -> Optional[Script]:
        return self.scripts.get(script_id)

    def _select_variant_in_asset(self, image_asset: Any, variant_id: str) -> Any:
        """Helper to select a variant in an ImageAsset. Returns the selected variant if found."""
        if not image_asset or not image_asset.variants:
            return None
            
        for variant in image_asset.variants:
            if variant.id == variant_id:
                image_asset.selected_id = variant_id
                return variant
        return None

    def _delete_variant_in_asset(self, image_asset: Any, variant_id: str) -> bool:
        """Helper to delete a variant in an ImageAsset. Returns True if found and deleted."""
        if not image_asset or not image_asset.variants:
            return False
            
        initial_len = len(image_asset.variants)
        image_asset.variants = [v for v in image_asset.variants if v.id != variant_id]
        
        if len(image_asset.variants) < initial_len:
            # If we deleted the selected one, select the last one or None
            if image_asset.selected_id == variant_id:
                if image_asset.variants:
                    image_asset.selected_id = image_asset.variants[-1].id
                else:
                    image_asset.selected_id = None
            return True
        return False

    def select_asset_variant(self, script_id: str, asset_id: str, asset_type: str, variant_id: str, generation_type: str = None) -> Script:
        """Selects a specific variant for an asset."""
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
            
        target_asset = None
        asset_is_series_level = False
        if asset_type == "character":
            target_asset = next((c for c in script.characters if c.id == asset_id), None)
            # Fallback to parent series for series-level characters.
            if not target_asset and script.series_id:
                series = self.series_store.get(script.series_id)
                if series:
                    target_asset = next((c for c in series.characters if c.id == asset_id), None)
                    if target_asset:
                        asset_is_series_level = True
            if target_asset:
                # If generation_type is specified, only select from that specific asset
                if generation_type == "full_body":
                    variant = self._select_variant_in_asset(target_asset.full_body_asset, variant_id)
                    if variant:
                        target_asset.full_body_image_url = variant.url
                        target_asset.image_url = variant.url  # Legacy sync
                elif generation_type == "three_view":
                    variant = self._select_variant_in_asset(target_asset.three_view_asset, variant_id)
                    if variant:
                        target_asset.three_view_image_url = variant.url
                elif generation_type == "headshot":
                    variant = self._select_variant_in_asset(target_asset.headshot_asset, variant_id)
                    if variant:
                        target_asset.headshot_image_url = variant.url
                        target_asset.avatar_url = variant.url  # Sync avatar
                elif generation_type == "reference_sheet":
                    # R2V v2: reference_sheet is the canonical asset unit for
                    # the CastWorkbench flow. Selecting a variant here updates
                    # selected_image_id + legacy image_url so the rest of the
                    # app (storyboard reference, etc.) sees the pick.
                    variant = self._select_variant_in_asset(getattr(target_asset, "reference_sheet", None), variant_id)
                    if variant:
                        if target_asset.reference_sheet:
                            target_asset.reference_sheet.selected_image_id = variant.id
                        target_asset.image_url = variant.url
                else:
                    # Legacy fallback: search all assets (for backward compatibility)
                    variant = self._select_variant_in_asset(target_asset.full_body_asset, variant_id)
                    if variant:
                        target_asset.full_body_image_url = variant.url
                        target_asset.image_url = variant.url

                    if not variant:
                        variant = self._select_variant_in_asset(target_asset.three_view_asset, variant_id)
                        if variant:
                            target_asset.three_view_image_url = variant.url

                    if not variant:
                        variant = self._select_variant_in_asset(target_asset.headshot_asset, variant_id)
                        if variant:
                            target_asset.headshot_image_url = variant.url
                            target_asset.avatar_url = variant.url
                        
        elif asset_type == "scene":
            target_asset = next((s for s in script.scenes if s.id == asset_id), None)
            if not target_asset and script.series_id:
                series = self.series_store.get(script.series_id)
                if series:
                    target_asset = next((s for s in series.scenes if s.id == asset_id), None)
                    if target_asset:
                        asset_is_series_level = True
            if target_asset:
                variant = self._select_variant_in_asset(target_asset.image_asset, variant_id)
                if variant:
                    target_asset.image_url = variant.url

        elif asset_type == "prop":
            target_asset = next((p for p in script.props if p.id == asset_id), None)
            if not target_asset and script.series_id:
                series = self.series_store.get(script.series_id)
                if series:
                    target_asset = next((p for p in series.props if p.id == asset_id), None)
                    if target_asset:
                        asset_is_series_level = True
            if target_asset:
                variant = self._select_variant_in_asset(target_asset.image_asset, variant_id)
                if variant:
                    target_asset.image_url = variant.url

        elif asset_type == "storyboard_frame":
            target_asset = next((f for f in script.frames if f.id == asset_id), None)
            if target_asset:
                # Check rendered_image_asset
                variant = self._select_variant_in_asset(target_asset.rendered_image_asset, variant_id)
                if variant:
                    target_asset.rendered_image_url = variant.url
                    target_asset.image_url = variant.url # Main image is rendered one
                
                # Also check image_asset (sketch)?
                if not variant:
                    variant = self._select_variant_in_asset(target_asset.image_asset, variant_id)
                    # If sketch, maybe don't update main image_url if rendered exists?
                    # For now, let's assume we only select rendered variants for frames usually.

        self._save_data()
        if asset_is_series_level:
            self._save_series_data()
        return script

    def delete_asset_variant(self, script_id: str, asset_id: str, asset_type: str, variant_id: str) -> Script:
        """Deletes a specific variant from an asset."""
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
            
        target_asset = None
        if asset_type == "character":
            target_asset = next((c for c in script.characters if c.id == asset_id), None)
            if target_asset:
                if self._delete_variant_in_asset(target_asset.full_body_asset, variant_id):
                    # Sync legacy if needed
                    if target_asset.full_body_asset.selected_id:
                        selected = next((v for v in target_asset.full_body_asset.variants if v.id == target_asset.full_body_asset.selected_id), None)
                        target_asset.image_url = selected.url if selected else None
                    else:
                        target_asset.image_url = None
                
                elif self._delete_variant_in_asset(target_asset.three_view_asset, variant_id):
                    if target_asset.three_view_asset.selected_id:
                        selected = next((v for v in target_asset.three_view_asset.variants if v.id == target_asset.three_view_asset.selected_id), None)
                        target_asset.three_view_image_url = selected.url if selected else None
                    else:
                        target_asset.three_view_image_url = None

                elif self._delete_variant_in_asset(target_asset.headshot_asset, variant_id):
                    if target_asset.headshot_asset.selected_id:
                        selected = next((v for v in target_asset.headshot_asset.variants if v.id == target_asset.headshot_asset.selected_id), None)
                        target_asset.headshot_image_url = selected.url if selected else None
                    else:
                        target_asset.headshot_image_url = None

        elif asset_type == "scene":
            target_asset = next((s for s in script.scenes if s.id == asset_id), None)
            if target_asset and self._delete_variant_in_asset(target_asset.image_asset, variant_id):
                if target_asset.image_asset.selected_id:
                    selected = next((v for v in target_asset.image_asset.variants if v.id == target_asset.image_asset.selected_id), None)
                    target_asset.image_url = selected.url if selected else None
                else:
                    target_asset.image_url = None

        elif asset_type == "prop":
            target_asset = next((p for p in script.props if p.id == asset_id), None)
            if target_asset and self._delete_variant_in_asset(target_asset.image_asset, variant_id):
                if target_asset.image_asset.selected_id:
                    selected = next((v for v in target_asset.image_asset.variants if v.id == target_asset.image_asset.selected_id), None)
                    target_asset.image_url = selected.url if selected else None
                else:
                    target_asset.image_url = None

        elif asset_type == "storyboard_frame":
            target_asset = next((f for f in script.frames if f.id == asset_id), None)
            if target_asset:
                if self._delete_variant_in_asset(target_asset.rendered_image_asset, variant_id):
                    if target_asset.rendered_image_asset.selected_id:
                        selected = next((v for v in target_asset.rendered_image_asset.variants if v.id == target_asset.rendered_image_asset.selected_id), None)
                        target_asset.rendered_image_url = selected.url if selected else None
                        target_asset.image_url = selected.url if selected else None
                    else:
                        target_asset.rendered_image_url = None
                        # Don't clear image_url if it might fall back to sketch? 
                        # For now, clear it if rendered is cleared.
                        target_asset.image_url = None

        self._save_data()
        return script

    def update_model_settings(self, script_id: str, t2i_model: str = None, i2i_model: str = None, i2v_model: str = None, r2v_model: str = None, character_aspect_ratio: str = None, scene_aspect_ratio: str = None, prop_aspect_ratio: str = None, storyboard_aspect_ratio: str = None, image_model: str = None) -> Script:
        """Updates the model settings for a script.

        没有 `text_model`：文本模型是全局单源（`utils/global_settings.py`），不再按
        项目存。`ModelSettings.text_model` 字段保留只为兼容存量 JSON 的读入，
        不再有写入方。
        """
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")

        if t2i_model:
            script.model_settings.t2i_model = t2i_model
        if i2i_model:
            script.model_settings.i2i_model = i2i_model
        if i2v_model:
            script.model_settings.i2v_model = i2v_model
        if r2v_model:
            script.model_settings.r2v_model = r2v_model
        if image_model:
            script.model_settings.image_model = image_model
        if character_aspect_ratio:
            script.model_settings.character_aspect_ratio = character_aspect_ratio
        if scene_aspect_ratio:
            script.model_settings.scene_aspect_ratio = scene_aspect_ratio
        if prop_aspect_ratio:
            script.model_settings.prop_aspect_ratio = prop_aspect_ratio
        if storyboard_aspect_ratio:
            script.model_settings.storyboard_aspect_ratio = storyboard_aspect_ratio

        self._save_data()
        return script

    def _set_variant_favorite(self, image_asset: Any, variant_id: str, is_favorited: bool) -> bool:
        """Helper to set favorite status of a variant. Returns True if found."""
        if not image_asset or not image_asset.variants:
            return False
        for v in image_asset.variants:
            if v.id == variant_id:
                v.is_favorited = is_favorited
                return True
        return False

    def toggle_variant_favorite(self, script_id: str, asset_id: str, asset_type: str, variant_id: str, is_favorited: bool, generation_type: str = None) -> Script:
        """Toggles the favorite status of a variant."""
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
        
        found = False
        if asset_type == "character":
            target_asset = next((c for c in script.characters if c.id == asset_id), None)
            if target_asset:
                if generation_type == "full_body":
                    found = self._set_variant_favorite(target_asset.full_body_asset, variant_id, is_favorited)
                elif generation_type == "three_view":
                    found = self._set_variant_favorite(target_asset.three_view_asset, variant_id, is_favorited)
                elif generation_type == "headshot":
                    found = self._set_variant_favorite(target_asset.headshot_asset, variant_id, is_favorited)
                else:
                    # Try all character assets
                    found = self._set_variant_favorite(target_asset.full_body_asset, variant_id, is_favorited) or \
                            self._set_variant_favorite(target_asset.three_view_asset, variant_id, is_favorited) or \
                            self._set_variant_favorite(target_asset.headshot_asset, variant_id, is_favorited)
        
        elif asset_type == "scene":
            target_asset = next((s for s in script.scenes if s.id == asset_id), None)
            if target_asset:
                found = self._set_variant_favorite(target_asset.image_asset, variant_id, is_favorited)
        
        elif asset_type == "prop":
            target_asset = next((p for p in script.props if p.id == asset_id), None)
            if target_asset:
                found = self._set_variant_favorite(target_asset.image_asset, variant_id, is_favorited)
        
        elif asset_type == "storyboard_frame":
            target_asset = next((f for f in script.frames if f.id == asset_id), None)
            if target_asset:
                found = self._set_variant_favorite(target_asset.rendered_image_asset, variant_id, is_favorited) or \
                        self._set_variant_favorite(target_asset.image_asset, variant_id, is_favorited)
        
        if not found:
            raise ValueError(f"Variant {variant_id} not found")

        self._save_data()
        return script

    # ============================================================
    # Series Storage & CRUD
    # ============================================================

    def _load_series_data(self) -> Dict[str, Series]:
        data = _load_json_store(self.series_data_file, "series.json")
        if data is None:
            return {}
        return {k: Series(**v) for k, v in data.items()}

    def _save_series_data_unlocked(self):
        """Save series data without acquiring the lock (caller must hold self._save_lock)."""
        try:
            _atomic_write_json(
                self.series_data_file,
                {k: v.model_dump() for k, v in list(self.series_store.items())},
            )
        except Exception as e:
            logger.error(f"Failed to save series data: {e}")

    def _save_series_data(self):
        """Save series data with thread lock."""
        with self._save_lock:
            self._save_series_data_unlocked()

    # ============================================================
    # Global Asset Library Storage (project-independent shared pool)
    # ============================================================

    def _load_library_data(self) -> GlobalAssetLibrary:
        data = _load_json_store(self.library_data_file, "library_assets.json")
        if data is None:
            return GlobalAssetLibrary()
        return GlobalAssetLibrary(**data)

    def _save_library_data_unlocked(self):
        """Save global library data without acquiring the lock (caller must hold self._save_lock)."""
        try:
            _atomic_write_json(self.library_data_file, self.library_store.model_dump())
        except Exception as e:
            logger.error(f"Failed to save library data: {e}")

    def _save_library_data(self):
        """Save global library data with thread lock."""
        with self._save_lock:
            self._save_library_data_unlocked()

    # ------------------------------------------------------------------
    # Global Asset Library — CRUD + feed channels (One OK Studio Core shared pool)
    # ------------------------------------------------------------------
    # These methods are the single source of truth for mutating the
    # project-independent library. Both the /library/assets endpoints and
    # the Playground "录入资产库" flow call them, so the wiring stays
    # consistent. The library is curated/opt-in (anti-bloat): nothing is
    # auto-ingested here.

    def _library_list_for_type(self, asset_type: str) -> List:
        """Return the live list backing the given asset type in the global
        library (so callers can append/iterate). Raises on unknown type."""
        if asset_type == "character":
            return self.library_store.characters
        elif asset_type == "scene":
            return self.library_store.scenes
        elif asset_type == "prop":
            return self.library_store.props
        raise ValueError(f"Invalid asset type: {asset_type}")

    def _find_library_asset(self, asset_type: str, asset_id: str):
        """Locate a global library asset by (type, id). Raises ValueError
        when the type is invalid or the id is absent."""
        target_list = self._library_list_for_type(asset_type)
        asset = next((a for a in target_list if a.id == asset_id), None)
        if asset is None:
            raise ValueError(f"Asset {asset_id} of type {asset_type} not found in library")
        return asset

    def list_library_assets(self) -> GlobalAssetLibrary:
        """Return the global shared asset pool container (characters /
        scenes / props). Mirrors get_series for the library scope."""
        return self.library_store

    def create_library_asset(self, asset_type: str, payload: Dict[str, Any]):
        """Create a new global library asset of `asset_type`
        ("character" | "scene" | "prop") from a plain payload dict, persist
        it, and return the created asset object.

        Mirrors the series quick-create endpoints
        (create_series_character/scene/prop) but targets the
        project-independent global pool. Tolerates a partial payload (used
        by the Playground录入 flow, which calls this directly rather than
        through a request model). Recognized payload keys: name,
        description, image_url, persona (characters)."""
        from .models import Character, Scene, Prop, AssetUnit, ImageVariant
        with self._save_lock:
            payload = dict(payload or {})
            name = payload.get("name") or "未命名"
            description = payload.get("description") or ""
            image_url = payload.get("image_url")
            if asset_type == "character":
                ref_sheet = AssetUnit()
                if image_url:
                    variant = ImageVariant(id=f"img_{uuid.uuid4().hex[:12]}", url=image_url)
                    ref_sheet.image_variants.append(variant)
                    ref_sheet.selected_image_id = variant.id
                asset = Character(
                    id=f"char_{uuid.uuid4().hex[:12]}",
                    name=name,
                    description=description,
                    persona=payload.get("persona") or "",
                    reference_sheet=ref_sheet,
                )
            elif asset_type == "scene":
                asset = Scene(
                    id=f"scene_{uuid.uuid4().hex[:12]}",
                    name=name,
                    description=description,
                    image_url=image_url,
                )
            elif asset_type == "prop":
                asset = Prop(
                    id=f"prop_{uuid.uuid4().hex[:12]}",
                    name=name,
                    description=description,
                    image_url=image_url,
                )
            else:
                raise ValueError(f"Invalid asset type: {asset_type}")
            self._library_list_for_type(asset_type).append(asset)
            self._save_library_data_unlocked()
            return asset

    def update_library_asset(self, asset_type: str, asset_id: str, patch: Dict[str, Any]):
        """Patch attributes of a global library asset and persist. Mirrors
        update_series_asset_attributes — only sets keys that exist on the
        asset, and never touches id/status (use create/delete to manage
        those)."""
        with self._save_lock:
            asset = self._find_library_asset(asset_type, asset_id)
            for key, value in (patch or {}).items():
                if hasattr(asset, key) and key not in ("id", "status"):
                    setattr(asset, key, value)
            self._save_library_data_unlocked()
            return asset

    def _scan_library_asset_references(self, asset_type: str, asset_id: str) -> List[Dict[str, Any]]:
        """Find every storyboard frame (across all projects and series) that
        references the given asset id through the type-appropriate field:
        scene -> frame.scene_id, character -> frame.character_ids,
        prop -> frame.prop_ids. Returns a list of referrer descriptors
        (empty when nothing references it). Used by delete_library_asset for
        design Q2 reference integrity.

        Note: Series currently hold no frames of their own (their frames live
        in episode Scripts, which are in self.scripts), so the series loop is
        a defensive no-op today via getattr — kept so the scan stays correct
        if Series ever gains a frames list."""
        references: List[Dict[str, Any]] = []

        def _frame_hits(frame) -> bool:
            if asset_type == "scene":
                return getattr(frame, "scene_id", None) == asset_id
            if asset_type == "character":
                return asset_id in (getattr(frame, "character_ids", None) or [])
            if asset_type == "prop":
                return asset_id in (getattr(frame, "prop_ids", None) or [])
            return False

        def _scan(owner_kind: str, owner_id: str, owner, frames) -> None:
            for frame in frames or []:
                if _frame_hits(frame):
                    references.append({
                        "owner_kind": owner_kind,
                        "owner_id": owner_id,
                        "owner_title": getattr(owner, "title", None),
                        "frame_id": getattr(frame, "id", None),
                    })

        for sid, script in (getattr(self, "scripts", {}) or {}).items():
            _scan("project", sid, script, getattr(script, "frames", None))
        for sid, series in (getattr(self, "series_store", {}) or {}).items():
            _scan("series", sid, series, getattr(series, "frames", None))
        return references

    def delete_library_asset(self, asset_type: str, asset_id: str, force: bool = False) -> None:
        """Hard-delete a global library asset.

        Design Q2 (reference integrity): unless ``force`` is True, scan all
        project/series storyboard frames first; if any still reference this
        asset (scene_id / character_ids / prop_ids) the delete is refused via
        ``LibraryAssetInUseError`` (API maps to HTTP 409 and lists referrers).
        With ``force=True`` the asset is removed anyway, leaving those frame
        references dangling (the asset resolver simply drops the unknown id).

        Raises ValueError when the asset (or asset type) is absent — this is
        checked BEFORE the reference scan so a missing id still maps to 404."""
        with self._save_lock:
            target_list = self._library_list_for_type(asset_type)
            if not any(a.id == asset_id for a in target_list):
                raise ValueError(f"Asset {asset_id} of type {asset_type} not found in library")
            if not force:
                refs = self._scan_library_asset_references(asset_type, asset_id)
                if refs:
                    raise LibraryAssetInUseError(asset_type, asset_id, refs)
            kept = [a for a in target_list if a.id != asset_id]
            if asset_type == "character":
                self.library_store.characters = kept
            elif asset_type == "scene":
                self.library_store.scenes = kept
            else:  # prop
                self.library_store.props = kept
            self._save_library_data_unlocked()

    def promote_asset_to_library(self, source_kind: str, source_id: str, asset_type: str, asset_id: str):
        """Move an asset from a Project (episode) or Series into the global
        library, persist, and return the promoted asset.

        **Move, not copy, and the id is preserved.** Both properties matter:
        the three-layer merge dedupes by id, so a promoted copy that kept the
        original around (or that arrived with a fresh uuid) would show up as a
        second, same-named card in every project of that series. Keeping the id
        also means every existing frame reference keeps resolving — the
        resolver just falls through to the global layer.

        Promoted assets are shared, so later edits affect every project that
        sees them; use ``fork_library_asset_to_project`` to break that link.
        `source_kind` ∈ {"project", "series"}."""
        import copy
        if asset_type not in ("character", "scene", "prop"):
            raise ValueError(f"Invalid asset type: {asset_type}")
        with self._save_lock:
            if source_kind == "series":
                container = self.series_store.get(source_id)
                if not container:
                    raise ValueError("Source series not found")
            elif source_kind == "project":
                container = self.scripts.get(source_id)
                if not container:
                    raise ValueError("Source project not found")
            else:
                raise ValueError(f"Invalid source kind: {source_kind}")

            if asset_type == "character":
                src_list = container.characters
            elif asset_type == "scene":
                src_list = container.scenes
            else:  # prop
                src_list = container.props
            source_asset = next((a for a in src_list if a.id == asset_id), None)
            if source_asset is None:
                raise ValueError(
                    f"Asset {asset_id} of type {asset_type} not found in {source_kind} {source_id}"
                )
            if any(a.id == asset_id for a in self._library_list_for_type(asset_type)):
                raise ValueError(
                    f"Asset {asset_id} of type {asset_type} is already in the global library"
                )

            kept = [a for a in src_list if a.id != asset_id]
            if asset_type == "character":
                container.characters = kept
            elif asset_type == "scene":
                container.scenes = kept
            else:  # prop
                container.props = kept

            promoted = copy.deepcopy(source_asset)
            self._library_list_for_type(asset_type).append(promoted)
            self._save_library_data_unlocked()
            if source_kind == "series":
                self._save_series_data_unlocked()
            else:
                self._save_data()
            return promoted

    def fork_library_asset_to_project(self, script_id: str, asset_type: str, library_asset_id: str):
        """Deep-copy a *shared* asset (series pool or global library) into a
        project's local asset list with a fresh id, persist the project, and
        return the new (now project-owned) asset.

        This is the inverse direction of promote_asset_to_library and the
        "按需 fork" of design Q3: under D1 活引用 semantics a project references
        shared assets live; forking materializes an independent, editable local
        copy so subsequent edits no longer touch the shared original. That is
        exactly what "取消关联（在本集独立一份）" needs after a link. The source
        asset is left intact (additive).

        查找顺序 系列池 → 全局库，与 `_find_asset_with_source` 一致。
        Raises ValueError when the project, asset type, or source asset is
        absent. ``asset_type`` ∈ {"character", "scene", "prop"}."""
        import copy
        field = self._ASSET_FIELD_BY_TYPE.get(asset_type)
        if not field:
            raise ValueError(f"Invalid asset type: {asset_type}")
        with self._save_lock:
            script = self.scripts.get(script_id)
            if not script:
                raise ValueError(f"Project not found: {script_id}")
            source_asset = None
            if script.series_id:
                series = self.series_store.get(script.series_id)
                if series:
                    source_asset = next(
                        (a for a in getattr(series, field) if a.id == library_asset_id), None
                    )
            if source_asset is None:
                # 系列池没有就回落全局库；_find_library_asset 缺失时抛 ValueError。
                source_asset = self._find_library_asset(asset_type, library_asset_id)
            new_asset = copy.deepcopy(source_asset)
            prefix = {"character": "char", "scene": "scene", "prop": "prop"}[asset_type]
            new_asset.id = f"{prefix}_{uuid.uuid4().hex[:12]}"
            getattr(script, field).append(new_asset)
            script.updated_at = time.time()
            self._save_data()
            return new_asset

    def create_series(self, title: str, description: str = "", workflow_mode: str = "i2v_legacy", content_mode: str = "scripted", default_generation_mode: str = "r2v") -> Series:
        """Create a new Series."""
        with self._save_lock:
            series = Series(
                id=str(uuid.uuid4()),
                title=title,
                description=description,
                workflow_mode=workflow_mode,
                content_mode=content_mode,
                default_generation_mode=default_generation_mode,
                created_at=time.time(),
                updated_at=time.time(),
            )
            self.series_store[series.id] = series
            self._save_series_data_unlocked()
            return series

    def get_series(self, series_id: str) -> Optional[Series]:
        return self.series_store.get(series_id)

    def list_series(self) -> List[Series]:
        return list(self.series_store.values())

    def update_series(self, series_id: str, updates: Dict[str, Any]) -> Series:
        """Update Series fields (title, description, etc.)."""
        with self._save_lock:
            series = self.series_store.get(series_id)
            if not series:
                raise ValueError("Series not found")
            for key, value in updates.items():
                if hasattr(series, key) and key not in ("id", "created_at", "episode_ids"):
                    if key == "art_direction" and isinstance(value, dict):
                        value = ArtDirection(**value)
                    setattr(series, key, value)
            series.updated_at = time.time()
            self.series_store[series_id] = series
            self._save_series_data_unlocked()
            return series

    def delete_series(self, series_id: str) -> None:
        """Delete a Series and disassociate its episodes."""
        with self._save_lock:
            series = self.series_store.get(series_id)
            if not series:
                raise ValueError("Series not found")
            # Disassociate episodes
            for ep_id in series.episode_ids:
                script = self.scripts.get(ep_id)
                if script:
                    script.series_id = None
                    script.episode_number = None
            self._save_data()
            del self.series_store[series_id]
            self._save_series_data_unlocked()

    def add_episode_to_series(self, series_id: str, script_id: str, episode_number: Optional[int] = None) -> Series:
        """Add an existing Script/Project as an Episode to a Series."""
        with self._save_lock:
            series = self.series_store.get(series_id)
            if not series:
                raise ValueError("Series not found")
            script = self.scripts.get(script_id)
            if not script:
                raise ValueError("Script not found")
            # If script already belongs to another series, remove it from the old one
            if script.series_id and script.series_id != series_id:
                old_series = self.series_store.get(script.series_id)
                if old_series and script_id in old_series.episode_ids:
                    old_series.episode_ids.remove(script_id)
            if script_id not in series.episode_ids:
                series.episode_ids.append(script_id)
            script.series_id = series_id
            script.episode_number = episode_number or len(series.episode_ids)
            series.updated_at = time.time()
            self._save_data()
            self._save_series_data_unlocked()
            return series

    def remove_episode_from_series(self, series_id: str, script_id: str) -> Series:
        """Remove an Episode from a Series (does not delete the project)."""
        with self._save_lock:
            series = self.series_store.get(series_id)
            if not series:
                raise ValueError("Series not found")
            if script_id in series.episode_ids:
                series.episode_ids.remove(script_id)
            script = self.scripts.get(script_id)
            if script:
                script.series_id = None
                script.episode_number = None
            series.updated_at = time.time()
            self._save_data()
            self._save_series_data_unlocked()
            return series

    # ------------------------------------------------------------------
    # 角色工作台的「声音面」—— 生图面的镜像
    #
    # 工作台有两面：生图、生声。三列职责一一对应 ——
    #   主参考音 ↔ 主参考图 · 声音描述 ↔ 描述 · 音色提示词 ↔ 生图提示词
    # 所以这里的方法也照生图那套的形状写：左列是实物，中列是人改的那层，
    # 右列由中列生成、并记下自己基于哪一版描述。
    # ------------------------------------------------------------------

    #: 参考音的**存储引用前缀**（存进角色身上的那种 URL 式相对路径）。
    #:
    #: 它是个 URL，不是磁盘路径 —— 磁盘上它在 `output/` 下面（静态挂载 `/files` 的根
    #: 就是 `output/`），跟上传接口同一套约定（写 `output/uploads/x`、存 `uploads/x`）。
    #: 历史上这里被当成磁盘路径用过，于是文件落在数据目录根下、前端取的时候永远 404。
    REFERENCE_AUDIO_DIR = "uploads/reference_audio"

    # 默认试听词。带上角色名，人一听就知道这段是谁的；用户可以改。
    REFERENCE_AUDIO_TEXT = "我是{name}。这段话是用来做声音参考的试听。"

    _VOICE_DESCRIPTION_SYSTEM_PROMPT = (
        "你是一个声音指导，擅长从人物设定里听出这个人该怎么说话。"
        "输出要求："
        "1. 先读形象（体型、年龄、性别、气质），再定声音 —— 身材魁梧就该中气十足、"
        "胸腔共鸣厚；矮小年轻就该轻、薄、还没过变声期。声音跟长相不能打架。"
        "2. 按九维逐项写：年龄感、音高、明暗、厚薄、共鸣、气息、颗粒感、口音、稳定表达习惯。"
        "3. 每一维一句可执行的听觉描述，维度之间音色逻辑要自洽。"
        "4. 不要外貌、不要剧情、不要服装，不要标题、分点或引号。"
        "5. 用 100-300 字中文，单段。这段会直接喂给音色设计接口，超长会被截断。"
    )

    def _character_art_prompt(self, character: Character) -> str:
        """这个角色的**生图提示词** —— 形象的事实源。

        声音得跟长相搭（用户 2026-09-17 提的：定好形象之后，魁梧的人一看就该中气
        十足）。取「真用过的那一条」最准：先看已选中的那张参考图是用什么提示词生成
        的，再退到 `reference_sheet.image_prompt`，最后才翻三张 legacy 资产的 prompt。
        """
        sheet = getattr(character, "reference_sheet", None)
        if sheet is not None:
            selected = getattr(sheet, "selected_image_id", None)
            for variant in getattr(sheet, "image_variants", None) or []:
                used = (getattr(variant, "prompt_used", None) or "").strip()
                if selected and variant.id == selected and used:
                    return used
            prompt = (getattr(sheet, "image_prompt", None) or "").strip()
            if prompt:
                return prompt
        for field in ("full_body_prompt", "three_view_prompt", "headshot_prompt"):
            prompt = (getattr(character, field, None) or "").strip()
            if prompt:
                return prompt
        return ""

    def _voice_description_system_prompt(self, script: Script) -> str:
        """中列的 persona：绑了「音色提示词 Skill」就跟它走，没绑用内置声音指导。

        中列与右列共用 `voice_prompt` 一个槽位（用户 2026-09-17 拍板）：那类 Skill
        本来就是照「从角色资料设计音色」写的，中列是它的第一步，两列用同一个人设
        才不会出现「描述按 A 写、提示词按 B 生成」。

        **只用用户/Skill 真正提供的那一层**：内置默认 `DEFAULT_VOICE_PROMPT` 是写给
        右列方向的（「描述 → 提示词」），串到中列会让模型去做下一列的事。
        """
        series = self.series_store.get(script.series_id) if script.series_id else None
        return (
            self._resolve_stage_override("voice_prompt", script, series)
            or self._VOICE_DESCRIPTION_SYSTEM_PROMPT
        )

    #: 成品提示词的段标题。程序按它把「九维档案」拆出来写回中列，所以这是硬约定
    #: （给用户的 Skill 也靠这两个标题，见 llm.VOICE_PROMPT_OUTPUT_CONTRACT）。
    VOICE_ARCHIVE_HEADING = "### 九维声音档案"
    VOICE_ARTIFACT_HEADING = "### 可直接使用的提示词"

    def _voice_artifact_system_prompt(self, script: Script) -> str:
        """右列的 persona：绑了 Skill 跟它走，没绑用两段式的内置默认。

        跟中列不共用那个默认：`DEFAULT_VOICE_PROMPT` 是给音色设计弹窗的
        （产出单段、直接当 voice_prompt 用），而右列要的是「九维 + 台词」的成品。

        绑了 Skill 时补上硬契约：两段式标题是**程序**拆分的依据，九维那段的字数上限
        是写回中列时的截断长度 —— Skill 可以换人格，不能把这些盖掉。
        （内置默认里已经逐条写了，所以只在被覆盖时追加，否则重复一遍。）
        """
        from .llm import DEFAULT_VOICE_ARTIFACT_PROMPT, VOICE_PROMPT_OUTPUT_CONTRACT

        series = self.series_store.get(script.series_id) if script.series_id else None
        override = self._resolve_stage_override("voice_prompt", script, series)
        if override:
            return override + VOICE_PROMPT_OUTPUT_CONTRACT
        return DEFAULT_VOICE_ARTIFACT_PROMPT

    def _split_voice_artifact(self, text: str) -> Tuple[str, str]:
        """把两段式成品拆成 ``(九维档案, 成品)``。

        模型没照格式写就整段当成品、档案留空 —— 宁可中列空着，也不能把整段
        一两千字塞进中列：中列是给人看、给下一次微调看的（存的时候 [:600]）。
        遇到不认识的 `### 标题` 就停止收集：用户的 Skill 模板里有
        `### 参考录音绑定` 夹在两段之间，那是给人看的，不该进档案。
        """
        archive: List[str] = []
        artifact: List[str] = []
        bucket: Optional[List[str]] = None
        for line in text.splitlines():
            stripped = line.strip()
            if stripped.startswith("### "):
                if stripped.startswith(self.VOICE_ARCHIVE_HEADING):
                    bucket = archive
                elif stripped.startswith(self.VOICE_ARTIFACT_HEADING):
                    bucket = artifact
                else:
                    bucket = None
                continue
            if bucket is not None:
                bucket.append(line)
        if not artifact:
            return "", text
        return "\n".join(archive).strip(), "\n".join(artifact).strip()

    def _character_script_lines(
        self, script: Script, character_id: str, name: str, limit: int = 2
    ) -> List[str]:
        """这个角色在本集剧本里说过的台词（最多 ``limit`` 句）。

        右列要拿真台词当「配音内容」—— 参考音听起来才是这个角色在剧里说话。
        先走分镜（台词带说话人，最准）；还没生成分镜就回剧本原文里按
        `角色名（情绪）：台词` 那样挑。ponytail: 原文那条是朴素启发式，
        只认行首名字 + 全角冒号；分镜生成后就走上面那条准确路径了。
        """
        lines: List[str] = []
        for frame in script.frames or []:
            structured = getattr(frame, "dialogue_structured", None)
            text = ((getattr(structured, "line", None) if structured else None) or frame.dialogue or "").strip()
            if not text:
                continue
            speaker = (getattr(frame, "speaker", None) or (getattr(structured, "speaker", None) if structured else None) or "").strip()
            by_id = bool(frame.character_ids) and frame.character_ids[0] == character_id
            by_name = bool(speaker) and bool(name) and speaker == name.strip()
            if by_id or by_name:
                lines.append(text)
                if len(lines) >= limit:
                    return lines
        if lines:
            return lines
        for raw in (script.original_text or "").splitlines():
            stripped = raw.strip().lstrip("△ ")
            if not name or not stripped.startswith(name):
                continue
            _, sep, tail = stripped.partition("：")
            if sep and tail.strip():
                lines.append(tail.strip())
                if len(lines) >= limit:
                    break
        return lines

    def _character_or_raise(self, script: Script, character_id: str) -> Tuple[Character, str]:
        """按三层池子找角色，并把「它住在哪一层」一并交出来。

        角色不一定在本集：同名提取 / 手动关联之后，本集那份副本会被合并掉，
        只留系列池（或全局库）里那一条。以前只扫 `script.characters`，于是
        前端列表里明明看得见（它走三层合并），一点「AI 提取」就整列报
        「角色不存在」。

        返回 source 是因为改完必须落回**持有它的那一层**：角色在系列池却按
        `_save_data()` 写 projects.json 的话，改动直接消失，而且不报错。
        """
        character, source = self._find_asset_with_source(script, character_id, "character")
        if character is None or source is None:
            raise ValueError(f"角色不存在：{character_id}")
        return character, source  # type: ignore[return-value]

    def generate_voice_description(self, script_id: str, character_id: str) -> Character:
        """中列：把角色设定提炼成一段人话的「声音描述」。

        这是给人改的那一层 —— 之后右列的提示词由它生成。空回复直接报错，
        不能存成空字符串让右列拿空描述去生成提示词。
        """
        script = self.get_script(script_id)
        if not script:
            raise ValueError("Script not found")
        character, character_source = self._character_or_raise(script, character_id)

        from .llm_adapter import LLMAdapter

        adapter = LLMAdapter()
        if not adapter.is_configured:
            raise RuntimeError(NOT_CONFIGURED_MESSAGE)

        source_text = (character.description or character.extracted_description or "").strip()
        if not source_text:
            raise ValueError(f"「{character.name}」还没有角色描述，先写点东西再来提取声音")

        text = adapter.chat(
            messages=[
                {"role": "system", "content": self._voice_description_system_prompt(script)},
                {"role": "user", "content": f"角色设定：\n{source_text[:1200]}\n\n请输出这个角色的声音描述。"},
            ],
        )
        cleaned = (text or "").strip()
        if not cleaned:
            raise RuntimeError("声音描述生成失败：模型返回了空内容")

        character.voice_description = cleaned[:600]
        character.voice_description_source = "ai"
        character.voice_description_version += 1
        character.voice_description_updated_at = time.time()
        script.updated_at = time.time()
        self._save_after_asset_mutation(character_source)
        return character

    def rewrite_voice_description(
        self, script_id: str, character_id: str, instruction: str, description: Optional[str] = None
    ) -> Character:
        """「AI 修改」：按一句要求把「声音描述」改一遍。

        生图面描述那一列早就有这个动作（`rewrite_asset_description`）。这里**不
        复用那个方法** —— 它的 persona 是「影视资产描述编辑器」，默认指令是「优
        化为清晰、可视化、适合资产制作的描述」，会把模型往描述外貌上带。声音面
        用自己已经调好的 `_VOICE_DESCRIPTION_SYSTEM_PROMPT`，也就完全不碰生图那
        条已经在跑的链。

        改出来的算 AI 来源（不是手工），并且进版本 —— 右列的提示词据此变过期，
        跟手改一个待遇。
        """
        script = self.get_script(script_id)
        if not script:
            raise ValueError("Script not found")
        character, character_source = self._character_or_raise(script, character_id)

        current = (description if description is not None else character.voice_description or "").strip()
        if not current:
            raise ValueError(f"「{character.name}」还没有声音描述，先生成或写一段再来修改")

        from .llm_adapter import LLMAdapter

        adapter = LLMAdapter()
        if not adapter.is_configured:
            raise RuntimeError(NOT_CONFIGURED_MESSAGE)

        ask = (instruction or "").strip() or "改得更具体、更能指导音色设计"
        text = adapter.chat(
            messages=[
                {"role": "system", "content": self._voice_description_system_prompt(script)},
                {"role": "user", "content": (
                    f"当前声音描述：\n{current[:1200]}\n\n"
                    f"修改要求：{ask}\n\n"
                    "请输出修改后的声音描述，保持同样的篇幅与体例。"
                )},
            ],
        )
        cleaned = (text or "").strip()
        if not cleaned:
            raise ValueError("声音描述修改失败：模型返回了空内容")

        character.voice_description = cleaned[:600]
        character.voice_description_source = "ai"
        character.voice_description_version += 1
        character.voice_description_updated_at = time.time()
        script.updated_at = time.time()
        self._save_after_asset_mutation(character_source)
        return character

    def generate_voice_prompt(self, script_id: str, character_id: str) -> Character:
        """右列：把「角色资料 + 中列档案 + 本集台词」定成一段可直接用的音色提示词。

        产出是**两段式**成品（九维档案 + 可直接使用的提示词），因为用户要的是
        「拿去任何一个声音模型都能用」的一段话：既有九维维度，也有这个角色在
        剧本里的真台词。程序把九维那段拆回中列 —— 中列是喂 `create_voice` 的
        那一层（≤ 500），也是「AI 修改」能改的那一层。

        中列可以为空：产品入口就是这一下（用户 2026-09-17 拍板去掉「AI 提取」，
        直接点「生成提示词」）。
        """
        script = self.get_script(script_id)
        if not script:
            raise ValueError("Script not found")
        character, character_source = self._character_or_raise(script, character_id)

        sections = [f"角色名：{character.name}"]
        profile = (character.description or character.extracted_description or "").strip()
        if profile:
            sections.append(f"角色资料：\n{profile[:1000]}")
        # 形象单独成段：声音要跟它搭。体型/年龄/气质是判断音色的第一依据，
        # 而生图提示词是把形象定下来的那句话（描述里可能没写全）。
        visual = []
        if getattr(character, "age", None):
            visual.append(f"年龄：{character.age}")
        if getattr(character, "gender", None):
            visual.append(f"性别：{character.gender}")
        if getattr(character, "clothing", None):
            visual.append(f"服装与身份：{character.clothing}")
        art_prompt = self._character_art_prompt(character)
        if art_prompt:
            visual.append(f"生图提示词（这个角色的形象就是这么定下来的）：\n{art_prompt[:800]}")
        if visual:
            sections.append("形象（声音要跟它搭得上）：\n" + "\n".join(visual))
        lines = self._character_script_lines(script, character_id, character.name)
        if lines:
            sections.append("本集剧本里这个角色的台词：\n" + "\n".join(f"「{line}」" for line in lines))
        elif (script.original_text or "").strip():
            sections.append("剧本节选（自行找出这个角色的台词）：\n" + script.original_text.strip()[:1500])
        description = (character.voice_description or "").strip()
        if description:
            sections.append(f"已定的九维声音档案（沿用，可细化）：\n{description[:600]}")
        sections.append("请输出这个角色的音色提示词。")

        from .llm_adapter import LLMAdapter

        adapter = LLMAdapter()
        if not adapter.is_configured:
            raise RuntimeError(NOT_CONFIGURED_MESSAGE)
        text = adapter.chat(
            messages=[
                {"role": "system", "content": self._voice_artifact_system_prompt(script)},
                {"role": "user", "content": "\n\n".join(sections)},
            ],
        )
        artifact = (text or "").strip()
        if not artifact:
            raise RuntimeError("音色提示词生成失败：模型返回了空内容")

        archive, artifact = self._split_voice_artifact(artifact)
        if archive:
            character.voice_description = archive[:600]
            character.voice_description_source = "ai"
            character.voice_description_version += 1
            character.voice_description_updated_at = time.time()
        # 成品不过 500：它是给人看、拿去任何模型用的；真正喂 create_voice 的是
        # 中列那段九维档案。只挡一个防跑飞的硬上限。
        character.voice_prompt = artifact[:VOICE_PROMPT_ARTIFACT_MAX_CHARS]
        character.voice_prompt_source = "ai"
        character.voice_prompt_description_version = character.voice_description_version
        script.updated_at = time.time()
        self._save_after_asset_mutation(character_source)
        return character

    def generate_reference_audio(
        self, script_id: str, character_id: str, text: Optional[str] = None
    ) -> Character:
        """左列：让声音模型按右列的提示词产出一个声音，试听那段就是参考音。

        产品里只有 seed-audio-1.0 一个音频通道，它直接参考生音频：这里产出的是
        「按提示词生成的声音」，不是某个已绑音色的朗读样本（用户 2026-09-17 拍板）。
        每次点都出新的一版、攒进候选条对比 —— 跟生图面一个逻辑。
        """
        script = self.get_script(script_id)
        if not script:
            raise ValueError("Script not found")
        character, character_source = self._character_or_raise(script, character_id)

        prompt = self._reference_audio_prompt(character, text)
        # 每次一个文件名 —— 固定成 {char_id}.mp3 的话，生成第二版就把第一版覆盖掉了，
        # 候选条会全部指向同一个文件、旧版音频直接没了。
        #
        # 存两份写法：`stored_url` 是存进角色身上的引用（前端拼 `/files/<它>`），
        # `output_path` 是磁盘上的位置 —— 两者差一个 `output/` 前缀，不能混。
        filename = f"{character_id}_{uuid.uuid4().hex[:8]}.mp3"
        stored_url = media_ref(self.REFERENCE_AUDIO_DIR, filename)
        output_path = media_ref("output", stored_url)
        os.makedirs(os.path.dirname(output_path), exist_ok=True)

        from ...models.jiucaihezi import generate_audio

        try:
            generate_audio(prompt=prompt, output_path=output_path)
        except Exception as exc:
            raise RuntimeError(f"参考音生成失败：{exc}") from exc

        # 每生成一版就多一条候选 —— 跟生图面一个逻辑：改一版提示词、再生一版，
        # 攒几条之后回头看哪条好。不覆盖上一版。
        self._add_reference_variant(character, stored_url, origin="seed-audio-1.0")
        script.updated_at = time.time()
        self._save_after_asset_mutation(character_source)
        logger.info("[voice-face] reference take for %s → %s", character_id, stored_url)
        return character

    def _reference_audio_prompt(self, character: Character, text: Optional[str] = None) -> str:
        """喂给音频模型的那段话。

        右列的成品（九维 + `配音内容：“台词”`）就是模型要的东西，直接用；
        只有中列档案时补一句要念的台词。
        """
        archive = (character.voice_description or "").strip()
        artifact = (character.voice_prompt or "").strip()
        if not archive and not artifact:
            raise ValueError(
                f"「{character.name}」还没有音色提示词：先点右列的「生成提示词」"
            )
        spoken = (text or "").strip()
        if not spoken:
            return (artifact or (
                f"{archive}\n配音内容：“{self.REFERENCE_AUDIO_TEXT.format(name=character.name)}”"
            ))[:AUDIO_MAX_INPUT_CHARS]
        return f"{archive or artifact}\n配音内容：“{spoken}”"[:AUDIO_MAX_INPUT_CHARS]

    # 参考音只认这些扩展名。客户端已经用 accept="audio/*" 挡了一道，这里再挡一道：
    # 传上来一个 .jpg 的话，要到真正生成音频时才炸，而且炸在网关上、报错看不懂。
    REFERENCE_AUDIO_EXTS = (".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".webm")

    def update_voice_fields(
        self,
        script_id: str,
        character_id: str,
        voice_description: Optional[str] = None,
        voice_prompt: Optional[str] = None,
        reference_audio_url: Optional[str] = None,
    ) -> Character:
        """手改声音面：两个文本框 + 把一段现成的音频收进候选并设为主音。

        改「声音描述」要进版本 —— 右列的提示词据此变「过期」。改提示词则是手工
        覆盖，它对当前这一版描述就是新鲜的。换参考音不影响描述的版本。
        """
        script = self.get_script(script_id)
        if not script:
            raise ValueError("Script not found")
        character, character_source = self._character_or_raise(script, character_id)

        if voice_description is not None and voice_description.strip() != (character.voice_description or ""):
            character.voice_description = voice_description.strip()
            character.voice_description_source = "manual"
            character.voice_description_version += 1
            character.voice_description_updated_at = time.time()

        if voice_prompt is not None and voice_prompt.strip() != (character.voice_prompt or ""):
            character.voice_prompt = voice_prompt.strip()
            character.voice_prompt_source = "manual"
            character.voice_prompt_description_version = character.voice_description_version

        if reference_audio_url is not None:
            candidate = reference_audio_url.strip()
            self._assert_audio_reference(candidate, character.name)
            self._add_reference_variant(character, candidate, origin="upload")

        script.updated_at = time.time()
        self._save_after_asset_mutation(character_source)
        return character

    # ── 参考音的候选条 ─────────────────────────────────────────────
    #
    # 跟生图面的候选条是同一个逻辑：每生成一版、每上传一段都留档，攒几条之后回头
    # 看哪条好，把那条设为主音。所以这里只管「追加 / 选中 / 删掉 / 剪枝」四件事。

    def _add_reference_variant(
        self, character: Character, url: str, origin: Optional[str] = None
    ) -> ReferenceAudioVariant:
        """追加一条候选并设为主音。同一个 url 已经收过就不重复收，直接选中它。"""
        existing = next((v for v in character.reference_audio_variants if v.url == url), None)
        if existing is None:
            existing = ReferenceAudioVariant(
                id=f"refaudio_{uuid.uuid4().hex[:8]}", url=url, origin=origin,
            )
            character.reference_audio_variants.append(existing)
            self._prune_reference_variants(character)
        character.reference_audio_selected_id = existing.id
        character.reference_audio_url = existing.url
        return existing

    def _prune_reference_variants(self, character: Character) -> None:
        """超出上限就丢最旧的，**永远不丢当前选中的那条**。

        跟生图面共用 MAX_VARIANTS_PER_ASSET，不要各写各的上限。
        """
        variants = character.reference_audio_variants
        if len(variants) <= MAX_VARIANTS_PER_ASSET:
            return
        keep = sorted(
            variants,
            key=lambda v: (v.id == character.reference_audio_selected_id, v.created_at),
            reverse=True,
        )[:MAX_VARIANTS_PER_ASSET]
        keep_ids = {v.id for v in keep}
        character.reference_audio_variants = [v for v in variants if v.id in keep_ids]

    def select_reference_audio_variant(
        self, script_id: str, character_id: str, variant_id: str
    ) -> Character:
        """把某一版设为主音。"""
        script = self.get_script(script_id)
        if not script:
            raise ValueError("Script not found")
        character, character_source = self._character_or_raise(script, character_id)

        variant = next((v for v in character.reference_audio_variants if v.id == variant_id), None)
        if variant is None:
            raise ValueError(f"这一版参考音不存在：{variant_id}")

        character.reference_audio_selected_id = variant.id
        character.reference_audio_url = variant.url
        script.updated_at = time.time()
        self._save_after_asset_mutation(character_source)
        return character

    def delete_reference_audio_variant(
        self, script_id: str, character_id: str, variant_id: str
    ) -> Character:
        """删掉某一版候选。删的正好是主音时，回落到最新的一版；一条都不剩就清空。

        只摘指针，**不删磁盘上的文件**：那可能是某个克隆音色的源音频，别的角色或
        音色还在引用。宁可留个孤儿文件，也不要删掉别人还在用的东西。
        """
        script = self.get_script(script_id)
        if not script:
            raise ValueError("Script not found")
        character, character_source = self._character_or_raise(script, character_id)

        remaining = [v for v in character.reference_audio_variants if v.id != variant_id]
        if len(remaining) == len(character.reference_audio_variants):
            raise ValueError(f"这一版参考音不存在：{variant_id}")
        character.reference_audio_variants = remaining

        if character.reference_audio_selected_id == variant_id:
            newest = max(remaining, key=lambda v: v.created_at) if remaining else None
            character.reference_audio_selected_id = newest.id if newest else None
            character.reference_audio_url = newest.url if newest else None

        script.updated_at = time.time()
        self._save_after_asset_mutation(character_source)
        return character

    def _assert_audio_reference(self, url: str, character_name: str) -> None:
        """上传的参考音必须真是一个音频文件（或至少长得像）。

        只看 URL 的路径部分（OSS 链接后面可能挂 query），而且**没有扩展名就放行**
        —— 认不出来不等于错，不要把合法的没后缀链接挡在外面。
        """
        path = urlparse(url).path if url.startswith(("http://", "https://")) else url
        ext = os.path.splitext(path)[1].lower()
        if ext and ext not in self.REFERENCE_AUDIO_EXTS:
            raise ValueError(
                f"「{character_name}」的参考音必须是音频文件（{ext} 不行），"
                f"支持：{'、'.join(self.REFERENCE_AUDIO_EXTS)}"
            )

    # ------------------------------------------------------------------
    # 声音设计（可选步骤）：全局声音导演稿 + 全集声音
    #
    # 这一步的产出纯粹给人听 —— 「哪几个分镜一组」由人听完自己判断，程序不参与。
    # 所以这里没有分段、没有帧关联，只有一份导演稿和若干版音频。
    # ------------------------------------------------------------------

    def _audio_plan_of(self, script: Script) -> EpisodeAudioPlan:
        """取（必要时初始化）本集的声音设计。整块是可选字段，读到 None 就建一个。"""
        if script.audio_plan is None:
            script.audio_plan = EpisodeAudioPlan()
        return script.audio_plan

    @staticmethod
    def _voice_script_hash(text: str) -> str:
        return hashlib.md5((text or "").encode("utf-8")).hexdigest()

    def generate_audio_plan_script(self, script_id: str) -> EpisodeAudioPlan:
        """生成全局声音导演稿（LLM）。

        导演稿是「这一集的声音怎么演」的文字稿：谁在什么时候说什么、什么情绪、
        要不要环境声。它同时是后面生成全集声音时喂给模型的正文，所以长度要压在
        seed-audio-1.0 的输入上限（3000 字符）以内。
        """
        script = self.get_script(script_id)
        if not script:
            raise ValueError("Script not found")

        from .llm_adapter import LLMAdapter

        adapter = LLMAdapter()
        if not adapter.is_configured:
            raise RuntimeError(NOT_CONFIGURED_MESSAGE)

        cast_lines = []
        for character in script.characters:
            voice = "已有参考音" if character.reference_audio_url else "还没有参考音"
            cast_lines.append(f"- {character.name}（{voice}）：{character.description}")
        cast_block = "\n".join(cast_lines) or "（暂无角色）"

        # 走 prompt 阶段解析：项目/剧集绑定的 Skill 优先，其次自定义文本，最后内置默认。
        # 默认那段里的长度、【】标记等硬限制由 get_effective_prompt 负责兜住。
        series = self.series_store.get(script.series_id) if script.series_id else None
        system_prompt = self.get_effective_prompt("audio_plan", script, series)
        user_prompt = (
            f"【角色与参考音】\n{cast_block}\n\n"
            f"【剧本】\n{(script.original_text or '')[:8000]}"
        )

        text = adapter.chat(messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ])
        text = (text or "").strip()
        if not text:
            raise RuntimeError("声音导演稿生成失败：模型返回了空内容")

        plan = self._audio_plan_of(script)
        plan.script_text = text
        plan.script_hash = self._voice_script_hash(text)
        script.updated_at = time.time()
        self._save_data()
        logger.info("[voice-script] generated %d chars for script=%s", len(text), script_id)
        return plan

    # --- 异步提交 ---------------------------------------------------------
    #
    # 三个动作（生成导演稿 / 带参考音出一版 / 不带参考音出一版）都走同一套：
    # 提交即返回，状态落在 script.audio_plan 的字段上，前端轮询 getProject。
    # 形状照抄资产那套 `create_prompt_generation_task` / `process_prompt_generation_task`。
    #
    # 两个必须遵守的点：
    #   1. 状态一定要落在**会被持久化**的字段上 —— FastAPI 的 BackgroundTasks 只活在
    #      进程内存里，重启后内存任务表就没了，前端只能看到永远转不完的圈。重启时由
    #      `_recover_orphan_tasks` 把这些残留标成 failed。
    #   2. 参数错误（参考音没绑、导演稿是空的）要在**提交时**就抛。丢给后台等于让用户
    #      切走之后再失败，他回来只看到一条红字，不知道是自己勾错了。

    #: 任务表上限，超了就丢最早结束的那些（只是幂等查表，丢了不影响持久化状态）。
    _AUDIO_TASKS_MAX = 50

    def _prune_audio_tasks(self) -> None:
        if len(self.audio_plan_tasks) <= self._AUDIO_TASKS_MAX:
            return
        finished = [
            key for key, task in self.audio_plan_tasks.items()
            if task["status"] in ("completed", "failed")
        ]
        for key in finished[: len(self.audio_plan_tasks) - self._AUDIO_TASKS_MAX]:
            self.audio_plan_tasks.pop(key, None)

    def create_audio_plan_task(self, script_id: str) -> Tuple[EpisodeAudioPlan, str]:
        """排队生成导演稿，立刻返回 ``(plan, task_id)``。

        已经在跑就原样返回那一次 —— 连点两下不重复起任务（LLM 不贵，但重复覆盖
        会让人分不清哪一稿是自己要的）。
        """
        script = self.get_script(script_id)
        if not script:
            raise ValueError("Script not found")

        plan = self._audio_plan_of(script)
        if plan.script_status in ("queued", "processing") and plan.script_task_id:
            return plan, plan.script_task_id

        task_id = f"audioplan_{uuid.uuid4().hex}"
        self.audio_plan_tasks[task_id] = {
            "task_id": task_id,
            "kind": "script",
            "script_id": script_id,
            "status": "queued",
        }
        plan.script_status = "queued"
        plan.script_error = None
        plan.script_task_id = task_id
        script.updated_at = time.time()
        self._prune_audio_tasks()
        self._save_data()
        return plan, task_id

    def process_audio_plan_task(self, task_id: str) -> None:
        """后台执行：调同步实现，把成功 / 失败写回 plan 字段。"""
        task = self.audio_plan_tasks.get(task_id)
        if not task:
            return
        script = self.get_script(task["script_id"])
        if not script:
            return
        plan = self._audio_plan_of(script)
        if plan.script_task_id != task_id:
            return  # 更晚的一次提交接管了，这次的结果直接丢

        task["status"] = "processing"
        plan.script_status = "processing"
        self._save_data()
        try:
            self.generate_audio_plan_script(task["script_id"])
            plan.script_status = "completed"
            plan.script_error = None
            task["status"] = "completed"
        except Exception as exc:
            logger.exception("Audio plan task %s failed", task_id)
            plan.script_status = "failed"
            plan.script_error = str(exc)
            task["status"] = "failed"
        finally:
            plan.script_task_id = None
            self._save_data()

    def resolve_character_reference_audios(
        self, script_id: str, character_ids: List[str]
    ) -> List[str]:
        """把角色 id 解析成参考音频的**本地路径**。

        链路就一层：``Character.reference_audio_url`` —— 角色工作台「声音面」生出的
        那条参考音。音色池、音色克隆随「音色选择」一起收掉了（产品只有一个音频通道）。

        取到的通常是 ``uploads/xxx`` 这种仓库内相对路径 —— 交给适配器在**生成时**
        转存成网关 URL 即可，这样天然避开网关临时素材 15 分钟失效的问题（存成
        网关 URL 就是死链）。

        勾了角色却没有参考音时报错而不是悄悄跳过：否则「我勾了 4 个只生效 2 个」
        会被误当成音色没听出来，很难查。
        """
        script = self.get_script(script_id)
        if not script:
            raise ValueError("Script not found")

        wanted = [cid for cid in (character_ids or []) if cid]
        if len(wanted) > AUDIO_MAX_REFERENCE_AUDIOS:
            raise ValueError(
                f"seed-audio-1.0 最多支持 {AUDIO_MAX_REFERENCE_AUDIOS} 段参考音频，"
                f"当前选了 {len(wanted)} 个角色"
            )

        resolved: List[str] = []
        missing: List[str] = []
        for character_id in wanted:
            # 走三层池子：同名提取/关联之后角色可能只活在系列池或全局库里，
            # 只查本集会在这里误报「角色不存在」。
            character, _source = self._find_asset_with_source(script, character_id, "character")
            if character is None:
                raise ValueError(f"角色不存在：{character_id}")
            own = getattr(character, "reference_audio_url", None)
            if own:
                resolved.append(own)
            else:
                missing.append(character.name)
        if missing:
            raise ValueError(
                "这些角色还没有参考音，请先到资产里他们的声音面生成一版参考音："
                + "、".join(missing)
            )
        return resolved

    def create_episode_audio_task(
        self, script_id: str, character_ids: List[str]
    ) -> Tuple[EpisodeAudioPlan, AudioTake]:
        """排队生成一版全集声音，立刻返回 ``(plan, take)``。

        ``character_ids`` 可以为空 —— 那就是纯文生音频，只作为参考听；
        也可以给 1–3 个角色带上他们的参考音。多生成几版对比着听是预期用法。

        提交时就追加一条 `queued` 的占位 take：前端据此显示「生成中」，进程重启时
        也扫得到它。参考音在**这里**解析（不是后台）—— 勾了没参考音的角色要当场报错。
        """
        script = self.get_script(script_id)
        if not script:
            raise ValueError("Script not found")

        plan = self._audio_plan_of(script)
        if not (plan.script_text or "").strip():
            raise ValueError("请先生成（或填写）全局声音导演稿，再生成全集声音")

        references = self.resolve_character_reference_audios(script_id, character_ids)

        take_id = f"take_{uuid.uuid4().hex[:8]}"
        take = AudioTake(
            id=take_id,
            audio_url="",
            status="queued",
            reference_character_ids=list(character_ids or []),
            script_hash=plan.script_hash,
        )
        plan.takes.append(take)
        if plan.selected_take_id is None:
            plan.selected_take_id = take.id
        self.audio_plan_tasks[take_id] = {
            "task_id": take_id,
            "kind": "take",
            "script_id": script_id,
            "take_id": take_id,
            "references": references,
            "status": "queued",
        }
        script.updated_at = time.time()
        self._prune_audio_tasks()
        self._save_data()
        return plan, take

    def process_episode_audio_task(self, task_id: str) -> None:
        """后台执行：真正调 seed-audio-1.0，成功后回填这一版的地址与时长。

        刻意**不做自动重试**：网关可能已经接单并计费，重试就是重复付费
        （和视频生成那条一样的理由）。失败就把原文留在 take 上给人看。
        """
        task = self.audio_plan_tasks.get(task_id)
        if not task:
            return
        script = self.get_script(task["script_id"])
        if not script:
            return
        plan = self._audio_plan_of(script)
        take = next((item for item in plan.takes if item.id == task["take_id"]), None)
        if take is None:
            return

        task["status"] = "processing"
        take.status = "processing"
        self._save_data()
        try:
            from ...models.jiucaihezi import generate_audio

            output_path = media_ref(
                "output", "audio", f"episode_{task['script_id']}_{take.id}.mp3"
            )
            generate_audio(
                prompt=plan.script_text,
                output_path=output_path,
                reference_audio_urls=task["references"],
            )
            take.audio_url = output_path
            take.duration_ms = _probe_audio_duration_ms(output_path)
            take.status = "completed"
            take.error = None
            # 生成完就选中这一版 —— 人刚点的那一版才是他想听的。
            plan.selected_take_id = take.id
            task["status"] = "completed"
            logger.info(
                "[episode-audio] take=%s refs=%d url=%s",
                take.id, len(task["references"]), output_path,
            )
        except Exception as exc:
            logger.exception("Episode audio task %s failed", task_id)
            take.status = "failed"
            take.error = str(exc)
            task["status"] = "failed"
        finally:
            script.updated_at = time.time()
            self._save_data()

    def update_audio_plan(
        self,
        script_id: str,
        script_text: Optional[str] = None,
        selected_take_id: Optional[str] = None,
    ) -> EpisodeAudioPlan:
        """保存导演稿 / 切换当前在听的版本。

        改导演稿只更新 hash，**不删除已有版本** —— 前端据此把旧版本标成「已过期」，
        听哪一版还是用户自己决定。
        """
        script = self.get_script(script_id)
        if not script:
            raise ValueError("Script not found")

        plan = self._audio_plan_of(script)
        if script_text is not None:
            plan.script_text = script_text
            plan.script_hash = self._voice_script_hash(script_text) if script_text.strip() else None
        if selected_take_id is not None:
            if selected_take_id and not any(t.id == selected_take_id for t in plan.takes):
                raise ValueError(f"没有这个声音版本：{selected_take_id}")
            plan.selected_take_id = selected_take_id or None

        script.updated_at = time.time()
        self._save_data()
        return plan

    def get_series_episodes(self, series_id: str) -> List[Script]:
        """Get all Episodes belonging to a Series, in order."""
        series = self.series_store.get(series_id)
        if not series:
            raise ValueError("Series not found")
        episodes = []
        for ep_id in series.episode_ids:
            script = self.scripts.get(ep_id)
            if script:
                episodes.append(script)
        return episodes

    #: 资产分层，低层给高层让路（按 id，本地永远赢）。
    _ASSET_LAYER_KEYS = ("characters", "scenes", "props")

    def resolve_episode_assets_with_source(
        self, episode: Script, series: Optional[Series] = None
    ) -> Dict[str, List[Tuple[Any, str]]]:
        """三层资产合并，并给每个资产标出它来自哪一层。

        优先级按 id：Episode > Series > Global，返回顺序也是这个层序。
        每个资产的来源是 `"episode" | "series" | "global"`，前端靠它区分
        资产归属（`ConsistencyVault` 会把 global 显示成「全局模板库」）。

        分层逻辑只在这里实现一次。API 层曾经自己手写了一遍两层合并
        （只有 Episode + Series），导致全局模板库的资产永远不出现在项目里，
        所以现在 endpoint 一律走这里。
        """
        if not series and episode.series_id:
            series = self.series_store.get(episode.series_id)

        layers: List[Tuple[str, Tuple[List[Any], List[Any], List[Any]]]] = [
            ("episode", (episode.characters, episode.scenes, episode.props)),
        ]
        if series:
            layers.append(("series", (series.characters, series.scenes, series.props)))
        layers.append(
            ("global", (self.library_store.characters, self.library_store.scenes, self.library_store.props))
        )

        resolved: Dict[str, List[Tuple[Any, str]]] = {key: [] for key in self._ASSET_LAYER_KEYS}
        seen: Dict[str, set] = {key: set() for key in self._ASSET_LAYER_KEYS}
        for source, groups in layers:
            for key, group in zip(self._ASSET_LAYER_KEYS, groups):
                for asset in group:
                    if asset.id in seen[key]:
                        continue
                    seen[key].add(asset.id)
                    resolved[key].append((asset, source))
        return resolved

    def resolve_episode_assets(self, episode: Script, series: Optional[Series] = None) -> Dict[str, List]:
        """合并 Episode 本地资产、Series 共享资产与项目无关的全局模板库。

        按 id 的优先级：Episode > Series > Global（本地永远赢）。全局库是
        最低层，对每个项目都生效，无论有没有父系列；全局库为空时行为与原先的
        两层（Episode/Series）合并完全一致。"""
        layered = self.resolve_episode_assets_with_source(episode, series)
        return {key: [asset for asset, _source in items] for key, items in layered.items()}

    # ---- 跨集复用：候选清单 + 关联（合并） ----------------------------------
    _ASSET_FIELD_BY_TYPE = {"character": "characters", "scene": "scenes", "prop": "props"}
    # 帧引用按类型存在不同字段上：场景单值，角色/道具多值。
    _ASSET_FRAME_REF = {"character": "character_ids", "scene": "scene_id", "prop": "prop_ids"}

    @staticmethod
    def _asset_name_keys(asset: Any) -> set:
        """一条资产可用于匹配的全部名字（本体名 + 别名），统一小写去空白。

        别名是让「刘玄德」也能解析到「刘备」那条 —— 用户关联过一次之后，
        下一集再提取到这个名字不该再问一遍。空别名时就等于只看名字。
        """
        keys = {(getattr(asset, "name", "") or "").strip().lower()}
        for alias in getattr(asset, "aliases", None) or []:
            keys.add(str(alias).strip().lower())
        keys.discard("")
        return keys

    def list_asset_candidates(self, script_id: str, asset_type: str) -> List[Dict[str, Any]]:
        """列出这一集可以把某条本地资产“关联过去”的候选资产。

        候选分四类，顺序就是推荐顺序：
          1. `series` —— 系列池。该系列任何一集都解析得到。
          2. `global` —— 全局库。所有项目都解析得到。
          3. `episode` —— 本集自己池里的其它条目（同一集内部的重复，直接合并即可）。
          4. `episode` + `needs_promote=True` —— 同系列**其它集**的私有资产。
             帧引用解析不到它（`_find_asset_with_source` 只看 本集 → 系列 → 全局），
             所以关联时必须先把它提升到系列池（沿用原 id），否则这条引用是断的。

        返回的是资产本身（`model_dump()`）加上 `source` / `needs_promote` /
        `owner_episode_*` 几个归属字段 —— 图片字段原样带出去，前端复用
        `lib/characterImage` 那套取图逻辑，不在后端重算。
        """
        field = self._ASSET_FIELD_BY_TYPE.get(asset_type)
        if not field:
            raise ValueError(f"Invalid asset type: {asset_type}")
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")

        candidates: List[Dict[str, Any]] = []
        seen: set = set()

        def add(asset, source: str, owner: Optional[Script] = None, needs_promote: bool = False) -> None:
            if asset.id in seen:
                return
            seen.add(asset.id)
            candidates.append({
                **asset.model_dump(),
                "source": source,
                "needs_promote": needs_promote,
                "owner_episode_id": owner.id if owner else None,
                "owner_episode_title": owner.title if owner else None,
            })

        series = self.series_store.get(script.series_id) if script.series_id else None
        if series:
            for asset in getattr(series, field):
                add(asset, "series")
        for asset in getattr(self.library_store, field):
            add(asset, "global")
        for asset in getattr(script, field):
            add(asset, "episode", script)
        if series:
            for sibling in self.scripts.values():
                if sibling.id == script.id or sibling.series_id != script.series_id:
                    continue
                for asset in getattr(sibling, field):
                    add(asset, "episode", sibling, needs_promote=True)
        return candidates

    def _rewrite_asset_refs(self, script: Script, asset_type: str, old_id: str, new_id: str) -> None:
        """把这一集分镜里指向 old_id 的引用改写成 new_id。

        只改这一集：跨集合并是逐集做的，别的集有自己的分镜。场景是单值字段，
        角色/道具是多值列表。
        """
        ref = self._ASSET_FRAME_REF.get(asset_type)
        if not ref:
            return
        for frame in script.frames:
            if ref == "scene_id":
                if frame.scene_id == old_id:
                    frame.scene_id = new_id
            else:
                current = getattr(frame, ref) or []
                setattr(frame, ref, [new_id if item == old_id else item for item in current])

    def link_local_asset(self, script_id: str, asset_type: str, local_id: str, target_id: str) -> Script:
        """把本集的某条资产合并到另一条已存在的资产上（“这个刘玄德就是刘备”）。

        全流程只有这一份实现：改写本集帧引用 → 删掉本集这条。目标可以是
        系列池 / 全局库 / 本集另一条 / 同系列其它集的私有资产；最后一类先提升到
        系列池（沿用原 id，所以那一集的帧引用不用动）再合并。
        """
        field = self._ASSET_FIELD_BY_TYPE.get(asset_type)
        if not field:
            raise ValueError(f"Invalid asset type: {asset_type}")
        if not target_id or target_id == local_id:
            raise ValueError("target_id 必须不同于 local_id")
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
        local_pool = getattr(script, field)
        local = next((a for a in local_pool if a.id == local_id), None)
        if local is None:
            raise ValueError(f"Asset {local_id} of type {asset_type} not found in project")

        target, source = self._find_asset_with_source(script, target_id, asset_type)
        sibling_owner: Optional[Script] = None
        if target is None and script.series_id:
            for sibling in self.scripts.values():
                if sibling.id == script.id or sibling.series_id != script.series_id:
                    continue
                found = next((a for a in getattr(sibling, field) if a.id == target_id), None)
                if found is not None:
                    target, source, sibling_owner = found, "sibling", sibling
                    break
        if target is None:
            raise ValueError(f"Target asset {target_id} of type {asset_type} not found")

        with self._save_lock:
            if source == "sibling" and sibling_owner is not None:
                series = self.series_store.get(script.series_id)
                if not series:
                    raise ValueError("Series not found")
                sibling_pool = getattr(sibling_owner, field)
                setattr(sibling_owner, field, [a for a in sibling_pool if a.id != target_id])
                sibling_owner.updated_at = time.time()
                getattr(series, field).append(target)
                series.updated_at = time.time()
                self._save_series_data_unlocked()
                self._save_data()

            self._rewrite_asset_refs(script, asset_type, local_id, target_id)
            # 记住这次的判断：被合并掉的那个名字变成目标的别名 —— 以后任何一集
            # 再提取到这个名字（「刘玄德」）会直接命中「刘备」，不用再关联一次。
            local_name = (local.name or "").strip()
            target_name = (target.name or "").strip()
            if local_name and target_name and local_name.lower() != target_name.lower():
                if local_name.lower() not in {k for k in self._asset_name_keys(target)}:
                    target.aliases = [*(getattr(target, "aliases", None) or []), local_name]
            setattr(script, field, [a for a in local_pool if a.id != local_id])
            script.updated_at = time.time()
            self._save_data()
        return script

    def set_asset_aliases(
        self, script_id: str, asset_type: str, asset_id: str, aliases: List[str]
    ) -> Script:
        """覆盖式设置某条资产的别名（传统空列表 = 清空）。

        路由走 `_find_asset_with_source`：资产可能住在集内 / 系列池 / 全局库，
        得写到真正持有它的那一层（与 `toggle_asset_starred` 同一套约定）。
        本体名不进别名表（它已经是名字了）。
        """
        script = self.scripts.get(script_id)
        if not script:
            raise ValueError("Script not found")
        target, source = self._find_asset_with_source(script, asset_id, asset_type)
        if target is None:
            raise ValueError(f"Asset {asset_id} of type {asset_type} not found")

        cleaned: List[str] = []
        seen = self._asset_name_keys(target)
        for alias in aliases:
            name = str(alias).strip()
            if name and name.lower() not in seen:
                seen.add(name.lower())
                cleaned.append(name)
        target.aliases = cleaned
        self._save_after_asset_mutation(source)
        return script

    # ============================================================
    # File Import & Episode Splitting
    # ============================================================

    def import_file_and_split(self, text: str, suggested_episodes: int = 3) -> List[Dict]:
        """Split text into episodes using LLM. Returns episode preview data."""
        return self.script_processor.split_into_episodes(text, suggested_episodes)

    def create_series_from_import(self, title: str, text: str, episodes_data: List[Dict],
                                   description: str = "") -> Dict:
        """Create a Series with Episodes from import data.
        episodes_data: list of dicts with episode_number, title, start_marker, end_marker."""
        # Create the Series (already acquires lock internally)
        series = self.create_series(title, description)

        # Split text into episode chunks based on markers
        episode_texts = self._split_text_by_markers(text, episodes_data)

        with self._save_lock:
            # Create Episode (Script) for each chunk
            created_episodes = []
            for idx, ep_data in enumerate(episodes_data):
                ep_text = episode_texts[idx] if idx < len(episode_texts) else ""
                ep_title = ep_data.get("title", f"第{idx+1}集")
                episode_number = ep_data.get("episode_number", idx + 1)

                # Create draft script (no LLM analysis yet — user can trigger later)
                script = self.script_processor.create_draft_script(ep_title, ep_text)
                script.series_id = series.id
                script.episode_number = episode_number
                self.scripts[script.id] = script

                series.episode_ids.append(script.id)
                created_episodes.append({
                    "id": script.id,
                    "title": ep_title,
                    "episode_number": episode_number,
                    "text_length": len(ep_text),
                })

            self._save_data()
            self._save_series_data_unlocked()

        return {
            "series": series.model_dump(),
            "episodes": created_episodes,
        }

    def _split_text_by_markers(self, text: str, episodes_data: List[Dict]) -> List[str]:
        """Split text into chunks using start/end markers from LLM.
        Searches sequentially to avoid overlapping chunks."""
        chunks = []
        search_from = 0  # Track position to avoid overlap

        for ep in episodes_data:
            start_marker = ep.get("start_marker", "")
            end_marker = ep.get("end_marker", "")

            start_idx = search_from
            end_idx = len(text)

            if start_marker:
                found = text.find(start_marker, search_from)
                if found >= 0:
                    start_idx = found

            if end_marker:
                found = text.find(end_marker, start_idx)
                if found >= 0:
                    end_idx = found + len(end_marker)

            chunks.append(text[start_idx:end_idx])
            search_from = end_idx  # Next episode starts after this one

        # Fallback: if markers produced empty/overlapping chunks, do equal split
        if not chunks or all(len(c.strip()) == 0 for c in chunks):
            chunk_size = max(1, len(text) // len(episodes_data))
            chunks = []
            for i in range(len(episodes_data)):
                start = i * chunk_size
                end = start + chunk_size if i < len(episodes_data) - 1 else len(text)
                chunks.append(text[start:end])

        return chunks

    # ============================================================
    # Series Asset Operations
    # ============================================================

    def _find_series_asset(self, series_id: str, asset_id: str, asset_type: str):
        """Find an asset in a Series. Returns (series, asset) tuple."""
        if asset_type not in ("character", "scene", "prop"):
            raise ValueError(f"Invalid asset type: {asset_type}")
        series = self.series_store.get(series_id)
        if not series:
            raise ValueError("Series not found")
        target_asset = None
        if asset_type == "character":
            target_asset = next((c for c in series.characters if c.id == asset_id), None)
        elif asset_type == "scene":
            target_asset = next((s for s in series.scenes if s.id == asset_id), None)
        elif asset_type == "prop":
            target_asset = next((p for p in series.props if p.id == asset_id), None)
        if not target_asset:
            raise ValueError(f"Asset {asset_id} of type {asset_type} not found in series")
        return series, target_asset

    def toggle_series_asset_lock(self, series_id: str, asset_id: str, asset_type: str) -> Series:
        """Toggle the locked status of a Series asset."""
        with self._save_lock:
            series, target_asset = self._find_series_asset(series_id, asset_id, asset_type)
            target_asset.locked = not target_asset.locked
            self._save_series_data_unlocked()
            return series

    def toggle_series_asset_starred(self, series_id: str, asset_id: str, asset_type: str) -> Series:
        """Toggle the starred (library shortlist) status of a Series asset."""
        with self._save_lock:
            series, target_asset = self._find_series_asset(series_id, asset_id, asset_type)
            target_asset.starred = not target_asset.starred
            self._save_series_data_unlocked()
            return series

    def update_series_asset_image(self, series_id: str, asset_id: str, asset_type: str, image_url: str) -> Series:
        """Updates the image URL of a Series asset."""
        with self._save_lock:
            series, target_asset = self._find_series_asset(series_id, asset_id, asset_type)
            target_asset.image_url = image_url
            if asset_type == "character":
                target_asset.avatar_url = image_url
            self._save_series_data_unlocked()
            return series

    def update_series_asset_attributes(self, series_id: str, asset_id: str, asset_type: str, attributes: Dict[str, Any]) -> Series:
        """Updates arbitrary attributes of a Series asset."""
        with self._save_lock:
            series, target_asset = self._find_series_asset(series_id, asset_id, asset_type)
            for key, value in attributes.items():
                if hasattr(target_asset, key) and key not in ("id", "status", "locked"):
                    setattr(target_asset, key, value)
            series.updated_at = time.time()
            self._save_series_data_unlocked()
            return series

    def generate_series_asset(self, series_id: str, asset_id: str, asset_type: str,
                              style_preset: str = None, reference_image_url: str = None,
                              style_prompt: str = None, generation_type: str = "all",
                              prompt: str = None, apply_style: bool = True,
                              negative_prompt: str = None, batch_size: int = 1,
                              model_name: str = None) -> tuple:
        """Generate a Series asset. Creates an async task like project asset generation.
        Returns (series, task_id)."""
        series = self.series_store.get(series_id)
        if not series:
            raise ValueError("Series not found")

        t2i_model = model_name or series.model_settings.t2i_model

        from .assets import ASPECT_RATIO_TO_SIZE
        if asset_type == "character":
            aspect_ratio = series.model_settings.character_aspect_ratio
            default_size = "576*1024"
        elif asset_type == "scene":
            aspect_ratio = series.model_settings.scene_aspect_ratio
            default_size = "1024*576"
        elif asset_type == "prop":
            aspect_ratio = series.model_settings.prop_aspect_ratio
            default_size = "1024*1024"
        else:
            aspect_ratio = "9:16"
            default_size = "576*1024"
        effective_size = ASPECT_RATIO_TO_SIZE.get(aspect_ratio, default_size)

        effective_positive_prompt = ""
        effective_negative_prompt = negative_prompt or ""
        resolved_art_dir = series.art_direction
        if isinstance(resolved_art_dir, dict):
            resolved_art_dir = ArtDirection(**resolved_art_dir)
        if apply_style:
            if resolved_art_dir and resolved_art_dir.style_config:
                effective_positive_prompt = resolved_art_dir.style_config.get('positive_prompt', '')
                global_neg = resolved_art_dir.style_config.get('negative_prompt', '')
                if global_neg:
                    effective_negative_prompt = f"{effective_negative_prompt}, {global_neg}" if effective_negative_prompt else global_neg
            elif style_prompt:
                effective_positive_prompt = style_prompt
            elif style_preset:
                effective_positive_prompt = f"{style_preset} style"

        task_id = str(uuid.uuid4())
        self.asset_generation_tasks[task_id] = {
            "status": "pending",
            "progress": 0,
            "error": None,
            "script_id": series_id,  # reuse field name for task lookup
            "asset_id": asset_id,
            "asset_type": asset_type,
            "created_at": time.time(),
            "is_series": True,
            "params": {
                "style_preset": style_preset,
                "reference_image_url": reference_image_url,
                "effective_positive_prompt": effective_positive_prompt,
                "effective_negative_prompt": effective_negative_prompt,
                "generation_type": generation_type,
                "prompt": prompt,
                "apply_style": apply_style,
                "batch_size": batch_size,
                "t2i_model": t2i_model,
                "effective_size": effective_size,
            }
        }
        return series, task_id

    def import_assets_from_series(self, target_series_id: str, source_series_id: str, asset_ids: List[str]) -> Tuple[Series, List[str], List[str]]:
        """Deep-copy selected assets from source Series to target Series.
        Returns (target_series, imported_ids, skipped_ids)."""
        with self._save_lock:
            target = self.series_store.get(target_series_id)
            if not target:
                raise ValueError("Target series not found")
            source = self.series_store.get(source_series_id)
            if not source:
                raise ValueError("Source series not found")

            # Build lookup of all source assets
            source_assets = {}
            for c in source.characters:
                source_assets[c.id] = ("character", c)
            for s in source.scenes:
                source_assets[s.id] = ("scene", s)
            for p in source.props:
                source_assets[p.id] = ("prop", p)

            imported_ids = []
            skipped_ids = []
            for aid in asset_ids:
                if aid not in source_assets:
                    skipped_ids.append(aid)
                    continue
                asset_type, asset = source_assets[aid]
                # Deep copy with new ID
                import copy
                new_asset = copy.deepcopy(asset)
                new_asset.id = str(uuid.uuid4())
                if asset_type == "character":
                    target.characters.append(new_asset)
                elif asset_type == "scene":
                    target.scenes.append(new_asset)
                elif asset_type == "prop":
                    target.props.append(new_asset)
                imported_ids.append(aid)

            target.updated_at = time.time()
            self._save_series_data_unlocked()
            return target, imported_ids, skipped_ids

    def _resolve_stage_override(
        self, prompt_type: str, episode: Script, series: Optional[Series] = None
    ) -> str:
        """这一阶段**用户或 Skill 真正提供**的那一层：不含内置默认，也不含输出契约。

        解析顺序：集内 skill_binding → 系列 skill_binding → 集内文本 → 系列文本。
        单独抽出来是因为有两个用途：
        1. `get_effective_prompt` 落地默认值之前得先记住「有没有被覆盖」
           （音频那两个硬契约只在被覆盖时才补）；
        2. 中列「AI 提取」要区分「用户绑了 Skill」和「没绑、用内置」。
        """
        resolved = ""
        episode_bindings = getattr(episode.prompt_config, "skill_bindings", {}) or {}
        if episode_bindings.get(prompt_type):
            resolved = self.skill_packages.compile(episode_bindings[prompt_type])
        if not resolved and series:
            series_bindings = getattr(series.prompt_config, "skill_bindings", {}) or {}
            if series_bindings.get(prompt_type):
                resolved = self.skill_packages.compile(series_bindings[prompt_type])
        episode_value = getattr(episode.prompt_config, prompt_type, "")
        if not resolved and episode_value.strip():
            resolved = episode_value
        if not resolved and series:
            series_value = getattr(series.prompt_config, prompt_type, "")
            if series_value.strip():
                resolved = series_value
        return resolved

    def get_effective_prompt(self, prompt_type: str, episode: Script, series: Optional[Series] = None) -> str:
        """Resolve Skill Package/text/default, then attach the stage's output contract."""
        valid_prompt_types = (
            "entity_extraction", "style_analysis", "storyboard_extraction",
            "storyboard_polish", "video_polish", "r2v_polish", "r2v_minimax",
            "character_prompt", "scene_prompt", "prop_prompt",
            "audio_plan", "voice_prompt",
        )
        if prompt_type not in valid_prompt_types:
            raise ValueError(f"Invalid prompt_type: {prompt_type}. Must be one of {valid_prompt_types}")
        from .llm import (
            DEFAULT_CHARACTER_ASSET_PROMPT, DEFAULT_ENTITY_EXTRACTION_PROMPT,
            DEFAULT_PROP_ASSET_PROMPT, DEFAULT_R2V_POLISH_PROMPT,
            DEFAULT_SCENE_ASSET_PROMPT, DEFAULT_STORYBOARD_EXTRACTION_PROMPT,
            DEFAULT_STORYBOARD_POLISH_PROMPT, DEFAULT_STYLE_ANALYSIS_PROMPT,
            DEFAULT_VIDEO_POLISH_PROMPT,
            DEFAULT_AUDIO_PLAN_PROMPT, DEFAULT_VOICE_PROMPT,
            AUDIO_PLAN_OUTPUT_CONTRACT, VOICE_PROMPT_OUTPUT_CONTRACT,
        )
        defaults = {
            "entity_extraction": DEFAULT_ENTITY_EXTRACTION_PROMPT,
            "style_analysis": DEFAULT_STYLE_ANALYSIS_PROMPT,
            "storyboard_polish": DEFAULT_STORYBOARD_POLISH_PROMPT,
            "video_polish": DEFAULT_VIDEO_POLISH_PROMPT,
            "r2v_polish": DEFAULT_R2V_POLISH_PROMPT,
            "r2v_minimax": DEFAULT_R2V_POLISH_PROMPT,
            "storyboard_extraction": DEFAULT_STORYBOARD_EXTRACTION_PROMPT,
            "character_prompt": DEFAULT_CHARACTER_ASSET_PROMPT,
            "scene_prompt": DEFAULT_SCENE_ASSET_PROMPT,
            "prop_prompt": DEFAULT_PROP_ASSET_PROMPT,
            "audio_plan": DEFAULT_AUDIO_PLAN_PROMPT,
            "voice_prompt": DEFAULT_VOICE_PROMPT,
        }
        resolved = self._resolve_stage_override(prompt_type, episode, series)
        # 到这里 `resolved` 还是「用户或 Skill 真正提供的那一层」；下面一落地默认值
        # 就分不出是谁给的，所以先把「有没有被覆盖」记下来 —— 音频那两个硬契约
        # 只在被覆盖时才补（内置默认里已经逐条写了，不加会重复）。
        overridden = bool(resolved)
        resolved = resolved or defaults.get(prompt_type, "")
        if overridden and prompt_type == "audio_plan":
            resolved += AUDIO_PLAN_OUTPUT_CONTRACT
        elif overridden and prompt_type == "voice_prompt":
            resolved += VOICE_PROMPT_OUTPUT_CONTRACT
        if prompt_type in {"storyboard_extraction", "storyboard_polish", "video_polish", "r2v_polish", "r2v_minimax", "character_prompt", "scene_prompt", "prop_prompt"}:
            art = episode.art_direction or (series.art_direction if series else None)
            style = ""
            if isinstance(art, dict):
                style = (art.get("style_config") or {}).get("positive_prompt", "")
            elif art:
                style = (getattr(art, "style_config", {}) or {}).get("positive_prompt", "")
            if style:
                resolved += ("\n\n# 本项目视觉风格合同\n" + style + "\n执行本 Skill 时必须以该风格为视觉基础，但不得让风格覆盖资产身份、剧情事实或镜头要求。")
        return resolved

    def get_effective_polish_model(self, episode: Script) -> str:
        """文本模型：全局单源（`output/settings.json`）。

        以前这里是 episode → series → 目录默认 的三级回落，再叠 episode/series 的
        `prompt_config.polish_model` 覆盖。文本模型收敛成全局一个值之后那几级全部
        取消 —— 留着它们就等于留着「在设置里改一处、别处不生效」。

        `episode` 参数保留只为不动二十多个调用点。
        """
        return get_active_text_model()
