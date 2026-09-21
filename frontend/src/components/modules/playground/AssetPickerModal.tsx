'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
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
  /** 点一张瓦片：不在参考图里的就加进去，已在里面的就移出去。**点完就生效**，
   *  弹窗没有「提交」这一步 —— 所以直接关掉（× / Esc / 点背景 / 完成）不会丢东西。 */
  onToggle: (ref: string) => void;
  accept: 'image' | 'video' | 'all';
  /** 参考图里现有的引用（＝瓦片的勾选态）。 */
  existing?: string[];
  /** 还能再收几张（调用方实时算：maxFiles − 已有）。不传 = 不限。 */
  capacity?: number;
  /** 已在里面的那张能不能点掉。多参考模式可以；单参考模式那张是当前唯一一张，
   *  不给点（想换就点别人）。 */
  canRemoveExisting?: boolean;
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
  onToggle,
  accept,
  existing,
  capacity,
  canRemoveExisting,
}: AssetPickerModalProps) {
  const t = useTranslations('playground');
  const [items, setItems] = useState<AssetPickerItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [activeTab, setActiveTab] = useState<FilterTab>(
    accept === 'all' ? 'all' : accept
  );
  // 勾选态直接看调用方的引用列表 —— 弹窗自己不留一份待提交的副本。
  const alreadyIn = useMemo(() => new Set(existing ?? []), [existing]);

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
    if (isOpen) fetchAssets();
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

  const inCount = alreadyIn.size;
  const room = capacity === undefined ? Infinity : Math.max(capacity, 0);
  const atCapacity = room <= 0;

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
  //
  // 一定要走 portal 挂到 document.body：创作台的媒体卡片是 `.glass-panel`
  // （backdrop-blur），而 `backdrop-filter` 会给 fixed 后代创造包含块 ——
  // 留在卡片里的话 `fixed inset-0` 的遮罩只会盖住那张卡，弹窗连同底部的按钮
  // 被裁在卡片范围里，用户根本点不到（2026-09-21 用户在 App 里就是这么卡住的）。
  // 同一个目录的 PromptTemplateModal / DetailPanel 都是这么挂的。
  // -------------------------------------------------------------------------

  if (typeof document === 'undefined') return null;

  return createPortal(
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
              w-[640px] max-w-[calc(100vw-2rem)] max-h-[calc(100vh-2rem)]
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
                    const isThere = alreadyIn.has(asset.ref);
                    // 已在里面 + 允许移除 → 点一下移出去；单参考模式那张不给点（想换就点别人）。
                    const removable = isThere && !!canRemoveExisting;
                    const disabled = isThere ? !removable : atCapacity;
                    const hint = isThere
                      ? removable
                        ? t('assetPicker.tapToRemove')
                        : t('media.refAlreadyAdded')
                      : atCapacity
                        ? t('media.refsFull')
                        : t('assetPicker.tapToAdd');

                    return (
                      <button
                        key={asset.id}
                        type="button"
                        disabled={disabled}
                        aria-pressed={isThere}
                        title={[asset.sourceName ? `${asset.sourceName} · ${asset.label}` : asset.label, hint]
                          .filter(Boolean)
                          .join(' — ')}
                        onClick={() => onToggle(asset.ref)}
                        className={`
                          relative aspect-square rounded-lg overflow-hidden
                          bg-glass transition-all duration-150
                          ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}
                          ${
                            isThere
                              ? 'border-2 border-primary ring-2 ring-primary/30'
                              : atCapacity
                                ? 'border border-border-subtle opacity-40'
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

                        {/* 已在参考图里的标记 */}
                        {isThere && (
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
            {/*                                                               */}
            {/* 没有「提交」：点瓦片就已经生效了，这里只是关掉。                  */}
            {/* -------------------------------------------------------------- */}
            <div className="flex items-center gap-3 px-6 py-4 border-t border-glass-border">
              <span className="mr-auto text-[0.6875rem] text-text-muted">
                {canRemoveExisting ? t('assetPicker.hintMulti') : t('assetPicker.hintSingle')}
              </span>
              <span className="font-mono text-[0.6875rem] text-text-muted">
                <span className="text-foreground">{t('assetPicker.addedCount', { count: inCount })}</span>
                {/* 单参考模式（canRemoveExisting=false）容量恒为 1，报「还能加 1 张」会误导 —— 那一栏只在多参考模式显示。 */}
                {capacity !== undefined && canRemoveExisting && (
                  <>
                    <span className="mx-1.5 opacity-50">·</span>
                    {t('assetPicker.roomLeft', { count: room })}
                  </>
                )}
              </span>
              <button
                type="button"
                onClick={onClose}
                className="
                  inline-flex items-center gap-[7px] px-4 py-2 rounded-full text-xs font-medium
                  bg-primary text-on-accent shadow-[var(--glow-primary)]
                  hover:bg-primary-hover hover:-translate-y-px transition-all
                "
              >
                <Check className="w-3.5 h-3.5" />
                {t('assetPicker.done')}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
