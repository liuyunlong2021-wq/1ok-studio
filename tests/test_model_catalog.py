import json
from copy import deepcopy
from pathlib import Path

import pytest
import yaml

from src.utils.model_catalog import (
    MODEL_CATALOG_ROOT,
    build_catalog_dict,
    build_catalog_validation_report,
    build_provider_family_configs,
    get_catalog_accessor,
    get_default_model_settings,
    write_frontend_generated_catalog,
    write_generated_catalog,
)


def _write_yaml(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(yaml.safe_dump(payload, sort_keys=False), encoding="utf-8")


def _meta_defaults() -> dict:
    """catalog.meta.yaml 里的默认模型设置。

    测试一律从这里取期望值，不写死模型 id —— 换模型时测试不用改，也不会在
    默认值变更后静默失效（破坏一个无关模型，校验自然不报错）。
    """
    meta = yaml.safe_load(
        (Path(MODEL_CATALOG_ROOT) / "catalog.meta.yaml").read_text(encoding="utf-8")
    )
    return meta["defaults"]["model_settings"]


class TestModelCatalog:
    def test_repo_catalog_builds_with_compatibility_defaults_and_legacy_model_ids(self):
        catalog = build_catalog_dict(MODEL_CATALOG_ROOT)

        assert catalog["version"] == 1

        # 不写死具体模型 id：要守的是「目录里的默认值 == catalog.meta.yaml 写的」
        # 且默认值确实指向存在的模型。换模型时这条测试不用改。
        assert catalog["defaults"]["model_settings"] == _meta_defaults()

        models = catalog["models"]
        assert models, "目录不能为空"
        for field, model_id in _meta_defaults().items():
            assert model_id in models, f"默认值 {field}={model_id} 不在目录里"

        # 每个模型都要有 legacy -> canonical 映射，且 canonical 指向真实 mode。
        for model_id in models:
            canonical_id = catalog["compat"]["legacy_model_ids"][model_id]
            assert canonical_id in catalog["modes"], model_id

    def test_repo_catalog_emits_additive_mode_aware_sections(self):
        catalog = build_catalog_dict(MODEL_CATALOG_ROOT)

        assert "model_lines" in catalog
        assert "modes" in catalog
        assert "compat" in catalog
        assert "legacy_model_ids" in catalog["compat"]
        assert catalog["model_lines"], "model_lines 不能为空"
        assert catalog["modes"], "modes 不能为空"

        # 对每个真实模型：legacy -> canonical -> mode 三段必须对得上。
        for model_id in catalog["models"]:
            canonical_id = catalog["compat"]["legacy_model_ids"][model_id]
            mode = catalog["modes"].get(canonical_id)
            assert mode is not None, f"{model_id} 的 canonical mode 缺失"
            assert mode["legacy_model_id"] == model_id
            assert mode["model_line_id"] in catalog["model_lines"]

    def test_mode_runtime_gateway_metadata_is_additive_and_routing_stays_family_based(self):
        catalog = build_catalog_dict(MODEL_CATALOG_ROOT)

        # 用当前的默认 r2v 模型，不写死已删家族的 id。
        default_r2v = _meta_defaults()["r2v_model"]
        canonical_mode_id = catalog["compat"]["legacy_model_ids"][default_r2v]
        runtime = catalog["modes"][canonical_mode_id]["runtime"]
        assert runtime, f"{canonical_mode_id} 缺少 runtime 元数据"
        assert all("gateway" in entry for entry in runtime.values())

        # 路由仍按 family 推导：每个家族都应产出 provider 配置。
        family_configs = build_provider_family_configs(catalog)
        assert family_configs
        families = {model["family"] for model in catalog["models"].values()}
        for family in families:
            assert any(
                config.model_family.startswith(family) for config in family_configs
            ), f"家族 '{family}' 没有派生 provider 配置"

    def test_visible_models_must_link_to_context_hub_docs(self):
        catalog = build_catalog_dict(MODEL_CATALOG_ROOT)

        for model_id, model in catalog["models"].items():
            visible_in = model["ui"].get("visible_in", [])
            if visible_in:
                assert model["docs"]["context_hub_doc_ids"], model_id

    def test_generated_catalog_is_deterministic(self, tmp_path):
        first = tmp_path / "catalog-a.json"
        second = tmp_path / "catalog-b.json"

        write_generated_catalog(first, catalog_root=MODEL_CATALOG_ROOT)
        write_generated_catalog(second, catalog_root=MODEL_CATALOG_ROOT)

        assert first.read_text(encoding="utf-8") == second.read_text(encoding="utf-8")

    def test_frontend_generated_catalog_matches_backend_catalog(self, tmp_path):
        frontend_catalog_path = tmp_path / "frontend" / "src" / "generated" / "modelCatalog.json"

        written_path = write_frontend_generated_catalog(
            frontend_catalog_path,
            catalog_root=MODEL_CATALOG_ROOT,
        )

        assert written_path == frontend_catalog_path
        assert frontend_catalog_path.exists()
        assert build_catalog_dict(MODEL_CATALOG_ROOT) == json.loads(
            frontend_catalog_path.read_text(encoding="utf-8")
        )

    def test_catalog_derives_provider_family_configs(self):
        catalog = build_catalog_dict(MODEL_CATALOG_ROOT)
        family_configs = build_provider_family_configs(catalog)
        family_map = {config.model_family: config for config in family_configs}

        assert family_map, "目录应至少派生出一个 provider 家族配置"
        # 产品当前只接韭菜盒子：目录里出现的每个家族都要能派生配置。
        for model_id, model in catalog["models"].items():
            family = model["family"]
            matches = [cfg for name, cfg in family_map.items() if name.startswith(family)]
            assert matches, f"{model_id} 的 family '{family}' 没有派生配置"

        assert family_map.get("jiucaihezi/") is not None, (
            "韭菜盒子应派生一个带路由前缀的家族配置"
        )

    def test_default_model_settings_come_from_catalog(self):
        defaults = get_default_model_settings(MODEL_CATALOG_ROOT)

        # 不写死具体模型 id：真正要守的是「代码读到的默认值 == catalog.meta.yaml 里写的」，
        # 以及默认值确实还在目录里（删模型时最容易漏的就是这两个）。
        meta = yaml.safe_load(
            (Path(MODEL_CATALOG_ROOT) / "catalog.meta.yaml").read_text(encoding="utf-8")
        )
        expected = meta["defaults"]["model_settings"]
        for field in ("t2i_model", "i2i_model", "i2v_model", "r2v_model", "image_model"):
            assert getattr(defaults, field) == expected[field], f"{field} 与 catalog.meta.yaml 不一致"

        models = build_catalog_dict(MODEL_CATALOG_ROOT)["models"]
        for field in ("t2i_model", "i2i_model", "i2v_model", "r2v_model", "image_model"):
            assert getattr(defaults, field) in models, f"{field} 指向了不存在的模型"

    def test_validation_report_passes_for_repo_catalog(self):
        catalog = build_catalog_dict(MODEL_CATALOG_ROOT)

        report = build_catalog_validation_report(catalog, deepcopy(catalog))

        assert report.ok is True
        assert report.errors == ()
        assert report.stats["defaults"]["t2i_model"] == catalog["defaults"]["model_settings"]["t2i_model"]
        # video_sidebar 是 {分组: [模型 id]}，至少要有一个分组挂上了模型 ——
        # 不写死具体分组名，免得分组归属变了（i2v → r2v）就挂。
        assert any(len(ids) > 0 for ids in report.stats["surface_summary"]["video_sidebar"].values())

    def test_validation_report_detects_frontend_catalog_drift(self):
        catalog = build_catalog_dict(MODEL_CATALOG_ROOT)
        frontend_catalog = deepcopy(catalog)
        frontend_catalog["defaults"]["model_settings"]["i2v_model"] = "wan2.5-i2v-preview"

        report = build_catalog_validation_report(catalog, frontend_catalog)

        assert report.ok is False
        assert any("Frontend generated catalog does not match" in error for error in report.errors)

    def test_validation_report_detects_default_visibility_regression(self):
        catalog = build_catalog_dict(MODEL_CATALOG_ROOT)
        # 直接拿当前默认 i2v 模型来破坏。写死具体 id 的话，换默认模型后这条测试
        # 会静默失效 —— 破坏了一个无关模型，校验自然不会报错。
        default_i2v = _meta_defaults()["i2v_model"]

        broken_catalog = deepcopy(catalog)
        broken_catalog["models"][default_i2v]["ui"]["visible_in"] = [
            "project_settings",
            "series_settings",
            "global_settings",
        ]

        report = build_catalog_validation_report(broken_catalog, deepcopy(broken_catalog))

        assert report.ok is False
        assert any("video_sidebar" in error for error in report.errors)


class TestModelCatalogValidation:
    def test_duplicate_model_ids_fail_validation(self, tmp_path):
        _write_yaml(
            tmp_path / "catalog.meta.yaml",
            {
                "version": 1,
                "defaults": {
                    "model_settings": {
                        "t2i_model": "wan2.6-t2i",
                        "i2i_model": "wan2.6-image",
                        # image_model is required by the catalog validator
                        # (added during the Phase 2 unified image surface
                        # work) — synthetic test catalogs must include it.
                        "image_model": "wan2.6-t2i",
                        "i2v_model": "wan2.6-i2v",
                        # text_model 也成了必填项（文本模型接入后加的校验）。
                        "text_model": "wan2.6-t2i",
                    }
                },
            },
        )
        _write_yaml(
            tmp_path / "families" / "wan.yaml",
            {
                "family": "wan",
                "provider": "aliyun",
                "routing_prefixes": ["wan2.6-"],
                "supported_backends": ["dashscope"],
                "default_backend": "dashscope",
                "credential_sources": {"dashscope": ["DASHSCOPE_API_KEY"]},
                "supported_modalities": ["t2i", "i2i", "i2v", "r2v"],
                "transport": {
                    "image_input_mode": {"dashscope": "dashscope_multimodal_message"},
                    "audio_input_mode": {"dashscope": "dashscope_temp_file_url"},
                    "reference_video_input_mode": {"dashscope": "dashscope_temp_file_url"},
                },
                "docs": {"official_snapshot_ids": ["aliyun/wan/2026-04-03"]},
                "models": [
                    {
                        "id": "wan2.6-t2i",
                        "display_name": "Wan 2.6 T2I",
                        "description": "Latest T2I model",
                        "status": "active",
                        "release_stage": "stable",
                        "capabilities": ["t2i"],
                        "docs": {"context_hub_doc_ids": ["aliyun/wan-t2i"]},
                        "ui": {"selection_group": "t2i", "visible_in": ["project_settings"]},
                    },
                    {
                        "id": "wan2.6-t2i",
                        "display_name": "Wan 2.6 T2I Duplicate",
                        "description": "Duplicate",
                        "status": "active",
                        "release_stage": "stable",
                        "capabilities": ["t2i"],
                        "docs": {"context_hub_doc_ids": ["aliyun/wan-t2i"]},
                        "ui": {"selection_group": "t2i", "visible_in": ["project_settings"]},
                    },
                ],
            },
        )

        with pytest.raises(ValueError, match="Duplicate model id"):
            build_catalog_dict(tmp_path)

    def test_unsupported_backend_name_fails_validation(self, tmp_path):
        _write_yaml(
            tmp_path / "catalog.meta.yaml",
            {
                "version": 1,
                "defaults": {
                    "model_settings": {
                        "t2i_model": "wan2.6-t2i",
                        "i2i_model": "wan2.6-image",
                        # image_model is required by the catalog validator
                        # (added during the Phase 2 unified image surface
                        # work) — synthetic test catalogs must include it.
                        "image_model": "wan2.6-t2i",
                        "i2v_model": "wan2.6-i2v",
                        # text_model 也成了必填项（文本模型接入后加的校验）。
                        "text_model": "wan2.6-t2i",
                    }
                },
            },
        )
        _write_yaml(
            tmp_path / "families" / "broken.yaml",
            {
                "family": "broken",
                "provider": "example",
                "routing_prefixes": ["broken-"],
                "supported_backends": ["dashscope", "mystery"],
                "default_backend": "dashscope",
                "credential_sources": {"dashscope": ["DASHSCOPE_API_KEY"]},
                "supported_modalities": ["i2v"],
                "transport": {
                    "image_input_mode": {"dashscope": "dashscope_image_to_video"},
                    "audio_input_mode": {"dashscope": "dashscope_temp_file_url"},
                    "reference_video_input_mode": {"dashscope": "dashscope_temp_file_url"},
                },
                "docs": {"official_snapshot_ids": ["example/broken/2026-04-03"]},
                "models": [
                    {
                        "id": "broken-v1",
                        "display_name": "Broken v1",
                        "description": "Invalid backend example",
                        "status": "active",
                        "release_stage": "stable",
                        "capabilities": ["i2v"],
                        "docs": {"context_hub_doc_ids": ["example/broken"]},
                        "ui": {"selection_group": "i2v", "visible_in": ["video_sidebar"]},
                    }
                ],
            },
        )

        with pytest.raises(ValueError, match="Unsupported backend"):
            build_catalog_dict(tmp_path)


class TestPhase2CatalogContract:
    """Phase 2: Treat additive metadata as official generated contract."""

    def test_model_lines_emitted_for_all_families(self):
        catalog = build_catalog_dict(MODEL_CATALOG_ROOT)

        model_lines = catalog["model_lines"]
        families_with_lines = {ml["family"] for ml in model_lines.values()}

        for family_name in catalog["families"]:
            assert family_name in families_with_lines, (
                f"Family '{family_name}' has no model_lines entries"
            )

    def test_every_legacy_model_has_canonical_mapping(self):
        catalog = build_catalog_dict(MODEL_CATALOG_ROOT)

        for model_id in catalog["models"]:
            assert model_id in catalog["compat"]["legacy_model_ids"], (
                f"Legacy model '{model_id}' missing from compat.legacy_model_ids"
            )
            canonical_id = catalog["compat"]["legacy_model_ids"][model_id]
            assert canonical_id in catalog["modes"], (
                f"Canonical mode '{canonical_id}' for '{model_id}' missing from modes"
            )

    def test_canonical_defaults_resolve_to_valid_modes(self):
        catalog = build_catalog_dict(MODEL_CATALOG_ROOT)

        canonical_defaults = catalog["defaults"]["canonical_model_settings"]
        assert canonical_defaults, "canonical_model_settings must be present"

        for key, canonical_id in canonical_defaults.items():
            assert canonical_id in catalog["modes"], (
                f"Canonical default '{key}' -> '{canonical_id}' not in modes"
            )
            mode_entry = catalog["modes"][canonical_id]
            assert mode_entry["legacy_model_id"] in catalog["models"], (
                f"Mode '{canonical_id}' legacy_model_id not in models"
            )

    def test_mode_entries_have_required_metadata(self):
        catalog = build_catalog_dict(MODEL_CATALOG_ROOT)

        for mode_id, mode in catalog["modes"].items():
            assert "model_line_id" in mode, f"{mode_id} missing model_line_id"
            assert "legacy_model_id" in mode, f"{mode_id} missing legacy_model_id"
            assert "mode" in mode, f"{mode_id} missing mode name"
            assert "runtime" in mode, f"{mode_id} missing runtime"
            assert "family" in mode, f"{mode_id} missing family"
            assert "ui" in mode, f"{mode_id} missing ui"
            assert mode["model_line_id"] in catalog["model_lines"], (
                f"{mode_id} references nonexistent model_line '{mode['model_line_id']}'"
            )

    def test_runtime_gateway_present_where_defined(self):
        catalog = build_catalog_dict(MODEL_CATALOG_ROOT)

        modes_with_runtime = [
            (mid, mode) for mid, mode in catalog["modes"].items() if mode.get("runtime")
        ]
        assert modes_with_runtime, "应至少有一个 mode 声明了 runtime"
        for mid, mode in modes_with_runtime:
            for backend, entry in mode["runtime"].items():
                assert "gateway" in entry, f"{mid} 的 {backend} 缺少 gateway"


class TestCatalogAccessor:
    """Phase 2: Test the CatalogAccessor helper API.

    一律用目录里真实存在的 id（首个模型 / 默认 r2v 模型），不写死具体模型名。
    """

    @staticmethod
    def _catalog():
        return build_catalog_dict(MODEL_CATALOG_ROOT)

    def test_resolve_legacy_to_canonical(self):
        catalog = self._catalog()
        accessor = get_catalog_accessor(catalog)

        for legacy_id, canonical_id in catalog["compat"]["legacy_model_ids"].items():
            assert accessor.resolve_legacy_to_canonical(legacy_id) == canonical_id
        assert accessor.resolve_legacy_to_canonical("nonexistent") is None

    def test_resolve_canonical_to_legacy(self):
        catalog = self._catalog()
        accessor = get_catalog_accessor(catalog)

        for legacy_id, canonical_id in catalog["compat"]["legacy_model_ids"].items():
            assert accessor.resolve_canonical_to_legacy(canonical_id) == legacy_id
        assert accessor.resolve_canonical_to_legacy("nonexistent") is None

    def test_resolve_to_flat_accepts_both_id_forms(self):
        catalog = self._catalog()
        accessor = get_catalog_accessor(catalog)
        legacy_id, canonical_id = next(iter(catalog["compat"]["legacy_model_ids"].items()))

        assert accessor.resolve_to_flat(legacy_id) == legacy_id
        assert accessor.resolve_to_flat(canonical_id) == legacy_id
        assert accessor.resolve_to_flat("unknown-id") == "unknown-id"

    def test_get_mode_entry_returns_full_metadata(self):
        catalog = self._catalog()
        accessor = get_catalog_accessor(catalog)
        legacy_id, canonical_id = next(iter(catalog["compat"]["legacy_model_ids"].items()))
        expected = catalog["modes"][canonical_id]

        entry = accessor.get_mode_entry(canonical_id)
        assert entry is not None
        assert entry["model_line_id"] == expected["model_line_id"]
        assert entry["legacy_model_id"] == legacy_id
        assert entry["mode"] == expected["mode"]
        assert entry["family"] == catalog["models"][legacy_id]["family"]

    def test_get_mode_runtime(self):
        catalog = self._catalog()
        accessor = get_catalog_accessor(catalog)
        canonical_id = catalog["compat"]["legacy_model_ids"][_meta_defaults()["r2v_model"]]

        runtime = accessor.get_mode_runtime(canonical_id)
        assert runtime
        assert accessor.get_mode_runtime("nonexistent") is None

    def test_get_mode_product(self):
        catalog = self._catalog()
        accessor = get_catalog_accessor(catalog)
        legacy_id, canonical_id = next(iter(catalog["compat"]["legacy_model_ids"].items()))

        ui = accessor.get_mode_product(canonical_id)
        assert ui is not None
        assert ui["selection_group"] == catalog["models"][legacy_id]["ui"]["selection_group"]
        assert accessor.get_mode_product("nonexistent") is None

    def test_get_gateway(self):
        catalog = self._catalog()
        accessor = get_catalog_accessor(catalog)
        canonical_id = catalog["compat"]["legacy_model_ids"][_meta_defaults()["r2v_model"]]
        runtime = catalog["modes"][canonical_id]["runtime"]
        backend, entry = next(iter(runtime.items()))

        # 注意：backend 默认值是 "dashscope"，单家族产品里必须显式传后端。
        assert accessor.get_gateway(canonical_id, backend) == entry["gateway"]
        assert accessor.get_gateway(canonical_id, "no-such-backend") is None
        assert accessor.get_gateway("nonexistent") is None

    def test_enumeration_helpers(self):
        accessor = get_catalog_accessor(build_catalog_dict(MODEL_CATALOG_ROOT))

        canonical_ids = accessor.all_canonical_mode_ids()
        legacy_ids = accessor.all_legacy_model_ids()
        line_ids = accessor.all_model_line_ids()

        assert len(canonical_ids) == len(legacy_ids)
        assert len(canonical_ids) > 0
        assert len(line_ids) > 0
        assert all("#" in cid for cid in canonical_ids)

    def test_canonical_defaults(self):
        accessor = get_catalog_accessor(build_catalog_dict(MODEL_CATALOG_ROOT))

        defaults = accessor.canonical_defaults()
        assert "t2i_model" in defaults
        assert "i2i_model" in defaults
        assert "i2v_model" in defaults
        assert all("#" in v for v in defaults.values())


class TestGetGatewayForModel:
    """Phase 2 Task 6: Tests for provider_registry.get_gateway_for_model().

    用目录里真实存在的 id；曾经的 kling/vidu vendor 后端随家族删除一起消失，
    所以不再测「路由到 vendor 适配器」。
    """

    @staticmethod
    def _expected_gateway() -> tuple:
        """返回 (flat_id, canonical_id, backend, gateway)，全部从目录推导。"""
        catalog = build_catalog_dict(MODEL_CATALOG_ROOT)
        legacy_id = _meta_defaults()["r2v_model"]
        canonical_id = catalog["compat"]["legacy_model_ids"][legacy_id]
        backend, entry = next(iter(catalog["modes"][canonical_id]["runtime"].items()))
        return legacy_id, canonical_id, backend, entry["gateway"]

    def test_gateway_lookup_with_flat_id(self):
        from src.utils.provider_registry import get_gateway_for_model

        legacy_id, _canonical, backend, gateway = self._expected_gateway()
        assert get_gateway_for_model(legacy_id, backend=backend) == gateway

    def test_gateway_lookup_with_canonical_id(self):
        from src.utils.provider_registry import get_gateway_for_model

        _flat, canonical_id, backend, gateway = self._expected_gateway()
        assert get_gateway_for_model(canonical_id, backend=backend) == gateway

    def test_gateway_lookup_returns_none_for_unknown_model(self):
        from src.utils.provider_registry import get_gateway_for_model

        result = get_gateway_for_model("nonexistent-model")
        assert result is None

    def test_gateway_lookup_returns_none_for_unregistered_backend(self):
        from src.utils.provider_registry import get_gateway_for_model

        # 单家族产品：目录里没有 vendor 后端，显式指定应取不到 gateway。
        _flat, _canonical, _backend, _gateway = self._expected_gateway()
        assert get_gateway_for_model(_flat, backend="vendor") is None
