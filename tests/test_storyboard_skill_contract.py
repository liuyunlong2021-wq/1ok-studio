"""Contract check for the storyboard-inline-camera skill.

`analyze_text_to_frames` only reads a fixed set of keys out of each frame dict
(`frame_data.get(...)`); anything else the model emits is dropped without a
warning. So a skill that adds a field the pipeline does not read produces a
silent no-op — which is exactly what happened while writing this skill.

This test keeps the two sides honest: every key in the skill's worked example
must be a key the pipeline actually consumes.

Run: `.venv/bin/python -m pytest tests/test_storyboard_skill_contract.py -q`
"""

import json
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SKILL_PATH = REPO_ROOT / "skills" / "storyboard-inline-camera" / "SKILL.md"
PIPELINE_PATH = REPO_ROOT / "src" / "apps" / "comic_gen" / "pipeline.py"


def _pipeline_consumed_keys() -> set:
    """Keys `analyze_text_to_frames` pulls out of each frame dict."""
    source = PIPELINE_PATH.read_text(encoding="utf-8")
    start = source.index("def analyze_text_to_frames")
    # Method body ends at the next method definition at the same indent.
    end = source.index("\n    def ", start + 1)
    body = source[start:end]
    return set(re.findall(r'frame_data\.get\(\s*"([^"]+)"', body))


def _skill_example_frames() -> list:
    """The `{"frames": [...]}` example embedded in the skill."""
    text = SKILL_PATH.read_text(encoding="utf-8")
    for block in re.findall(r"```json\n(.*?)```", text, flags=re.DOTALL):
        payload = json.loads(block)
        if isinstance(payload, dict) and payload.get("frames"):
            return payload["frames"]
    raise AssertionError("skill has no parsable {\"frames\": [...]} example")


def test_skill_example_only_uses_keys_the_pipeline_consumes():
    consumed = _pipeline_consumed_keys()
    assert "visual_description" in consumed, (
        "pipeline.analyze_text_to_frames no longer reads 'visual_description' — "
        "the skill's fused camera paragraph would be dropped"
    )

    for index, frame in enumerate(_skill_example_frames(), start=1):
        assert isinstance(frame, dict), f"frame {index} is not an object"
        unknown = set(frame) - consumed
        assert not unknown, (
            f"frame {index} emits {sorted(unknown)}, which "
            f"analyze_text_to_frames drops. Either remove them from the skill or "
            f"wire them up in pipeline.py."
        )


def test_skill_keeps_the_template_placeholders():
    """`analyze_to_storyboard` substitutes these; missing ones mean the model
    never receives the script at all."""
    text = SKILL_PATH.read_text(encoding="utf-8")
    for placeholder in ("{entities_str}", "{text}"):
        assert placeholder in text, f"skill lost {placeholder} — the call would send no script content"


def test_first_shot_carries_episode_summary_and_music():
    first = _skill_example_frames()[0]
    opener = first["visual_description"]

    assert opener.startswith("生成一段"), "第 1 镜必须以「生成一段〈画幅〉电影片段，讲述……」开头"
    assert re.search(r"生成一段\d+:\d+电影片段，讲述", opener), "总起段要写明画幅和整集剧情"
    assert "音乐以" in opener and "为主奏乐器" in opener, "总起段要写主奏乐器"
    assert "整体情绪" in opener, "总起段要收在整体情绪上"

    # Later shots must not repeat the episode opener.
    for index, frame in enumerate(_skill_example_frames()[1:], start=2):
        assert "音乐以" not in (frame.get("visual_description") or ""), (
            f"第 {index} 镜重复写了音乐说明，总起段只属于第 1 镜"
        )
