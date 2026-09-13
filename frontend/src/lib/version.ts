/**
 * 应用版本号的唯一来源是 `frontend/package.json`。
 *
 * `next.config.mjs` 在构建时把它读出来注入 `NEXT_PUBLIC_APP_VERSION`，Next 会把
 * 这个值编译期内联进 bundle —— 静态导出（Tauri / Docker）一样生效。
 *
 * 别在这里写回死值。以前 SettingsPage / UpdateChecker / GlobalSidebar 各自存了
 * 一份 `"v1.0.1"` 字面量，于是 manifest 都已经走到 1.1.0 了，界面上还显示 1.0.1，
 * `UpdateChecker` 也拿这个旧版本去跟 GitHub release tag 比，判断全是错的。
 *
 * vitest 不跑 next.config，所以留一个明显不是发布号的兜底值。测试断言的是
 * 「组件没有硬编码版本」，不是这个兜底值本身。
 */
export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "v0.0.0-dev";

/** 构建日期，形如 `20260913`。同样由 next.config.mjs 注入。 */
export const APP_BUILD_DATE = process.env.NEXT_PUBLIC_BUILD_DATE ?? "dev";
