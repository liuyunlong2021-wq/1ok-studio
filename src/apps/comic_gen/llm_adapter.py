"""
LLM Adapter - Unified interface for DashScope and OpenAI-compatible APIs.

Supports two providers:
  - dashscope (default): Alibaba Cloud DashScope via OpenAI-compatible endpoint
  - openai: Any OpenAI-compatible API (OpenAI, DeepSeek, Ollama, etc.)

Configuration via environment variables:
  LLM_PROVIDER=dashscope|openai
  DASHSCOPE_API_KEY=...
  OPENAI_API_KEY=...
  OPENAI_BASE_URL=https://api.openai.com/v1
  OPENAI_MODEL=gpt-4o
"""
import os
import time
import logging
from typing import Dict, List, Optional, Any

from ...utils.endpoints import get_provider_base_url

logger = logging.getLogger(__name__)

JIUCAIHEZI_MODELS = {
    "claude-fable-5-1",
    "claude-sonnet-5",
    "deepseek-v4-pro-0813",
    "deepseek-v4-flash",
    "gemini-3.8-flash",
    "gpt-5.6-sol",
}

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
# 注意：韭菜盒子经 Cloudflare，边缘的代理读超时是 120 秒。客户端超时必须比它短，
# 否则永远等不到自己的超时，只会拿到边缘的 524。
LLM_TIMEOUT_SECONDS = 180.0
JIUCAIHEZI_TIMEOUT_SECONDS = 115.0


def _is_transient_gateway_error(exc: Exception) -> bool:
    message = str(exc).lower()
    return any(token in message for token in TRANSIENT_TOKENS)


def _readable_gateway_error(exc: Exception) -> str:
    """把 Cloudflare 那一整块 JSON 压成一句能直接展示给用户的话。"""
    message = str(exc)
    if "524" in message:
        return (
            "Jiucaihezi 网关超时（524）：源站没有在 Cloudflare 的 120 秒代理读超时内返回。"
            "这通常是网关侧瞬时过载，等 1-2 分钟后重试；若持续出现，可在项目设置里"
            "换一个更快的文本模型，或把剧本拆短后再生成。"
        )
    return message


class LLMAdapter:
    """Unified LLM call interface supporting DashScope and OpenAI-compatible APIs."""

    def __init__(self):
        self.provider = os.getenv("LLM_PROVIDER", "dashscope").lower()
        self._client = None
        self._jiucaihezi_client = None
        logger.info(f"LLM Adapter initialized with provider: {self.provider}")

    @property
    def is_configured(self) -> bool:
        if self.provider == "openai":
            return bool(os.getenv("OPENAI_API_KEY"))
        return bool(os.getenv("DASHSCOPE_API_KEY") or os.getenv("JIUCAIHEZI_API_KEY"))

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
            else:
                # DashScope uses OpenAI-compatible endpoint
                self._client = OpenAI(
                    api_key=os.getenv("DASHSCOPE_API_KEY"),
                    base_url=f"{get_provider_base_url('DASHSCOPE')}/compatible-mode/v1",
                    timeout=LLM_TIMEOUT_SECONDS,
                    max_retries=0,
                )
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
        if self.provider == "openai":
            return os.getenv("OPENAI_MODEL", "gpt-4o")
        return self._DASHSCOPE_MODEL_FALLBACK_CHAIN[0]

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
        if model in JIUCAIHEZI_MODELS:
            client = self._get_jiucaihezi_client()
            try:
                return self._chat_once(
                    client, model, messages, response_format, "Jiucaihezi"
                )
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

        # When only the Jiucaihezi credential is configured, do not silently
        # fall through to DashScope's default qwen model.
        if not model and self.provider != "openai" and os.getenv("JIUCAIHEZI_API_KEY") and not os.getenv("DASHSCOPE_API_KEY"):
            return self._chat_once(
                self._get_jiucaihezi_client(), JIUCAIHEZI_FALLBACK_MODEL, messages, response_format, "Jiucaihezi"
            )

        client = self._get_client()

        # 显式 model override 路径：单次尝试，失败就抛。
        if model:
            return self._chat_once(client, model, messages, response_format)

        # Provider 默认路径：DashScope 走 fallback chain，OpenAI 单次尝试。
        if self.provider == "openai":
            return self._chat_once(client, self._get_default_model(), messages, response_format)

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
            label = provider_label or ("DashScope" if self.provider != "openai" else "OpenAI")
            raise RuntimeError(f"{label} API error: {e}") from e
