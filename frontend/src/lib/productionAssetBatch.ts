/**
 * 第 3 步「一键生成全部资产」的编排：每个资产各走一条
 * 提示词 →（角色）九维声音 → 提交出图 的链，几条链并行，单个失败不拖垮其他。
 * 网络调用全部由调用方注入，这里只管顺序、去重和汇总。
 */

export const VOICE_KEYS = ["年龄感", "音高", "明暗", "厚薄", "共鸣", "气息", "颗粒感", "口音", "稳定表达习惯"] as const;

export type BatchAsset = {
    key: string;
    id: string;
    lookId?: string;
    kind: "character" | "scene" | "prop";
    name: string;
    source?: string;
    locked: boolean;
    imagePrompt: string;
    hasImage: boolean;
    voice: Record<string, string | undefined>;
};

export type OneClickDeps = {
    /** 全局库资产先复制到本集，返回本集副本。 */
    ensureEpisode: (asset: BatchAsset) => Promise<BatchAsset>;
    /** 生成并等待提示词完成，返回最新提示词正文。 */
    generatePrompt: (asset: BatchAsset) => Promise<string>;
    generateVoice: (asset: BatchAsset) => Promise<void>;
    /** 只负责提交图片任务；出图进度由既有轮询跟踪。 */
    submitImage: (asset: BatchAsset, prompt: string) => Promise<void>;
};

export type OneClickResult = {
    prompts: number;
    voices: number;
    images: number;
    failures: { name: string; error: string }[];
};

const voiceMissing = (asset: BatchAsset) =>
    asset.kind === "character" && !VOICE_KEYS.every((key) => asset.voice?.[key]?.trim());

export function oneClickTargets(assets: BatchAsset[]): BatchAsset[] {
    return assets.filter((asset) => !asset.locked && (!asset.hasImage || !asset.imagePrompt.trim() || voiceMissing(asset)));
}

export async function runOneClickAssets(assets: BatchAsset[], deps: OneClickDeps, concurrency = 3): Promise<OneClickResult> {
    const result: OneClickResult = { prompts: 0, voices: 0, images: 0, failures: [] };
    const voiced = new Set<string>();
    const queue = [...assets];

    const runOne = async (initial: BatchAsset) => {
        try {
            const asset = await deps.ensureEpisode(initial);
            let prompt = asset.imagePrompt.trim();
            if (!prompt) {
                prompt = (await deps.generatePrompt(asset)).trim();
                if (!prompt) throw new Error("提示词生成结果为空");
                result.prompts += 1;
            }
            // 同一角色的多套造型共用一份声音档案；先占位再 await，避免并发链重复生成。
            if (voiceMissing(asset) && !voiced.has(asset.id)) {
                voiced.add(asset.id);
                await deps.generateVoice(asset);
                result.voices += 1;
            }
            if (!asset.hasImage) {
                await deps.submitImage(asset, prompt);
                result.images += 1;
            }
        } catch (error) {
            const detail = (error as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
            result.failures.push({
                name: initial.name,
                error: typeof detail === "string" ? detail : error instanceof Error ? error.message : String(error),
            });
        }
    };

    const worker = async () => {
        for (let next = queue.shift(); next; next = queue.shift()) await runOne(next);
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker));
    return result;
}
