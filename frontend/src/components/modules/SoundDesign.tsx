"use client";
/**
 * SoundDesign — R2V workflow Step 4「声音」（可选步骤）。
 *
 * 一期定位（用户原话）：「这一步是给人看的，不是给程序看的」。
 *   · 全局声音导演稿：一稿散文/剧本体的文本，人不分段、不关联分镜
 *   · 全集声音：拿导演稿直接出一整版音频，多出几版对比着听
 *   · 参考音可有可无：勾角色 = 带上它的参考音；一个不勾 = 纯音频
 *
 * 刻意不做的事：
 *   · 不做分段、不做对白级时序 —— 那是分镜/配音步骤的事
 *   · 波形图只是给人看节奏的，不进数据、不落库
 *   · 步骤状态只会是 idle / ready，永远不会 gated（跳过它完全合法）
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    AlertTriangle, ArrowRight, Check, Download, Play, Square, Volume2, Wand2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useProjectStore } from "@/store/projectStore";
import { api, type CustomVoice } from "@/lib/api";
import { getAssetUrl } from "@/lib/utils";
import { toast } from "@/store/toastStore";
import StepPageHeader, { StepPill } from "@/components/shared/StepPageHeader";
import WorkflowActionButton from "@/components/shared/WorkflowActionButton";
import { buildThirtySecondMarks, formatClock } from "@/lib/audioTimeline";
import type { AudioTake } from "@/store/projectStore";

const MAX_REFERENCE_AUDIOS = 3;

/* ─────────────────────────────────────────────────────────────────────
   波形条 —— 纯前端解码画图，只为了让人「看得见节奏」。
   ponytail: 峰值只取 400 根柱子，够看清楚呼吸；要更细就调这个数。
   ───────────────────────────────────────────────────────────────────── */
function Waveform({
    url,
    durationMs,
    progressMs,
    onSeek,
}: {
    url: string;
    durationMs: number;
    progressMs: number;
    onSeek: (ms: number) => void;
}) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const [peaks, setPeaks] = useState<number[]>([]);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let cancelled = false;
        setPeaks([]);
        setFailed(false);
        if (!url) return;

        (async () => {
            try {
                const response = await fetch(getAssetUrl(url));
                const bytes = await response.arrayBuffer();
                const ctx = new AudioContext();
                const buffer = await ctx.decodeAudioData(bytes);
                await ctx.close();
                if (cancelled) return;

                const data = buffer.getChannelData(0);
                const bars = 400;
                const stride = Math.max(1, Math.floor(data.length / bars));
                const out: number[] = [];
                for (let i = 0; i < bars; i++) {
                    let peak = 0;
                    const start = i * stride;
                    for (let j = start; j < start + stride && j < data.length; j++) {
                        peak = Math.max(peak, Math.abs(data[j]));
                    }
                    out.push(peak);
                }
                setPeaks(out);
            } catch {
                // 解码失败（编解码器不支持等）不该炸掉整个步骤 —— 退回一条素条。
                if (!cancelled) setFailed(true);
            }
        })();

        return () => { cancelled = true; };
    }, [url]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const dpr = window.devicePixelRatio || 1;
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);

        // 30 秒刻度：只画竖线，标签由外层 DOM 排版，避免 canvas 里量字宽。
        const marks = buildThirtySecondMarks(durationMs);
        ctx.fillStyle = "rgba(255,255,255,0.08)";
        for (const mark of marks) {
            const x = (mark.ms / durationMs) * width;
            ctx.fillRect(x, 0, 1, height);
        }

        if (!peaks.length) return;
        const mid = height / 2;
        const barWidth = width / peaks.length;
        const playedBars = durationMs > 0
            ? Math.round((progressMs / durationMs) * peaks.length)
            : 0;
        for (let i = 0; i < peaks.length; i++) {
            const h = Math.max(1.5, peaks[i] * (height * 0.86));
            ctx.fillStyle = i <= playedBars
                ? "rgba(167,139,250,0.95)"   // 已播 = 主色
                : "rgba(255,255,255,0.22)";
            ctx.fillRect(i * barWidth, mid - h / 2, Math.max(1, barWidth - 1), h);
        }
    }, [peaks, progressMs, durationMs]);

    return (
        <div className="relative">
            <canvas
                ref={canvasRef}
                className="h-[72px] w-full cursor-pointer rounded-lg bg-surface-inset"
                onClick={(e) => {
                    if (!durationMs) return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    onSeek(Math.round(((e.clientX - rect.left) / rect.width) * durationMs));
                }}
            />
            {failed ? (
                <span className="absolute inset-0 flex items-center justify-center font-mono text-[0.625rem] text-text-muted">
                    波形不可用（仍可播放）
                </span>
            ) : null}
            <div className="relative mt-1 h-3">
                {buildThirtySecondMarks(durationMs).map((mark) => (
                    <span
                        key={mark.ms}
                        className={`absolute font-mono text-[0.59375rem] text-text-muted ${
                            mark.ms === 0 ? "translate-x-0" : "-translate-x-1/2"
                        }`}
                        style={{ left: `${(mark.ms / durationMs) * 100}%` }}
                    >
                        {mark.label}
                    </span>
                ))}
                <span className="absolute right-0 font-mono text-[0.59375rem] text-text-muted">
                    {formatClock(durationMs)}
                </span>
            </div>
        </div>
    );
}

/* ─────────────────────────────────────────────────────────────────────
   章节壳 —— 与 Cast / ArtDirection 同一套「标题 + 细线」语法。
   ───────────────────────────────────────────────────────────────────── */
function Section({
    title,
    count,
    hint,
    trailing,
    children,
}: {
    title: string;
    count?: number;
    hint?: string;
    trailing?: React.ReactNode;
    children: React.ReactNode;
}) {
    return (
        <section>
            <header className="mb-3 flex items-center gap-2">
                <h3 className="font-mono text-[0.6875rem] font-medium uppercase tracking-[0.18em] text-text-secondary">
                    {title}
                </h3>
                {typeof count === "number" ? (
                    <span className="font-mono text-[0.625rem] text-text-muted">({count})</span>
                ) : null}
                <div aria-hidden="true" className="ml-3 h-px flex-1 bg-glass-border" />
                {trailing}
            </header>
            {hint ? <p className="mb-3 text-[0.75rem] leading-relaxed text-text-muted">{hint}</p> : null}
            {children}
        </section>
    );
}

export default function SoundDesign() {
    const tStep = useTranslations("stepHeader");
    const t = useTranslations("sound");

    const currentProject = useProjectStore((s) => s.currentProject);
    const updateProject = useProjectStore((s) => s.updateProject);

    const plan = currentProject?.audio_plan;
    const takes = plan?.takes ?? [];
    const scriptText = plan?.script_text ?? "";
    const currentTake = takes.find((tk) => tk.id === plan?.selected_take_id) ?? takes[takes.length - 1];
    const characters = useMemo(
        () => (currentProject?.characters ?? []).filter((c) => c.id && c.name),
        [currentProject?.characters],
    );

    const [draft, setDraft] = useState(scriptText);
    const [dirty, setDirty] = useState(false);
    const [picked, setPicked] = useState<string[]>([]);
    const [customVoices, setCustomVoices] = useState<CustomVoice[]>([]);
    const [busy, setBusy] = useState<"script" | "take" | null>(null);
    const [playingId, setPlayingId] = useState<string | null>(null);
    const [progressMs, setProgressMs] = useState(0);

    const audioRef = useRef<HTMLAudioElement | null>(null);

    // 后端外部改动（重新生成/切版本）后把输入框同步回来；用户正在打字时不覆盖。
    useEffect(() => {
        if (!dirty) setDraft(scriptText);
    }, [scriptText, dirty]);

    // 参考音可用性 = 角色 voice_id 命中 clone 音色且带 source_audio_url。
    // 与后端 resolve_character_reference_audios 的链路一致。
    useEffect(() => {
        const seriesId = currentProject?.series_id;
        if (!seriesId) { setCustomVoices([]); return; }
        let cancelled = false;
        api.listCustomVoices(seriesId)
            .then((list) => { if (!cancelled) setCustomVoices(list ?? []); })
            .catch(() => { if (!cancelled) setCustomVoices([]); });
        return () => { cancelled = true; };
    }, [currentProject?.series_id]);

    const voiceById = useMemo(() => {
        const map = new Map<string, CustomVoice>();
        for (const voice of customVoices) map.set(voice.id, voice);
        return map;
    }, [customVoices]);

    const referenceUrlOf = useCallback(
        (characterId: string): string | null => {
            const character = characters.find((c) => c.id === characterId);
            const voice = character?.voice_id ? voiceById.get(character.voice_id) : undefined;
            return voice?.source_audio_url || null;
        },
        [characters, voiceById],
    );

    /* ── 播放控制（同一时刻只响一条）────────────────────────────── */
    const stop = useCallback(() => {
        const audio = audioRef.current;
        if (audio) { audio.pause(); audioRef.current = null; }
        setPlayingId(null);
        setProgressMs(0);
    }, []);

    const play = useCallback((id: string, url: string, onTime?: (ms: number) => void) => {
        stop();
        const audio = new Audio(getAssetUrl(url));
        audio.ontimeupdate = () => { if (onTime) onTime(Math.round(audio.currentTime * 1000)); };
        audio.onended = () => { setPlayingId(null); if (onTime) onTime(0); };
        audio.onerror = () => { setPlayingId(null); if (onTime) onTime(0); };
        audioRef.current = audio;
        setPlayingId(id);
        audio.play().catch(() => setPlayingId(null));
    }, [stop]);

    useEffect(() => stop, [stop]);

    const previewReference = (characterId: string) => {
        const url = referenceUrlOf(characterId);
        if (!url) return;
        if (playingId === `ref:${characterId}`) { stop(); return; }
        play(`ref:${characterId}`, url);
    };

    const playTake = (take: AudioTake) => {
        if (playingId === take.id) { stop(); return; }
        play(take.id, take.audio_url, setProgressMs);
    };

    /* ── 写回 store ─────────────────────────────────────────────── */
    const adoptPlan = useCallback((nextPlan: typeof plan) => {
        if (!currentProject || !nextPlan) return;
        updateProject(currentProject.id, { audio_plan: nextPlan });
    }, [currentProject, updateProject]);

    const handleGenerateScript = async () => {
        if (!currentProject || busy) return;
        setBusy("script");
        try {
            const { audio_plan } = await api.generateAudioPlanScript(currentProject.id);
            adoptPlan(audio_plan);
            setDirty(false);
            toast.success(t("scriptSaved"), { body: t("scriptTitle") });
        } catch (e: any) {
            toast.error(t("generateFailed"), { body: e?.message });
        } finally {
            setBusy(null);
        }
    };

    const handleSaveScript = async () => {
        if (!currentProject || busy) return;
        setBusy("script");
        try {
            const { audio_plan } = await api.updateAudioPlan(currentProject.id, { script_text: draft });
            adoptPlan(audio_plan);
            setDirty(false);
            toast.success(t("scriptSaved"));
        } catch (e: any) {
            toast.error(t("scriptSaved") + " ✗", { body: e?.message });
        } finally {
            setBusy(null);
        }
    };

    const handleGenerateTake = async (withReferences: boolean) => {
        if (!currentProject || busy) return;
        const characterIds = withReferences ? picked : [];
        if (withReferences && !characterIds.length) {
            toast.error(t("castHint"));
            return;
        }
        setBusy("take");
        try {
            const { audio_plan } = await api.generateEpisodeAudio(currentProject.id, characterIds);
            adoptPlan(audio_plan);
        } catch (e: any) {
            toast.error(t("generateFailed"), { body: e?.message });
        } finally {
            setBusy(null);
        }
    };

    const handleSelectTake = async (takeId: string) => {
        if (!currentProject || plan?.selected_take_id === takeId) return;
        try {
            const { audio_plan } = await api.updateAudioPlan(currentProject.id, { selected_take_id: takeId });
            adoptPlan(audio_plan);
        } catch (e: any) {
            toast.error(t("loadFailed"), { body: e?.message });
        }
    };

    const togglePicked = (characterId: string) => {
        setPicked((prev) => prev.includes(characterId)
            ? prev.filter((id) => id !== characterId)
            : prev.length >= MAX_REFERENCE_AUDIOS ? prev : [...prev, characterId]);
    };

    const unboundCount = characters.filter((c) => !referenceUrlOf(c.id)).length;
    const staleIds = new Set(
        takes.filter((tk) => plan?.script_hash && tk.script_hash !== plan.script_hash).map((tk) => tk.id),
    );

    return (
        <div className="flex h-full w-full flex-col overflow-hidden">
            <StepPageHeader
                stepNumber={4}
                englishName="SOUND"
                title={tStep("soundTitle")}
                subtitle={tStep("soundSubtitle")}
                pills={
                    <>
                        <StepPill label={t("pillTakes")} value={takes.length} />
                        {characters.length ? (
                            <StepPill label={t("pillRefs")} value={`${characters.length - unboundCount}/${characters.length}`} />
                        ) : null}
                    </>
                }
            />

            <div className="flex-1 space-y-9 overflow-y-auto bg-surface px-8 py-6 custom-scrollbar">
                {/* ① 角色参考音 —— 横向一排，与资产的排版步调一致 */}
                <Section
                    title={t("castTitle")}
                    count={characters.length}
                    hint={t("castHint")}
                    trailing={unboundCount ? (
                        <button
                            type="button"
                            onClick={() => document.dispatchEvent(
                                new CustomEvent("1okstudio:navigateStep", { detail: "cast" }),
                            )}
                            className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-glass-border bg-surface-inset px-2.5 py-1 font-mono text-[0.59375rem] text-text-secondary transition-colors hover:border-primary hover:text-primary"
                        >
                            {unboundCount} · {t("castUnbound")}
                            <ArrowRight size={10} />
                        </button>
                    ) : null}
                >
                    {characters.length === 0 ? (
                        <p className="font-mono text-[0.6875rem] text-text-muted">{t("scriptEmptyHint")}</p>
                    ) : (
                        <div className="flex snap-x gap-3 overflow-x-auto pb-1 custom-scrollbar">
                            {characters.map((character) => {
                                const referenceUrl = referenceUrlOf(character.id);
                                const isPicked = picked.includes(character.id);
                                const isPlaying = playingId === `ref:${character.id}`;
                                return (
                                    <div
                                        key={character.id}
                                        className={`w-[152px] shrink-0 snap-start rounded-xl border bg-surface-inset p-2.5 transition-colors ${
                                            isPicked ? "border-primary" : "border-glass-border"
                                        }`}
                                    >
                                        <div className="flex items-start justify-between gap-2">
                                            <span className="truncate text-[0.8125rem] font-medium text-foreground" title={character.name}>
                                                {character.name}
                                            </span>
                                            <button
                                                type="button"
                                                onClick={() => referenceUrl && togglePicked(character.id)}
                                                disabled={!referenceUrl}
                                                aria-label={character.name}
                                                title={referenceUrl ? t("castHint") : t("castNoReference")}
                                                className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                                                    isPicked
                                                        ? "border-primary bg-primary text-white"
                                                        : "border-glass-border bg-transparent"
                                                } ${referenceUrl ? "cursor-pointer" : "cursor-not-allowed opacity-40"}`}
                                            >
                                                {isPicked ? <Check size={10} strokeWidth={3} /> : null}
                                            </button>
                                        </div>
                                        <div className="mt-2 flex items-center gap-1.5">
                                            <button
                                                type="button"
                                                onClick={() => previewReference(character.id)}
                                                disabled={!referenceUrl}
                                                title={referenceUrl ? t("castPreview") : t("castNoReference")}
                                                className="flex h-6 w-6 items-center justify-center rounded-full border border-glass-border text-text-secondary transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:border-glass-border disabled:hover:text-text-secondary"
                                            >
                                                {isPlaying ? <Square size={9} /> : <Play size={10} />}
                                            </button>
                                            <span className={`truncate font-mono text-[0.59375rem] ${referenceUrl ? "text-text-muted" : "text-text-muted/60"}`}>
                                                {referenceUrl ? (character.voice_name || t("castPreview")) : t("castUnbound")}
                                            </span>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </Section>

                {/* ② / ③ 宽屏左右分栏（45/55），窄窗口自动堆叠 —— 不然
                    右栏会被 overflow-hidden 裁掉，看起来像「没有音频区」。 */}
                <div className="grid gap-8 lg:grid-cols-[45fr_55fr]">
                    <Section
                        title={t("scriptTitle")}
                        trailing={
                            <div className="flex items-center gap-2">
                                {dirty ? (
                                    <WorkflowActionButton variant="primary" size="sm" onClick={handleSaveScript} loading={busy === "script"}>
                                        {t("scriptSave")}
                                    </WorkflowActionButton>
                                ) : null}
                                <WorkflowActionButton
                                    variant={scriptText ? "ghost" : "secondary"}
                                    size="sm"
                                    leftIcon={<Wand2 size={12} />}
                                    onClick={handleGenerateScript}
                                    loading={busy === "script"}
                                >
                                    {scriptText ? t("scriptRegenerate") : t("scriptGenerate")}
                                </WorkflowActionButton>
                            </div>
                        }
                        hint={t("scriptHint")}
                    >
                        <textarea
                            value={draft}
                            onChange={(e) => { setDraft(e.target.value); setDirty(true); }}
                            onBlur={() => { if (dirty) handleSaveScript(); }}
                            placeholder={t("scriptPlaceholder")}
                            spellCheck={false}
                            className="h-[360px] w-full resize-none rounded-xl border border-glass-border bg-surface-inset px-4 py-3 font-sans text-[0.8125rem] leading-relaxed text-foreground outline-none transition-colors placeholder:text-text-muted focus:border-primary custom-scrollbar"
                        />
                        <div className="mt-2 flex items-center justify-between font-mono text-[0.59375rem] text-text-muted">
                            <span>{draft.length} / 3000</span>
                            {dirty ? <span className="text-primary">{t("scriptSave")}…</span> : null}
                        </div>
                    </Section>

                    <Section
                        title={t("takeTitle")}
                        count={takes.length}
                        hint={t("takeHint")}
                        trailing={
                            <div className="flex items-center gap-2">
                                <WorkflowActionButton
                                    variant="primary"
                                    size="sm"
                                    leftIcon={<Volume2 size={12} />}
                                    onClick={() => handleGenerateTake(true)}
                                    loading={busy === "take"}
                                >
                                    {t("takeGenerate")}
                                </WorkflowActionButton>
                                <WorkflowActionButton
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => handleGenerateTake(false)}
                                    loading={busy === "take"}
                                    title={t("takeHint")}
                                >
                                    {t("takeGeneratePlain")}
                                </WorkflowActionButton>
                            </div>
                        }
                    >
                        {currentTake ? (
                            <div className="rounded-xl border border-glass-border bg-surface-inset p-3">
                                <Waveform
                                    url={currentTake.audio_url}
                                    durationMs={currentTake.duration_ms ?? 0}
                                    progressMs={progressMs}
                                    onSeek={(ms) => {
                                        const audio = audioRef.current;
                                        if (audio) audio.currentTime = ms / 1000;
                                        setProgressMs(ms);
                                    }}
                                />
                                <div className="mt-2 flex items-center justify-between">
                                    <button
                                        type="button"
                                        onClick={() => playTake(currentTake)}
                                        className="inline-flex items-center gap-1.5 rounded-full border border-glass-border bg-glass px-3 py-1 text-[0.75rem] text-text-secondary transition-colors hover:border-primary hover:text-primary"
                                    >
                                        {playingId === currentTake.id ? <Square size={10} /> : <Play size={11} />}
                                        {playingId === currentTake.id ? t("takeStop") : t("takePlay")}
                                    </button>
                                    <a
                                        href={getAssetUrl(currentTake.audio_url)}
                                        download
                                        className="inline-flex items-center gap-1 font-mono text-[0.59375rem] text-text-muted transition-colors hover:text-primary"
                                    >
                                        <Download size={11} />
                                        {t("takeDownload")}
                                    </a>
                                </div>
                            </div>
                        ) : (
                            <p className="rounded-xl border border-dashed border-glass-border px-4 py-10 text-center font-mono text-[0.6875rem] text-text-muted">
                                {t("takeEmptyHint")}
                            </p>
                        )}

                        <ul className="mt-3 space-y-1.5">
                            {[...takes].reverse().map((take) => {
                                const isCurrent = take.id === plan?.selected_take_id;
                                const names = (take.reference_character_ids ?? [])
                                    .map((id) => characters.find((c) => c.id === id)?.name)
                                    .filter(Boolean)
                                    .join("、");
                                return (
                                    <li
                                        key={take.id}
                                        className={`group flex items-center gap-2.5 rounded-lg border px-3 py-2 transition-colors ${
                                            isCurrent ? "border-primary bg-primary/[0.06]" : "border-glass-border bg-surface-inset"
                                        }`}
                                    >
                                        <button
                                            type="button"
                                            onClick={() => playTake(take)}
                                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-glass-border text-text-secondary transition-colors hover:border-primary hover:text-primary"
                                        >
                                            {playingId === take.id ? <Square size={9} /> : <Play size={10} />}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => handleSelectTake(take.id)}
                                            className="flex min-w-0 flex-1 items-center gap-2 text-left"
                                        >
                                            <span className="truncate text-[0.75rem] text-text-secondary">
                                                {names ? t("takeWithRefs", { names }) : t("takePlain")}
                                            </span>
                                            {typeof take.duration_ms === "number" ? (
                                                <span className="shrink-0 font-mono text-[0.59375rem] text-text-muted">
                                                    {formatClock(take.duration_ms)}
                                                </span>
                                            ) : null}
                                            {staleIds.has(take.id) ? (
                                                <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[0.59375rem] text-amber-400/90">
                                                    <AlertTriangle size={10} />
                                                    {t("takeStale")}
                                                </span>
                                            ) : null}
                                        </button>
                                        {isCurrent ? (
                                            <span className="shrink-0 font-mono text-[0.59375rem] text-primary">
                                                {t("takeCurrent")}
                                            </span>
                                        ) : (
                                            <span className="shrink-0 font-mono text-[0.59375rem] text-text-muted opacity-0 transition-opacity group-hover:opacity-100">
                                                {t("takeSetCurrent")}
                                            </span>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    </Section>
                </div>

                <p className="font-mono text-[0.59375rem] text-text-muted">{t("waveformHint")}</p>
            </div>
        </div>
    );
}
