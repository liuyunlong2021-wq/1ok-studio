import type { Character, ImageAsset, ImageVariant, AssetUnit } from "@/store/projectStore";

/**
 * Character image resolution helpers.
 *
 * Characters store images in two containers from two schema eras:
 *   - reference_sheet (new, canonical): { image_variants, selected_image_id }
 *   - full_body_asset (legacy):         { variants, selected_id }
 *
 * New characters are written to reference_sheet only, so every consumer must
 * read reference_sheet first and fall back to full_body_asset — otherwise newly
 * generated characters render blank. Centralised here so call sites can't drift.
 *
 * NOTE: this is for resolving a character's *display / reference* image. It is
 * NOT for full_body-specific management UI (e.g. CharacterWorkbench panels that
 * edit the full_body asset type itself).
 */

/** Selected (or first) variant URL from EITHER container shape. */
export function selectedVariantUrl(asset?: ImageAsset | AssetUnit | null): string | undefined {
  if (!asset) return undefined;
  const variants = "image_variants" in asset ? asset.image_variants : asset.variants;
  if (!variants?.length) return undefined;
  const selectedId = "image_variants" in asset ? asset.selected_image_id : asset.selected_id;
  const selected = variants.find((v) => v.id === selectedId);
  return selected?.url || variants[0]?.url;
}

/** Resolve a character's primary image container to a normalized ImageAsset
 *  ({ variants, selected_id }), preferring reference_sheet over legacy full_body. */
export function characterImageAsset(c: Character): ImageAsset | undefined {
  const rs = c.reference_sheet;
  if (rs?.image_variants?.length) {
    return { selected_id: rs.selected_image_id, variants: rs.image_variants };
  }
  return c.full_body_asset;
}

/** A character's variant list (reference_sheet → full_body), for counts / variant strips. */
export function characterVariants(c: Character): ImageVariant[] {
  return characterImageAsset(c)?.variants ?? [];
}

/** A character's best display image: reference_sheet → full_body → legacy top-level urls. */
export function characterImageUrl(c: Character): string | undefined {
  return selectedVariantUrl(characterImageAsset(c)) || c.image_url || c.full_body_image_url;
}

/**
 * 场景 / 道具的展示图（与角色同一套回退顺序，只差没有 reference_sheet 那一层历史包袱）。
 *
 * 存在的理由和 characterImageUrl 一样：资产库页、旧资产库（ConsistencyVault）、Cast
 * 三处各自手写过一份取图逻辑，而其中一份漏了 `reference_sheet` —— 于是同一个资产
 * 在新 UI 有图、旧 UI 是空占位。取图只走这里，别再各写一份。
 */
export function scenePropImageUrl(asset?: {
  image_asset?: ImageAsset | null;
  reference_sheet?: AssetUnit | null;
  image_url?: string | null;
  reference_image_url?: string | null;
} | null): string | undefined {
  if (!asset) return undefined;
  return (
    selectedVariantUrl(asset.image_asset) ||
    selectedVariantUrl(asset.reference_sheet) ||
    asset.image_url ||
    asset.reference_image_url ||
    undefined
  );
}
