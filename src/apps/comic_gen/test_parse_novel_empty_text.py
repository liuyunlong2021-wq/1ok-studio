"""空正文不该去打模型。

背景（2026-09-22 用户实测）：新建的集里一个字都没有，界面上却弹出「剧本解析失败」。
`parse_novel` 以前不校验正文，空串照样发给模型 —— 白花一次调用，失败时的文案还会
让人以为"我什么都没干它就失败了"。现在空正文在**碰 LLM 之前**就断掉。

护栏两条：① 空/纯空白正文不调用 `llm.chat`；② 报的是「剧本为空」这种能照着做的
提示，而不是把模型的报错糊上来。
"""

import os
import sys
from unittest.mock import Mock

import pytest

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../..")))

from src.apps.comic_gen.llm import ScriptProcessor


def _processor(response='{"characters": [], "scenes": [], "props": [], "frames": []}'):
    processor = ScriptProcessor.__new__(ScriptProcessor)
    processor.llm = Mock(is_configured=True)
    processor.llm.chat.return_value = response
    return processor


@pytest.mark.parametrize("text", ["", "   ", "\n\t  \n"])
def test_empty_text_never_reaches_the_model(text):
    processor = _processor()

    with pytest.raises(ValueError) as excinfo:
        processor.parse_novel("1", text, "", "")

    assert "剧本为空" in str(excinfo.value)
    processor.llm.chat.assert_not_called()


def test_non_empty_text_still_parses():
    processor = _processor()

    script = processor.parse_novel("1", "第1集 场1-1 白天", "", "")

    assert processor.llm.chat.call_count == 1
    assert script is not None
