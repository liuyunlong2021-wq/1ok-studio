"""
LLM Adapter - 统一文本调用入口。

产品只有一条文本通道：**韭菜盒子网关**（与图像 / 视频共用同一把 key）。
`LLM_PROVIDER` 只用来显式 opt-in 两条历史通道，单家族构建里不该有人命中：

  （默认 / 未设置）      → 韭菜盒子网关
  LLM_PROVIDER=openai    → 任意 OpenAI 兼容 API
                           （OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL）
  LLM_PROVIDER=dashscope → 阿里云百炼（DASHSCOPE_API_KEY）

`LLM_PROVIDER` 曾经默认是 `dashscope`，而且有一条「只要环境里存在
DASHSCOPE_API_KEY 就不走韭菜盒子」的守卫 —— 仓库 `.env` 里一个陈旧的 DashScope
key 就能把整条文本链路打回 401 Incorrect API key。现在默认通道固定为韭菜盒子，
DashScope 必须被显式选中才启用。
"""
import os
import time
import logging
from typing import Dict, List, Optional, Any

from ...utils.endpoints import get_provider_base_url

logger = logging.getLogger(__name__)

# 韭菜盒子链路里"另一个模型也依旧救得回来"的兜底选项。
JIUCAIHEZI_FALLBACK_MODEL = "gpt-5.6-sol"

# 网关源站超过 Cloudflare 的 120 秒代理读超时后回 524。这多半是源站瞬时过载，
# Cloudflare 自己的建议就是稍等重试，所以对同一个模型再试一次。退避时间刻意
# 不照抄它建议的 120 秒——后台任务干等两分钟不如快速失败让用户重试。
TRANSIENT_TOKENS = ("524", "timeout", "timed out", "connection")
TRANSIENT_RETRY_BACKOFF_SECONDS = 5.0

# 单次 chat 调用的超时秒数。长文生成（如 Motion 提示词要写几千字）经常跑过 60 秒，
# 超时会一路冒泡成 502，把「还在生成」误判成失败。
#
# 韭菜盒子在 Cloudflare 后面，边缘的 Proxy Read Timeout **默认 125 秒**
# （官方文档；实测 524 正好在 125.2 秒回来）。所以客户端超时比它长时，
# 超过 125 秒的请求会先被边缘抓成 524 —— 这不是坏事，524 会经
# _readable_gateway_error() 翻成人话再展示。
# 想真正放开长任务，得先把长耗时接口挪到不经 CF 的灰云子域，或开 Enterprise 调
# zone 的 proxy_read_timeout —— 单改这里的数字没用。
LLM_TIMEOUT_SECONDS = 180.0
JIUCAIHEZI_TIMEOUT_SECONDS = 180.0


def _is_transient_gateway_error(exc: Exception) -> bool:
    message = str(exc).lower()
    return any(token in message for token in TRANSIENT_TOKENS)


def _readable_gateway_error(exc: Exception) -> str:
    """把 Cloudflare 那一整块 JSON 压成一句能直接展示给用户的话。"""
    message = str(exc)
    if "524" in message:
        return (
            "Jiucaihezi 网关超时（524）：源站没有在 Cloudflare 的 125 秒代理读超时"
            "（Proxy Read Timeout）内返回。这通常是网关侧瞬时过载，等 1-2 分钟后重试；"
            "若持续出现，可在项目设置里换一个更快的文本模型，或把剧本拆短后再生成。"
        )
    return message


class LLMAdapter:
    """Unified LLM call interface supporting DashScope and OpenAI-compatible APIs."""

    def __init__(self):
        # 默认通道 = 韭菜盒子。`LLM_PROVIDER` 只在显式设置时才覆盖 ——
        # 曾经默认值是 "dashscope"，于是一个没配百炼 key 的用户点任何
        # 「AI 生成」都会拿到一句带 DashScope 字样的 401。
        self.provider = (os.getenv("LLM_PROVIDER") or "").strip().lower() or "jiucaihezi"
        self._client = None
        self._jiucaihezi_client = None
        logger.info(f"LLM Adapter initialized with provider: {self.provider}")

    @property
    def is_configured(self) -> bool:
        if self.provider == "openai":
            return bool(os.getenv("OPENAI_API_KEY"))
        if self.provider == "dashscope":
            return bool(os.getenv("DASHSCOPE_API_KEY"))
        return bool(os.getenv("JIUCAIHEZI_API_KEY"))

    def _get_client(self):
        """Get or create the OpenAI-compatible client (lazy, cached)."""
        if self._client is None:
            try:
                from openai import OpenAI
            except ImportError:
                raise RuntimeError(
                    "openai package not installed. Run: pip install openai>=1.0.0"
                )

            if self.provider == "openai":
                self._client = OpenAI(
                    api_key=os.getenv("OPENAI_API_KEY"),
                    base_url=os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1"),
                    timeout=LLM_TIMEOUT_SECONDS,
                    max_retries=0,
                )
            elif self.provider == "dashscope":
                # 历史通道，只在 LLM_PROVIDER=dashscope 时启用
                self._client = OpenAI(
                    api_key=os.getenv("DASHSCOPE_API_KEY"),
                    base_url=f"{get_provider_base_url('DASHSCOPE')}/compatible-mode/v1",
                    timeout=LLM_TIMEOUT_SECONDS,
                    max_retries=0,
                )
            else:
                # 默认通道：与图像 / 视频同一个网关、同一把 key。
                self._client = self._get_jiucaihezi_client()
        return self._client

    def _get_jiucaihezi_client(self):
        if self._jiucaihezi_client is None:
            key = os.getenv("JIUCAIHEZI_API_KEY")
            if not key:
                raise RuntimeError("JIUCAIHEZI_API_KEY not configured")
            try:
                from openai import OpenAI
            except ImportError:
                raise RuntimeError("openai package not installed. Run: pip install openai>=1.0.0")
            base_url = get_provider_base_url("JIUCAIHEZI")
            if not base_url.endswith("/v1"):
                base_url += "/v1"
            self._jiucaihezi_client = OpenAI(
                api_key=key,
                base_url=base_url,
                timeout=JIUCAIHEZI_TIMEOUT_SECONDS,
                max_retries=0,
            )
        return self._jiucaihezi_client

    # DashScope qwen 系列：首选 qwen3.7-plus（最新），不可用时回退到 qwen3.6-plus，
    # 最终回退到 qwen-plus alias（始终指向最新稳定通用版）。
    # 维护 fallback chain 而不是硬写一个名字，避免新版本上下线时整条 LLM 链断掉。
    _DASHSCOPE_MODEL_FALLBACK_CHAIN = ["qwen3.7-plus", "qwen3.6-plus", "qwen-plus"]

    def _get_default_model(self) -> str:
        """未显式指定 model 时用哪个。

        韭菜盒子通道优先用「设置 → 文本模型」里选中的那一个（全局单一事实源），
        用户没选过才回落到网关的稳定兜底模型。
        """
        if self.provider == "openai":
            return os.getenv("OPENAI_MODEL", "gpt-4o")
        if self.provider == "dashscope":
            return self._DASHSCOPE_MODEL_FALLBACK_CHAIN[0]
        from ...utils.global_settings import get_active_text_model
        return get_active_text_model() or JIUCAIHEZI_FALLBACK_MODEL

    def chat(
        self,
        messages: List[Dict[str, str]],
        model: Optional[str] = None,
        response_format: Optional[Dict[str, str]] = None,
    ) -> str:
        """
        Send a chat completion request and return the response content.

        Args:
            messages: List of {"role": ..., "content": ...} dicts
            model: Model name override (uses provider default if None)
            response_format: Optional {"type": "json_object"} constraint

        Returns:
            The assistant's response content as a string.

        Raises:
            RuntimeError: If the API call fails.
        """
        # Model ids are stored canonically in lowercase; tolerate UI/API callers
        # sending the vendor's mixed-case spelling as well.
        model = model.lower() if isinstance(model, str) else model

        if self.provider == "openai":
            return self._chat_once(
                self._get_client(),
                model or self._get_default_model(),
                messages,
                response_format,
                "OpenAI",
            )
        if self.provider == "dashscope":
            return self._chat_dashscope(model, messages, response_format)

        # 产品默认通道。目录里的模型 id 与「没指定模型」都落在这里。
        return self._chat_jiucaihezi(
            model or self._get_default_model(), messages, response_format
        )

    def _chat_jiucaihezi(
        self,
        model: str,
        messages: List[Dict[str, str]],
        response_format: Optional[Dict[str, str]],
    ) -> str:
        """韭菜盒子通道：瞬时故障换兜底模型，已在兜底模型上则原地退避重试一次。"""
        client = self._get_jiucaihezi_client()
        try:
            return self._chat_once(client, model, messages, response_format, "Jiucaihezi")
        except RuntimeError as exc:
            if not _is_transient_gateway_error(exc):
                raise
            if model != JIUCAIHEZI_FALLBACK_MODEL:
                logger.warning(
                    "%s failed temporarily; falling back to %s",
                    model,
                    JIUCAIHEZI_FALLBACK_MODEL,
                )
                return self._chat_once(
                    client,
                    JIUCAIHEZI_FALLBACK_MODEL,
                    messages,
                    response_format,
                    "Jiucaihezi",
                )
            # 已经在兜底模型上：换模型这条退路不存在，但"网关瞬时过载"仍然
            # 值得按 Cloudflare 的建议重试一次。旧代码在这里直接 raise，
            # 于是一次重试都没发生，用户只看到一整块 Cloudflare JSON。
            logger.warning(
                "%s transient failure (%s); retrying once in %.0fs",
                model,
                exc,
                TRANSIENT_RETRY_BACKOFF_SECONDS,
            )
            time.sleep(TRANSIENT_RETRY_BACKOFF_SECONDS)
            try:
                return self._chat_once(
                    client, model, messages, response_format, "Jiucaihezi"
                )
            except RuntimeError as retry_exc:
                raise RuntimeError(_readable_gateway_error(retry_exc)) from None

    def _chat_dashscope(
        self,
        model: Optional[str],
        messages: List[Dict[str, str]],
        response_format: Optional[Dict[str, str]],
    ) -> str:
        """历史通道：显式 model 单次尝试；未指定则走 qwen 版本兜底链。"""
        client = self._get_client()

        if model:
            return self._chat_once(client, model, messages, response_format)

        last_err: Optional[Exception] = None
        for idx, candidate in enumerate(self._DASHSCOPE_MODEL_FALLBACK_CHAIN):
            try:
                return self._chat_once(client, candidate, messages, response_format)
            except RuntimeError as e:
                # 仅在 "模型不存在 / 不可用" 类错误时回退；其他错误（鉴权、限流、网络）
                # 直接抛，不浪费第二次重试。判定关键字宽松匹配 DashScope 文案。
                msg = str(e).lower()
                is_model_unavailable = any(k in msg for k in (
                    "model not found", "invalidmodel", "model_not_found",
                    "no such model", "not supported", "modelnotfound", "404",
                ))
                last_err = e
                if is_model_unavailable and idx < len(self._DASHSCOPE_MODEL_FALLBACK_CHAIN) - 1:
                    next_candidate = self._DASHSCOPE_MODEL_FALLBACK_CHAIN[idx + 1]
                    logger.warning(
                        "DashScope model %s unavailable (%s); falling back to %s",
                        candidate, e, next_candidate,
                    )
                    continue
                raise
        # 理论上不可达（最后一次失败已 raise），保留兜底
        raise last_err if last_err else RuntimeError("DashScope: no models available")

    def _chat_once(
        self,
        client,
        model: str,
        messages: List[Dict[str, str]],
        response_format: Optional[Dict[str, str]],
        provider_label: Optional[str] = None,
    ) -> str:
        kwargs: Dict[str, Any] = {
            "model": model,
            "messages": messages,
        }
        if response_format:
            kwargs["response_format"] = response_format

        try:
            response = client.chat.completions.create(**kwargs)
            return response.choices[0].message.content
        except Exception as e:
            label = provider_label or {
                "openai": "OpenAI",
                "dashscope": "DashScope",
            }.get(self.provider, "韭菜盒子")
            raise RuntimeError(f"{label} API error: {e}") from e
