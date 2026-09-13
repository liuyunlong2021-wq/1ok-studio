import type { LucideIcon } from "lucide-react";
import {
    BookOpen,
    Clapperboard,
    Film,
    Layout,
    Palette,
    Users,
    Video,
    Volume2,
} from "lucide-react";

export interface Step {
    id: string;
    label: string;
    icon: LucideIcon;
    comingSoon?: boolean;
    /** Per-step status for the rail's stage model (not a wizard done-check).
     *  'ready' = has content (teal check); 'warn' = partial / needs attention
     *  (amber dot); 'idle' = not started (muted hollow); 'gated' = blocked by
     *  an upstream step (muted + lock, still clickable). */
    status?: "ready" | "warn" | "idle" | "gated";
    statusLabel?: string;
}

// PR-3m · Steps 7-9 (Voice / Final Mix / Export) deprecated. Their
// functionality moved into:
//   - Voice  → Cast voice binding + Storyboard DialogueAudioRow (PR-3g-3j)
//   - Mix    → Assembly Mix phase tab (PR-3k)
//   - Export → Assembly Export phase tab (PR-3k)
// Both legacy and unified projects now share the 6-step shape.
export const LEGACY_STEPS: Step[] = [
    { id: "script", label: "1. 剧本", icon: BookOpen },
    { id: "art_direction", label: "2. 风格", icon: Palette },
    { id: "assets", label: "3. 资产", icon: Users },
    { id: "storyboard", label: "4. 分镜", icon: Layout },
    { id: "motion", label: "5. 动作", icon: Video },
    { id: "assembly", label: "6. 合成", icon: Film },
];

// PR-3f (r2v-workflow-v3) — Unified workflow with Cast.
// Per-shot tabMode toggle (t2i_i2v vs direct_r2v) inside Storyboard
// replaces the project-level i2v_legacy / r2v split. Backend enum
// value remains "r2v" for backward compat — UI normalizes to "Unified".
// Legacy `assets` step is dropped — Cast supersedes ConsistencyVault
// for unified projects (ConsistencyVault stays only for legacy workflow).
//
// 「声音」是**纯可选的参考步骤**：录一版整集声音给人听，听完自己判断哪几个分镜
// 一组、每段大约多少秒。它不参与任何自动决策，跳过它后面一步都不受影响 ——
// 所以它的状态只会是 idle / ready，永远不会 gated。
export const UNIFIED_STEPS: Step[] = [
    { id: "script", label: "1. 剧本", icon: BookOpen },
    { id: "art_direction", label: "2. 风格", icon: Palette },
    { id: "cast", label: "3. Cast", icon: Users },
    { id: "sound", label: "4. 声音", icon: Volume2 },
    { id: "storyboard_r2v", label: "5. 分镜", icon: Clapperboard },
    { id: "assembly", label: "6. 合成", icon: Film },
];

/**
 * 按项目的工作流模式选出步骤表。
 *
 * - 非 r2v（老项目）→ LEGACY_STEPS，一步都不动
 * - r2v + freeform → 跳过「剧本」，编号从 1 重排（没有剧本就没什么可念的）
 * - r2v + scripted → UNIFIED_STEPS
 */
export function stepsForWorkflow({
    workflowMode,
    seriesContentMode,
}: {
    workflowMode?: string | null;
    seriesContentMode?: string | null;
}): Step[] {
    if (workflowMode !== "r2v") {
        return LEGACY_STEPS;
    }
    if (seriesContentMode === "freeform") {
        return UNIFIED_STEPS
            .filter((step) => step.id !== "script")
            .map((step, index) => ({
                ...step,
                label: step.label.replace(/^\d+\./, `${index + 1}.`),
            }));
    }
    return UNIFIED_STEPS;
}
