"use client";
/**
 * CharacterVoiceFace —— 角色工作台的「声音面」。
 *
 * 工作台有两面镜子：一面生图、一面生声。这个文件是生声那一面，结构跟生图面
 * 一模一样地镜像过来：
 *
 *     主参考音    ↔ 主参考图      实物：能播的音频文件
 *     声音描述    ↔ 描述          人改的那一层
 *     音色提示词  ↔ 生图提示词     由上一层生成，喂给模型
 *     试听/用这个音色 ↔ 生成图片   产物
 *
 * 「音色设计」造出来的音色天生没有源音频（只有克隆才有），所以左列的
 * 「生成参考音」不是锦上添花 —— 它是设计音色拿到参考音的**唯一**途径。
 *
 * 自带数据读写（直接读 store + api），不从 CharacterWorkbench 往下传一堆回调：
 * 那层已经有 11 个 props 了，再加 8 个只会更难读。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
    AudioWaveform, Check, Loader2, Play, RefreshCw, Square, Trash2, Upload, UserRound,
} from "lucide-react";
import { api } from "@/lib/api";
import { getAssetUrl } from "@/lib/utils";
import { useProjectStore } from "@/store/projectStore";
import { toast } from "@/store/toastStore";

interface CharacterVoiceFaceProps {
    /** 同一个角色对象（来自 currentProject.characters）。 */
    character: any;
}

type Busy = null | "prompt" | "reference" | "upload" | "rewrite";

/** 跟 Motion Ref 那边的音频上传同一道门槛（10MB），别两处不一样。 */
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

const columnClass =
    "min-w-0 min-h-0 border-r border-glass-border p-5 flex flex-col gap-3 bg-surface overflow-y-auto last:border-r-0";
const headerClass = "flex items-center justify-between gap-2";
const titleClass = "text-sm font-bold text-foreground";
const subTitleClass = "text-xs text-text-muted mt-1";
const textAreaClass =
    "min-h-[240px] flex-1 w-full rounded-xl border border-glass-border bg-input-bg p-4 text-sm leading-relaxed text-text-secondary resize-none focus:outline-none focus:border-primary/60";
const linkButtonClass = "text-xs text-primary disabled:opacity-50";

export default function CharacterVoiceFace({ character }: CharacterVoiceFaceProps) {
    const t = useTranslations("characterVoice");
    const currentProject = useProjectStore((state) => state.currentProject);
    const updateProject = useProjectStore((state) => state.updateProject);

    const [descriptionDraft, setDescriptionDraft] = useState(character.voice_description || "");
    const [promptDraft, setPromptDraft] = useState(character.voice_prompt || "");
    // 「AI 修改」—— 跟生图面描述那一列同一套：点开一个输入条，填一句要求让模型改。
    const [showRewriteBar, setShowRewriteBar] = useState(false);
    const [rewriteInstruction, setRewriteInstruction] = useState("");
    const [busy, setBusy] = useState<Busy>(null);
    const [playing, setPlaying] = useState(false);

    const audioRef = useRef<HTMLAudioElement | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    // 切角色时把播放停掉，否则会在另一个角色的面板上继续响。
    useEffect(() => () => { audioRef.current?.pause(); audioRef.current = null; }, [character.id]);

    // 外部（重新生成 / AI 提取）改了角色之后把输入框同步回来；正在打字时不覆盖。
    useEffect(() => { setDescriptionDraft(character.voice_description || ""); }, [character.voice_description]);
    useEffect(() => { setPromptDraft(character.voice_prompt || ""); }, [character.voice_prompt]);

    const stopAudio = useCallback(() => {
        audioRef.current?.pause();
        audioRef.current = null;
        setPlaying(false);
    }, []);

    const playUrl = useCallback(async (url: string) => {
        stopAudio();
        const audio = new Audio(getAssetUrl(url));
        audio.onended = () => { setPlaying(false); if (audioRef.current === audio) audioRef.current = null; };
        audio.onerror = () => { setPlaying(false); toast.error(t("playFailed")); };
        audioRef.current = audio;
        setPlaying(true);
        try {
            await audio.play();
        } catch {
            setPlaying(false);
        }
    }, [stopAudio, t]);

    /** 每次改动都重拉整个项目 —— 角色对象是派生出来的，就地改不会重渲染。 */
    const refresh = useCallback(async () => {
        if (!currentProject) return;
        updateProject(currentProject.id, await api.getProject(currentProject.id));
    }, [currentProject, updateProject]);

    /** 把项目对象直接交给动作 —— 省掉满屏的 currentProject! 和闭包里的窄化丢失。 */
    const run = async (
        kind: Busy,
        action: (project: NonNullable<typeof currentProject>) => Promise<void>,
    ) => {
        if (!currentProject || busy) return;
        setBusy(kind);
        try {
            await action(currentProject);
            await refresh();
        } catch (e: any) {
            toast.error(e?.message || t("playFailed"));
        } finally {
            setBusy(null);
        }
    };

    /* ── 中列 ─────────────────────────────────────────────────── */
    const handleDescriptionBlur = () => {
        const next = descriptionDraft.trim();
        if (next === (character.voice_description || "")) return;
        void run(null, async (project) => {
            await api.updateCharacterVoiceFields(project.id, character.id, {
                voice_description: next,
            });
        });
    };

    /** 「AI 修改」：把输入框里当前这版（可能刚手改过）+ 要求一起交给模型。 */
    const handleRewriteDescription = async () => {
        if (!rewriteInstruction.trim()) return;
        await run("rewrite", async (project) => {
            await api.rewriteCharacterVoiceDescription(
                project.id, character.id, rewriteInstruction.trim(), descriptionDraft,
            );
            setRewriteInstruction("");
            setShowRewriteBar(false);
        });
    };

    /* ── 右列 ─────────────────────────────────────────────────── */
    const handleGeneratePrompt = () => run("prompt", async (project) => {
        await api.generateCharacterVoicePrompt(project.id, character.id);
    });

    const handlePromptBlur = () => {
        const next = promptDraft.trim();
        if (next === (character.voice_prompt || "")) return;
        void run(null, async (project) => {
            await api.updateCharacterVoiceFields(project.id, character.id, {
                voice_prompt: next,
            });
        });
    };

    /* ── 左列 ─────────────────────────────────────────────────── */
    /** 上传一段现成的录音当参考音（克隆音色本来就有源音频，不需要模型念）。 */
    const handleReferenceUpload = async (file?: File | null) => {
        if (!file) return;
        if (!file.type.startsWith("audio/")) {
            toast.error(t("audioOnly"));
            return;
        }
        if (file.size > MAX_AUDIO_BYTES) {
            toast.error(t("audioTooLarge"));
            return;
        }
        await run("upload", async (project) => {
            // 先走现成的通用上传拿路径（它管扩展名 + OSS/本地二选一），
            // 再把路径指到角色身上。
            const { url } = await api.uploadFile(file);
            await api.updateCharacterVoiceFields(project.id, character.id, {
                reference_audio_url: url,
            });
        });
    };

    const hasReference = !!character.reference_audio_url;
    const variants: any[] = character.reference_audio_variants || [];

    /** 把某一版设为主音。删的正好是主音时后端会自己回落，这里不用管。 */
    const handleSelectVariant = (variantId: string) => {
        if (variantId === character.reference_audio_selected_id) return;
        stopAudio();
        void run(null, async (project) => {
            await api.selectCharacterReferenceAudio(project.id, character.id, variantId);
        });
    };

    const handleDeleteVariant = (variantId: string) => {
        stopAudio();
        void run("reference", async (project) => {
            await api.deleteCharacterReferenceAudio(project.id, character.id, variantId);
        });
    };
    const promptStale =
        !!character.voice_prompt &&
        (character.voice_prompt_description_version ?? 0) < (character.voice_description_version ?? 0);

    return (
        <div className="flex-1 min-h-0 grid grid-cols-[minmax(280px,32%)_minmax(280px,34%)_minmax(320px,34%)] overflow-hidden">
            {/* ① 主参考音 —— 生图面「主参考图」的镜像 */}
            <section className={columnClass}>
                <div className={headerClass}>
                    <div>
                        <h3 className={titleClass}>{t("referenceTitle")}</h3>
                        <p className={subTitleClass}>{t("referenceHint")}</p>
                    </div>
                    <span className="text-[0.625rem] uppercase tracking-wider text-primary">
                        {t("faceVoice")}
                    </span>
                </div>

                <div className="flex-1 min-h-0 rounded-xl border border-glass-border bg-glass p-3 flex flex-col items-center justify-center gap-4">
                    {hasReference ? (
                        <>
                            <div className="flex h-24 w-full items-center justify-center text-primary/70">
                                <AudioWaveform size={72} strokeWidth={1.2} />
                            </div>
                            <div className="flex items-center gap-2">
                                <button
                                    type="button"
                                    onClick={() => (playing ? stopAudio() : playUrl(character.reference_audio_url))}
                                    className="inline-flex items-center gap-2 rounded-full border border-glass-border bg-surface px-4 py-2 text-xs font-medium text-text-secondary transition-colors hover:border-primary/50 hover:text-primary"
                                >
                                    {playing ? <Square size={11} /> : <Play size={12} />}
                                    {playing ? t("referenceStop") : t("referencePlay")}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => handleDeleteVariant(character.reference_audio_selected_id)}
                                    disabled={!!busy}
                                    title={t("referenceDelete")}
                                    className="inline-flex items-center gap-1.5 rounded-full border border-glass-border bg-surface px-3 py-2 text-xs font-medium text-text-muted transition-colors hover:border-red-400/50 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    <Trash2 size={12} />
                                    {t("referenceDelete")}
                                </button>
                            </div>
                        </>
                    ) : (
                        <>
                            <UserRound size={48} className="text-text-muted" />
                            <p className="text-center text-xs text-text-muted">{t("referenceEmpty")}</p>
                        </>
                    )}
                </div>

                <div className={headerClass}>
                    <span className="text-xs text-text-muted">
                        {variants.length > 0 ? t("referenceTakeCount", { count: variants.length }) : ""}
                    </span>
                </div>

                <div className="flex items-center justify-end gap-2">
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept="audio/*"
                        className="hidden"
                        onChange={(e) => {
                            void handleReferenceUpload(e.target.files?.[0]);
                            // 清掉 value，否则选同一个文件不会再触发 onChange
                            e.target.value = "";
                        }}
                    />
                    <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={!!busy}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-glass-border bg-surface px-2.5 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:border-primary/50 hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {busy === "upload" ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
                        {busy === "upload" ? t("referenceUploading") : t("referenceUpload")}
                    </button>
                    <button
                        type="button"
                        onClick={() => run("reference", async (project) => {
                            await api.generateCharacterReferenceAudio(project.id, character.id);
                        })}
                        disabled={!!busy}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white shadow-sm shadow-primary/20 transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {busy === "reference" ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                        {busy === "reference"
                            ? t("referenceGenerate")
                            : hasReference ? t("referenceRegenerate") : t("referenceGenerate")}
                    </button>
                </div>

                {/* 候选条 —— 跟生图面那条同一个逻辑、同一套视觉：
                    改一版提示词生成一版，每版都留档；攒几条之后回头看哪条好，
                    点一下把它设为主音。 */}
                {variants.length > 0 && (
                    <div className="flex gap-2 overflow-x-auto pb-2 snap-x custom-scrollbar">
                        {variants.map((variant) => {
                            const isSelected = variant.id === character.reference_audio_selected_id;
                            const label = variant.origin === "upload" ? t("takeUpload") : (variant.origin || t("takeVoice"));
                            return (
                                <div
                                    key={variant.id}
                                    className={`relative flex-shrink-0 w-20 h-20 rounded-md border-2 transition-all snap-start group/take ${
                                        isSelected
                                            ? "border-blue-500 ring-2 ring-blue-500/30"
                                            : "border-transparent hover:border-gray-500"
                                    }`}
                                >
                                    <button
                                        type="button"
                                        onClick={() => handleSelectVariant(variant.id)}
                                        title={label}
                                        className="flex h-full w-full flex-col items-center justify-center gap-1 bg-glass px-1"
                                    >
                                        <AudioWaveform size={20} className={isSelected ? "text-blue-400" : "text-text-muted"} />
                                        <span className="w-full truncate text-center text-[0.5625rem] text-text-muted">
                                            {label}
                                        </span>
                                    </button>
                                    {isSelected && (
                                        <div className="absolute top-1 left-1 rounded-full bg-blue-500 p-0.5">
                                            <Check size={10} className="text-white" />
                                        </div>
                                    )}
                                    <button
                                        type="button"
                                        onClick={() => handleDeleteVariant(variant.id)}
                                        disabled={!!busy}
                                        title={t("referenceDelete")}
                                        className="absolute top-1 right-1 rounded-full bg-overlay/60 p-1 text-text-secondary opacity-0 transition-all hover:bg-red-500 hover:text-white group-hover/take:opacity-100 disabled:cursor-not-allowed"
                                    >
                                        <Trash2 size={10} />
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                )}
            </section>

            {/* ② 声音描述 —— 生图面「描述」的镜像 */}
            <section className={columnClass}>
                <div className={headerClass}>
                    <div>
                        <h3 className={titleClass}>{t("descriptionTitle")}</h3>
                        <p className={subTitleClass}>{t("descriptionHint")}</p>
                    </div>
                    <div className="flex items-center gap-3">
                        <button
                            type="button"
                            onClick={() => setShowRewriteBar((v) => !v)}
                            disabled={!!busy}
                            className={linkButtonClass}
                        >
                            {t("descriptionRewrite")}
                        </button>
                    </div>
                </div>
                <textarea
                    value={descriptionDraft}
                    onChange={(e) => setDescriptionDraft(e.target.value)}
                    onBlur={handleDescriptionBlur}
                    placeholder={t("descriptionPlaceholder")}
                    className={textAreaClass}
                />
                {showRewriteBar && (
                    <div className="rounded-xl border border-primary/25 bg-glass p-3">
                        <div className="relative">
                            <textarea
                                value={rewriteInstruction}
                                onChange={(e) => setRewriteInstruction(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter" && !e.shiftKey) {
                                        e.preventDefault();
                                        void handleRewriteDescription();
                                    }
                                }}
                                placeholder={t("descriptionRewritePlaceholder")}
                                disabled={busy === "rewrite"}
                                className="min-h-[104px] w-full resize-none rounded-lg border border-glass-border bg-input-bg p-3 pb-11 text-xs leading-relaxed text-text-secondary outline-none focus:border-primary/60 placeholder:text-text-muted"
                            />
                            <button
                                type="button"
                                onClick={() => void handleRewriteDescription()}
                                disabled={busy === "rewrite"}
                                className="absolute bottom-2 right-2 rounded-md bg-primary px-3 py-1.5 text-xs text-white disabled:opacity-50"
                            >
                                {busy === "rewrite" ? t("descriptionRewriting") : t("descriptionRewriteRun")}
                            </button>
                        </div>
                    </div>
                )}
                <p className="text-[0.6875rem] text-text-muted">
                    v{character.voice_description_version || 0}
                    {character.voice_description_source === "manual" ? " · 手工编辑" : ""}
                    {character.voice_description_source === "ai" ? " · AI 生成" : ""}
                </p>
            </section>

            {/* ③ 音色提示词 —— 生图面「生图提示词」的镜像 */}
            <section className={columnClass}>
                <div className={headerClass}>
                    <div>
                        <h3 className={titleClass}>{t("promptTitle")}</h3>
                        <p className={subTitleClass}>{t("promptHint")}</p>
                    </div>
                    <button
                        type="button"
                        onClick={handleGeneratePrompt}
                        disabled={!!busy}
                        className={linkButtonClass}
                    >
                        {busy === "prompt" ? t("promptGenerating") : t("promptGenerate")}
                    </button>
                </div>
                {promptStale && <p className="text-xs text-amber-400/90">{t("promptStale")}</p>}
                <textarea
                    value={promptDraft}
                    onChange={(e) => setPromptDraft(e.target.value)}
                    onBlur={handlePromptBlur}
                    placeholder={t("promptPlaceholder")}
                    className={textAreaClass}
                />
            </section>
        </div>
    );
}
