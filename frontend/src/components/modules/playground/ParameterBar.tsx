'use client';

import { useState, useRef, useEffect } from 'react';
import { usePlaygroundStore } from './usePlaygroundStore';
import { getModelParams, getModelDuration } from './playgroundModels';
import { ChevronDown, Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  ASPECT_RATIO_PRESETS,
  CUSTOM_RATIO,
  CUSTOM_SIZE_RULES,
  formatSizeLabel,
  parseImageSize,
  presetRatioForSize,
  presetResolutionForSize,
  resolvePresetSize,
  validateCustomSize,
  type AspectRatioPreset,
  type Resolution,
} from '@/lib/imageSizePresets';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VIDEO_MODES = new Set(['t2v', 'i2v', 'r2v', 'v2v']);
const BATCH_OPTIONS = [1, 2, 4] as const;

const FALLBACK_RATIOS = ['16:9', '9:16', '1:1'];
const FALLBACK_RESOLUTIONS = ['720P', '1080P'];

// ---------------------------------------------------------------------------
// ParamDropdown — custom styled dropdown (replaces native <select>)
// ---------------------------------------------------------------------------

/** Compute aspect ratio label from a "WxH" or "W*H" size string. */
function sizeToRatioLabel(size: string): string | null {
  const m = size.match(/^(\d+)[x*×](\d+)$/i);
  if (!m) return null;
  const w = parseInt(m[1], 10);
  const h = parseInt(m[2], 10);
  if (!w || !h) return null;
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const d = gcd(w, h);
  return `${w / d}:${h / d}`;
}

function ParamDropdown({
  label,
  value,
  options,
  onChange,
  disabled,
  formatOption,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
  disabled?: boolean;
  formatOption?: (opt: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const display = formatOption ?? ((o: string) => o);

  return (
    <div className="flex flex-col gap-[6px]">
      <span className="font-mono text-[0.625rem] uppercase tracking-[0.08em] text-text-muted">{label}</span>
      <div ref={containerRef} className="relative">
        <button
          type="button"
          disabled={disabled}
          onClick={() => !disabled && setOpen((o) => !o)}
          className={`w-full flex items-center justify-between px-3 py-2.5 rounded-[14px] bg-surface-inset border border-border-subtle text-foreground text-xs font-medium transition cursor-pointer ${
            disabled
              ? 'opacity-50 cursor-not-allowed'
              : 'hover:border-foreground/30'
          }`}
        >
          <span>{display(value)}</span>
          {!disabled && <ChevronDown className={`w-3 h-3 text-text-muted transition-transform ${open ? 'rotate-180' : ''}`} />}
        </button>

        {open && (
          <div className="absolute bottom-full mb-1 w-full bg-elevated atelier-card border border-border-subtle z-30 max-h-48 overflow-y-auto">
            {options.map((opt) => (
              <div
                key={opt}
                onClick={() => {
                  onChange(opt);
                  setOpen(false);
                }}
                className="px-3 py-2 text-xs flex items-center justify-between hover:bg-hover-bg cursor-pointer"
              >
                <span className={opt === value ? 'text-foreground' : 'text-text-secondary'}>
                  {display(opt)}
                </span>
                {opt === value && <Check className="w-3 h-3 text-primary" />}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Format image size with aspect ratio: "1024x1024" → "1024×1024 (1:1)" */
function formatImageSize(size: string): string {
  const normalized = size.replace(/[*x]/g, '×');
  const ratio = sizeToRatioLabel(size);
  return ratio ? `${normalized} (${ratio})` : normalized;
}

/**
 * `768p竖` -> `9:16`；不带 横/竖 后缀的（如 `720p`）返回 null。
 *
 * resolution 自带横竖时它是唯一事实源，aspect_ratio 跟着它走，
 * 这样状态里不会留下与界面不符的旧比例。
 */
function ratioForOrientedResolution(resolution: string): string | null {
  const suffix = resolution.slice(-1);
  if (suffix !== '横' && suffix !== '竖') return null;
  return suffix === '横' ? '16:9' : '9:16';
}

// ---------------------------------------------------------------------------
// SizePresetPicker — 分辨率 + 画面比例 两个下拉（GPT Image 2.5 系列）
// ---------------------------------------------------------------------------
//
// 只把 `size` 存进 parameters，分辨率和比例都从像素反查出来：
// 表里每个 size 全局唯一，所以反查是确定的，不用再存第二份状态，
// 也就不会出现「比例显示 7:3、实际选了 21:9」这种漂移。

function SizePresetPicker({
  resolutions,
  size,
  onChange,
}: {
  resolutions: Resolution[];
  size: string;
  onChange: (size: string) => void;
}) {
  const t = useTranslations('playground');
  const [customOpen, setCustomOpen] = useState(false);
  // 自定义像素时分辨率下拉锁住，但离开自定义要回到用户上一档，所以记住它
  const [lastResolution, setLastResolution] = useState<Resolution>(resolutions[0] ?? '1K');
  const [customInput, setCustomInput] = useState(() => {
    const parsed = parseImageSize(size);
    return { w: String(parsed?.width ?? 1024), h: String(parsed?.height ?? 1024) };
  });

  const sizeResolution = presetResolutionForSize(size);
  const sizeRatio = presetRatioForSize(size);
  // 同步 effect 跑之前 parameters.size 可能还是空的（或上一个模型的旧值），
  // 这时先把 UI 当成 1:1 展示，避免闪一下「自定义」输入框。
  const parsedSize = parseImageSize(size);
  const isCustom = !!parsedSize && (customOpen || sizeRatio === CUSTOM_RATIO);

  useEffect(() => {
    if (sizeResolution) setLastResolution(sizeResolution);
  }, [sizeResolution]);

  const shownResolution = sizeResolution ?? lastResolution;
  const width = parseInt(customInput.w, 10) || 0;
  const height = parseInt(customInput.h, 10) || 0;
  const customResult = isCustom ? validateCustomSize(width, height) : null;

  const pickRatio = (next: string) => {
    if (next === CUSTOM_RATIO) {
      // 进自定义时用当前像素做初值，SizePresetPicker 只在换模型时重挂载，
      // 所以这里显式种一遍。
      const parsed = parseImageSize(size);
      setCustomInput({
        w: String(parsed?.width ?? 1024),
        h: String(parsed?.height ?? 1024),
      });
      setCustomOpen(true);
      return;
    }
    setCustomOpen(false);
    const resolved = resolvePresetSize(shownResolution, next as AspectRatioPreset);
    if (resolved) onChange(resolved.size);
  };

  const pickResolution = (next: string) => {
    setLastResolution(next as Resolution);
    // 保持比例只换档；比例是自定义像素时没有档位概念，等用户选回预设比例
    if (sizeRatio !== CUSTOM_RATIO) {
      const resolved = resolvePresetSize(next as Resolution, sizeRatio);
      if (resolved) onChange(resolved.size);
    }
  };

  const typeCustom = (axis: 'w' | 'h', value: string) => {
    const next = { ...customInput, [axis]: value.replace(/[^\d]/g, '') };
    setCustomInput(next);
    const parsed = validateCustomSize(parseInt(next.w, 10) || 0, parseInt(next.h, 10) || 0);
    // 只在合法时提交，避免把 1920x10 这种中间态发给后端
    if (parsed.size) onChange(parsed.size);
  };

  const parsed = parseImageSize(size);

  return (
    <div className="col-span-2 flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <ParamDropdown
          label={t('parameters.resolution')}
          value={shownResolution}
          options={resolutions}
          onChange={pickResolution}
          disabled={isCustom}
        />
        <ParamDropdown
          label={t('parameters.aspectRatio')}
          value={parsedSize ? sizeRatio : '1:1'}
          options={[...ASPECT_RATIO_PRESETS, CUSTOM_RATIO]}
          onChange={pickRatio}
        />
      </div>

      {isCustom ? (
        <div className="flex flex-col gap-[6px]">
          <div className="flex items-center gap-2">
            {(['w', 'h'] as const).map((axis, index) => (
              <div key={axis} className="flex items-center gap-2 flex-1">
                {index === 1 && <span className="text-text-muted text-xs">×</span>}
                <input
                  inputMode="numeric"
                  value={customInput[axis]}
                  onChange={(e) => typeCustom(axis, e.target.value)}
                  className="w-full px-3 py-2.5 rounded-[14px] bg-surface-inset border border-border-subtle text-foreground text-xs font-medium outline-none focus:border-foreground/30"
                />
              </div>
            ))}
          </div>
          <span className="text-[0.6875rem] text-text-muted">
            {customResult?.errors.length
              ? customResult.errors[0]
              : `${parsed ? formatSizeLabel(parsed) : ''} · ${
                  CUSTOM_SIZE_RULES.multipleOf
                } 的倍数，单边 ≤ ${CUSTOM_SIZE_RULES.maxSide}`}
          </span>
        </div>
      ) : (
        <span className="text-[0.6875rem] text-text-muted">
          {parsed ? formatSizeLabel(parsed) : ''}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PillToggle — ON / OFF pill selector
// ---------------------------------------------------------------------------

function PillToggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-[6px]">
      <span className="font-mono text-[0.625rem] uppercase tracking-[0.08em] text-text-muted">{label}</span>
      <div className="flex gap-[2px] p-[3px] bg-surface-inset rounded-full atelier-pill-tabs">
        <button
          type="button"
          onClick={() => onChange(true)}
          className={`flex-1 rounded-full px-3 py-1.5 text-[0.6875rem] font-medium text-center cursor-pointer transition-all ${
            value
              ? 'bg-primary text-on-accent'
              : 'text-text-muted hover:text-foreground hover:bg-hover-bg'
          }`}
        >
          ON
        </button>
        <button
          type="button"
          onClick={() => onChange(false)}
          className={`flex-1 rounded-full px-3 py-1.5 text-[0.6875rem] font-medium text-center cursor-pointer transition-all ${
            !value
              ? 'bg-primary text-on-accent'
              : 'text-text-muted hover:text-foreground hover:bg-hover-bg'
          }`}
        >
          OFF
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DurationStepper — +/- stepper for integer seconds
// ---------------------------------------------------------------------------

function DurationStepper({
  value,
  min,
  max,
  step,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  const t = useTranslations('playground');
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value.replace(/[^0-9]/g, '');
    if (raw === '') return;
    const num = parseInt(raw, 10);
    onChange(Math.max(min, Math.min(max, num)));
  };

  const handleBlur = () => {
    onChange(Math.max(min, Math.min(max, value)));
  };

  return (
    <div className="flex flex-col gap-[6px]">
      <span className="font-mono text-[0.625rem] uppercase tracking-[0.08em] text-text-muted">{t('parameters.duration')}</span>
      <div className="flex items-center gap-0 rounded-[14px] border border-border-subtle bg-surface-inset overflow-hidden">
        <button
          type="button"
          disabled={value <= min}
          onClick={() => onChange(Math.max(min, value - step))}
          className="px-3 py-2.5 text-text-secondary hover:text-foreground hover:bg-hover-bg transition disabled:opacity-30 disabled:cursor-not-allowed text-sm font-medium shrink-0"
        >
          −
        </button>
        <div className="flex-1 flex items-center justify-center gap-0.5 py-2.5">
          <input
            type="text"
            inputMode="numeric"
            value={value}
            onChange={handleInputChange}
            onBlur={handleBlur}
            className="w-8 bg-transparent text-center font-mono text-xs font-medium text-foreground outline-none"
          />
          <span className="text-[0.625rem] text-text-muted font-mono">s</span>
        </div>
        <button
          type="button"
          disabled={value >= max}
          onClick={() => onChange(Math.min(max, value + step))}
          className="px-3 py-2.5 text-text-secondary hover:text-foreground hover:bg-hover-bg transition disabled:opacity-30 disabled:cursor-not-allowed text-sm font-medium shrink-0"
        >
          +
        </button>
      </div>
      <div className="flex justify-between px-1">
        <span className="text-[0.5625rem] text-text-muted font-mono">{min}s</span>
        <span className="text-[0.5625rem] text-text-muted font-mono">{max}s</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ParameterBar
// ---------------------------------------------------------------------------

export default function ParameterBar() {
  const t = useTranslations('playground');
  const mode = usePlaygroundStore((s) => s.mode);
  const modelId = usePlaygroundStore((s) => s.modelId);
  const parameters = usePlaygroundStore((s) => s.parameters);
  const batchSize = usePlaygroundStore((s) => s.batchSize);
  const setParameters = usePlaygroundStore((s) => s.setParameters);
  const setBatchSize = usePlaygroundStore((s) => s.setBatchSize);

  const [showAdvanced, setShowAdvanced] = useState(false);

  const isVideoMode = VIDEO_MODES.has(mode);
  const isAudioMode = mode === 't2a' || mode === 'r2a';

  // Read model-specific params and duration from catalog
  const modelParams = getModelParams(modelId);
  const modelDuration = getModelDuration(modelId);

  // Derive options with fallbacks — IMAGE uses size, VIDEO uses resolution/ratio
  const hasSize = !!modelParams?.size;
  const hasResolution = !!modelParams?.resolution;
  const hasRatio = !!modelParams?.ratio;
  const hasQuality = !!modelParams?.quality;

  const sizeOptions = modelParams?.size?.options ?? [];
  const sizeDefault = modelParams?.size?.default ?? sizeOptions[0] ?? '1024*1024';
  // 目录声明了 resolutions 的模型（GPT Image 2.5 系列）走「分辨率 + 画面比例」，
  // 像素表在前端 imageSizePresets.ts；没声明的（gemini / grok）继续走旧单下拉。
  const sizeResolutions = modelParams?.size?.resolutions ?? [];
  const usesSizePresets = sizeResolutions.length > 0;
  const ratioOptions = modelParams?.ratio?.options ?? FALLBACK_RATIOS;
  const ratioDefault = modelParams?.ratio?.default ?? ratioOptions[0];
  const resolutionOptions = modelParams?.resolution?.options ?? FALLBACK_RESOLUTIONS;
  const resolutionDefault = modelParams?.resolution?.default ?? resolutionOptions[0];
  const qualityOptions = modelParams?.quality?.options ?? [];
  const qualityDefault = modelParams?.quality?.default ?? qualityOptions[0] ?? 'high';

  // 有些模型的 resolution 选项自带 横/竖（如 480p横 / 768p竖），横竖已经由它决定。
  // 这时再显示「画面比例」就是两个控件表达同一件事，必然打架（16:9 + 768p竖）。
  // 以 resolution 为准隐藏 ratio；后端也会在两者矛盾时纠正 ratio，双保险。
  const resolutionEncodesOrientation = resolutionOptions.some(
    (o) => ratioForOrientedResolution(o) !== null,
  );
  const showRatio = hasRatio && !resolutionEncodesOrientation;

  // Boolean feature flags from model
  const supportsSeed = modelParams?.seed !== false;
  const supportsPromptExtend = modelParams?.promptExtend !== false;
  const supportsWatermark = modelParams?.watermark !== false;
  const hasAnyAdvanced = supportsSeed || supportsPromptExtend || supportsWatermark;

  // When model changes, reset params whose current value is not in the new model's options
  useEffect(() => {
    const patches: Record<string, any> = {};

    if (hasSize) {
      const cur = parameters.size as string | undefined;
      if (usesSizePresets) {
        // 走预设表的模型：值必须落在该模型声明的分辨率档里，
        // 否则切模型后（1K 模型 → 超分模型，或反过来）会留着一个非法尺寸。
        const curResolution = cur ? presetResolutionForSize(cur) : null;
        if (!curResolution || !sizeResolutions.includes(curResolution)) {
          patches.size = resolvePresetSize(sizeResolutions[0] ?? '1K', '1:1')?.size ?? sizeDefault;
        }
      } else if (cur && !sizeOptions.includes(cur)) {
        patches.size = sizeDefault;
      }
    }
    if (hasRatio) {
      const cur = parameters.aspect_ratio as string | undefined;
      if (cur && !ratioOptions.includes(cur)) patches.aspect_ratio = ratioDefault;
    }
    if (hasResolution) {
      const cur = parameters.resolution as string | undefined;
      const next = cur && resolutionOptions.includes(cur) ? cur : resolutionDefault;
      if (next !== cur) patches.resolution = next;
      // 自带 横/竖 的模型：aspect_ratio 必须跟着 resolution，否则会发出矛盾组合
      const impliedRatio = ratioForOrientedResolution(next);
      if (impliedRatio && parameters.aspect_ratio !== impliedRatio) {
        patches.aspect_ratio = impliedRatio;
      }
    }
    if (hasQuality) {
      const cur = parameters.quality as string | undefined;
      if (cur && !qualityOptions.includes(cur)) patches.quality = qualityDefault;
    }

    if (isVideoMode && modelDuration) {
      const currentDur = parameters.duration as number | undefined;
      if (modelDuration.type === 'slider') {
        if (currentDur != null && (currentDur < modelDuration.min || currentDur > modelDuration.max))
          patches.duration = modelDuration.default;
      } else if (modelDuration.type === 'buttons') {
        if (currentDur != null && !modelDuration.options.includes(currentDur))
          patches.duration = modelDuration.default;
      } else if (modelDuration.type === 'fixed') {
        patches.duration = modelDuration.value;
      }
    }

    if (Object.keys(patches).length > 0) setParameters({ ...parameters, ...patches });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId]);

  const updateParam = (key: string, value: any) => {
    setParameters({ ...parameters, [key]: value });
  };

  // 一次改多个参数：分别调用 updateParam 会在同一个 stale parameters 上展开，后者覆盖前者。
  const updateParams = (patch: Record<string, any>) => {
    setParameters({ ...parameters, ...patch });
  };

  // resolution 的 横/竖 后缀 -> 对应比例，让 aspect_ratio 跟它保持一致，
  // 不会出现「界面显示 768p竖、状态里还存着 16:9」。

  // Duration state (video only)
  const durationValue = (parameters.duration as number | undefined)
    ?? (modelDuration?.type === 'fixed' ? modelDuration.value
      : (modelDuration?.type === 'slider' || modelDuration?.type === 'buttons') ? modelDuration.default : 5);
  const durationFixed = modelDuration?.type === 'fixed';

  // Batch pill renderer (reused for both image and video)
  const batchPills = (
    <div className="flex flex-col gap-[6px]">
      <span className="font-mono text-[0.625rem] uppercase tracking-[0.08em] text-text-muted">{t('parameters.batchSize')}</span>
      <div className="flex gap-[2px] p-[3px] bg-surface-inset rounded-full atelier-pill-tabs">
        {BATCH_OPTIONS.map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => setBatchSize(n)}
            className={`flex-1 rounded-full px-3 py-1.5 font-mono text-[0.6875rem] font-medium cursor-pointer transition-all text-center ${
              batchSize === n
                ? 'bg-primary text-on-accent'
                : 'text-text-muted hover:text-foreground hover:bg-hover-bg'
            }`}
          >
            x{n}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">

        {/* ── IMAGE MODE PARAMS ── */}
        {!isVideoMode && !isAudioMode && (
          <>
            {/* Size (image-specific, replaces resolution) */}
            {hasSize &&
              (usesSizePresets ? (
                <SizePresetPicker
                  key={modelId}
                  resolutions={sizeResolutions}
                  size={(parameters.size as string) ?? sizeDefault}
                  onChange={(v) => updateParam('size', v)}
                />
              ) : (
                <ParamDropdown
                  label={t('parameters.imageSize')}
                  value={(parameters.size as string) ?? sizeDefault}
                  options={sizeOptions}
                  onChange={(v) => updateParam('size', v)}
                  formatOption={formatImageSize}
                />
              ))}

            {/* Quality (GPT-Image-2 specific) */}
            {hasQuality && (
              <ParamDropdown
                label={t('parameters.quality')}
                value={(parameters.quality as string) ?? qualityDefault}
                options={qualityOptions}
                onChange={(v) => updateParam('quality', v)}
              />
            )}

            {/* Batch — spans full width if no quality, else single col */}
            <div className={!hasQuality && !hasSize ? 'col-span-2' : hasSize && !hasQuality ? '' : ''}>
              {batchPills}
            </div>
          </>
        )}

        {/* ── VIDEO MODE PARAMS ── */}
        {isVideoMode && (
          <>
            {/* Ratio —— resolution 自带 横/竖 时隐藏，避免两个控件打架 */}
            {showRatio && (
              <ParamDropdown
                label={t('parameters.aspectRatio')}
                value={(parameters.aspect_ratio as string) ?? ratioDefault}
                options={ratioOptions}
                onChange={(v) => updateParam('aspect_ratio', v)}
              />
            )}

            {/* Resolution */}
            {hasResolution && (
              <ParamDropdown
                label={t('parameters.resolution')}
                value={(parameters.resolution as string) ?? resolutionDefault}
                options={resolutionOptions}
                onChange={(v) => {
                  const impliedRatio = ratioForOrientedResolution(v);
                  updateParams(impliedRatio ? { resolution: v, aspect_ratio: impliedRatio } : { resolution: v });
                }}
              />
            )}

            {/* Fallback: show ratio + resolution even if model doesn't declare them */}
            {!hasRatio && !hasResolution && (
              <>
                <ParamDropdown
                  label={t('parameters.aspectRatio')}
                  value={(parameters.aspect_ratio as string) ?? FALLBACK_RATIOS[0]}
                  options={FALLBACK_RATIOS}
                  onChange={(v) => updateParam('aspect_ratio', v)}
                />
                <ParamDropdown
                  label={t('parameters.resolution')}
                  value={(parameters.resolution as string) ?? FALLBACK_RESOLUTIONS[0]}
                  options={FALLBACK_RESOLUTIONS}
                  onChange={(v) => updateParam('resolution', v)}
                />
              </>
            )}

            {/* Duration */}
            {durationFixed ? (
              <div className="flex flex-col gap-[6px]">
                <span className="font-mono text-[0.625rem] uppercase tracking-[0.08em] text-text-muted">{t('parameters.duration')}</span>
                <div className="w-full flex items-center px-3 py-2.5 rounded-[14px] bg-surface-inset border border-border-subtle text-text-muted text-xs font-medium">
                  {durationValue}s {t('parameters.durationFixedSuffix')}
                </div>
              </div>
            ) : modelDuration?.type === 'buttons' ? (
              <div className="flex flex-col gap-[6px]">
                <span className="font-mono text-[0.625rem] uppercase tracking-[0.08em] text-text-muted">{t('parameters.duration')}</span>
                <div className="flex gap-[2px] p-[3px] bg-surface-inset rounded-full atelier-pill-tabs">
                  {modelDuration.options.map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => updateParam('duration', n)}
                      className={`flex-1 rounded-full px-3 py-1.5 font-mono text-[0.6875rem] font-medium cursor-pointer transition-all text-center ${
                        durationValue === n
                          ? 'bg-primary text-on-accent'
                          : 'text-text-muted hover:text-foreground hover:bg-hover-bg'
                      }`}
                    >
                      {n}s
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <DurationStepper
                value={durationValue}
                min={modelDuration?.type === 'slider' ? modelDuration.min : 1}
                max={modelDuration?.type === 'slider' ? modelDuration.max : 15}
                step={modelDuration?.type === 'slider' ? modelDuration.step : 1}
                onChange={(v) => updateParam('duration', v)}
              />
            )}

            {/* Batch */}
            {batchPills}
          </>
        )}
      </div>
      {isAudioMode && <div className="text-[0.6875rem] text-text-muted">Seed Audio · MP3</div>}

      {/* Advanced params — only show controls the model actually supports */}
      {hasAnyAdvanced && (
        <div>
          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="inline-flex items-center gap-1 text-[0.6875rem] font-medium text-text-muted hover:text-foreground transition-colors cursor-pointer"
          >
            <ChevronDown className={`w-3 h-3 text-text-muted shrink-0 transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
            {t('parameters.advanced')}
          </button>

          {showAdvanced && (
            <div className="grid grid-cols-2 gap-3 mt-3">
              {supportsSeed && (
                <div className="flex flex-col gap-[6px] atelier-field">
                  <span className="font-mono text-[0.625rem] uppercase tracking-[0.08em] text-text-muted">Seed</span>
                  <input
                    type="number"
                    placeholder={t('parameters.seedPlaceholder')}
                    className="glass-input w-full text-xs text-foreground font-mono placeholder:text-text-muted bg-surface-inset rounded-[14px]"
                    value={parameters.seed ?? ''}
                    onChange={(e) => {
                      const val = e.target.value;
                      updateParam('seed', val === '' ? undefined : parseInt(val) || undefined);
                    }}
                  />
                </div>
              )}

              {supportsPromptExtend && (
                <PillToggle
                  label={t('parameters.promptExtend')}
                  value={parameters.prompt_extend !== false}
                  onChange={(v) => updateParam('prompt_extend', v)}
                />
              )}

              {supportsWatermark && (
                <PillToggle
                  label={t('parameters.watermark')}
                  value={parameters.watermark === true}
                  onChange={(v) => updateParam('watermark', v)}
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
