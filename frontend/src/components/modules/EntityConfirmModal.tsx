"use client";
import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Users, MapPin, Box, Check, X } from "lucide-react";
import { useTranslations } from "next-intl";

export interface ExtractionPreview {
    characters: { name: string; description?: string }[];
    scenes: { name: string; description?: string }[];
    props: { name: string; description?: string }[];
}

interface EntityConfirmModalProps {
    isOpen: boolean;
    preview: ExtractionPreview | null;
    currentCounts: { characters: number; scenes: number; props: number };
    /** 已存在于系列池/全局库的实体键（`${kind}:${小写名}`）。命中的会被直接复用。 */
    sharedKeys?: Set<string>;
    onConfirm: (reuseExisting: boolean) => void;
    onDiscard: () => void;
}

export default function EntityConfirmModal({
    isOpen,
    preview,
    currentCounts,
    sharedKeys,
    onConfirm,
    onDiscard,
}: EntityConfirmModalProps) {
    const t = useTranslations("script");
    // 同名直接复用：默认开（hook 必须在 `if (!preview)` 之前，否则钩子顺序会变）
    const [reuseExisting, setReuseExisting] = useState(true);

    if (!preview) return null;

    const shared = sharedKeys ?? new Set<string>();
    const isShared = (key: string, name: string) => shared.has(`${key}:${name.trim().toLowerCase()}`);

    const sections = [
        { key: "characters" as const, icon: Users, items: preview.characters, prev: currentCounts.characters },
        { key: "scenes" as const, icon: MapPin, items: preview.scenes, prev: currentCounts.scenes },
        { key: "props" as const, icon: Box, items: preview.props, prev: currentCounts.props },
    ];
    const reuseCount = sections.reduce(
        (n, s) => n + s.items.filter((i) => isShared(s.key, i.name)).length,
        0,
    );

    return (
        <AnimatePresence>
            {isOpen && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="fixed inset-0 z-[100] grid place-items-center bg-overlay backdrop-blur-sm"
                    onClick={onDiscard}
                >
                    <motion.div
                        initial={{ scale: 0.96, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0.96, opacity: 0 }}
                        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                        className="relative w-full max-w-lg max-h-[70vh] flex flex-col rounded-2xl border border-glass-border bg-elevated shadow-[0_24px_64px_-12px_rgba(0,0,0,0.7)]"
                        onClick={e => e.stopPropagation()}
                    >
                        {/* Header */}
                        <header className="px-6 py-5 border-b border-glass-border">
                            <h2 className="font-display text-display font-medium text-foreground">
                                {t("extractConfirmTitle")}
                            </h2>
                            <p className="text-xs text-text-secondary mt-1">
                                {t("extractConfirmSubtitle")}
                            </p>
                        </header>

                        {/* Body */}
                        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
                            {sections.map(({ key, icon: Icon, items, prev }) => (
                                <div key={key} className="space-y-2">
                                    <div className="flex items-center gap-2 text-sm text-text-secondary">
                                        <Icon size={14} />
                                        <span className="font-medium">
                                            {t(`entityKind_${key}`)}
                                        </span>
                                        <span className="ml-auto text-xs opacity-70">
                                            {prev} → {items.length}
                                        </span>
                                    </div>
                                    {items.length > 0 ? (
                                        <div className="flex flex-wrap gap-1.5">
                                            {items.map((item, i) => {
                                                const already = isShared(key, item.name);
                                                return (
                                                    <span
                                                        key={i}
                                                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-elevated border text-xs text-foreground ${already ? "border-primary/50" : "border-glass-border"}`}
                                                        title={item.description}
                                                    >
                                                        {item.name}
                                                        {already && (
                                                            <span className="font-mono text-[0.5625rem] uppercase tracking-wide text-primary">
                                                                {t("extractExistingChip")}
                                                            </span>
                                                        )}
                                                    </span>
                                                );
                                            })}
                                        </div>
                                    ) : (
                                        <p className="text-xs text-text-tertiary italic">{t("noEntities")}</p>
                                    )}
                                </div>
                            ))}
                        </div>

                        {/* 同名直接复用（默认开）：不选就回到"每集各存一份"的旧行为 */}
                        {reuseCount > 0 && (
                            <label className="flex items-start gap-2 px-6 py-3 border-t border-glass-border text-xs text-text-secondary cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={reuseExisting}
                                    onChange={(e) => setReuseExisting(e.target.checked)}
                                    className="mt-0.5 accent-[var(--color-primary)]"
                                />
                                <span>
                                    {t("extractReuseExisting", { count: reuseCount })}
                                    <span className="mt-0.5 block text-text-tertiary">{t("extractReuseHint")}</span>
                                </span>
                            </label>
                        )}

                        {/* Footer */}
                        <footer className="flex items-center justify-end gap-3 px-6 py-4 border-t border-glass-border">
                            <button
                                onClick={onDiscard}
                                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm text-text-secondary hover:text-foreground hover:bg-hover-bg transition-colors"
                            >
                                <X size={14} />
                                {t("extractDiscard")}
                            </button>
                            <button
                                onClick={() => onConfirm(reuseExisting)}
                                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-primary text-white hover:bg-primary/90 transition-colors"
                            >
                                <Check size={14} />
                                {t("extractApply")}
                            </button>
                        </footer>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}
