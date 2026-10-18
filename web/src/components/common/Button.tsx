import type { ButtonHTMLAttributes } from 'react';

import { cn } from '@/lib/cn';

export type ButtonVariant = 'primary' | 'subtle' | 'outline' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

/**
 * 手写按钮。配色只用设计令牌：
 *   primary → 主色实底（状态栏里唯一允许出现的彩色按钮之一）
 *   subtle  → --bg-elevated 底（「+ 记一笔」）
 *   outline → 白底细边（AI 观察块里的「加入」）
 *   ghost   → 无底色，纯文字（「忽略」）
 */
const VARIANT_CLASS: Record<ButtonVariant, string> = {
  // 主按钮：悬停时轻微抬起（阴影 + 变暗）。不做位移/缩放 ——
  // 这个产品整天在安抚用户，界面上再来一堆动作会显得吵。
  primary:
    'bg-primary text-on-brand shadow-card hover:bg-primary-hover hover:shadow-card-hover active:bg-primary-hover',
  subtle: 'bg-elevated text-primary hover:bg-inset active:bg-inset',
  outline: 'border border-light bg-surface text-primary hover:bg-elevated hover:shadow-card active:bg-inset',
  ghost: 'text-secondary hover:bg-elevated active:bg-inset',
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'h-8 gap-1.5 rounded-lg px-3 text-[13px]',
  md: 'h-11 gap-2 rounded-xl px-4 text-[15px]',
  // lg 是页面里真正的「主行动」（记一笔 / 选立场开辩）：更高、更粗，
  // 和次要按钮拉开层级，而不是只靠颜色区分。
  lg: 'h-12 gap-2 rounded-xl px-5 text-[15px] font-semibold',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  loading?: boolean;
}

export function Button({
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  loading = false,
  disabled,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={Boolean(disabled) || loading}
      className={cn(
        'inline-flex select-none items-center justify-center font-medium transition-all duration-150',
        'disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none',
        VARIANT_CLASS[variant],
        SIZE_CLASS[size],
        fullWidth && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading && (
        <span
          aria-hidden
          className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      )}
      {children}
    </button>
  );
}
