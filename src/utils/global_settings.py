"""全局文本模型 —— 单一事实源。

**为什么需要这个模块。** 文本模型原来能由**四个**地方决定：

1. `project.model_settings.text_model`（项目级）
2. `series.model_settings.text_model`（系列级）
3. `project/series.prompt_config.polish_model`（「润色模型」，还有一条自己的
   episode → series → 目录默认 的三级链）
4. 剧本标准化弹窗里的一次性覆盖（请求体里的 `model` / `polish_model`）

再加上设置页那份「全局默认」存在**浏览器 localStorage** 里 —— 后端根本读不到。
四处并存时，「我在设置里改一次、全局都跟着走」在结构上就不可能成立：改了全局，
存量项目和系列里各自固化着的那份照旧生效。

这里把它收敛成一个值，落盘在 `output/settings.json`，后端可直接读。

**兼容性。** 文件不存在时回落到目录默认值（`get_default_model_settings().text_model`），
所以上线那一刻行为与之前完全一致，不需要迁移脚本；项目/系列里存的那份
`text_model` 只是不再被读取，保留着以便回滚。
"""

import json
import logging
import os
import threading

from .model_catalog import get_default_model_settings

logger = logging.getLogger(__name__)

SETTINGS_FILE = "output/settings.json"
_TEXT_MODEL_KEY = "text_model"

# 设置文件可能被并发写（handler 跑在 anyio 线程池里，彼此自由重叠）。
_lock = threading.Lock()


def _default_text_model() -> str:
    return (get_default_model_settings().text_model or "").strip()


def _read_raw() -> dict:
    """读设置文件。缺失或损坏一律当「没有设置」，不抛异常。

    这个文件只决定用哪个模型；读不出来最多是回落到默认值，为它把整条生成
    链路打挂不划算。
    """
    try:
        with open(SETTINGS_FILE, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as error:
        logger.warning("Failed to read %s, using defaults: %s", SETTINGS_FILE, error)
        return {}
    return data if isinstance(data, dict) else {}


def get_global_text_model() -> str:
    """当前全局文本模型；未设置时回落目录默认值。"""
    configured = _read_raw().get(_TEXT_MODEL_KEY)
    if isinstance(configured, str) and configured.strip():
        return configured.strip()
    return _default_text_model()


def set_global_text_model(model: str) -> str:
    """写入全局文本模型，返回落盘后的值。

    只动 `text_model` 这一个键：这个文件以后会长别的设置，整份重写会误伤同目录
    的其它键。传空串 = 清除设置、回到目录默认值。
    """
    cleaned = (model or "").strip()
    with _lock:
        data = _read_raw()
        if cleaned:
            data[_TEXT_MODEL_KEY] = cleaned
        else:
            data.pop(_TEXT_MODEL_KEY, None)
        directory = os.path.dirname(SETTINGS_FILE)
        if directory:
            os.makedirs(directory, exist_ok=True)
        with open(SETTINGS_FILE, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2, ensure_ascii=False)
    return get_global_text_model()


def get_active_text_model() -> str:
    """交给 LLMAdapter 的文本模型；空串 = 用 adapter 自己的默认链路。

    没有韭菜盒子凭证时返回空串：全局设置里存的是韭菜盒子的模型 id，硬塞给
    DashScope 只会得到「模型不存在」。（这条守卫原来写在
    `pipeline.get_effective_polish_model` 里，语义不变。）
    """
    if not os.getenv("JIUCAIHEZI_API_KEY"):
        return ""
    return get_global_text_model()
