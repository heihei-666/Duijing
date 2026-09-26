import { useState } from 'react';

import { Button } from '@/components/common/Button';
import { cn } from '@/lib/cn';
import { ChevronDownIcon } from '@/features/weakness/icons';

/** 一条归档条目：优势的 name 或原则的 content + 它的状态说明 */
export interface ArchivedEntry {
  id: number;
  /** 正文（优势名 / 原则内容） */
  text: string;
  /** 状态说明，见 api.ts 的 ADVANTAGE_ARCHIVED_LABELS / PRINCIPLE_ARCHIVED_LABELS */
  statusLabel: string;
  /** 可选时间（已格式化，如 "9/26 14:30"） */
  time?: string | null;
}

interface ArchivedSectionProps {
  entries: ArchivedEntry[];
  /** 正在恢复的条目 id（用于 loading 态） */
  busyId: number | null;
  disabled?: boolean;
  /** 展开后没有条目时的一句话 */
  emptyHint: string;
  onRestore: (entry: ArchivedEntry) => void;
}

/**
 * 「已归档」折叠段（优势库 / 原则库共用，方案 3.8）。
 *
 * 归档的条目**不能混在正常列表里**——那会让用户以为它们还在生效。
 * 所以单独成段、默认收起，展开才看得到。
 *
 * 配色严格按配色方案七 / 八：
 *   归档优势 / 归档原则 = --bg-elevated 底 + --text-tertiary 字；
 *   恢复按钮只用 --primary，不加彩色图标、不加徽章。
 * 计数为 0 时不显示数字（和 SegmentedControl 的约定一致），但入口始终在，
 * 用户才知道「归档过的东西去哪了」。
 */
export function ArchivedSection({
  entries,
  busyId,
  disabled = false,
  emptyHint,
  onRestore,
}: ArchivedSectionProps) {
  const [open, setOpen] = useState(false);

  return (
    <section className="space-y-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex min-h-[44px] w-full items-center gap-1.5 text-[13px] text-secondary"
      >
        <ChevronDownIcon
          className={cn('shrink-0 text-tertiary transition-transform', open ? 'rotate-0' : '-rotate-90')}
        />
        已归档
        {entries.length > 0 ? (
          <span className="tabular-nums text-tertiary">{entries.length}</span>
        ) : null}
      </button>

      {open ? (
        entries.length === 0 ? (
          <p className="pb-1 text-xs text-tertiary">{emptyHint}</p>
        ) : (
          <ul className="space-y-2.5">
            {entries.map((entry) => (
              <li
                key={entry.id}
                className="flex items-center gap-2 rounded-xl bg-elevated px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] leading-snug text-tertiary">{entry.text}</p>
                  <p className="mt-0.5 text-[11px] text-tertiary">
                    {entry.statusLabel}
                    {entry.time ? ` · ${entry.time}` : ''}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="min-h-[44px] shrink-0 px-3 text-brand hover:bg-surface"
                  loading={busyId === entry.id}
                  disabled={disabled}
                  onClick={() => onRestore(entry)}
                >
                  恢复
                </Button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
}
