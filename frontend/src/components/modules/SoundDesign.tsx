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
    AlertTriangle, ArrowRight, Check, Download, Loader2, Play, Square, Volume1, Volume2, Wand2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useProjectStore } from "@/store/projectStore";
import { api, type CustomVoice, type SkillPackageSummary } from "@/lib/api";
import { getAssetUrl } from "@/lib/utils";
import { toast } from "@/store/toastStore";
import StepPageHeader, { StepPill } from "@/components/shared/StepPageHeader";
import WorkflowActionButton from "@/components/shared/WorkflowActionButton";
import SkillPicker, { skillNameFor } from "@/components/shared/SkillPicker";
import { buildSubMarks, buildThirtySecondMarks, formatClock } from "@/lib/audioTimeline";
import { isAudioJobRunning, type AudioTake } from "@/store/projectStore";

const MAX_REFERENCE_AUDIOS = 3;

/* ─────────────────────────────────────────────────────────────────────
   波形条 —— 纯前端解码画图，只为了让人「看得见节奏」。

   时间读数有三个来源，都在回答「到这儿是多少秒」—— 这是判断「哪几个镜头
   能放一组」的依据（视频模型单次上限 30 秒）：
     · 左下角常驻「当前 / 总长」
     · 鼠标悬停 → 跟随位置的读数
     · 点一下 → 留一个落点标记（只留一个，多了反而看不出哪个是刚点的）

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
    const [hoverMs, setHoverMs] = useState<number | null>(null);
    const [markerMs, setMarkerMs] = useState<number | null>(null);

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

    // 换了一版音频，上一版的落点就没有意义了
    useEffect(() => { setMarkerMs(null); setHoverMs(null); }, [url]);

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

        const xAt = (ms: number) => (durationMs > 0 ? (ms / durationMs) * width : 0);

        // 次刻度（10 秒）：更细的参照，不标字
        ctx.fillStyle = "rgba(255,255,255,0.055)";
        for (const ms of buildSubMarks(durationMs)) {
            ctx.fillRect(xAt(ms), 0, 1, height);
        }

        // 主刻度（30 秒）：这条才是「哪几个镜头能放一组」的判断线
        ctx.fillStyle = "rgba(255,255,255,0.14)";
        for (const mark of buildThirtySecondMarks(durationMs)) {
            ctx.fillRect(xAt(mark.ms), 0, 1, height);
        }

        if (peaks.length) {
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
        }

        if (markerMs !== null) {
            ctx.fillStyle = "rgba(167,139,250,0.6)";
            ctx.fillRect(xAt(markerMs), 0, 1, height);
        }
        if (hoverMs !== null) {
            ctx.fillStyle = "rgba(255,255,255,0.4)";
            ctx.fillRect(xAt(hoverMs), 0, 1, height);
        }
        if (progressMs > 0) {
            ctx.fillStyle = "rgba(167,139,250,1)";
            ctx.fillRect(xAt(progressMs) - 0.5, 0, 1.5, height);
        }
    }, [peaks, progressMs, durationMs, hoverMs, markerMs]);

    const percentOf = (ms: number) => (durationMs > 0 ? (ms / durationMs) * 100 : 0);
    const msAt = (clientX: number, element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        const ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
        return Math.round(Math.min(1, Math.max(0, ratio)) * durationMs);
    };

    return (
        <div>
            <div className="relative">
                <canvas
                    ref={canvasRef}
                    className="h-[72px] w-full cursor-pointer rounded-lg bg-surface-inset"
                    onMouseMove={(e) => {
                        if (!durationMs) return;
                        setHoverMs(msAt(e.clientX, e.currentTarget));
                    }}
                    onMouseLeave={() => setHoverMs(null)}
                    onClick={(e) => {
                        if (!durationMs) return;
                        const ms = msAt(e.clientX, e.currentTarget);
                        setMarkerMs(ms);
                        onSeek(ms);
                    }}
                />
                {failed ? (
                    <span className="absolute inset-0 flex items-center justify-center font-mono text-[0.625rem] text-text-muted">
                        波形不可用（仍可播放）
                    </span>
                ) : null}

                {/* 落点读数 —— 点一下记住「这里是多少秒」 */}
                {markerMs !== null ? (
                    <span
                        className="pointer-events-none absolute top-1 -translate-x-1/2 rounded bg-primary px-1 py-px font-mono text-[0.5625rem] leading-tight text-white"
                        style={{ left: `${percentOf(markerMs)}%` }}
                    >
                        {formatClock(markerMs)}
                    </span>
                ) : null}

                {/* 悬停读数 —— 眼睛扫到哪里就知道哪里几秒 */}
                {hoverMs !== null ? (
                    <span
                        className="pointer-events-none absolute top-5 -translate-x-1/2 rounded bg-black/60 px-1 py-px font-mono text-[0.5625rem] leading-tight text-white/90"
                        style={{ left: `${percentOf(hoverMs)}%` }}
                    >
                        {formatClock(hoverMs)}
                    </span>
                ) : null}

                {/* 常驻读数放左下角，让开上面两个跟随气泡 */}
                <span className="pointer-events-none absolute bottom-1 left-1.5 rounded bg-black/45 px-1.5 py-px font-mono text-[0.59375rem] leading-tight text-white/90">
                    {formatClock(progressMs)} / {formatClock(durationMs)}
                </span>
            </div>
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
    // 生成在后台跑，这里只是把状态读出来 —— 「在跑」不等于「要等」。
    const scriptRunning = isAudioJobRunning(plan?.script_status);
    const takeRunning = takes.some((tk) => isAudioJobRunning(tk.status));
    const anyRunning = scriptRunning || takeRunning;
    // 有地址且在跑 = 还不能听。失败的版本没地址，自然落进「不能听」。
    const takeReady = (take: AudioTake) => Boolean(take.audio_url) && !isAudioJobRunning(take.status);
    const currentTake = takes.find((tk) => tk.id === plan?.selected_take_id) ?? takes[takes.length - 1];
    const characters = useMemo(
        () => (currentProject?.characters ?? []).filter((c) => c.id && c.name),
        [currentProject?.characters],
    );

    const [draft, setDraft] = useState(scriptText);
    const [dirty, setDirty] = useState(false);
    const [picked, setPicked] = useState<string[]>([]);
    const [customVoices, setCustomVoices] = useState<CustomVoice[]>([]);
    const [skillPackages, setSkillPackages] = useState<SkillPackageSummary[]>([]);
    /** 系列级的 Skill 绑定 —— 导演稿的绑定可以是系列级的，只显示项目级会误导。 */
    const [seriesBindings, setSeriesBindings] = useState<Record<string, string>>({});
    // 生成已经不是同步的了，这里只剩「保存导演稿」那个转圈。
    const [saving, setSaving] = useState(false);
    const [playingId, setPlayingId] = useState<string | null>(null);
    const [progressMs, setProgressMs] = useState(0);

    const audioRef = useRef<HTMLAudioElement | null>(null);
    /** 「设为当前」的请求序号 —— 只有最后发出的那次才允许回填。 */
    const selectSeq = useRef(0);
    /** 出全集声音期间不回填选版本的结果（那一版响应更全）。 */
    const takeInFlight = useRef(false);

    // 后端外部改动（重新生成/切版本）后把输入框同步回来；用户正在打字时不覆盖。
    useEffect(() => {
        if (!dirty) setDraft(scriptText);
    }, [scriptText, dirty]);

    // 参考音可用性 = 角色 voice_id 命中 clone 音色且带 source_audio_url。
    // 与后端 resolve_character_reference_audios 的链路一致。
    // 顺便把系列的 Skill 绑定读回来：导演稿的绑定可以是系列级的。
    useEffect(() => {
        const seriesId = currentProject?.series_id;
        if (!seriesId) { setCustomVoices([]); setSeriesBindings({}); return; }
        let cancelled = false;
        api.listCustomVoices(seriesId)
            .then((list) => { if (!cancelled) setCustomVoices(list ?? []); })
            .catch(() => { if (!cancelled) setCustomVoices([]); });
        api.getSeries(seriesId)
            .then((series) => {
                if (!cancelled) setSeriesBindings(series?.prompt_config?.skill_bindings ?? {});
            })
            .catch(() => { if (!cancelled) setSeriesBindings({}); });
        return () => { cancelled = true; };
    }, [currentProject?.series_id]);

    // Skill 选择器的数据源，与设置页 / 项目模态框同一个接口。
    useEffect(() => {
        api.listSkillPackages()
            .then((list) => setSkillPackages(list ?? []))
            .catch(() => setSkillPackages([]));
    }, []);

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

    // 生成在后台跑，这里只负责把状态拉回来；跑完自动停。轮询条件是「在跑」，
    // 不是「点过生成」—— 形状与资产那套（ConsistencyVault）一致。
    useEffect(() => {
        if (!currentProject || !anyRunning) return;
        const projectId = currentProject.id;
        const timer = window.setInterval(async () => {
            try {
                updateProject(projectId, await api.getProject(projectId));
            } catch (error) {
                console.error("[SoundDesign] 刷新生成状态失败:", error);
            }
        }, 2000);
        return () => window.clearInterval(timer);
    }, [currentProject, anyRunning, updateProject]);

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
        if (!currentProject || scriptRunning) return;
        try {
            const { audio_plan } = await api.generateAudioPlanScript(currentProject.id);
            adoptPlan(audio_plan);
            setDirty(false);
            toast.success(t("queuedShort"), { body: t("scriptTitle") });
        } catch (e: any) {
            toast.error(t("generateFailed"), { body: e?.message });
        }
    };

    const handleSaveScript = async () => {
        if (!currentProject || saving) return;
        setSaving(true);
        try {
            const { audio_plan } = await api.updateAudioPlan(currentProject.id, { script_text: draft });
            adoptPlan(audio_plan);
            setDirty(false);
            toast.success(t("scriptSaved"));
        } catch (e: any) {
            toast.error(t("scriptSaved") + " ✗", { body: e?.message });
        } finally {
            setSaving(false);
        }
    };

    const handleGenerateTake = async (withReferences: boolean) => {
        if (!currentProject || takeRunning) return;
        const characterIds = withReferences ? picked : [];
        if (withReferences && !characterIds.length) {
            toast.error(t("castHint"));
            return;
        }
        takeInFlight.current = true;
        try {
            const { audio_plan } = await api.generateEpisodeAudio(currentProject.id, characterIds);
            adoptPlan(audio_plan);
            toast.success(t("queuedShort"), { body: t("takeTitle") });
        } catch (e: any) {
            toast.error(t("generateFailed"), { body: e?.message });
        } finally {
            takeInFlight.current = false;
        }
    };

    const handleSelectTake = async (takeId: string) => {
        if (!currentProject || plan?.selected_take_id === takeId) return;
        // 每次请求返回的都是「当时的整份方案」快照，所以响应到达顺序不等于
        // 发出顺序：连点两行「设为当前」时，先发的那次可能后到，把 UI 回退成
        // 旧选中项。用请求序号挡掉旧响应；正在出全集声音时就干脆不回填 ——
        // 那一版的响应会带上最终状态（含刚加的这一版和新的选中项）。
        const seq = ++selectSeq.current;
        try {
            const { audio_plan } = await api.updateAudioPlan(currentProject.id, { selected_take_id: takeId });
            if (seq === selectSeq.current && !takeInFlight.current) adoptPlan(audio_plan);
        } catch (e: any) {
            toast.error(t("loadFailed"), { body: e?.message });
        }
    };

    const togglePicked = (characterId: string) => {
        setPicked((prev) => prev.includes(characterId)
            ? prev.filter((id) => id !== characterId)
            : prev.length >= MAX_REFERENCE_AUDIOS ? prev : [...prev, characterId]);
    };

    /* ── 导演稿 Skill 绑定 ───────────────────────────────────────
       与设置页 / 项目模态框共用同一份 `prompt_config.skill_bindings.audio_plan`。 */
    const projectBindings = currentProject?.prompt_config?.skill_bindings ?? {};
    const boundSkillId = projectBindings.audio_plan || seriesBindings.audio_plan || "";
    const boundSkill = boundSkillId
        ? {
            name: skillNameFor(boundSkillId, skillPackages) ?? boundSkillId,
            fromProject: Boolean(projectBindings.audio_plan),
            source: projectBindings.audio_plan ? t("skillSourceProject") : t("skillSourceSeries"),
        }
        : null;

    const handleBindSkill = async (packageId: string) => {
        if (!currentProject) return;
        // skill_bindings 是**整表替换**，不是合并（后端靠它区分「没提到」和「解绑」）。
        // 所以先把已有的整张表读出来，只改 audio_plan 这一个键写回去。
        const next = { ...projectBindings };
        if (packageId) next.audio_plan = packageId; else delete next.audio_plan;
        try {
            const result = await api.updatePromptConfig(currentProject.id, { skill_bindings: next });
            updateProject(currentProject.id, { prompt_config: result.prompt_config });
        } catch (e: any) {
            toast.error(t("generateFailed"), { body: e?.message });
        }
    };

    const unboundCount = characters.filter((c) => !referenceUrlOf(c.id)).length;
    // 管资产的步骤在两张表里 id 不同：r2v 叫 cast，legacy 叫 assets。
    // navigateStep 对不认识的 id 是静默忽略的 —— 跳错了就是按钮点了没反应。
    const assetStepId = currentProject?.workflow_mode === "r2v" ? "cast" : "assets";
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
                            title={t("castGoBind")}
                            onClick={() => document.dispatchEvent(
                                new CustomEvent("1okstudio:navigateStep", { detail: assetStepId }),
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
                                    <WorkflowActionButton variant="primary" size="sm" onClick={handleSaveScript} loading={saving}>
                                        {t("scriptSave")}
                                    </WorkflowActionButton>
                                ) : null}
                                {/* 生成类动作用 ghost + 图标，与资产 / 摘要那些「生成 / 重新生成」一致；
                                    这一区里真正的主行动是右边那个花钱的「生成一版」。 */}
                                <WorkflowActionButton
                                    variant="ghost"
                                    size="sm"
                                    leftIcon={scriptRunning ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
                                    onClick={handleGenerateScript}
                                    disabled={scriptRunning}
                                >
                                    {scriptRunning
                                        ? (plan?.script_status === "queued" ? t("queuedShort") : t("generating"))
                                        : scriptText ? t("scriptRegenerate") : t("scriptGenerate")}
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
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                            <span className="font-mono text-[0.59375rem] text-text-muted">{t("skillLabel")}</span>
                            <SkillPicker
                                packages={skillPackages}
                                onSelect={handleBindSkill}
                                title={t("skillLabel")}
                            />
                            {boundSkill ? (
                                <>
                                    <span className="text-[0.6875rem] text-emerald-400">
                                        {t("skillBound", { name: boundSkill.name, source: boundSkill.source })}
                                    </span>
                                    {boundSkill.fromProject ? (
                                        <button
                                            type="button"
                                            onClick={() => handleBindSkill("")}
                                            className="text-[0.6875rem] text-text-muted transition-colors hover:text-foreground"
                                        >
                                            {t("skillUnbind")}
                                        </button>
                                    ) : null}
                                </>
                            ) : (
                                <span className="text-[0.6875rem] text-text-muted">{t("skillUnbound")}</span>
                            )}
                        </div>
                        {plan?.script_status === "failed" && plan.script_error ? (
                            <p className="mt-2 flex items-start gap-1.5 text-[0.6875rem] leading-relaxed text-red-400">
                                <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                                {plan.script_error}
                            </p>
                        ) : null}
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
                                    leftIcon={takeRunning ? <Loader2 size={12} className="animate-spin" /> : <Volume2 size={12} />}
                                    onClick={() => handleGenerateTake(true)}
                                    disabled={takeRunning}
                                >
                                    {takeRunning ? t("generating") : t("takeGenerate")}
                                </WorkflowActionButton>
                                <WorkflowActionButton
                                    variant="ghost"
                                    size="sm"
                                    leftIcon={<Volume1 size={12} />}
                                    onClick={() => handleGenerateTake(false)}
                                    disabled={takeRunning}
                                    title={t("takeHint")}
                                >
                                    {t("takeGeneratePlain")}
                                </WorkflowActionButton>
                            </div>
                        }
                    >
                        {currentTake && takeReady(currentTake) ? (
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
                        ) : currentTake ? (
                            // 选中的这一版还没生成完（或失败了）—— 这里说清楚它在哪一步，
                            // 而不是画一条空波形让人以为音频是静音的。
                            <div className="rounded-xl border border-dashed border-glass-border px-4 py-10 text-center font-mono text-[0.6875rem] text-text-muted">
                                {isAudioJobRunning(currentTake.status) ? (
                                    <span className="inline-flex items-center gap-1.5 text-primary">
                                        <Loader2 size={12} className="animate-spin" />
                                        {currentTake.status === "queued" ? t("queuedShort") : t("generating")}
                                    </span>
                                ) : (
                                    <span className="text-red-400">{currentTake.error || t("takeFailed")}</span>
                                )}
                            </div>
                        ) : (
                            <p className="rounded-xl border border-dashed border-glass-border px-4 py-10 text-center font-mono text-[0.6875rem] text-text-muted">
                                {t("takeEmptyHint")}
                            </p>
                        )}

                        <ul className="mt-3 space-y-1.5">
                            {[...takes].reverse().map((take) => {
                                const isCurrent = take.id === plan?.selected_take_id;
                                const ready = takeReady(take);
                                const running = isAudioJobRunning(take.status);
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
                                            disabled={!ready}
                                            title={ready ? t("takePlay") : running ? t("generating") : (take.error || t("takeFailed"))}
                                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-glass-border text-text-secondary transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:border-glass-border disabled:hover:text-text-secondary"
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
                                            {running ? (
                                                <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[0.59375rem] text-primary">
                                                    <Loader2 size={10} className="animate-spin" />
                                                    {take.status === "queued" ? t("queuedShort") : t("generating")}
                                                </span>
                                            ) : typeof take.duration_ms === "number" ? (
                                                <span className="shrink-0 font-mono text-[0.59375rem] text-text-muted">
                                                    {formatClock(take.duration_ms)}
                                                </span>
                                            ) : null}
                                            {take.status === "failed" ? (
                                                <span
                                                    className="inline-flex shrink-0 items-center gap-1 font-mono text-[0.59375rem] text-red-400"
                                                    title={take.error ?? ""}
                                                >
                                                    <AlertTriangle size={10} />
                                                    {t("takeFailed")}
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
