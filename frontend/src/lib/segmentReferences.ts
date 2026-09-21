import { characterImageUrl, scenePropImageUrl } from "./characterImage";

/**
 * 从创作台选中的一段连续镜头推导参考图清单。
 *
 * 「参考图N」的编号由数组下标决定（后端 `_motion_prompt_reference_block` 按提交顺序渲染），
 * 所以这里的顺序就是最终提示词里的编号 —— 不能由调用方再排一次。
 *
 * 规则（用户拍板 2026-09-19）：
 * - 顺序 = 资产在段内的**首次出现顺序**。13–20 镜那段新出现的资产直接追加在后面，
 *   1–9 号与上一段保持一致，核对提示词时不用来回跳。
 * - 去重按 **id**，不按名字：同名资产（系列池 / 集内各一份）是真实存在的，按名去重会串图。
 * - 超 9 张**不截断**：模型上限以后会放宽，现在先让用户看得见（计数标红）再自己删镜头。
 */

const TYPE_LABEL = { character: "角色", scene: "场景", prop: "道具" } as const;
export type SegmentReferenceType = (typeof TYPE_LABEL)[keyof typeof TYPE_LABEL];

/** 与创作台槽位的 `ReferenceAsset` 结构一致。 */
export interface SegmentReference {
    url: string;
    thumbnail: string;
    name: string;
    assetName: string;
    type: SegmentReferenceType;
}

export interface SegmentReferenceMiss {
    name: string;
    type: SegmentReferenceType;
    /** 段内第几镜（1 起）首次出现 */
    shot: number;
    /** missing-asset：帧引用的 id 在项目里找不到；no-image：资产存在但没图 */
    reason: "missing-asset" | "no-image";
}

export interface SegmentReferenceResult {
    references: SegmentReference[];
    misses: SegmentReferenceMiss[];
}

/**
 * store 的 `StoryboardFrame` 类型还没补 `character_ids` / `prop_ids`（代码里各处都用 any
 * 取的），这里只声明真正用到的字段，免得依赖一个不完整的类型。
 */
export interface SegmentFrame {
    id: string;
    scene_id?: string | null;
    character_ids?: string[] | null;
    prop_ids?: string[] | null;
}

export function deriveSegmentReferences(
    frameIds: string[],
    frames: SegmentFrame[],
    assets: { characters?: any[]; scenes?: any[]; props?: any[] },
): SegmentReferenceResult {
    const frameById = new Map(frames.map((frame) => [frame.id, frame]));
    const references: SegmentReference[] = [];
    const misses: SegmentReferenceMiss[] = [];
    const seen = new Set<string>();

    frameIds.forEach((frameId, index) => {
        const frame = frameById.get(frameId);
        if (!frame) return;
        const shot = index + 1;

        // 同一镜内也按「场景 → 角色 → 道具」收集：先有地方再有人，拼出来的参考图块读起来顺。
        const slots: Array<{ kind: SegmentReferenceType; id: string }> = [];
        if (frame.scene_id) slots.push({ kind: TYPE_LABEL.scene, id: frame.scene_id });
        for (const id of frame.character_ids || []) {
            if (id) slots.push({ kind: TYPE_LABEL.character, id });
        }
        for (const id of frame.prop_ids || []) {
            if (id) slots.push({ kind: TYPE_LABEL.prop, id });
        }

        for (const { kind, id } of slots) {
            const key = `${kind}:${id}`;
            if (seen.has(key)) continue;
            seen.add(key);

            const asset = findAsset(kind, id, assets);
            if (!asset) {
                misses.push({ name: id, type: kind, shot, reason: "missing-asset" });
                continue;
            }
            const url = kind === TYPE_LABEL.character ? characterImageUrl(asset) : scenePropImageUrl(asset);
            if (!url) {
                misses.push({ name: asset.name, type: kind, shot, reason: "no-image" });
                continue;
            }
            references.push({
                url,
                thumbnail: url,
                name: asset.name,
                assetName: asset.name,
                type: kind,
            });
        }
    });

    return { references, misses };
}

function findAsset(
    kind: SegmentReferenceType,
    id: string,
    assets: { characters?: any[]; scenes?: any[]; props?: any[] },
): any | undefined {
    const list =
        kind === TYPE_LABEL.character ? assets.characters : kind === TYPE_LABEL.scene ? assets.scenes : assets.props;
    return list?.find((item) => item.id === id);
}
