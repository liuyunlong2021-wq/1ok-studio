import os
from dataclasses import dataclass, field, replace
from typing import Dict, Mapping, Optional, Sequence, Tuple

from .model_catalog import build_provider_family_configs, load_generated_model_catalog

SUPPORTED_PROVIDER_BACKENDS = ("dashscope", "vendor", "mulerouter", "jiucaihezi")


@dataclass
class ProviderFamilyConfig:
    model_family: str
    backend_default: str = "dashscope"
    backend_env_key: Optional[str] = None
    credential_sources: Dict[str, Tuple[str, ...]] = field(default_factory=dict)
    supported_modalities: Tuple[str, ...] = field(default_factory=tuple)
    image_input_mode: Dict[str, str] = field(default_factory=dict)
    audio_input_mode: Dict[str, str] = field(default_factory=dict)
    reference_video_input_mode: Dict[str, str] = field(default_factory=dict)


class ProviderRegistry:
    """Data-driven provider routing registry keyed by model family prefix."""

    def __init__(self, families: Optional[Sequence[ProviderFamilyConfig]] = None):
        self._families: Dict[str, ProviderFamilyConfig] = {}
        for family in families or ():
            self.register_family(family)

    def register_family(self, config: ProviderFamilyConfig) -> None:
        family = (config.model_family or "").strip().lower()
        if not family:
            raise ValueError("model_family cannot be empty")
        backend_default = (config.backend_default or "").strip().lower()
        if backend_default not in SUPPORTED_PROVIDER_BACKENDS:
            raise ValueError(f"Unsupported backend_default: {config.backend_default}")
        self._families[family] = replace(
            config,
            model_family=family,
            backend_default=backend_default,
        )

    def get_family_config(self, model_name: str) -> ProviderFamilyConfig:
        normalized = (model_name or "").strip().lower()
        if not normalized:
            raise ValueError("model_name cannot be empty")

        for family in sorted(self._families.keys(), key=len, reverse=True):
            if normalized.startswith(family):
                return self._families[family]
        raise KeyError(f"No provider family registered for model '{model_name}'")

    def resolve_backend(self, model_name: str, env: Optional[Mapping[str, str]] = None) -> str:
        family = self.get_family_config(model_name)
        mode = ""
        if family.backend_env_key:
            env_mapping = env if env is not None else os.environ
            mode = (env_mapping.get(family.backend_env_key) or "").strip().lower()

        if mode in SUPPORTED_PROVIDER_BACKENDS:
            return mode
        return family.backend_default


def get_default_provider_registry() -> ProviderRegistry:
    """ProviderRegistry，唯一事实源是生成的目录数据。

    目录加载失败就直接抛出去，**不要**退回任何内置家族列表。曾经这里有一份
    DEFAULT_PROVIDER_FAMILIES 兜底，装着 kling / vidu / pixverse / wan2.6 等已删除的
    provider：目录缺失时它会静默生效，把请求路由到适配器已删、也没凭证的通道上，
    报出来的错跟真正的原因（目录没打进包）毫无关系。
    """
    catalog = load_generated_model_catalog()
    return ProviderRegistry(build_provider_family_configs(catalog))


def resolve_provider_backend(model_name: str, env: Optional[Mapping[str, str]] = None) -> str:
    return get_default_provider_registry().resolve_backend(model_name=model_name, env=env)


# ---------------------------------------------------------------------------
# Phase 2: Gateway metadata inspection (read-only, no routing changes)
# ---------------------------------------------------------------------------

def get_gateway_for_model(
    model_id: str,
    backend: Optional[str] = None,
) -> Optional[str]:
    """Inspect the gateway metadata for a model (flat or canonical ID).

    This is a read-only diagnostic helper.  It does NOT change routing
    behavior — current routing remains family-prefix based.
    """
    from .model_catalog import get_catalog_accessor

    accessor = get_catalog_accessor()
    canonical_id = accessor.resolve_legacy_to_canonical(model_id)
    if canonical_id is None:
        canonical_id = model_id  # already canonical or unknown

    resolved_backend = backend or "dashscope"
    return accessor.get_gateway(canonical_id, resolved_backend)
