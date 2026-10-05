'use client';

import { useState, useMemo, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Sparkles, Grid3x3, GalleryHorizontal } from 'lucide-react';
import { usePlaygroundStore, type PlaygroundGeneration } from './usePlaygroundStore';
import { playgroundApi } from '@/lib/api';
import ResultCard from './ResultCard';
import GalleryView from './GalleryView';
import DetailPanel from './DetailPanel';
import QueuePanel from './QueuePanel';
import { toast } from '@/store/toastStore';

type VisibilityTarget = { generation_id: string; output_id: string };
const targetKey = (item: VisibilityTarget) => `${item.generation_id}:${item.output_id}`;

type FilterType = 'all' | 'image' | 'video' | 'audio';

const VIDEO_MODES = new Set(['t2v', 'i2v', 'r2v', 'v2v']);
const AUDIO_MODES = new Set(['t2a', 'r2a']);

function formatSessionLabel(
  dateStr: string,
  todayLabel: string,
  yesterdayLabel: string,
): string {
  const date = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const itemDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');

  if (itemDay.getTime() === today.getTime()) {
    return `${todayLabel} · ${hh}:${mm}`;
  }
  if (itemDay.getTime() === yesterday.getTime()) {
    return `${yesterdayLabel} · ${hh}:${mm}`;
  }
  const month = date.getMonth() + 1;
  const day = date.getDate();
  return `${month}/${day} · ${hh}:${mm}`;
}

export default function ResultGallery() {
  const { history, startGeneration, updateGeneration, useResultAsReference: setResultAsReference } = usePlaygroundStore();
  const t = useTranslations('playground');
  const [showRemoved, setShowRemoved] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [visibilityBusy, setVisibilityBusy] = useState(false);
  const visibilityLock = useRef(false);

  const changeVisibility = async (items: VisibilityTarget[], hidden: boolean, allowUndo = true) => {
    if (visibilityLock.current || !items.length) return;
    const current = usePlaygroundStore.getState().history;
    const changed = items.filter((item) => {
      const output = current.find((g) => g.id === item.generation_id)?.outputs.find((o) => o.id === item.output_id);
      return output && Boolean(output.hidden) !== hidden;
    });
    if (!changed.length) return;
    visibilityLock.current = true;
    setVisibilityBusy(true);
    try {
      const updated = await playgroundApi.setOutputVisibility(changed, hidden);
      updated.forEach((gen) => updateGeneration(gen as PlaygroundGeneration));
      setDetailGen(null);
      setSelected(new Set());
      toast.success(hidden ? `已从创作台移除 ${changed.length} 个结果` : `已恢复 ${changed.length} 个结果`, {
        body: '本地文件和资产库素材继续保留',
        autoCloseMs: 10000,
        action: allowUndo ? { label: '撤销', onClick: () => { void changeVisibility(changed, !hidden, false); } } : undefined,
      });
    } catch (error) {
      console.error('[Playground] Visibility update failed:', error);
      toast.error('未能保存媒体显示状态，请重试');
    } finally {
      visibilityLock.current = false;
      setVisibilityBusy(false);
    }
  };

  const [activeFilter, setActiveFilter] = useState<FilterType>('all');
  const [viewMode, setViewMode] = useState<'grid' | 'gallery'>('grid');
  const [detailGen, setDetailGen] = useState<PlaygroundGeneration | null>(null);
  const [detailOutputId, setDetailOutputId] = useState<string | undefined>(undefined);

  const handleOpenDetail = useCallback((gen: PlaygroundGeneration, outputId?: string) => {
    setDetailGen(gen);
    setDetailOutputId(outputId);
  }, []);

  const handleRetry = useCallback(async (gen: PlaygroundGeneration) => {
    try {
      const resp = await playgroundApi.generate({
        mode: gen.mode,
        model_id: gen.model_id,
        prompt: gen.prompt,
        negative_prompt: gen.negative_prompt || undefined,
        input_media: gen.input_media.length > 0 ? gen.input_media : undefined,
        parameters: Object.keys(gen.parameters).length > 0 ? gen.parameters : undefined,
        batch_size: gen.batch_size > 1 ? gen.batch_size : undefined,
      });
      const newGen: PlaygroundGeneration = {
        id: resp.id,
        mode: resp.mode as PlaygroundGeneration['mode'],
        model_id: resp.model_id,
        prompt: resp.prompt,
        negative_prompt: resp.negative_prompt,
        input_media: resp.input_media,
        parameters: resp.parameters,
        batch_size: resp.batch_size,
        outputs: [],
        status: resp.status as PlaygroundGeneration['status'],
        error: resp.error,
        created_at: resp.created_at,
      };
      startGeneration(newGen);
      // Poll for status
      const poll = setInterval(async () => {
        try {
          const s = await playgroundApi.getGenerationStatus(newGen.id);
          if (s.status === 'completed' || s.status === 'failed') {
            clearInterval(poll);
            const full = await playgroundApi.getGeneration(newGen.id);
            updateGeneration({
              ...newGen,
              status: full.status as PlaygroundGeneration['status'],
              outputs: full.outputs.map((o) => ({ id: o.id, media_path: o.media_path, media_type: o.media_type as 'image' | 'video' | 'audio', thumbnail_path: o.thumbnail_path, saved_to_library: o.saved_to_library, hidden: o.hidden })),
              error: full.error,
            });
          }
        } catch { clearInterval(poll); }
      }, 2000);
    } catch (err) {
      console.error('[Playground] Retry failed:', err);
    }
  }, [startGeneration, updateGeneration]);

  const handleDelete = useCallback(async (gen: PlaygroundGeneration) => {
    try {
      await playgroundApi.deleteGeneration(gen.id);
      usePlaygroundStore.getState().removeGeneration(gen.id);
    } catch (err) {
      console.error('[Playground] Delete failed:', err);
    }
  }, []);

  // Image result → "Generate video": set the image as i2v reference and switch mode.
  const handleGenerateVideo = useCallback(
    (mediaPath: string) => setResultAsReference(mediaPath, 'image', 'i2v'),
    [setResultAsReference],
  );

  const filtered = useMemo(() => {
    return history.flatMap((g) => {
      const mediaType = VIDEO_MODES.has(g.mode) ? 'video' : AUDIO_MODES.has(g.mode) ? 'audio' : 'image';
      const outputs = g.outputs.filter((o) => Boolean(o.hidden) === showRemoved && (activeFilter === 'all' || o.media_type === activeFilter));
      if (g.status === 'completed' || showRemoved) return outputs.length ? [{ ...g, outputs }] : [];
      return activeFilter === 'all' || activeFilter === mediaType ? [g] : [];
    });
  }, [history, activeFilter, showRemoved]);

  const availableTargets = filtered.flatMap((g) => g.status === 'completed' ? g.outputs.map((o) => ({ generation_id: g.id, output_id: o.id })) : []);
  const selectedTargets = availableTargets.filter((item) => selected.has(targetKey(item)));
  const removedCount = history.reduce((n, g) => n + g.outputs.filter((o) => o.hidden).length, 0);

  // Sort descending by created_at
  const sorted = useMemo(
    () =>
      [...filtered].sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      ),
    [filtered],
  );

  // Build items with session dividers
  const itemsWithDividers = useMemo(() => {
    const result: Array<
      | { type: 'generation'; data: PlaygroundGeneration }
      | { type: 'divider'; label: string; key: string }
    > = [];

    for (let i = 0; i < sorted.length; i++) {
      if (i > 0) {
        const prevTime = new Date(sorted[i - 1].created_at).getTime();
        const currTime = new Date(sorted[i].created_at).getTime();
        const gap = prevTime - currTime; // prev is more recent (descending)
        if (gap > 30 * 60 * 1000) {
          result.push({
            type: 'divider',
            label: formatSessionLabel(
              sorted[i].created_at,
              t('results.today'),
              t('results.yesterday'),
            ),
            key: `divider-${sorted[i].id}`,
          });
        }
      }
      result.push({ type: 'generation', data: sorted[i] });
    }

    return result;
  }, [sorted, t]);

  // Flat list of generation data items (no dividers) for GalleryView and DetailPanel
  const dataItems = useMemo(
    () =>
      itemsWithDividers
        .filter((item): item is { type: 'generation'; data: PlaygroundGeneration } => item.type === 'generation')
        .map((item) => item.data),
    [itemsWithDividers],
  );

  // Grid items: expand each completed generation into one tile per output (so
  // multi-output batches show all N); keep pending/processing/failed as one card.
  const gridItems = useMemo(() => {
    const out: Array<
      | { kind: 'divider'; label: string; key: string }
      | { kind: 'output'; gen: PlaygroundGeneration; outputIndex: number }
      | { kind: 'gen'; gen: PlaygroundGeneration }
    > = [];
    for (const item of itemsWithDividers) {
      if (item.type === 'divider') {
        out.push({ kind: 'divider', label: item.label, key: item.key });
        continue;
      }
      const g = item.data;
      if (g.status === 'completed' && g.outputs.length > 0) {
        g.outputs.forEach((_, i) => out.push({ kind: 'output', gen: g, outputIndex: i }));
      } else {
        out.push({ kind: 'gen', gen: g });
      }
    }
    return out;
  }, [itemsWithDividers]);

  const filters: { key: FilterType; label: string }[] = [
    { key: 'all', label: t('results.filterAll') },
    { key: 'image', label: t('results.filterImage') },
    { key: 'video', label: t('results.filterVideo') },
    { key: 'audio', label: t('results.filterAudio') },
  ];

  if (history.length === 0) {
    return (
      <div className="flex flex-col flex-1 overflow-hidden min-w-0 items-center justify-center">
        <Sparkles className="w-12 h-12 text-text-muted opacity-40 mb-4" />
        <p className="font-display atelier-display text-base text-foreground mb-1">
          {t('results.emptyTitle')}
        </p>
        <p className="text-xs text-text-muted">{t('results.emptyBody')}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 overflow-hidden min-w-0">
      {/* Header */}
      <div className="px-7 py-4 flex items-center justify-between border-b border-border-subtle shrink-0">
        <div className="flex flex-col gap-1">
          <span className="font-mono text-[0.6875rem] uppercase tracking-[0.18em] text-text-muted">
            RESULTS
          </span>
          <div className="flex items-center gap-2">
            <span className="text-[2.125rem] leading-[1.1] font-semibold tracking-[-0.02em] text-foreground font-display atelier-display">
              {t('results.title')}
            </span>
            <span className="font-mono text-[0.625rem] bg-elevated text-text-secondary rounded px-[6px] py-[1px]">
              {filtered.reduce((n, g) => n + g.outputs.length, 0)}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-[2px] bg-surface-inset rounded-full p-1 atelier-pill-tabs">
            {filters.map((f) => (
              <button
                key={f.key}
                onClick={() => { setActiveFilter(f.key); setSelected(new Set()); }}
                className={`rounded-full px-4 py-2 text-[0.8125rem] font-medium text-center transition-all cursor-pointer ${
                  activeFilter === f.key
                    ? 'bg-surface text-foreground atelier-pill-tab-active'
                    : 'text-text-muted hover:text-foreground hover:bg-hover-bg'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-[2px] bg-surface-inset rounded-full p-1 atelier-pill-tabs">
            <button
              onClick={() => setViewMode('grid')}
              className={`rounded-full p-2 transition-all cursor-pointer ${
                viewMode === 'grid'
                  ? 'bg-surface text-foreground atelier-pill-tab-active'
                  : 'text-text-muted hover:text-foreground hover:bg-hover-bg'
              }`}
              title={t('results.gridView')}
            >
              <Grid3x3 className="w-4 h-4" />
            </button>
            <button
              onClick={() => { setViewMode('gallery'); setSelecting(false); setSelected(new Set()); }}
              className={`rounded-full p-2 transition-all cursor-pointer ${
                viewMode === 'gallery'
                  ? 'bg-surface text-foreground atelier-pill-tab-active'
                  : 'text-text-muted hover:text-foreground hover:bg-hover-bg'
              }`}
              title={t('results.galleryView')}
            >
              <GalleryHorizontal className="w-4 h-4" />
            </button>
          </div>

          <QueuePanel />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-b border-border-subtle px-7 py-3 text-xs">
        <button type="button" disabled={visibilityBusy} className={`rounded-full px-3 py-2 ${showRemoved ? 'bg-primary text-on-accent' : 'bg-surface-inset'}`}
          onClick={() => { setShowRemoved(!showRemoved); setSelected(new Set()); }}>
          {showRemoved ? '返回生成结果' : `已移除 (${removedCount})`}
        </button>
        <button type="button" disabled={visibilityBusy} className="rounded-full bg-surface-inset px-3 py-2"
          onClick={() => { setSelecting(!selecting); setViewMode('grid'); setSelected(new Set()); }}>
          {selecting ? '退出选择' : '批量管理'}
        </button>
        {selecting && <>
          <button type="button" disabled={visibilityBusy || !availableTargets.length} onClick={() => setSelected(new Set(availableTargets.map(targetKey)))}>全选当前列表</button>
          <button type="button" disabled={visibilityBusy} onClick={() => setSelected(new Set())}>取消选择</button>
          <button type="button" disabled={visibilityBusy || !selectedTargets.length} className="rounded-full bg-primary px-3 py-2 text-on-accent disabled:opacity-40"
            onClick={() => { void changeVisibility(selectedTargets, !showRemoved); }}>
            {visibilityBusy ? '保存中…' : `${showRemoved ? '恢复' : '移除'}已选 (${selectedTargets.length})`}
          </button>
        </>}
        {showRemoved && <span className="text-text-muted">可恢复，本地文件继续保留</span>}
      </div>
      {filtered.length === 0 && <p className="px-7 py-8 text-sm text-text-muted">{showRemoved ? '没有已移除的媒体' : '当前列表没有结果'}</p>}
      {/* Content area */}
      {viewMode === 'gallery' ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <GalleryView
            generations={dataItems.flatMap((gen) => gen.outputs.length ? gen.outputs.map((output) => ({ ...gen, outputs: [output] })) : [gen])}
            onOpenDetail={(gen) => handleOpenDetail(gen, gen.outputs[0]?.id)}
            onRetry={handleRetry}
            visibilityBusy={visibilityBusy}
            onVisibilityChange={(gen, outputId, hidden) => { void changeVisibility([{ generation_id: gen.id, output_id: outputId }], hidden); }}
          />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-6">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4 content-start">
            {gridItems.map((it) => {
              if (it.kind === 'divider') {
                return (
                  <div
                    key={it.key}
                    className="col-span-full flex items-center gap-3 py-2"
                  >
                    <div className="flex-1 h-px bg-border-subtle" />
                    <span className="font-mono text-[0.5625rem] text-text-muted uppercase tracking-wider whitespace-nowrap">
                      {it.label}
                    </span>
                    <div className="flex-1 h-px bg-border-subtle" />
                  </div>
                );
              }
              if (it.kind === 'output') {
                return (
                  <div key={`${it.gen.id}-${it.gen.outputs[it.outputIndex].id}`} className="relative">
                    {selecting && <label className="absolute left-2 top-2 z-30 flex items-center gap-1 rounded-lg bg-surface/95 px-2 py-1 text-xs shadow">
                      <input type="checkbox" aria-label="选择媒体" disabled={visibilityBusy}
                        checked={selected.has(targetKey({ generation_id: it.gen.id, output_id: it.gen.outputs[it.outputIndex].id }))}
                        onChange={(e) => {
                          const key = targetKey({ generation_id: it.gen.id, output_id: it.gen.outputs[it.outputIndex].id });
                          setSelected((old) => { const next = new Set(old); if (e.target.checked) next.add(key); else next.delete(key); return next; });
                        }} />选择
                    </label>}
                    <ResultCard
                      generation={it.gen}
                      outputIndex={it.outputIndex}
                      onRetry={handleRetry}
                      onDelete={handleDelete}
                      onGenerateVideo={handleGenerateVideo}
                      onOpenDetail={handleOpenDetail}
                      visibilityBusy={visibilityBusy}
                      onVisibilityChange={(gen, outputId, hidden) => { void changeVisibility([{ generation_id: gen.id, output_id: outputId }], hidden); }}
                    />
                  </div>
                );
              }
              return (
                <ResultCard
                  key={it.gen.id}
                  generation={it.gen}
                  onRetry={handleRetry}
                  onDelete={handleDelete}
                  onGenerateVideo={handleGenerateVideo}
                  onOpenDetail={handleOpenDetail}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* Detail Panel */}
      {detailGen && (
        <DetailPanel
          generation={detailGen}
          allGenerations={dataItems}
          focusOutputId={detailOutputId}
          visibilityBusy={visibilityBusy}
          onVisibilityChange={(gen, outputId, hidden) => { void changeVisibility([{ generation_id: gen.id, output_id: outputId }], hidden); }}
          onClose={() => { setDetailGen(null); setDetailOutputId(undefined); }}
          onNavigate={(g) => handleOpenDetail(g)}
          onRetry={handleRetry}
          onGenerateVideo={handleGenerateVideo}
        />
      )}
    </div>
  );
}
