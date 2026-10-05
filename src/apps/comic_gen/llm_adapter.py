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
import re
import time
import logging
from typing import Dict, List, Optional, Any

from ...utils.endpoints import get_provider_base_url

logger = logging.getLogger(__name__)

# 韭菜盒子链路里"另一个模型也依旧救得回来"的兜底选项。
JIUCAIHEZI_FALLBACK_MODEL = "gpt-5.6-sol"

# 文本请求最多追加一次尝试；SDK 的自动重试关闭，避免叠加重试。
TRANSIENT_STATUS_CODES = {500, 502, 503, 504, 520, 521, 522, 523, 524}
TRANSIENT_TOKENS = ("timeout", "timed out", "connection")
TRANSIENT_RETRY_BACKOFF_SECONDS = 5.0

# 单次 chat 调用的超时秒数。长文生成（如 Motion 提示词要写几千字）经常跑过 60 秒，
# 超时会一路冒泡成 502，把「还在生成」误判成失败。
#
# 客户端超时不能改变网关自身的等待上限；网关返回的错误另行分类和提示。
LLM_TIMEOUT_SECONDS = 180.0
JIUCAIHEZI_TIMEOUT_SECONDS = 180.0


def _gateway_error_status(exc: Exception) -> Optional[int]:
    cause = exc
    for _ in range(6):
        status = getattr(cause, "status_code", None)
        if isinstance(status, int):
            return status
        cause = cause.__cause__
        if cause is None:
            break
    # 兼容调用方提供的旧式 RuntimeError，不从任意请求编号中匹配数字。
    match = re.search(r"(?:error code:|api error:)\s*(\d{3})\b", str(exc), re.IGNORECASE)
    return int(match.group(1)) if match else None


def _is_transient_gateway_error(exc: Exception) -> bool:
    status = _gateway_error_status(exc)
    if status is not None:
        return status in TRANSIENT_STATUS_CODES
    message = str(exc).lower()
    return any(token in message for token in TRANSIENT_TOKENS)


def _readable_gateway_error(exc: Exception) -> str:
    """把 Cloudflare 那一整块 JSON 压成一句能直接展示给用户的话。"""
    status = _gateway_error_status(exc)
    if status not in TRANSIENT_STATUS_CODES and not _is_transient_gateway_error(exc):
        return str(exc)
    descriptions = {
        502: "网关未能从上游取得完整的文本响应",
        503: "文本服务暂时不可用",
        504: "网关等待上游文本响应超时",
        524: "网关等待源站文本响应超时",
    }
    description = descriptions.get(status, "文本服务暂时异常" if status else "文本请求连接中断或超时")
    message = f"文本生成失败：{description}"
    if status:
        message += f"（HTTP {status}）"
    message += "。自动重试后仍未成功，请稍后重试；持续失败时，请检查网关日志。"

    # SDK 原始异常保留响应头和错误正文；只展示排查编号，全文留在日志中。
    request_id = ray_id = None
    cause = exc
    for _ in range(6):
        response = getattr(cause, "response", None)
        headers = getattr(response, "headers", {})
        body = getattr(cause, "body", None)
        request_id = request_id or getattr(cause, "request_id", None) or headers.get("x-request-id")
        ray_id = ray_id or headers.get("cf-ray")
        if isinstance(body, dict):
            ray_id = ray_id or body.get("ray_id")
        cause = cause.__cause__
        if cause is None:
            break
    for label, identifier in (("请求编号", request_id), ("Cloudflare Ray ID", ray_id)):
        if identifier:
            identifier = re.sub(r"[^\w.-]", "", str(identifier))[:128]
            message += f" [{label}: {identifier}]"
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
                from openai import OpenAI, DefaultHttpxClient
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
                # HTTPX also discovers macOS system proxies through getproxies().
                # A desktop proxy can silently route this gateway overseas and
                # close long requests before any response headers arrive.
                http_client=DefaultHttpxClient(
                    trust_env=False, timeout=JIUCAIHEZI_TIMEOUT_SECONDS,
                ),
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

    def chat_images(self, messages: List[Dict[str, Any]]) -> str:
        """Use the configured model for actual image input, without fallback to another model."""
        model = self._get_default_model()
        label = {"jiucaihezi": "Jiucaihezi", "openai": "OpenAI", "dashscope": "DashScope"}.get(self.provider, "Jiucaihezi")
        try:
            return self._chat_once(self._get_client(), model, messages, None, label)
        except RuntimeError as exc:
            raise RuntimeError(f"当前文本模型 {model} 的读图请求失败，请确认模型及通道支持图片输入；未降级为纯文字。{exc}") from exc

    def _chat_jiucaihezi(
        self,
        model: str,
        messages: List[Dict[str, str]],
        response_format: Optional[Dict[str, str]],
    ) -> str:
        """网关临时故障退避后最多再尝试一次，并统一最终失败提示。"""
        client = self._get_jiucaihezi_client()
        try:
            return self._chat_once(client, model, messages, response_format, "Jiucaihezi")
        except RuntimeError as exc:
            if not _is_transient_gateway_error(exc):
                raise
            retry_model = JIUCAIHEZI_FALLBACK_MODEL
            logger.warning(
                "Text request transient failure: model=%s status=%s; retrying once with %s in %.0fs",
                model, _gateway_error_status(exc), retry_model, TRANSIENT_RETRY_BACKOFF_SECONDS,
            )
            time.sleep(TRANSIENT_RETRY_BACKOFF_SECONDS)
            try:
                return self._chat_once(
                    client, retry_model, messages, response_format, "Jiucaihezi"
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

        started = time.monotonic()
        try:
            if provider_label == "Jiucaihezi":
                # Receive chunks while generation is running; waiting for the
                # whole response can exceed the gateway's idle read timeout.
                stream = client.chat.completions.create(**kwargs, stream=True)
                parts = []
                finish_reason = None
                try:
                    for chunk in stream:
                        if not chunk.choices:
                            continue
                        choice = chunk.choices[0]
                        if choice.delta.content:
                            parts.append(choice.delta.content)
                        if choice.finish_reason:
                            finish_reason = choice.finish_reason
                finally:
                    stream.close()
                if finish_reason != "stop":
                    raise RuntimeError(
                        f"文本流未完整结束（finish_reason={finish_reason or 'missing'}），请重试；未采用不完整正文"
                    )
                content = "".join(parts)
                if not content.strip():
                    raise RuntimeError("模型返回了空正文，请重试")
                return content
            response = client.chat.completions.create(**kwargs)
            return response.choices[0].message.content
        except Exception as e:
            label = provider_label or {
                "openai": "OpenAI",
                "dashscope": "DashScope",
            }.get(self.provider, "韭菜盒子")
            causes = []
            cause = e.__cause__
            while cause is not None and len(causes) < 5:
                causes.append(f"{type(cause).__name__}: {cause}")
                cause = cause.__cause__
            detail = str(e)
            if causes:
                detail += " | " + " -> ".join(causes)
            # Do not include credentials even if an upstream error echoes one.
            for env_key in ("JIUCAIHEZI_API_KEY", "OPENAI_API_KEY", "DASHSCOPE_API_KEY"):
                secret = os.getenv(env_key)
                if secret:
                    detail = detail.replace(secret, "[redacted]")
            logger.error(
                "Text request failed: provider=%s model=%s elapsed=%.2fs status=%s request_id=%s detail=%s",
                label, model, time.monotonic() - started,
                getattr(e, "status_code", None), getattr(e, "request_id", None), detail,
            )
            raise RuntimeError(f"{label} API error [model={model}]: {detail}") from e
