'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Check, Image, Film, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { assetPickerItems, loadAssetSources, type AssetPickerItem } from '@/lib/assetLibrary';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AssetPickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (path: string) => void;
  accept: 'image' | 'video' | 'all';
}

type FilterTab = 'all' | 'image' | 'video';

// ---------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------

const overlayVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
};

const modalVariants = {
  hidden: { opacity: 0, scale: 0.95, y: 16 },
  visible: { opacity: 1, scale: 1, y: 0 },
};

const springModal = { type: 'spring' as const, stiffness: 400, damping: 30 };

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AssetPickerModal({
  isOpen,
  onClose,
  onSelect,
  accept,
}: AssetPickerModalProps) {
  const t = useTranslations('playground');
  const [items, setItems] = useState<AssetPickerItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<FilterTab>(
    accept === 'all' ? 'all' : accept
  );

  // -------------------------------------------------------------------------
  // Load the asset library
  // -------------------------------------------------------------------------
  //
  // 列的是**资产库**里的角色 / 场景 / 道具图（系列池 + 独立项目 + 全局池），
  // 与按钮「从资产库选取」说的是同一件事。以前拉的是 playground history
  // （生成结果 + 上传素材全列一遍，还混进音频、渲染成碎图），来源与文案对不上。

  const fetchAssets = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      setItems(assetPickerItems(await loadAssetSources(t('assetPicker.globalGroup'))));
    } catch (err) {
      console.error('[AssetPickerModal] load failed:', err);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (isOpen) {
      setSelected(null);
      fetchAssets();
    }
  }, [isOpen, fetchAssets]);

  // Reset active tab when accept changes
  useEffect(() => {
    setActiveTab(accept === 'all' ? 'all' : accept);
  }, [accept]);

  // -------------------------------------------------------------------------
  // Filter
  // -------------------------------------------------------------------------

  const filteredAssets = useMemo(() => {
    // First filter by what the caller accepts
    let pool = items;
    if (accept !== 'all') {
      pool = pool.filter((a) => a.type === accept);
    }
    // Then by active tab
    if (activeTab !== 'all') {
      pool = pool.filter((a) => a.type === activeTab);
    }
    return pool;
  }, [items, accept, activeTab]);

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  const handleSelect = () => {
    if (selected) {
      onSelect(selected);
      onClose();
    }
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  // -------------------------------------------------------------------------
  // Tab config
  // -------------------------------------------------------------------------

  const tabs: { key: FilterTab; label: string; icon: React.ReactNode; show: boolean }[] = [
    {
      key: 'all',
      label: t('assetPicker.tabAll'),
      icon: null,
      show: accept === 'all',
    },
    {
      key: 'image',
      label: t('assetPicker.tabImage'),
      icon: <Image className="w-3.5 h-3.5" />,
      show: accept === 'all' || accept === 'image',
    },
    {
      key: 'video',
      label: t('assetPicker.tabVideo'),
      icon: <Film className="w-3.5 h-3.5" />,
      show: accept === 'all' || accept === 'video',
    },
  ];

  const visibleTabs = tabs.filter((t) => t.show);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
          variants={overlayVariants}
          initial="hidden"
          animate="visible"
          exit="hidden"
          transition={{ duration: 0.2 }}
          onClick={handleBackdropClick}
        >
          <motion.div
            className="
              w-[640px] max-h-[80vh]
              bg-elevated border border-glass-border
              rounded-2xl shadow-2xl
              flex flex-col overflow-hidden
            "
            variants={modalVariants}
            initial="hidden"
            animate="visible"
            exit="hidden"
            transition={springModal}
            onClick={(e) => e.stopPropagation()}
          >
            {/* -------------------------------------------------------------- */}
            {/* Header                                                          */}
            {/* -------------------------------------------------------------- */}
            <div className="px-6 py-5 border-b border-glass-border flex items-center justify-between shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-primary/15 flex items-center justify-center">
                  <Image size={16} className="text-primary" />
                </div>
                <h2 className="text-[0.9375rem] font-semibold text-foreground">{t('assetPicker.title')}</h2>
              </div>

              <button
                type="button"
                onClick={onClose}
                className="grid h-8 w-8 place-items-center rounded-lg text-text-muted transition-colors hover:bg-hover-bg hover:text-foreground"
              >
                <X size={16} />
              </button>
            </div>

            {/* Filter tabs */}
            {visibleTabs.length > 1 && (
              <div className="flex items-center gap-1.5 px-6 pt-4 pb-2 shrink-0">
                {visibleTabs.map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setActiveTab(tab.key)}
                    className={[
                      "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[0.6875rem] font-medium transition-all border",
                      activeTab === tab.key
                        ? "text-primary bg-primary/15 border-primary/30"
                        : "text-text-muted hover:text-foreground hover:bg-hover-bg border-transparent",
                    ].join(" ")}
                  >
                    {tab.icon}
                    {tab.label}
                  </button>
                ))}
              </div>
            )}

            {/* -------------------------------------------------------------- */}
            {/* Grid                                                            */}
            {/* -------------------------------------------------------------- */}
            <div className="flex-1 overflow-y-auto px-6 pb-2 min-h-0">
              {loading && (
                <div className="flex flex-col items-center justify-center py-16 gap-3">
                  <Loader2 className="w-6 h-6 text-text-muted animate-spin" />
                  <span className="text-xs text-text-muted">{t('assetPicker.loading')}</span>
                </div>
              )}

              {failed && !loading && (
                <div className="flex flex-col items-center justify-center py-16 gap-3">
                  <span className="text-xs text-status-failed-fg">{t('assetPicker.loadFailed')}</span>
                  <button
                    type="button"
                    onClick={fetchAssets}
                    className="text-xs text-primary hover:underline"
                  >
                    {t('assetPicker.retry')}
                  </button>
                </div>
              )}

              {!loading && !failed && filteredAssets.length === 0 && (
                <div className="flex flex-col items-center justify-center py-16 gap-2">
                  <Image className="w-8 h-8 text-text-muted" />
                  <span className="text-xs text-text-muted">
                    {t('assetPicker.empty')}
                  </span>
                  <span className="text-[0.6875rem] text-text-muted">
                    {t('assetPicker.emptyHint')}
                  </span>
                </div>
              )}

              {!loading && !failed && filteredAssets.length > 0 && (
                <div className="grid grid-cols-4 gap-3">
                  {filteredAssets.map((asset) => {
                    const isSelected = selected === asset.ref;

                    return (
                      <button
                        key={asset.id}
                        type="button"
                        title={asset.sourceName ? `${asset.sourceName} · ${asset.label}` : asset.label}
                        onClick={() =>
                          setSelected(isSelected ? null : asset.ref)
                        }
                        className={`
                          relative aspect-square rounded-lg overflow-hidden
                          bg-glass cursor-pointer
                          transition-all duration-150
                          ${
                            isSelected
                              ? 'border-2 border-primary ring-2 ring-primary/30'
                              : 'border border-border-subtle hover:border-primary/50'
                          }
                        `}
                      >
                        {/* Thumbnail */}
                        {asset.type === 'video' ? (
                          <video
                            src={asset.url}
                            className="w-full h-full object-cover"
                            muted
                            preload="metadata"
                          />
                        ) : (
                          <img
                            src={asset.url}
                            alt={asset.label}
                            className="w-full h-full object-cover"
                            loading="lazy"
                          />
                        )}

                        {/* Type badge */}
                        {asset.type === 'video' && (
                          <div className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-black/60 backdrop-blur-sm">
                            <Film className="w-3 h-3 text-foreground/80" />
                          </div>
                        )}

                        {/* Selected checkmark */}
                        {isSelected && (
                          <div className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-primary flex items-center justify-center">
                            <Check className="w-3 h-3 text-on-accent" />
                          </div>
                        )}

                        {/* File name */}
                        <div className="absolute bottom-0 left-0 right-0 px-1.5 py-1 bg-gradient-to-t from-black/70 to-transparent">
                          <span className="text-[0.625rem] text-foreground/80 truncate block">
                            {asset.label}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* -------------------------------------------------------------- */}
            {/* Footer                                                          */}
            {/* -------------------------------------------------------------- */}
            <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-glass-border">
              <button
                type="button"
                onClick={onClose}
                className="
                  px-4 py-2 rounded-lg text-xs
                  text-text-secondary hover:text-foreground
                  hover:bg-hover-bg
                  transition-colors
                "
              >
                {t('assetPicker.cancel')}
              </button>
              <button
                type="button"
                onClick={handleSelect}
                disabled={!selected}
                className={[
                  "inline-flex items-center gap-[7px] px-4 py-2 rounded-full text-xs font-medium transition-all",
                  selected
                    ? "bg-primary text-on-accent shadow-[var(--glow-primary)] hover:bg-primary-hover hover:-translate-y-px"
                    : "bg-elevated text-text-muted cursor-not-allowed",
                ].join(" ")}
              >
                <Check className="w-3.5 h-3.5" />
                {t('assetPicker.select')}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
