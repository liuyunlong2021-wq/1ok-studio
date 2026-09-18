"use client";
/**
 * ReconcileAction — 资产库顶部的「与系列对齐」按钮 + 弹窗。
 *
 * ReconcileModal 早就写好了，但只挂在 `ScriptProcessor` 上，而那个组件在整个
 * app 里没有任何地方 import —— 事件派发了没人监听，所以用户从来看不到这个弹窗。
 * 这里把它接到一个用户主动点的按钮上（不自动弹：刚提取完那一刻，人脑里还是
 * "我新提了一堆东西"，等真在资产库里看到两个「刘备」时点才有判断力）。
 */
import { useState } from "react";
import { Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import WorkflowActionButton from "@/components/shared/WorkflowActionButton";
import ReconcileModal from "./ReconcileModal";

export interface ReconcileActionProps {
    scriptId: string | null;
    onApplied?: () => void;
}

export default function ReconcileAction({ scriptId, onApplied }: ReconcileActionProps) {
    const t = useTranslations("reconcile");
    const [open, setOpen] = useState(false);

    return (
        <>
            <WorkflowActionButton
                variant="secondary"
                size="sm"
                leftIcon={<Sparkles />}
                onClick={() => setOpen(true)}
                disabled={!scriptId}
                title={t("title")}
            >
                {t("openButton")}
            </WorkflowActionButton>
            <ReconcileModal
                isOpen={open}
                scriptId={scriptId}
                onClose={() => setOpen(false)}
                onApplied={onApplied}
            />
        </>
    );
}
