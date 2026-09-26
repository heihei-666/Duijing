import { useId } from 'react';
import type { TextareaHTMLAttributes } from 'react';

import { cn } from '@/lib/cn';

interface TextAreaFieldProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** 不传就只渲染输入框（外层已有标题时用，记得补 aria-label） */
  label?: string;
  /** 输入框下方的常驻说明 */
  hint?: string;
  /** 校验或接口返回的错误，优先于 hint 展示 */
  error?: string | null;
}

/**
 * 多行输入。样式与 `components/common/Field` 完全一致，
 * 只是把那边的 input 换成 textarea（common 里没有多行版本，且本次不允许改动 common）。
 */
export function TextAreaField({
  label,
  hint,
  error,
  className,
  id,
  rows = 3,
  ...rest
}: TextAreaFieldProps) {
  const autoId = useId();
  const areaId = id ?? autoId;

  return (
    <div className="space-y-1.5">
      {label ? (
        <label htmlFor={areaId} className="block text-[13px] text-secondary">
          {label}
        </label>
      ) : null}
      <textarea
        id={areaId}
        rows={rows}
        className={cn(
          'w-full resize-none rounded-xl border bg-surface px-3 py-2.5 text-[15px] leading-relaxed text-primary',
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
