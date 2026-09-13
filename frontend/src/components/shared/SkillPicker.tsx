"use client";

import React from 'react';
import type { SkillPackageSummary } from '@/lib/api';

/**
 * 解析要显示在“已绑定”后面的名字。
 *
 * 优先用后端在绑定详情里给的 name（已删除的包就只剩 id），再退回本机列表，
 * 最后兜底显示裸 id，而不是显示空白。
 */
export function skillNameFor(
    packageId: string | undefined,
    packages: SkillPackageSummary[],
    boundName?: string,
): string | undefined {
    if (!packageId) return undefined;
    return boundName || packages.find((pkg) => pkg.id === packageId)?.name || packageId;
}

interface SkillPickerProps {
    packages: SkillPackageSummary[];
    onSelect: (packageId: string) => void;
    /** `undefined` 时优先显示内置包的加载提示。 */
    title?: string;
    className?: string;
}

/**
 * 从本机已有的 Skill 里选一个绑定，免去每次打包上传。
 *
 * 用 `value=""` 当动作菜单用：选完不驻留在选择状态，选中项由外层
 * `skill_bindings` 决定，这样“已绑定”那行永远是真值来源。
 */
export default function SkillPicker({ packages, onSelect, title, className }: SkillPickerProps) {
    if (!packages.length) {
        return <span className="text-[0.625rem] text-text-muted" title={title}>暂无可用 Skill</span>;
    }
    return (
        <select
            value=""
            title={title || '从内置或已上传的 Skill 中选择'}
            className={className || 'text-[0.625rem] bg-input-bg border border-glass-border rounded px-1.5 py-1 text-text-secondary focus:outline-none focus:border-primary/50 w-[8.5rem] shrink-0 whitespace-nowrap'}
            onChange={(event) => {
                if (event.target.value) onSelect(event.target.value);
            }}
        >
            <option value="">选择 Skill</option>
            {packages.map((pkg) => (
                <option key={pkg.id} value={pkg.id}>
                    {pkg.name}{pkg.builtin ? '（内置）' : ''}
                </option>
            ))}
        </select>
    );
}
