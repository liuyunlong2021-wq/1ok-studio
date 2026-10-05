'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { toast } from '@/store/toastStore';
import type { StylePreset } from '@/store/projectStore';
import type { PromptContext, PromptImage, PromptStyle } from '@/lib/promptEditorApi';
import type { AssetPickerItem } from '@/lib/assetLibrary';
import { StylePresetCardV2, PresetDetailModal } from '../ArtDirection';
import MediaInput from '../playground/MediaInput';

const BUTTON = 'rounded-lg border border-border-subtle px-3 py-1.5 text-xs hover:bg-hover-bg disabled:opacity-40';
const snapshot = (style: StylePreset): PromptStyle => ({ id: style.id, name: style.name_zh || style.name, description: style.description ?? '', positive_prompt: style.positive_prompt, negative_prompt: style.negative_prompt, thumbnail: style.thumbnail ?? null });

export default function PromptContextInput({ value, onChange, disabled }: { value: PromptContext; onChange: (value: PromptContext) => void; disabled: boolean }) {
  const [showStyles, setShowStyles] = useState(false);
  const [presets, setPresets] = useState<StylePreset[]>([]);
  const [detail, setDetail] = useState<StylePreset | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [styleError, setStyleError] = useState('');
  const assets = useRef(new Map<string, PromptImage>());
  const current = useRef(value); current.current = value;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!showStyles) return;
    let alive = true; setLoading(true); setStyleError('');
    void Promise.allSettled([api.getStylePresets(), api.getProjects(), api.listSeries()]).then(([library, projects, series]) => {
      if (!alive) return;
      if (library.status !== 'fulfilled') throw new Error('风格库加载失败');
      const styles: StylePreset[] = library.value.presets ?? [];
      for (const result of [projects, series]) {
        if (result.status !== 'fulfilled') { toast.warning('部分自定义风格未能加载，可稍后重新打开风格库'); continue; }
        for (const owner of result.value as Array<{ id: string; title: string; art_direction?: { custom_styles?: Array<Partial<StylePreset> & { thumbnail_url?: string; name: string }> } }>) {
          for (const custom of owner.art_direction?.custom_styles ?? []) styles.push({ id: `custom:${owner.id}:${custom.id}`, category: 'custom', name: custom.name, name_zh: custom.name_zh || `${custom.name} · ${owner.title}`, description: custom.description, positive_prompt: custom.positive_prompt ?? '', negative_prompt: custom.negative_prompt ?? '', thumbnail: custom.thumbnail_url ?? custom.thumbnail ?? null });
        }
      }
      setPresets(styles);
    }).catch(() => { if (alive) setStyleError('风格库加载失败，请关闭后重试'); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [showStyles]);
  const refsChanged = (refs: string[]) => {
    if (!mounted.current) return;
    const latest = current.current;
    const images = refs.map((ref) => latest.images.find((image) => image.ref === ref) ?? assets.current.get(ref) ?? { ref, name: ref.split('/').pop() || '上传图片', source: 'upload', description: '' });
    onChange({ ...latest, images });
  };
  const reorder = (index: number, step: number) => {
    const images = [...value.images];
    [images[index], images[index + step]] = [images[index + step], images[index]];
    onChange({ ...value, images });
    toast.info('图片顺序已调整，请检查正文中的 Image 编号');
  };
  return <div className={`space-y-3 border-b border-border-subtle p-4 ${disabled ? 'pointer-events-none opacity-50' : ''}`}>
    <details><summary className="cursor-pointer text-sm font-medium">风格 · {value.style?.name ?? '未选择'}</summary>
      <div className="mt-2 flex gap-2"><button className={BUTTON} onClick={() => setShowStyles(true)}>选择风格</button>{value.style && <button className={BUTTON} onClick={() => onChange({ ...value, style: null })}>清除</button>}</div>
      {value.style && <details className="mt-2 text-xs text-text-muted"><summary>查看当前风格</summary><p className="mt-2 whitespace-pre-wrap">{value.style.description}\n{value.style.positive_prompt}</p>{value.style.negative_prompt && <p className="mt-1 whitespace-pre-wrap">避免：{value.style.negative_prompt}</p>}</details>}
    </details>
    <details open><summary className="cursor-pointer text-sm font-medium">参考图片 · {value.images.length}/8</summary>
      <p className="my-2 text-xs text-text-muted">PNG / JPEG / WebP · 单张 10MB · 总量 30MB。发送时读图，不自动生成媒体。</p>
      <MediaInput controlled={{ value: value.images.map((image) => image.ref), onChange: refsChanged, onAsset: (item: AssetPickerItem) => { assets.current.set(item.ref, { ref: item.ref, name: item.label, source: item.id, description: `${item.sourceName}\n${item.description ?? ''}` }); }, onUploaded: (file, ref) => { assets.current.set(ref, { ref, name: file.name, source: 'upload', description: '' }); }, disabled, maxBytes: 10 * 1024 * 1024,
        config: { labelKey: 'compose.mediaReference', accept: 'image/png,image/jpeg,image/webp', hintKey: 't2i', multiple: true, maxFiles: 8, icon: 'image' } }} />
      <div className="mt-2 space-y-1">{value.images.map((image, index) => <div key={image.ref} className="flex items-center gap-1 text-xs"><span className="min-w-0 flex-1 truncate" title={image.name}>Image {index + 1} · {image.name}</span><button className={BUTTON} disabled={!index} onClick={() => reorder(index, -1)} aria-label="上移图片">↑</button><button className={BUTTON} disabled={index === value.images.length - 1} onClick={() => reorder(index, 1)} aria-label="下移图片">↓</button></div>)}</div>
    </details>
    {showStyles && <div role="dialog" aria-modal="true" aria-label="选择风格" className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-6" onClick={() => setShowStyles(false)}>
      <section className="relative flex h-[80vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-border-subtle bg-surface p-5" onClick={(event) => event.stopPropagation()}>
        <div className="mb-4 flex gap-3"><input placeholder="搜索风格" aria-label="搜索风格" className="min-w-0 flex-1 rounded-lg border border-border-subtle bg-input-bg px-3 py-2 text-sm" value={query} onChange={(event) => setQuery(event.target.value)} /><button className={BUTTON} onClick={() => setShowStyles(false)}>关闭</button></div>
        {loading ? <p>加载中…</p> : styleError ? <p role="alert">{styleError}</p> : <div className="grid grid-cols-2 gap-3 overflow-auto md:grid-cols-3">{presets.filter((style) => `${style.name} ${style.name_zh} ${style.description ?? ''}`.toLowerCase().includes(query.toLowerCase())).map((style) => <StylePresetCardV2 key={style.id} style={style} isSelected={style.id === value.style?.id} onClick={() => setDetail(style)} />)}</div>}
        {detail && <PresetDetailModal allowEditing={false} preset={detail} isSelected={detail.id === value.style?.id} editing={false} positivePrompt={detail.positive_prompt} negativePrompt={detail.negative_prompt} onPositiveChange={() => {}} onNegativeChange={() => {}} onStartEditing={() => {}} onApply={() => { onChange({ ...value, style: snapshot(detail) }); setDetail(null); setShowStyles(false); }} onClose={() => setDetail(null)} sameCategoryPresets={presets.filter((style) => style.category === detail.category)} onSwitchPreset={setDetail} />}
      </section>
    </div>}
  </div>;
}
