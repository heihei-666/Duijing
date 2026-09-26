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
  primary: 'bg-primary text-on-brand hover:bg-primary-hover active:bg-primary-hover',
  subtle: 'bg-elevated text-primary hover:bg-inset active:bg-inset',
  outline: 'border border-light bg-surface text-primary hover:bg-elevated active:bg-inset',
  ghost: 'text-secondary hover:bg-elevated active:bg-inset',
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'h-8 gap-1.5 rounded-lg px-3 text-[13px]',
  md: 'h-11 gap-2 rounded-xl px-4 text-[15px]',
  lg: 'h-12 gap-2 rounded-xl px-5 text-[15px]',
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
        'inline-flex select-none items-center justify-center font-medium transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50',
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
