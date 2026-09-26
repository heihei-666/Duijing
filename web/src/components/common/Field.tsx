import { useId } from 'react';
import type { InputHTMLAttributes } from 'react';

import { cn } from '@/lib/cn';

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  /** 输入框下方的常驻说明 */
  hint?: string;
  /** 校验或接口返回的错误，优先于 hint 展示 */
  error?: string | null;
}

/** 表单字段：标签 + 输入框 + 说明/错误。登录注册页共用。 */
export function Field({ label, hint, error, className, id, ...rest }: FieldProps) {
  const autoId = useId();
  const inputId = id ?? autoId;

  return (
    <div className="space-y-1.5">
      <label htmlFor={inputId} className="block text-[13px] text-secondary">
        {label}
      </label>
      <input
        id={inputId}
        className={cn(
          'h-11 w-full rounded-xl border bg-surface px-3 text-[15px] text-primary',
          'placeholder:text-disabled',
          'focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary',
          error ? 'border-danger' : 'border-light',
          className,
        )}
        aria-invalid={error ? true : undefined}
        {...rest}
      />
      {error ? (
        <p className="text-xs text-danger">{error}</p>
      ) : hint ? (
        <p className="text-xs text-tertiary">{hint}</p>
      ) : null}
    </div>
  );
}
