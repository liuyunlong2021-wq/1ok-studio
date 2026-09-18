import os
import time
import hashlib
from typing import Dict, Any, List, Optional
from .models import StoryboardFrame, Character, GenerationStatus
from ...utils import get_logger
from ...utils.media_refs import to_media_ref

logger = get_logger(__name__)


def _compute_dialogue_hash(text: str, reference_audio_url: Optional[str], instructions: Optional[str]) -> str:
    """PR-3j · Snapshot hash for stale detection. Frame is STALE when current
    (dialogue|reference_audio_url|instructions) hash != stored snapshot."""
    payload = f"{text or ''}|{reference_audio_url or ''}|{instructions or ''}"
    return hashlib.md5(payload.encode("utf-8")).hexdigest()


# PR-3k · BGM preset catalog. Each entry maps a stable id → human label,
# mood tag, and a relative path under output/presets/bgm/. v1 ships the
# catalog only; actual audio files are dropped in by the operator (or
# left empty, in which case merge_videos will skip the BGM track).
BGM_PRESETS: List[Dict[str, Any]] = [
    {"id": "calm_warm",      "label": "温暖治愈",   "mood": "warm",      "url": "presets/bgm/calm_warm.mp3"},
    {"id": "uplifting_pop",  "label": "明朗轻快",   "mood": "uplifting", "url": "presets/bgm/uplifting_pop.mp3"},
    {"id": "epic_cinematic", "label": "史诗电影感", "mood": "epic",      "url": "presets/bgm/epic_cinematic.mp3"},
    {"id": "mystery_ambient","label": "悬疑氛围",   "mood": "mystery",   "url": "presets/bgm/mystery_ambient.mp3"},
    {"id": "sad_piano",      "label": "忧伤钢琴",   "mood": "sad",       "url": "presets/bgm/sad_piano.mp3"},
    {"id": "tension_drama",  "label": "紧张戏剧",   "mood": "tense",     "url": "presets/bgm/tension_drama.mp3"},
    {"id": "lofi_chill",     "label": "Lo-Fi 慵懒", "mood": "chill",     "url": "presets/bgm/lofi_chill.mp3"},
    {"id": "fantasy_dreamy", "label": "奇幻梦境",   "mood": "dreamy",    "url": "presets/bgm/fantasy_dreamy.mp3"},
]


def get_bgm_presets() -> List[Dict[str, Any]]:
    """PR-3k · Return BGM preset list. UI displays these in the Mix phase
    picker; selected entry's url is stored on Script.bgm_url."""
    return list(BGM_PRESETS)


def _effective_dialogue_text(frame: StoryboardFrame) -> str:
    """Prefer dialogue_structured.line, fall back to legacy frame.dialogue."""
    if frame.dialogue_structured and frame.dialogue_structured.line:
        return frame.dialogue_structured.line
    return frame.dialogue or ""


def _effective_instructions(frame: StoryboardFrame) -> Optional[str]:
    """Prefer explicit dialogue_instructions; lazy-build from dialogue_structured if missing."""
    if frame.dialogue_instructions:
        return frame.dialogue_instructions
    if frame.dialogue_structured:
        parts = []
        if frame.dialogue_structured.emotion:
            parts.append(f"情绪：{frame.dialogue_structured.emotion}")
        if frame.dialogue_structured.delivery:
            parts.append(f"演绎：{frame.dialogue_structured.delivery}")
        if parts:
            return "；".join(parts)
    return None


def dialogue_audio_is_stale(frame: StoryboardFrame, character: Optional[Character]) -> bool:
    """True when frame.audio_url exists but its snapshot no longer matches
    the current (dialogue|reference audio|instructions) state."""
    if not frame.audio_url:
        return False
    if not frame.dialogue_text_hash:
        return True  # legacy frame without snapshot — treat as stale
    reference = character.reference_audio_url if character else frame.dialogue_reference_audio_url
    text = _effective_dialogue_text(frame)
    instructions = _effective_instructions(frame)
    current = _compute_dialogue_hash(text, reference, instructions)
    return current != frame.dialogue_text_hash

class AudioGenerator:
    def __init__(self, config: Dict[str, Any] = None):
        self.config = config or {}
        self.output_dir = self.config.get('output_dir', 'output/audio')

    def generate_dialogue(
        self,
        frame: StoryboardFrame,
        character: Character,
        instructions: Optional[str] = None,
    ) -> StoryboardFrame:
        """用角色的**参考音**念这一句台词（seed-audio-1.0 参考生音频）。

        产品里只有这一个音频通道，没有 TTS、也没有 speed/pitch/volume —— 声音
        是角色的参考音决定的，要换声音就去声音面重新生成参考音。台词本身 + 情绪
        提示当提示词，参考音当 ``metadata.references``。
        """
        text = _effective_dialogue_text(frame)
        if not text:
            return frame

        frame.status = GenerationStatus.PROCESSING

        if instructions is None:
            instructions = _effective_instructions(frame)

        reference = (character.reference_audio_url or "").strip()
        if not reference:
            frame.status = GenerationStatus.FAILED
            frame.audio_error = (
                f"「{character.name}」还没有参考音：先到资产里这个角色的声音面生成一版参考音。"
            )
            logger.warning("[dialogue] no reference audio for character %s", character.id)
            return frame

        logger.info(
            "[dialogue] generating for %s: %s (instr: %s)",
            character.name, text, instructions or '-',
        )
        return self._real_generate_dialogue(frame, character, text, reference, instructions)

    def _real_generate_dialogue(
        self,
        frame: StoryboardFrame,
        character: Character,
        text: str,
        reference_audio_url: str,
        instructions: Optional[str] = None,
    ) -> StoryboardFrame:
        """Generate dialogue with the character's reference audio as the voice."""
        from ...models.jiucaihezi import AUDIO_MAX_INPUT_CHARS, generate_audio

        try:
            output_path = os.path.join(self.output_dir, 'dialogue', f"{frame.id}.mp3")
            os.makedirs(os.path.dirname(output_path), exist_ok=True)

            prompt = f"{text}\n演绎要求：{instructions}" if instructions else text
            generate_audio(
                prompt=prompt[:AUDIO_MAX_INPUT_CHARS],
                output_path=output_path,
                reference_audio_urls=[reference_audio_url],
            )

            rel_path = to_media_ref(os.path.relpath(output_path, "output"))
            frame.audio_url = rel_path
            frame.audio_error = None
            frame.status = GenerationStatus.COMPLETED
            # PR-3j · snapshot for stale detection
            frame.dialogue_reference_audio_url = reference_audio_url
            frame.dialogue_instructions = instructions
            frame.dialogue_text_hash = _compute_dialogue_hash(text, reference_audio_url, instructions)

        except Exception as e:
            logger.error(f"Dialogue generation failed for frame {frame.id}: {e}")
            frame.status = GenerationStatus.FAILED
            frame.audio_error = f"对白生成失败：{e}"

        return frame

    def generate_sfx(self, frame: StoryboardFrame) -> StoryboardFrame:
        """Generates sound effects for the frame."""
        frame.status = GenerationStatus.PROCESSING
        
        try:
            # TODO: Implement actual SFX call (e.g., MMAudio)
            # For now, we mock it.
            logger.info(f"Generating SFX for: {frame.action_description}")
            
            output_path = os.path.join(self.output_dir, 'sfx', f"{frame.id}.mp3")
            os.makedirs(os.path.dirname(output_path), exist_ok=True)
            
            # Create a dummy file
            with open(output_path, 'wb') as f:
                f.write(b'dummy sfx content')
                
            # Store relative path for frontend serving
            rel_path = to_media_ref(os.path.relpath(output_path, "output"))
            frame.sfx_url = rel_path
            frame.status = GenerationStatus.COMPLETED
            
        except Exception as e:
            logger.error(f"Failed to generate SFX for frame {frame.id}: {e}")
            frame.status = GenerationStatus.FAILED
            
        return frame

    def generate_sfx_from_video(self, frame: StoryboardFrame) -> StoryboardFrame:
        """Generates SFX based on video content (Video-to-Audio)."""
        if not frame.video_url:
            return frame
            
        logger.info(f"Generating SFX from video for frame {frame.id}")
        # Mock V2A Logic
        time.sleep(1)
        
        output_path = os.path.join(self.output_dir, 'sfx', f"{frame.id}_v2a.mp3")
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        
        with open(output_path, 'wb') as f:
            f.write(b'dummy v2a sfx content')
            
        frame.sfx_url = to_media_ref(os.path.relpath(output_path, "output"))
        return frame

    def generate_bgm(self, frame: StoryboardFrame) -> StoryboardFrame:
        """Generates BGM based on frame context."""
        logger.info(f"Generating BGM for frame {frame.id}")
        # Mock MusicGen Logic
        time.sleep(1)
        
        output_path = os.path.join(self.output_dir, 'bgm', f"{frame.id}.mp3")
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        
        with open(output_path, 'wb') as f:
            f.write(b'dummy bgm content')
            
        frame.bgm_url = to_media_ref(os.path.relpath(output_path, "output"))
        return frame
