import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// `vitest.config.mts` 跑的是 node 环境。Node 22+ 自带一个实验性 localStorage
// 全局，但只有配了 `--localstorage-file` 才可用，否则它存在却没有任何方法
// （启动时那句 `Warning: --localstorage-file was provided without a valid path`），
// 于是 zustand 的 persist 中间件会在每次 setState 上抛 `storage.setItem is not
// a function` —— 整份 settings-store.test.ts 因此全红。
// 所以判据是「能不能用」，不是「存不存在」。happy-dom 环境自带可用实现，不会走到这里。
const existingStorage = globalThis.localStorage as Storage | undefined;
if (!existingStorage || typeof existingStorage.setItem !== 'function') {
    const store = new Map<string, string>();
    const memoryStorage = {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, String(value)),
        removeItem: (key: string) => void store.delete(key),
        clear: () => store.clear(),
        key: (index: number) => Array.from(store.keys())[index] ?? null,
        get length() {
            return store.size;
        },
    } as Storage;
    // 直接赋值在 node 下可能被内建 getter 拦掉，用 defineProperty 确保换得掉。
    Object.defineProperty(globalThis, 'localStorage', {
        value: memoryStorage,
        configurable: true,
        writable: true,
    });
}

afterEach(() => {
    cleanup();
});
