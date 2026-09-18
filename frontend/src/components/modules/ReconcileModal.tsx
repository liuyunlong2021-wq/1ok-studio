"use client";
/**
 * ReconcileModal — 跨集资产对齐（R2V v2 Phase 4 的 Phase 4 弹窗）。
 *
 * 触发方式：资产库顶部「与系列对齐」按钮，**用户自己点**（不再靠提取后自动弹）。
 * 匹配池由后端 `list_asset_candidates` 给：系列池 + 全局库 + 本集 + 同系列其它集，
 * 所以"第一集和第九集场景一样"这种跨集重复现在能匹配到。
 *
 * 每行默认动作：
 *   · conf ≥ 75 且命中目标 → merge（合并到目标那条）
 *   · 否则 → create_new_in_series（提升为系列共享），无系列的项目则 skip
 * 用户可以逐行改，或一键全部确认。
 */
import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Sparkles, Check, X, Users, MapPin, Box, ArrowRight, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { api, type ReconcileSuggestion, type ReconcileAction } from "@/lib/api";
import { errorMessage } from "@/lib/utils";
import { assetSourceLabel } from "@/lib/assetSourceLabel";
import WorkflowActionButton from "@/components/shared/WorkflowActionButton";

interface ReconcileModalProps {
    isOpen: boolean;
    scriptId: string | null;
    onClose: () => void;
    /** Called after successful apply. Frontend uses this to dispatch a
     *  navigateStep("cast") event if the user clicks "去 Cast 查看 →". */
    onApplied?: () => void;
}

type Kind = "character" | "scene" | "prop";

interface Row {
    kind: Kind;
    suggestion: ReconcileSuggestion;
    action: "merge" | "create_new_in_series" | "skip";
}

export default function ReconcileModal({ isOpen, scriptId, onClose, onApplied }: ReconcileModalProps) {
    const t = useTranslations("reconcile");
    const [rows, setRows] = useState<Row[] | null>(null);
    const [hasSeries, setHasSeries] = useState(true);
    const [loading, setLoading] = useState(false);
    const [applying, setApplying] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Fetch suggestions on open
    useEffect(() => {
        if (!isOpen || !scriptId) return;
        let cancelled = false;
        setLoading(true);
        setError(null);
        api.getReconcileSuggestions(scriptId)
            .then(data => {
                if (cancelled) return;
                const canPromote = data.has_series;
                setHasSeries(canPromote);
                const init: Row[] = [];
                const seed = (kind: Kind, list: ReconcileSuggestion[]) => {
                    for (const s of list) {
                        init.push({
                            kind,
                            suggestion: s,
                            // 默认：高置信度且有目标 → 合并；否则提升为系列共享；
                            // 不属于系列的项目没地方提升，保持本集。
                            action: s.confidence >= 75 && s.suggested_target_id
                                ? "merge"
                                : (canPromote ? "create_new_in_series" : "skip"),
                        });
                    }
                };
                seed("character", data.characters);
                seed("scene", data.scenes);
                seed("prop", data.props);
                setRows(init);
            })
            .catch(err => {
                if (cancelled) return;
                setError(errorMessage(err, "加载失败"));
            })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [isOpen, scriptId]);

    const counts = useMemo(() => {
        const base = { total: 0, merge: 0, create: 0, skip: 0 };
        if (!rows) return base;
        base.total = rows.length;
        for (const r of rows) {
            if (r.action === "merge") base.merge++;
            else if (r.action === "create_new_in_series") base.create++;
            else base.skip++;
        }
        return base;
    }, [rows]);

    const handleSetAction = (idx: number, action: Row["action"]) => {
        setRows(prev => prev?.map((r, i) => i === idx ? { ...r, action } : r) ?? null);
    };

    const buildPayload = (): { characters: ReconcileAction[]; scenes: ReconcileAction[]; props: ReconcileAction[] } => {
        const payload = { characters: [] as ReconcileAction[], scenes: [] as ReconcileAction[], props: [] as ReconcileAction[] };
        for (const r of rows ?? []) {
            const act: ReconcileAction = {
                local_id: r.suggestion.local_id,
                action: r.action,
                target_id: r.action === "merge" ? (r.suggestion.suggested_target_id ?? undefined) : undefined,
            };
            if (r.kind === "character") payload.characters.push(act);
            else if (r.kind === "scene") payload.scenes.push(act);
            else payload.props.push(act);
        }
        return payload;
    };

    const handleApply = async (navigateToCast: boolean) => {
        if (!scriptId || !rows) return;
        setApplying(true);
        setError(null);
        try {
            await api.applyReconcile(scriptId, buildPayload());
            onApplied?.();
            onClose();
            if (navigateToCast) {
                document.dispatchEvent(new CustomEvent("1okstudio:navigateStep", { detail: "cast" }));
            }
        } catch (err: any) {
            setError(errorMessage(err, "应用失败"));
        } finally {
            setApplying(false);
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
                        className="relative w-full max-w-2xl max-h-[80vh] flex flex-col rounded-2xl border border-glass-border bg-elevated shadow-[0_24px_64px_-12px_rgba(0,0,0,0.7)]"
                        onClick={e => e.stopPropagation()}
                    >
                        {/* Header */}
                        <header className="flex items-center gap-3 px-6 py-5 border-b border-glass-border">
                            <div className="grid h-9 w-9 place-items-center rounded-full border border-primary/40 bg-primary/10 text-primary">
                                <Sparkles size={16} />
                            </div>
                            <div className="flex-1 min-w-0">
                                <h2 className="font-display text-display font-medium text-foreground">{t("title")}</h2>
                                <p className="text-xs text-text-secondary mt-0.5">
                                    {loading ? t("loading") : t("subtitle", {
                                        total: counts.total,
                                        merge: counts.merge,
                                        create: counts.create,
                                    })}
                                </p>
                            </div>
                            <button
                                onClick={onClose}
                                aria-label="Close"
                                className="p-2 hover:bg-hover-bg rounded-lg text-text-muted hover:text-foreground transition-colors"
                            >
                                <X size={16} />
                            </button>
                        </header>

                        {/* Body */}
                        <div className="flex-1 overflow-y-auto px-6 py-4 custom-scrollbar">
                            {loading ? (
                                <div className="flex items-center justify-center py-12 text-text-muted">
                                    <Loader2 size={20} className="animate-spin" />
                                </div>
                            ) : error ? (
                                <div className="rounded-lg border border-status-failed-border/40 bg-status-failed-bg/50 px-4 py-3 text-status-failed-fg text-sm">
                                    {error}
                                </div>
                            ) : !rows || rows.length === 0 ? (
                                <p className="text-center text-text-muted py-12 text-sm">{t("noEntities")}</p>
                            ) : (
                                <div className="space-y-1.5">
                                    {rows.map((row, idx) => (
                                        <ReconcileRow
                                            key={`${row.kind}-${row.suggestion.local_id}`}
                                            row={row}
                                            hasSeries={hasSeries}
                                            onActionChange={(action) => handleSetAction(idx, action)}
                                        />
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* Footer */}
                        <footer className="flex items-center gap-2 px-6 py-4 border-t border-glass-border">
                            <span className="flex-1 font-mono text-[0.65625rem] uppercase tracking-[0.16em] text-text-muted">
                                {counts.merge > 0 && <span className="text-primary mr-2">↳ {counts.merge} merge</span>}
                                {counts.create > 0 && <span className="text-pink-300 mr-2">+ {counts.create} new</span>}
                                {counts.skip > 0 && <span className="text-text-muted">⊘ {counts.skip} skip</span>}
                            </span>
                            <WorkflowActionButton
                                variant="ghost"
                                size="sm"
                                onClick={onClose}
                            >
                                {t("cancel")}
                            </WorkflowActionButton>
                            <WorkflowActionButton
                                variant="secondary"
                                size="sm"
                                loading={applying}
                                onClick={() => handleApply(false)}
                                disabled={!rows || rows.length === 0}
                            >
                                {t("confirmAll")}
                            </WorkflowActionButton>
                            <WorkflowActionButton
                                variant="primary"
                                size="sm"
                                loading={applying}
                                rightIcon={<ArrowRight />}
                                onClick={() => handleApply(true)}
                                disabled={!rows || rows.length === 0}
                            >
                                {t("confirmAndGoCast")}
                            </WorkflowActionButton>
                        </footer>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}

function ReconcileRow({ row, hasSeries, onActionChange }: { row: Row; hasSeries: boolean; onActionChange: (a: Row["action"]) => void }) {
    const t = useTranslations("reconcile");
    const tSource = useTranslations("assetSource");
    const Icon = row.kind === "character" ? Users : row.kind === "scene" ? MapPin : Box;
    const conf = row.suggestion.confidence;
    const hasTarget = !!row.suggestion.suggested_target_id;
    const isHighConf = conf >= 75;
    const isMediumConf = conf > 0 && conf < 75;
    // 目标住在哪一层：系列 / 全局库 / 同系列别的集（后者合并时会先提升）
    const kind = row.suggestion.suggested_target_kind;
    const targetLabel = assetSourceLabel(kind, tSource, row.suggestion.suggested_target_episode_title);
    return (
        <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-glass-border bg-glass">
            <Icon size={14} className="shrink-0 text-text-muted" />
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                    <span className="font-sans text-[0.8125rem] font-medium text-foreground truncate">{row.suggestion.local_name}</span>
                    {hasTarget ? (
                        <>
                            <span className="font-mono text-[0.625rem] text-text-muted">→</span>
                            <span className={`font-sans text-[0.8125rem] truncate ${isHighConf ? 'text-foreground' : 'text-text-secondary'}`}>
                                {row.suggestion.suggested_target_name}
                            </span>
                            <span className="font-mono text-[0.59375rem] px-1.5 py-0.5 rounded-full bg-glass text-text-muted whitespace-nowrap" title={kind === "episode" ? tSource("promoteHint") : undefined}>
                                {targetLabel}
                            </span>
                            <span
                                className={`font-mono text-[0.59375rem] px-1.5 py-0.5 rounded-full ${
                                    isHighConf ? "bg-primary/15 text-primary" :
                                    isMediumConf ? "bg-amber-400/15 text-amber-300" :
                                    "bg-glass text-text-muted"
                                }`}
                            >
                                {conf}%
                            </span>
                        </>
                    ) : (
                        <span className="font-mono text-[0.59375rem] px-1.5 py-0.5 rounded-full bg-pink-400/15 text-pink-300">
                            {t("new")}
                        </span>
                    )}
                </div>
            </div>
            {/* Action selector */}
            <div className="shrink-0">
                <select
                    value={row.action}
                    onChange={(e) => onActionChange(e.target.value as Row["action"])}
                    className="bg-input-bg border border-glass-border rounded px-2 py-1 text-[0.71875rem] text-foreground focus:outline-none focus:border-primary"
                >
                    {hasTarget && (
                        <option value="merge">{t("actionMerge")}</option>
                    )}
                    {hasSeries && (
                        <option value="create_new_in_series">{t("actionCreateNew")}</option>
                    )}
                    <option value="skip">{t("actionSkip")}</option>
                </select>
            </div>
            {/* Status checkmark */}
            <div className="shrink-0 w-5 grid place-items-center">
                {row.action !== "skip" ? (
                    <Check size={14} className={row.action === "merge" ? "text-primary" : "text-pink-300"} />
                ) : (
                    <X size={14} className="text-text-muted" />
                )}
            </div>
        </div>
    );
}
