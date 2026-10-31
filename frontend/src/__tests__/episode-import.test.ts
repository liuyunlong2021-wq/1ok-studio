import { describe, expect, it } from 'vitest';
import { parseEpisodeFiles, parseEpisodeNumber, planAction } from '@/lib/episodeImport';

describe('parseEpisodeNumber', () => {
    it('认阿拉伯与中文数字', () => {
        expect(parseEpisodeNumber('12')).toBe(12);
        expect(parseEpisodeNumber('一')).toBe(1);
        expect(parseEpisodeNumber('十')).toBe(10);
        expect(parseEpisodeNumber('十二')).toBe(12);
        expect(parseEpisodeNumber('二十')).toBe(20);
        expect(parseEpisodeNumber('一百零三')).toBe(103);
        expect(parseEpisodeNumber('abc')).toBeNull();
    });
});

describe('parseEpisodeFiles', () => {
    it('文件夹：一集一个文件，集号取自文件名，跳过 index，相同内容合并', () => {
        const same = '0.0–3.5s：黑屏。';
        const { episodes, skipped } = parseEpisodeFiles([
            { path: '工程剧本/index.md', text: '# 工程剧本\n- [[第一集]]' },
            { path: '工程剧本/第1集工程剧本.md', text: same },
            { path: '工程剧本/第2集工程剧本.md', text: '0.0–2.0s：黑土地。' },
            { path: '工程剧本/第一集.md', text: same },
            { path: '工程剧本/cover.png', text: '' },
        ]);
        expect(episodes.map((e) => e.number)).toEqual([1, 2]);
        expect(episodes[0].candidates).toHaveLength(1);
        expect(episodes[0].mergedSources).toEqual(['工程剧本/第一集.md']);
        expect(skipped.map((s) => [s.path, s.reason])).toEqual([
            ['工程剧本/cover.png', 'unsupported'],
            ['工程剧本/index.md', 'index'],
        ]);
    });

    it('同集号内容不同：保留为候选', () => {
        const { episodes } = parseEpisodeFiles([
            { path: 'a/第1集.md', text: '版本甲' },
            { path: 'b/第一集.md', text: '版本乙' },
        ]);
        expect(episodes).toHaveLength(1);
        expect(episodes[0].candidates.map((c) => c.text)).toEqual(['版本甲', '版本乙']);
    });

    it('单个合并文件：按标题行拆成多集', () => {
        const { episodes } = parseEpisodeFiles([
            { path: '全集.md', text: '# 第1集 开端\n甲甲\n\n# 第2集 暗流\n乙乙\n\n## 第三集\n丙丙' },
        ]);
        expect(episodes.map((e) => [e.number, e.candidates[0].title, e.candidates[0].text])).toEqual([
            [1, '第1集 开端', '甲甲'],
            [2, '第2集 暗流', '乙乙'],
            [3, '第三集', '丙丙'],
        ]);
    });

    it('正文里偶然提到「第2集」不会触发拆分', () => {
        const { episodes } = parseEpisodeFiles([
            { path: '第1集.md', text: '这里提到后面的内容会在第2集揭晓，详见下文的很长很长很长很长很长很长的一句话。' },
        ]);
        expect(episodes).toHaveLength(1);
        expect(episodes[0].number).toBe(1);
    });

    it('没有集号的文件接在最大集号之后；去掉 frontmatter 与 BOM', () => {
        const { episodes } = parseEpisodeFiles([
            { path: '第5集.md', text: '---\ntitle: x\n---\n﻿正文五' },
            { path: '番外.md', text: '番外正文' },
        ]);
        expect(episodes.map((e) => e.number)).toEqual([5, 6]);
        expect(episodes[0].candidates[0].text).toBe('正文五');
    });

    it('空文件被跳过', () => {
        const { episodes, skipped } = parseEpisodeFiles([{ path: '第1集.md', text: '  \n' }]);
        expect(episodes).toEqual([]);
        expect(skipped[0].reason).toBe('empty');
    });
});

describe('planAction', () => {
    const existing = [
        { id: 'a', episodeNumber: 1, hasText: false },
        { id: 'b', episodeNumber: 2, hasText: true },
    ];
    it('空集填入、有正文标为已有、没有则新建', () => {
        expect(planAction(1, existing)).toEqual({ action: 'fill', existingId: 'a' });
        expect(planAction(2, existing)).toEqual({ action: 'existing', existingId: 'b' });
        expect(planAction(3, existing)).toEqual({ action: 'create' });
    });
});
