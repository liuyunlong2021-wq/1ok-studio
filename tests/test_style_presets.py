"""风格预设库的数据契约。

`style_presets.json` 是纯数据，但三种写坏方式都是**静默**的：

- JSON 语法错 → `/art_direction/presets` 直接 500，风格面板整块空掉；
- `category` 指向不存在的分类 → 前端按分类过滤，这条风格永远不出现；
- `thumbnail` 路径写错 → 卡片只显示占位图标，看不出是路径错了（`thumbnail: null`
  是合法值，表示「有意留占位」）。

`positive_prompt` / `negative_prompt` 是唯一影响生图的字段（`assets.py` 把它们
拼进模型 prompt 后缀），所以额外挡住中文注释和未展开的 `[...]` 分支块 —— 从外部
图库抄条目时最容易把 `(铁线描)`、`[TONE SELECTION — choose one:]` 这类带进来。

跑法：
    python -m pytest tests/test_style_presets.py
"""

import json
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
PRESETS_FILE = REPO / "src/apps/comic_gen/style_presets.json"
PUBLIC_DIR = REPO / "frontend/public"

REQUIRED_FIELDS = {
    "id",
    "category",
    "name",
    "name_zh",
    "positive_prompt",
    "negative_prompt",
    "thumbnail",
}


def _load() -> dict:
    return json.loads(PRESETS_FILE.read_text(encoding="utf-8"))


class TestStylePresets:
    def test_ids_and_categories_are_consistent(self):
        data = _load()
        assert data["version"] == 2

        preset_ids = [p["id"] for p in data["presets"]]
        assert len(preset_ids) == len(set(preset_ids)), "preset id 重复"

        category_ids = [c["id"] for c in data["categories"]]
        assert len(category_ids) == len(set(category_ids)), "category id 重复"

        for preset in data["presets"]:
            missing = REQUIRED_FIELDS - set(preset)
            assert not missing, f"{preset['id']} 缺字段 {missing}"
            assert preset["category"] in category_ids, f"{preset['id']} 的 category 不存在"

    def test_thumbnails_resolve(self):
        for preset in _load()["presets"]:
            if not preset["thumbnail"]:
                continue  # null = 有意留占位，合法
            path = PUBLIC_DIR / preset["thumbnail"].lstrip("/")
            assert path.is_file(), f"{preset['id']} 缩略图不存在: {preset['thumbnail']}"

    def test_prompts_are_model_ready_english(self):
        for preset in _load()["presets"]:
            for field in ("positive_prompt", "negative_prompt"):
                value = preset[field]
                assert value.strip(), f"{preset['id']}.{field} 为空"
                assert not re.search(r"[\u4e00-\u9fff]", value), f"{preset['id']}.{field} 含中文"
                assert not re.search(r"\[[^\]]*\]", value), f"{preset['id']}.{field} 含未展开分支块"
                assert not value.endswith("."), f"{preset['id']}.{field} 末尾多余句点"

    def test_topic_tags_follow_the_library_convention(self):
        """`best_for` 3–5 个、`avoid_for` 2–4 个：AI 推荐靠这两个字段排除错误风格，
        太窄选不中、太宽挡不住。"""
        for preset in _load()["presets"]:
            assert 3 <= len(preset.get("best_for", [])) <= 5, f"{preset['id']}.best_for"
            assert 2 <= len(preset.get("avoid_for", [])) <= 4, f"{preset['id']}.avoid_for"
