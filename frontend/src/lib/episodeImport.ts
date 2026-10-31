/**
 * episodeImport — 把「上传多集」的文件/文件夹解析成逐集草稿。纯函数，不调后端、不用 AI。
 *
 * 规则：
 * - 每个 .md/.txt 文件算一集；文件内部若有 ≥2 处递增的「第N集 / EP N」标题行，则按标题再拆开。
 * - 集号先看正文标题，再看文件名（中文数字、阿拉伯数字、EP01 都认），都没有就接在最大集号之后。
 * - index / README / 目录 之类的目录页自动跳过。
 * - 同集号：内容完全相同自动合并；内容不同保留为候选，由用户选。
 */

export interface ImportSourceFile {
    /** 相对路径（文件夹上传时带目录），用于显示与排序 */
    path: string;
    text: string;
}

export interface EpisodeCandidate {
    source: string;
    title: string;
    text: string;
}

export interface EpisodeDraft {
    number: number;
    /** 同集号的候选；只有一个时无冲突 */
    candidates: EpisodeCandidate[];
    /** 内容完全相同而被合并掉的来源文件 */
    mergedSources: string[];
}

export interface SkippedFile {
    path: string;
    reason: "unsupported" | "index" | "empty";
}

export interface ParsedEpisodeImport {
    episodes: EpisodeDraft[];
    skipped: SkippedFile[];
}

const SUPPORTED_EXT = /\.(md|markdown|txt)$/i;
const INDEX_NAMES = new Set(["index", "readme", "目录", "索引", "toc", "_index", "summary", "总览"]);

const DIGITS: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 「12」「十二」「一百零三」→ 数字；认不出来返回 null。 */
export function parseEpisodeNumber(raw: string): number | null {
    const value = raw.trim();
    if (/^\d+$/.test(value)) return Number(value);
    if (!/^[零〇一二两三四五六七八九十百千]+$/.test(value)) return null;
    let total = 0;
    let current = 0;
    for (const char of value) {
        if (char in DIGITS) current = DIGITS[char];
        else if (char === "十") { total += (current || 1) * 10; current = 0; }
        else if (char === "百") { total += (current || 1) * 100; current = 0; }
        else if (char === "千") { total += (current || 1) * 1000; current = 0; }
    }
    return total + current;
}

const NUM = "([0-9零〇一二两三四五六七八九十百千]+)";
const HEADING_LINE = new RegExp(
    `^\\s{0,3}(?:#{1,6}\\s*)?(?:\\*\\*)?\\s*(?:第\\s*${NUM}\\s*[集话話]|(?:EP|Ep|ep|Episode|EPISODE)\\s*\\.?\\s*(\\d{1,4})(?!\\d))[^\\n]{0,40}$`,
);
const FILE_NUMBER_PATTERNS = [
    new RegExp(`第\\s*${NUM}\\s*[集话話]`),
    /(?:ep|episode)\s*\.?\s*0*(\d{1,4})/i,
    /(?:^|[^\d])0*(\d{1,4})(?!\d)/,
];

function stripFrontmatter(text: string): string {
    return text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").replace(/^---\n[\s\S]*?\n---\n/, "");
}

function stem(path: string): string {
    const base = path.split("/").pop() || path;
    return base.replace(/\.[^.]+$/, "");
}

function numberFromFileName(path: string): number | null {
    const name = stem(path);
    for (const pattern of FILE_NUMBER_PATTERNS) {
        const match = name.match(pattern);
        if (match) {
            const value = parseEpisodeNumber(match[1]);
            if (value !== null && value > 0) return value;
        }
    }
    return null;
}

function cleanHeading(line: string): string {
    return line.replace(/^\s{0,3}#{1,6}\s*/, "").replace(/\*\*/g, "").trim();
}

interface Section { number: number; title: string; text: string }

/** 文件内按标题行拆分；少于两处递增标题则返回 null（整份算一集）。 */
function splitByHeadings(text: string): Section[] | null {
    const lines = text.split("\n");
    const marks: { index: number; number: number; title: string }[] = [];
    lines.forEach((line, index) => {
        const match = line.match(HEADING_LINE);
        if (!match) return;
        const number = parseEpisodeNumber(match[1] ?? match[2] ?? "");
        if (number && number > 0) marks.push({ index, number, title: cleanHeading(line) });
    });
    const increasing = marks.every((mark, i) => i === 0 || mark.number > marks[i - 1].number);
    if (marks.length < 2 || !increasing) return null;
    return marks.map((mark, i) => ({
        number: mark.number,
        title: mark.title,
        text: lines.slice(mark.index + 1, i + 1 < marks.length ? marks[i + 1].index : lines.length).join("\n").trim(),
    }));
}

export function parseEpisodeFiles(files: ImportSourceFile[]): ParsedEpisodeImport {
    const skipped: SkippedFile[] = [];
    const found: { number: number | null; order: number; candidate: EpisodeCandidate }[] = [];
    const ordered = [...files].sort((a, b) => a.path.localeCompare(b.path, "zh-Hans-CN", { numeric: true }));

    ordered.forEach((file, order) => {
        if (!SUPPORTED_EXT.test(file.path)) return void skipped.push({ path: file.path, reason: "unsupported" });
        if (INDEX_NAMES.has(stem(file.path).trim().toLowerCase())) return void skipped.push({ path: file.path, reason: "index" });
        const text = stripFrontmatter(file.text).trim();
        if (!text) return void skipped.push({ path: file.path, reason: "empty" });

        const sections = splitByHeadings(text);
        if (sections) {
            for (const section of sections) {
                if (!section.text) continue;
                found.push({ number: section.number, order, candidate: { source: file.path, title: section.title, text: section.text } });
            }
            return;
        }
        found.push({ number: numberFromFileName(file.path), order, candidate: { source: file.path, title: stem(file.path), text } });
    });

    // 没有集号的文件接在最大集号之后，保持路径顺序
    let next = Math.max(0, ...found.map((item) => item.number ?? 0));
    for (const item of found) if (item.number === null) item.number = ++next;

    const byNumber = new Map<number, EpisodeDraft>();
    for (const item of found) {
        const number = item.number as number;
        const draft = byNumber.get(number) ?? { number, candidates: [], mergedSources: [] };
        const duplicate = draft.candidates.find((c) => c.text === item.candidate.text);
        if (duplicate) draft.mergedSources.push(item.candidate.source);
        else draft.candidates.push(item.candidate);
        byNumber.set(number, draft);
    }
    return { episodes: Array.from(byNumber.values()).sort((a, b) => a.number - b.number), skipped };
}

export type ImportAction = "fill" | "create" | "existing";

export interface ExistingEpisodeInfo {
    id: string;
    episodeNumber: number;
    hasText: boolean;
}

/** 该集号在系列里的去向：已有空集 → fill；已有正文 → existing（默认跳过）；没有 → create。 */
export function planAction(number: number, existing: ExistingEpisodeInfo[]): { action: ImportAction; existingId?: string } {
    const match = existing.find((item) => item.episodeNumber === number);
    if (!match) return { action: "create" };
    return match.hasText ? { action: "existing", existingId: match.id } : { action: "fill", existingId: match.id };
}
