import type { ReactNode } from 'react';
import { useState } from 'react';

import { cn } from '@/lib/cn';
import { EmptyState } from '@/components/common/EmptyState';
import { ChevronDownIcon } from '@/features/weakness/icons';

interface WeaknessSectionProps {
  title: string;
  count: number;
  /** 空状态文案，克制、不喧哗 */
  emptyTitle: string;
  emptyHint?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}

/**
 * 弱点墙的一个分区（方案 3.2：移动端列表态 + 分区折叠）。
 * 折叠状态只存在内存里——刷新后回到默认，不做持久化，避免「上次折叠了结果再也看不到」。
 */
export function WeaknessSection({
  title,
  count,
  emptyTitle,
  emptyHint,
  defaultOpen = true,
  children,
}: WeaknessSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex min-h-[44px] w-full items-center gap-2 rounded-xl px-1 text-left"
      >
        <h2 className="text-[13px] text-secondary">{title}</h2>
        <span
          className={cn(
            'rounded-md px-1.5 py-0.5 text-[11px] tabular-nums',
            count > 0 ? 'bg-elevated text-secondary' : 'bg-elevated text-tertiary',
          )}
        >
          {count}
        </span>
        <ChevronDownIcon
          className={cn(
            'ml-auto text-tertiary transition-transform',
            open ? 'rotate-0' : '-rotate-90',
          )}
        />
      </button>

      {open ? (
        count === 0 ? (
          <EmptyState title={emptyTitle} hint={emptyHint} />
        ) : (
          <div className="mt-1 space-y-2.5">{children}</div>
        )
      ) : null}
    </section>
  );
}
