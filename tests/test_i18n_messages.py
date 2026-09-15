"""`frontend/messages/*.json` 的重复键守卫。

为什么要单独扫一遍原始文本：`JSON.parse` / `json.loads` 遇到同名键是**静默的
后者覆盖前者**，所以前端那条「zh 与 en 键结构一致」的测试永远发现不了重复键
—— 两边都重复、名字还一样，比较出来的键集合完全相等。

2026-09-15 真踩过：往 `playground` 里加文案时插了一个已经存在的 `media` 键，
整块新文案被悄悄吞掉，测试全绿，界面上直接显示原始 key（`playground.media.open`）。

跑法：
    python -m pytest tests/test_i18n_messages.py
"""

import json
from collections import Counter
from pathlib import Path

import pytest

MESSAGES_DIR = Path(__file__).resolve().parents[1] / "frontend/messages"
LOCALES = ("zh", "en")


def _duplicate_keys(raw: str) -> list:
    """返回所有重复键的名字（含嵌套层级）。

    `object_pairs_hook` 拿得到解析中的原始键值对列表，是唯一能在标准库里看见
    重复键的位置 —— 返回值一旦组装成 dict，重复信息就没了。
    """
    duplicates: list = []

    def hook(pairs):
        counts = Counter(key for key, _ in pairs)
        duplicates.extend(key for key, count in counts.items() if count > 1)
        return dict(pairs)

    json.loads(raw, object_pairs_hook=hook)
    return duplicates


@pytest.mark.parametrize("locale", LOCALES)
def test_no_duplicate_keys(locale):
    path = MESSAGES_DIR / f"{locale}.json"
    duplicates = _duplicate_keys(path.read_text(encoding="utf-8"))
    assert not duplicates, f"{path.name} 存在重复键（后者会静默覆盖前者）: {duplicates}"
