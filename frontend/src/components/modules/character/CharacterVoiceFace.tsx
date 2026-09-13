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
    AudioWaveform, Check, Loader2, Play, RefreshCw, Square, Upload, UserRound, Wand2,
} from "lucide-react";
import { api } from "@/lib/api";
import { getAssetUrl } from "@/lib/utils";
import { useProjectStore } from "@/store/projectStore";
import { toast } from "@/store/toastStore";
import VoicePickerModal from "../cast/VoicePickerModal";

interface CharacterVoiceFaceProps {
    /** 同一个角色对象（来自 currentProject.characters）。 */
    character: any;
}

type Busy = null | "description" | "prompt" | "reference" | "upload" | "preview" | "accept";

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
    const [busy, setBusy] = useState<Busy>(null);
    const [pickerOpen, setPickerOpen] = useState(false);
    const [previewVoiceId, setPreviewVoiceId] = useState<string | null>(null);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
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
    const handleExtractDescription = () => run("description", async (project) => {
        await api.generateCharacterVoiceDescription(project.id, character.id);
    });

    const handleDescriptionBlur = () => {
        const next = descriptionDraft.trim();
        if (next === (character.voice_description || "")) return;
        void run(null, async (project) => {
            await api.updateCharacterVoiceFields(project.id, character.id, {
                voice_description: next,
            });
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

    const handlePreview = async () => {
        if (!promptDraft.trim()) {
            toast.error(t("needPrompt"));
            return;
        }
        await run("preview", async () => {
            const { voice_id, preview_url } = await api.designVoicePreview({
                voice_prompt: promptDraft.trim(),
            });
            setPreviewVoiceId(voice_id);
            setPreviewUrl(preview_url);
            await playUrl(preview_url);
        });
    };

    const handleAccept = async () => {
        if (!previewVoiceId || !currentProject?.series_id) return;
        await run("accept", async (project) => {
            const voice = await api.designVoiceAccept({
                series_id: project.series_id!,
                voice_id: previewVoiceId,
                voice_prompt: promptDraft.trim(),
                label: character.name,
            });
            await api.bindVoice(project.id, character.id, voice.id, voice.label);
            toast.success(t("bound", { name: voice.label }));
            setPreviewVoiceId(null);
            setPreviewUrl(null);
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
                            <button
                                type="button"
                                onClick={() => (playing ? stopAudio() : playUrl(character.reference_audio_url))}
                                className="inline-flex items-center gap-2 rounded-full border border-glass-border bg-surface px-4 py-2 text-xs font-medium text-text-secondary transition-colors hover:border-primary/50 hover:text-primary"
                            >
                                {playing ? <Square size={11} /> : <Play size={12} />}
                                {playing ? t("referenceStop") : t("referencePlay")}
                            </button>
                        </>
                    ) : (
                        <>
                            <UserRound size={48} className="text-text-muted" />
                            <p className="text-center text-xs text-text-muted">{t("referenceEmpty")}</p>
                            {!character.voice_id && (
                                <p className="text-center text-[0.6875rem] text-text-muted">
                                    {t("referenceNoVoice")}
                                </p>
                            )}
                            {character.voice_origin === "design" && (
                                <p className="text-center text-[0.6875rem] text-text-muted">
                                    {t("referenceSameAsVoice")}
                                </p>
                            )}
                        </>
                    )}
                </div>

                <div className={headerClass}>
                    <span className="text-xs text-text-muted">
                        {character.voice_id
                            ? `${t("currentVoice")}：${character.voice_name || character.voice_id}`
                            : t("noVoice")}
                    </span>
                    <button type="button" onClick={() => setPickerOpen(true)} className={linkButtonClass}>
                        {t("pickVoice")}
                    </button>
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
                        disabled={!character.voice_id || !!busy}
                        title={!character.voice_id ? t("referenceNoVoice") : undefined}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white shadow-sm shadow-primary/20 transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {busy === "reference" ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                        {busy === "reference"
                            ? t("referenceGenerate")
                            : hasReference ? t("referenceRegenerate") : t("referenceGenerate")}
                    </button>
                </div>
            </section>

            {/* ② 声音描述 —— 生图面「描述」的镜像 */}
            <section className={columnClass}>
                <div className={headerClass}>
                    <div>
                        <h3 className={titleClass}>{t("descriptionTitle")}</h3>
                        <p className={subTitleClass}>{t("descriptionHint")}</p>
                    </div>
                    <button
                        type="button"
                        onClick={handleExtractDescription}
                        disabled={!!busy}
                        className={linkButtonClass}
                    >
                        {busy === "description" ? t("descriptionExtracting") : t("descriptionExtract")}
                    </button>
                </div>
                <textarea
                    value={descriptionDraft}
                    onChange={(e) => setDescriptionDraft(e.target.value)}
                    onBlur={handleDescriptionBlur}
                    placeholder={t("descriptionPlaceholder")}
                    className={textAreaClass}
                />
                <p className="text-[0.6875rem] text-text-muted">
                    v{character.voice_description_version || 0}
                    {character.voice_description_source === "manual" ? " · 手工编辑" : ""}
                    {character.voice_description_source === "ai" ? " · AI 提取" : ""}
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
                        disabled={!!busy || !descriptionDraft.trim()}
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

                <div className="space-y-2">
                    <div className="flex items-center justify-end gap-2">
                        <button
                            type="button"
                            onClick={handlePreview}
                            disabled={!!busy || !promptDraft.trim()}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-glass-border bg-surface px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:border-primary/50 hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {busy === "preview" ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
                            {busy === "preview" ? t("previewing") : t("preview")}
                        </button>
                        <button
                            type="button"
                            onClick={handleAccept}
                            disabled={!previewVoiceId || !!busy}
                            title={!previewVoiceId ? t("previewFirst") : undefined}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white shadow-sm shadow-primary/20 transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {busy === "accept" ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                            {busy === "accept" ? t("accepting") : t("accept")}
                        </button>
                    </div>
                    {previewUrl && (
                        <p className="text-right text-[0.6875rem] text-text-muted">
                            <Wand2 size={11} className="mr-1 inline" />
                            {t("preview")} OK
                        </p>
                    )}
                </div>
            </section>

            <VoicePickerModal
                isOpen={pickerOpen}
                onClose={() => setPickerOpen(false)}
                characterName={character.name}
                characterGender={character.gender || undefined}
                characterDescription={character.description || undefined}
                currentVoiceId={character.voice_id || undefined}
                seriesId={currentProject?.series_id || null}
                onApply={async (voiceId: string, voiceName: string) => {
                    if (!currentProject) return;
                    await api.bindVoice(currentProject.id, character.id, voiceId, voiceName);
                    await refresh();
                }}
            />
        </div>
    );
}
