"use client";

import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, FileUp, FolderUp, Loader2, Upload } from 'lucide-react';
import { api } from '@/lib/api';
import type { SkillPackageSummary } from '@/lib/api';
import { toast } from '@/store/toastStore';

/**
 * React 的 input 类型里没有 `webkitdirectory`，只能手动补上。
 * `directory` 是 Firefox 认的旧名字，一起给上：多写一个属性没成本，
 * 少写一个就会有浏览器永远弹不出文件夹选择框。
 */
const DIRECTORY_INPUT_PROPS = {
    webkitdirectory: '',
    directory: '',
} as unknown as React.InputHTMLAttributes<HTMLInputElement>;

interface SkillUploadButtonProps {
    /** 上传成功后回传元数据；外层负责绑定与刷新列表。 */
    onUploaded: (pkg: SkillPackageSummary) => void;
}

/**
 * 「上传 Skill」—— 文件与文件夹两个入口合一。
 *
 * 为什么必须支持文件夹：一个 Skill 不只是 SKILL.md，它通常还带一组
 * `references/*.md`。只传 SKILL.md 会被后端拒绝（缺少引用文件），而让用户
 * 自己去打 zip 是把工具的麻烦转嫁给用户。所以「上传文件夹」摆在显眼位置。
 */
export default function SkillUploadButton({ onUploaded }: SkillUploadButtonProps) {
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const fileInput = useRef<HTMLInputElement>(null);
    const folderInput = useRef<HTMLInputElement>(null);
    const wrapper = useRef<HTMLDivElement>(null);

    // 点外面或按 Esc 收起菜单。不加这个的话菜单会一直挂着挡住下面的文本框。
    useEffect(() => {
        if (!open) return;
        const onPointerDown = (event: MouseEvent) => {
            if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('mousedown', onPointerDown);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [open]);

    const run = async (task: () => Promise<SkillPackageSummary>) => {
        setBusy(true);
        try {
            onUploaded(await task());
        } catch (error) {
            const detail = (error as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
            toast.error(detail || 'Skill 上传失败');
        } finally {
            setBusy(false);
        }
    };

    const openPicker = (input: HTMLInputElement | null) => {
        setOpen(false);
        if (!input) return;
        // 清空 value，否则再次选同一个文件/文件夹不会触发 change 事件。
        input.value = '';
        input.click();
    };

    return (
        <div ref={wrapper} className="relative shrink-0">
            <button
                type="button"
                disabled={busy}
                onClick={() => setOpen((value) => !value)}
                className="text-[0.625rem] text-text-secondary hover:text-foreground flex items-center gap-1 px-2 py-1 rounded hover:bg-hover-bg whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
            >
                {busy ? <Loader2 size={10} className="animate-spin" /> : <Upload size={10} />}
                {busy ? '上传中…' : '上传 Skill'}
                {!busy && <ChevronDown size={10} />}
            </button>
            {open && (
                <div className="absolute right-0 top-full z-50 mt-1 w-44 rounded-lg border border-glass-border bg-elevated py-1 shadow-xl">
                    <button
                        type="button"
                        onClick={() => openPicker(fileInput.current)}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[0.6875rem] text-text-secondary hover:bg-hover-bg hover:text-foreground"
                    >
                        <FileUp size={11} /> 单个文件（.zip / .md）
                    </button>
                    <button
                        type="button"
                        onClick={() => openPicker(folderInput.current)}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[0.6875rem] text-text-secondary hover:bg-hover-bg hover:text-foreground"
                    >
                        <FolderUp size={11} /> 整个文件夹
                    </button>
                </div>
            )}
            <input
                ref={fileInput}
                type="file"
                accept=".zip,.md,.markdown,.txt,application/zip,text/markdown,text/plain"
                className="hidden"
                onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void run(() => api.uploadSkillPackage(file));
                }}
            />
            <input
                ref={folderInput}
                type="file"
                className="hidden"
                {...DIRECTORY_INPUT_PROPS}
                onChange={(event) => {
                    const files = Array.from(event.target.files ?? []);
                    if (files.length) void run(() => api.uploadSkillFolder(files));
                }}
            />
        </div>
    );
}
