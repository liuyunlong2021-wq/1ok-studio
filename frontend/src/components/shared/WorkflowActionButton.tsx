"use client";
/**
 * WorkflowActionButton — R2V workflow 统一 primary action 按钮。
 *
 * 视觉灵感：ZeroNode 项目的 frosted glass pill —— pill 形状 + 顶部高光
 * + 半透明品牌色 + backdrop-blur，让按钮看起来"漂浮"在 dark glass 之上。
 *
 * 适配 One OK Studio：
 *   · 颜色全部走主题变量（primary / on-accent / hover-bg），切主题自动跟随
 *   · backdrop-blur 落到 One OK Studio 已有的 glass 语言里
 *   · 顶部 inset highlight 约 1px 白色 4-5% —— 极克制，不喧宾
 *   · 三档 variant：
 *       - primary  : 主题色填充 + 顶部高光，主行动（"应用并继续" / "Generate ×N"）
 *       - secondary: 主题色 outline + 极浅填充，次行动（"导入" / "保存"）
 *       - ghost    : 透明 + 主题文字 + hover 显玻璃，纯导航（"取消" / 占位）
 *   · loading 态：左前显 spinner，禁交互
 *   · disabled 态：opacity 50% + cursor not-allowed
 *
 * 禁用 motion.button 包装 —— scale-95 active 已足够，不再加 framer-motion 重器。
 */
import { Loader2 } from "lucide-react";
import clsx from "clsx";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost";
type Size = "sm" | "md";

interface WorkflowActionButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
    /** primary = 主行动（紫色填充 frosted）
     *  secondary = 次行动（紫 outline + 极浅紫底）
     *  ghost = 纯导航（透明 + hover 显玻璃） */
    variant?: Variant;
    /** sm = 28px 高 (chrome 内嵌)；md = 36px 高（标准 step trailing）。 */
    size?: Size;
    /** 左 icon（可选）；与 children 之间有 1.5 间距。 */
    leftIcon?: ReactNode;
    /** 右 icon（可选）；常用于 ChevronRight "继续" 暗示。 */
    rightIcon?: ReactNode;
    /** loading 时左 icon 自动换 spinner，按钮禁用，文字不变。 */
    loading?: boolean;
    children: ReactNode;
}

/* ───────────────────────────────────────────────────────────────────
   Variant 风格表
   每档样式写在这里，避免 className 拼接里塞条件，可读性更好。

   ⚠️ 颜色一律走**主题变量**（`primary/xx` / `on-accent` / `hover-bg`），
   不写死色值。这里原来把紫色 `rgba(100,108,255,…)` 写死在 secondary/ghost 里，
   只有 primary 跟着主题跑 —— 于是切到非紫色主题（例如 atelier-light 的 teal）
   时，同一行里的按钮一个 teal、一个紫，看起来像两套组件。
   ─────────────────────────────────────────────────────────────────── */
const variantStyles: Record<Variant, string> = {
    /* Primary — 实色主题色 fill + frosted 顶部高光。
       光晕走 `.workflow-btn-primary`（定义在 globals.css）：各主题用自己的
       `--glow-primary`，亮色主题那版刻意更克制。别改回 Tailwind 的
       `shadow-[var(--…)]` —— 它解析不出颜色会把整条丢掉，按钮就没有阴影了。 */
    primary: clsx(
        "workflow-btn-primary",
        // on-accent = 「压在实色上的对比色」（暗主题下近黑、亮主题下白）。
        // 原来写 text-foreground 只在暗色主题下恰好是对的。
        "text-on-accent",
        "bg-primary",
        "border border-primary/65",
        "hover:bg-primary-hover",
        "hover:border-primary/85",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/55 focus-visible:ring-offset-2 focus-visible:ring-offset-surface",
    ),
    /* Secondary — 主题色 outline + 极浅填充。hover 加深但比 primary 轻。 */
    secondary: clsx(
        "text-primary",
        "bg-primary/10",
        "border border-primary/40",
        "shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]",
        "backdrop-blur-md",
        "hover:bg-primary/22 hover:border-primary/60 hover:text-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/55",
    ),
    /* Ghost — 透明，hover 才显玻璃。最低权重的导航 / 取消 / 次要动作。
       hover 底色走 `hover-bg`：它每个主题各定义一次（暗色是白 4.5%、
       亮色是黑 4%），写死白色在亮主题上等于没有 hover。 */
    ghost: clsx(
        "text-text-secondary bg-transparent border border-transparent",
        "hover:bg-hover-bg hover:text-foreground hover:border-glass-border",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/55",
    ),
};

const sizeStyles: Record<Size, string> = {
    sm: "min-h-[30px] px-3.5 text-[0.78125rem] gap-1.5",
    md: "min-h-[38px] px-5 text-[0.8125rem] gap-2",
};

export default function WorkflowActionButton({
    variant = "primary",
    size = "md",
    leftIcon,
    rightIcon,
    loading = false,
    disabled,
    className,
    children,
    type = "button",
    ...rest
}: WorkflowActionButtonProps) {
    const isDisabled = disabled || loading;
    return (
        <button
            type={type}
            disabled={isDisabled}
            className={clsx(
                // pill — rounded-full 是核心标识，所有 variant 共享
                "inline-flex items-center justify-center rounded-full font-semibold",
                // 字体走 sans (Inter→PingFang fallback)，符合 One OK Studio content tier
                "font-sans tracking-[-0.005em]",
                "select-none whitespace-nowrap",
                "transition-[background,border-color,box-shadow,transform] duration-fast ease-out-quart",
                "active:scale-[0.97]",
                "disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100",
                sizeStyles[size],
                variantStyles[variant],
                className,
            )}
            {...rest}
        >
            {loading ? (
                <Loader2 className="animate-spin" size={size === "sm" ? 12 : 14} aria-hidden="true" />
            ) : leftIcon ? (
                <span className="grid place-items-center [&>svg]:h-3.5 [&>svg]:w-3.5">{leftIcon}</span>
            ) : null}
            <span>{children}</span>
            {rightIcon && !loading ? (
                <span className="grid place-items-center [&>svg]:h-3.5 [&>svg]:w-3.5">{rightIcon}</span>
            ) : null}
        </button>
    );
}
