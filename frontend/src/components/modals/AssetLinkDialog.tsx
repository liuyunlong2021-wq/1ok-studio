"use client";
/**
 * AssetLinkDialog — 「关联到已有资产」。
 *
 * 场景：第 2 集又提取出一个「刘玄德」，可第 1 集已经有「刘备」的图了。
 * 选一条已存在的资产，本集这条会被合并过去（分镜引用一起改写），不用重新生图。
 *
 * 候选由后端 `/projects/{id}/asset-candidates` 给：系列池 → 全局库 → 本集 →
 * 同系列其它集。目标在别的集里时后端会先把它提升为系列共享（沿用原 id），
 * 所以那一集自己的引用也还解析得到。
 *
 * 取图复用 `lib/characterImage` —— 和后端一样，不在组件里重算图片字段。
 */
import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Check, Image as ImageIcon, Link as LinkIcon, Loader2, Search, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { api, type AssetCandidate } from "@/lib/api";
import { errorMessage } from "@/lib/utils";
import { characterImageUrl, scenePropImageUrl } from "@/lib/characterImage";
import { assetSourceLabel } from "@/lib/assetSourceLabel";
import PreviewImage from "@/components/shared/preview/PreviewImage";
import WorkflowActionButton from "@/components/shared/WorkflowActionButton";

export type LinkableAssetType = "character" | "scene" | "prop";

export interface AssetLinkDialogProps {
    isOpen: boolean;
    scriptId: string | null;
    assetType: LinkableAssetType;
    /** 要被合并掉的那条（本集资产）。 */
    localId: string;
    localName: string;
    onClose: () => void;
    onLinked?: () => void;
}

export default function AssetLinkDialog({
    isOpen,
    scriptId,
    assetType,
    localId,
    localName,
    onClose,
    onLinked,
}: AssetLinkDialogProps) {
    const t = useTranslations("assetLink");
    const tSource = useTranslations("assetSource");
    const [candidates, setCandidates] = useState<AssetCandidate[] | null>(null);
    const [query, setQuery] = useState("");
    const [selected, setSelected] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [linking, setLinking] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!isOpen || !scriptId) return;
        let cancelled = false;
        setLoading(true);
        setError(null);
        setSelected(null);
        setQuery("");
        api.getAssetCandidates(scriptId, assetType)
            .then((data) => {
                if (!cancelled) setCandidates(data.candidates ?? []);
            })
            .catch((e) => {
                if (!cancelled) setError(errorMessage(e, t("loadFailed")));
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [isOpen, scriptId, assetType, t]);

    const filtered = useMemo(() => {
        const list = (candidates ?? []).filter((c) => c.id !== localId);
        const q = query.trim().toLowerCase();
        if (!q) return list;
        return list.filter((c) => (c.name ?? "").toLowerCase().includes(q));
    }, [candidates, localId, query]);

    const handleLink = async () => {
        if (!scriptId || !selected) return;
        setLinking(true);
        setError(null);
        try {
            await api.linkAsset(scriptId, { asset_type: assetType, local_id: localId, target_id: selected });
            onLinked?.();
            onClose();
        } catch (e) {
            setError(errorMessage(e, t("linkFailed")));
        } finally {
            setLinking(false);
        }
    };

    return (
        <AnimatePresence>
            {isOpen && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="fixed inset-0 z-[100] grid place-items-center bg-overlay backdrop-blur-sm"
                    onClick={onClose}
                >
                    <motion.div
                        initial={{ scale: 0.96, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0.96, opacity: 0 }}
                        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                        className="relative w-full max-w-lg max-h-[80vh] flex flex-col rounded-2xl border border-glass-border bg-elevated shadow-[0_24px_64px_-12px_rgba(0,0,0,0.7)]"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <header className="flex items-start gap-3 px-6 py-5 border-b border-glass-border">
                            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-primary/40 bg-primary/10 text-primary">
                                <LinkIcon size={16} />
                            </div>
                            <div className="flex-1 min-w-0">
                                <h2 className="font-display text-display font-medium text-foreground">{t("title")}</h2>
                                <p className="text-xs text-text-secondary mt-0.5">{t("subtitle", { name: localName })}</p>
                            </div>
                            <button
                                onClick={onClose}
                                aria-label="Close"
                                className="p-2 hover:bg-hover-bg rounded-lg text-text-muted hover:text-foreground transition-colors"
                            >
                                <X size={16} />
                            </button>
                        </header>

                        <div className="px-6 pt-4">
                            <div className="flex items-center gap-2 rounded-lg border border-glass-border bg-input-bg px-3 py-2">
                                <Search size={14} className="text-text-muted" />
                                <input
                                    value={query}
                                    onChange={(e) => setQuery(e.target.value)}
                                    placeholder={t("search")}
                                    className="w-full bg-transparent text-sm text-foreground placeholder:text-text-muted focus:outline-none"
                                />
                            </div>
                        </div>

                        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 custom-scrollbar">
                            {loading ? (
                                <div className="flex items-center justify-center py-12 text-text-muted">
                                    <Loader2 size={20} className="animate-spin" />
                                </div>
                            ) : error ? (
                                <div className="rounded-lg border border-status-failed-border/40 bg-status-failed-bg/50 px-4 py-3 text-status-failed-fg text-sm">
                                    {error}
                                </div>
                            ) : filtered.length === 0 ? (
                                <p className="py-12 text-center text-sm text-text-muted">{t("empty")}</p>
                            ) : (
                                <div className="space-y-1.5">
                                    {filtered.map((c) => {
                                        // 取图交给 lib/characterImage（新 schema 只写 reference_sheet）
                                        const raw = assetType === "character"
                                            ? characterImageUrl(c as never)
                                            : scenePropImageUrl(c as never);
                                        const aliasText = ((c.aliases as string[] | undefined) ?? []).join("、");
                                        const subtitle = [c.description || "", aliasText ? `别名 ${aliasText}` : ""]
                                            .filter(Boolean)
                                            .join(" · ");
                                        const active = selected === c.id;
                                        return (
                                            <button
                                                key={c.id}
                                                type="button"
                                                onClick={() => setSelected(c.id)}
                                                className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors ${active
                                                    ? "border-primary/60 bg-primary/10"
                                                    : "border-glass-border bg-glass hover:border-primary/30"
                                                    }`}
                                            >
                                                <span className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-lg border border-glass-border bg-surface-inset">
                                                    <PreviewImage
                                                        src={raw}
                                                        alt=""
                                                        className="h-full w-full object-cover"
                                                        noLightbox
                                                        placeholder={<ImageIcon size={14} className="text-text-muted" />}
                                                    />
                                                </span>
                                                <span className="min-w-0 flex-1">
                                                    <span className="block truncate text-[0.8125rem] text-foreground">{c.name}</span>
                                                    <span className="block truncate text-[0.6875rem] text-text-muted">
                                                        {subtitle}
                                                    </span>
                                                </span>
                                                <span
                                                    className="shrink-0 whitespace-nowrap rounded-full bg-surface-inset px-2 py-0.5 font-mono text-[0.59375rem] text-text-muted"
                                                    title={c.needs_promote ? tSource("promoteHint") : undefined}
                                                >
                                                    {assetSourceLabel(c.source, tSource, c.owner_episode_title)}
                                                </span>
                                                {active && <Check size={14} className="shrink-0 text-primary" />}
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                        </div>

                        <footer className="flex items-center justify-end gap-2 px-6 py-4 border-t border-glass-border">
                            <WorkflowActionButton variant="ghost" size="sm" onClick={onClose}>
                                {t("cancel")}
                            </WorkflowActionButton>
                            <WorkflowActionButton
                                variant="primary"
                                size="sm"
                                leftIcon={<LinkIcon />}
                                loading={linking}
                                disabled={!selected}
                                onClick={handleLink}
                            >
                                {linking ? t("linking") : t("confirm")}
                            </WorkflowActionButton>
                        </footer>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}
