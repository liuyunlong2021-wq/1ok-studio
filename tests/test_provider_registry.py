import pytest

from src.utils.model_catalog import build_catalog_dict, build_provider_family_configs, MODEL_CATALOG_ROOT
from src.utils.provider_registry import ProviderFamilyConfig, ProviderRegistry, get_default_provider_registry


class TestProviderRegistryRouting:
    """resolve_backend 的契约：家族前缀 → backend_default，env 可覆盖。

    用注入的合成家族，不靠产品目录：当前目录只有 jiucaihezi 一家，而且模型 id
    是不带家族前缀的扁平名（如 海seedance2.5），匹配不上 routing_prefixes，
    所以目录本身测不了这段逻辑。
    """

    @staticmethod
    def _registry() -> ProviderRegistry:
        registry = ProviderRegistry()
        registry.register_family(
            ProviderFamilyConfig(
                model_family="demo-",
                backend_default="dashscope",
                backend_env_key="DEMO_PROVIDER_MODE",
            )
        )
        return registry

    def test_family_prefix_selects_backend_default(self):
        assert self._registry().resolve_backend("demo-v1") == "dashscope"

    def test_blank_env_falls_back_to_default(self):
        registry = self._registry()

        assert registry.resolve_backend("demo-v1", env={"DEMO_PROVIDER_MODE": ""}) == "dashscope"

    def test_env_override_wins_over_default(self):
        registry = self._registry()

        assert registry.resolve_backend("demo-v1", env={"DEMO_PROVIDER_MODE": "vendor"}) == "vendor"

    def test_invalid_env_value_falls_back_to_default(self):
        registry = self._registry()
        env = {"DEMO_PROVIDER_MODE": "not-a-valid-backend"}

        assert registry.resolve_backend("demo-v1", env=env) == "dashscope"

    def test_unregistered_model_raises(self):
        with pytest.raises(KeyError, match="No provider family registered"):
            self._registry().resolve_backend("no-such-family-v1")

    def test_catalog_derives_no_legacy_provider_family(self):
        """回归护栏：家族收敛成单一 provider 后，目录里不该再派生历史家族。"""
        catalog = build_catalog_dict(MODEL_CATALOG_ROOT)
        families = {config.model_family for config in build_provider_family_configs(catalog)}
        legacy = {
            "kling/", "kling-", "vidu", "vidu/", "pixverse-", "pixverse/",
            "wan2.6-", "wan2.7-", "qwen-image-",
        }

        assert not (families & legacy), f"目录里残留了历史家族: {families & legacy}"

    def test_default_registry_ignores_legacy_provider_models(self):
        """已删除的 provider 模型不该再解析出后端。"""
        registry = get_default_provider_registry()

        for stale_model in ("kling-v1", "vidu2.0", "pixverse-v4-i2v"):
            with pytest.raises(KeyError):
                registry.resolve_backend(stale_model)

    def test_default_registry_fails_loudly_when_catalog_is_unavailable(self, monkeypatch):
        """回归护栏：目录加载不了时必须抛出去。

        曾经这里 try/except 退回一份内置的 DEFAULT_PROVIDER_FAMILIES，里面装着
        已删除的 provider 家族 —— 打包漏带 config/model_catalog/ 时会静默把请求
        路由到适配器已删、也没凭证的通道上，错因完全指不出来。
        """
        import src.utils.provider_registry as registry_module

        def missing_catalog(*_args, **_kwargs):
            raise FileNotFoundError("config/model_catalog/ is not packaged")

        monkeypatch.setattr(registry_module, "load_generated_model_catalog", missing_catalog)

        with pytest.raises(FileNotFoundError):
            registry_module.get_default_provider_registry()

    def test_future_pixverse_family_can_be_registered_without_resolver_changes(self):
        registry = ProviderRegistry()
        registry.register_family(
            ProviderFamilyConfig(
                model_family="pixverse-",
                backend_default="dashscope",
                backend_env_key="PIXVERSE_PROVIDER_MODE",
                credential_sources={
                    "dashscope": ("DASHSCOPE_API_KEY",),
                    "vendor": ("PIXVERSE_API_KEY",),
                },
                supported_modalities=("t2v", "i2v"),
                image_input_mode={
                    "dashscope": "dashscope_image_input",
                    "vendor": "pixverse_vendor_image_input",
                },
                audio_input_mode={
                    "dashscope": "dashscope_temp_file_url",
                    "vendor": "pixverse_vendor_audio_url",
                },
                reference_video_input_mode={
                    "dashscope": "dashscope_temp_file_url",
                    "vendor": "pixverse_vendor_reference_video_url",
                },
            )
        )

        assert registry.resolve_backend("pixverse-v4-i2v") == "dashscope"
        assert (
            registry.resolve_backend(
                "pixverse-v4-i2v",
                env={"PIXVERSE_PROVIDER_MODE": "vendor"},
            )
            == "vendor"
        )

