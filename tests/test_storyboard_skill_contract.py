"""Contract check for the storyboard-inline-camera skill.

分镜解析只认契约里列出的那批字段（`storyboard_contract.REQUIRED_FRAME_KEYS`），
技能示例里多出来的键会被静默丢掉 —— 写了等于没写（当年写这个技能时正是这么踩的）。
实际链路：技能输出 → `storyboard_contract.validate_storyboard_frames` 校验 →
`engineering_script` 落成 StoryboardFrame。

所以这个测试守两件事：① 技能示例的字段与契约**完全一致**；
② 第 1 镜的影像基调段按技能自己的规则写全。

Run: `python -m pytest tests/test_storyboard_skill_contract.py -q`
"""

import json
import re
from pathlib import Path

from src.apps.comic_gen.storyboard_contract import REQUIRED_FRAME_KEYS

REPO_ROOT = Path(__file__).resolve().parents[1]
SKILL_PATH = REPO_ROOT / "skills" / "storyboard-inline-camera" / "SKILL.md"


def _skill_example_frames() -> list:
    """The `{"frames": [...]}` example embedded in the skill."""
    text = SKILL_PATH.read_text(encoding="utf-8")
    for block in re.findall(r"```json\n(.*?)```", text, flags=re.DOTALL):
        payload = json.loads(block)
        if isinstance(payload, dict) and payload.get("frames"):
            return payload["frames"]
    raise AssertionError("skill has no parsable {\"frames\": [...]} example")


def test_skill_example_matches_the_contract_exactly():
    required = set(REQUIRED_FRAME_KEYS)

    for index, frame in enumerate(_skill_example_frames(), start=1):
        assert isinstance(frame, dict), f"frame {index} is not an object"
        unknown = set(frame) - required
        assert not unknown, (
            f"frame {index} emits {sorted(unknown)}, which "
            f"validate_storyboard_frames drops. Either remove them from the skill or "
            f"wire them up in storyboard_contract.py."
        )
        missing = required - set(frame)
        assert not missing, (
            f"frame {index} is missing {sorted(missing)}, which the contract requires"
        )


def test_skill_keeps_the_template_placeholders():
    """`analyze_to_storyboard` substitutes these; missing ones mean the model
    never receives the script at all."""
    text = SKILL_PATH.read_text(encoding="utf-8")
    for placeholder in ("{entities_str}", "{text}"):
        assert placeholder in text, f"skill lost {placeholder} — the call would send no script content"


def test_first_shot_carries_the_look_and_feel_opener():
    """只有第 1 镜在 visual_description 开头写影像基调（类型题材 / 画幅 / 调色 /
    光线 / 焦段 / 构图），且不预述整集剧情、不把音乐当成本镜已发生的事件。"""
    opener = _skill_example_frames()[0]["visual_description"]

    assert opener.startswith("现实主义情感短剧"), "第 1 镜开头应是影像基调段"
    for token in ("9:16", "色调", "光", "焦段", "构图"):
        assert token in opener, f"影像基调要写清「{token}」"
    assert "音乐" not in opener, "第 1 镜不预述整集声音与音乐"
