import { describe, expect, it, vi } from 'vitest';
import { oneClickTargets, runOneClickAssets, type BatchAsset } from '@/lib/productionAssetBatch';

const VOICE = { 年龄感: 'a', 音高: 'a', 明暗: 'a', 厚薄: 'a', 共鸣: 'a', 气息: 'a', 颗粒感: 'a', 口音: 'a', 稳定表达习惯: 'a' };

const asset = (overrides: Partial<BatchAsset>): BatchAsset => ({
    key: 'k', id: 'id', kind: 'scene', name: '资产', source: 'episode', locked: false,
    imagePrompt: '', hasImage: false, voice: {}, ...overrides,
});

const deps = () => ({
    ensureEpisode: vi.fn(async (item: BatchAsset) => item),
    generatePrompt: vi.fn(async (item: BatchAsset) => `${item.name}的提示词`),
    generateVoice: vi.fn(async () => undefined),
    submitImage: vi.fn(async () => undefined),
});

describe('one-click production assets', () => {
    it('targets unlocked assets missing an image, a prompt, or a character voice', () => {
        const targets = oneClickTargets([
            asset({ key: 'done', imagePrompt: 'p', hasImage: true }),
            asset({ key: 'locked', locked: true }),
            asset({ key: 'no-image', imagePrompt: 'p' }),
            asset({ key: 'no-voice', kind: 'character', imagePrompt: 'p', hasImage: true }),
            asset({ key: 'voiced', kind: 'character', imagePrompt: 'p', hasImage: true, voice: VOICE }),
        ]);
        expect(targets.map((item) => item.key)).toEqual(['no-image', 'no-voice']);
    });

    it('generates a missing prompt first and submits the image with that prompt', async () => {
        const d = deps();
        const result = await runOneClickAssets([asset({ key: 'plaza', name: '广场' }), asset({ key: 'ship', name: '采矿船', imagePrompt: '已有提示词' })], d);

        expect(d.generatePrompt).toHaveBeenCalledTimes(1);
        expect(d.submitImage).toHaveBeenCalledWith(expect.objectContaining({ key: 'plaza' }), '广场的提示词');
        expect(d.submitImage).toHaveBeenCalledWith(expect.objectContaining({ key: 'ship' }), '已有提示词');
        expect(result).toMatchObject({ prompts: 1, images: 2, failures: [] });
    });

    it('designs each character voice once even when several looks are targeted', async () => {
        const d = deps();
        await runOneClickAssets([
            asset({ key: 'laila:a', id: 'laila', kind: 'character', lookId: 'a', imagePrompt: 'p' }),
            asset({ key: 'laila:b', id: 'laila', kind: 'character', lookId: 'b', imagePrompt: 'p' }),
        ], d);
        expect(d.generateVoice).toHaveBeenCalledTimes(1);
    });

    it('keeps going after one asset fails and reports which one', async () => {
        const d = deps();
        d.generatePrompt.mockImplementation(async (item: BatchAsset) => {
            if (item.key === 'bad') throw new Error('网关 500');
            return 'p';
        });
        const result = await runOneClickAssets([asset({ key: 'bad', name: '坏的' }), asset({ key: 'good', name: '好的' })], d);

        expect(result.images).toBe(1);
        expect(result.failures).toEqual([{ name: '坏的', error: '网关 500' }]);
    });

    it('does not regenerate images for assets that already have one', async () => {
        const d = deps();
        await runOneClickAssets([asset({ kind: 'character', imagePrompt: 'p', hasImage: true })], d);
        expect(d.submitImage).not.toHaveBeenCalled();
        expect(d.generateVoice).toHaveBeenCalledTimes(1);
    });

    it('runs at most the given number of assets at once', async () => {
        let running = 0;
        let peak = 0;
        const d = deps();
        d.submitImage.mockImplementation(async () => {
            running += 1; peak = Math.max(peak, running);
            await new Promise((resolve) => setTimeout(resolve, 5));
            running -= 1;
        });
        await runOneClickAssets(Array.from({ length: 7 }, (_, index) => asset({ key: `a${index}`, imagePrompt: 'p' })), d, 3);
        expect(peak).toBe(3);
    });
});
