import type { AssetSourceKind } from "@/lib/api";

/**
 * 资产来源 → 给人看的标签。资产卡片角标、关联弹窗、对齐弹窗共用这一份，
 * 免得同一句话在三个组件里各写一遍（写歪的那份就会和实际归属对不上）。
 *
 * 用法：`t` 传 `useTranslations("assetSource")`。
 * `episodeTitle` 只在目标来自**同系列别的集**时才有值 —— 那种资产对当前集是
 * 私有且不可直接解析的，合并时会先被提升为系列共享，所以标签要说清楚。
 */
export function assetSourceLabel(
    kind: AssetSourceKind | null | undefined,
    t: (key: string, values?: Record<string, string>) => string,
    episodeTitle?: string | null,
): string {
    if (kind === "global") return t("global");
    if (kind === "series") return t("series");
    if (kind === "episode" && episodeTitle) return t("sibling", { title: episodeTitle });
    return t("episode");
}
