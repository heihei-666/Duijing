import { useState } from 'react';

import type { LoopStatus } from '@/api/types';
import { cn } from '@/lib/cn';
import { Button } from '@/components/common/Button';
import { ChevronDownIcon, LoopIcon } from '@/features/weakness/icons';
import { LoopLogList } from '@/features/weakness/LoopLogList';
import { RateMeter } from '@/features/weakness/RateMeter';
import { LOOP_STATUS_LABELS, updateLoop, type LoopData } from '@/features/weakness/api';

interface LoopCardProps {
  loop: LoopData;
  /** 首页 ?loop=<id> 跳进来时高亮 */
  highlighted?: boolean;
  /** 记录一次演练之后 +1，让日志列表重新拉取 */
  logsReloadKey?: number;
  onChanged: (message: string) => void;
  onRecord: (loop: LoopData) => void;
}

/** 回环状态徽章：启用中给一点绿，待修订给一点琥珀，其余中性 */
const STATUS_CLASS: Record<LoopStatus, string> = {
  draft: 'bg-elevated text-secondary',
  active: 'bg-success-light text-success',
  needs_revision: 'bg-warning-light text-warning',
  paused: 'bg-elevated text-tertiary',
  archived: 'bg-elevated text-tertiary',
};

/**
 * 一条回环（方案 3.3）：触发场景 / 身体信号 / 应对预案 + 撑住率 + 演练日志。
 * 回环是用户自己的东西，用白底实线卡片，不套便签配色。
 */
export function LoopCard({
  loop,
  highlighted = false,
  logsReloadKey = 0,
  onChanged,
  onRecord,
}: LoopCardProps) {
  const [logsOpen, setLogsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nextStatus: LoopStatus = loop.status === 'active' ? 'paused' : 'active';
  const toggleLabel = loop.status === 'active' ? '暂停' : '启用';

  async function toggleStatus() {
    setBusy(true);
    setError(null);
    try {
      await updateLoop(loop.id, { status: nextStatus });
      onChanged(nextStatus === 'active' ? '回环已启用' : '回环已暂停');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败，请稍后再试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <article
      className={cn(
        'rounded-2xl border border-light bg-surface px-4 py-3.5 shadow-card',
        highlighted && 'ring-2 ring-primary',
      )}
    >
      <div className="flex items-start gap-2">
        <LoopIcon width={16} height={16} className="mt-0.5 shrink-0 text-brand" />
        <h3 className="min-w-0 flex-1 text-[15px] leading-snug text-primary">
          {loop.trigger_scene}
        </h3>
        <span
          className={cn(
            'shrink-0 rounded-md px-1.5 py-0.5 text-[11px] leading-4',
            STATUS_CLASS[loop.status],
          )}
        >
          {LOOP_STATUS_LABELS[loop.status]}
        </span>
      </div>

      <dl className="mt-2.5 space-y-1.5 text-[13px] leading-relaxed">
        {loop.body_signal ? (
          <div className="flex gap-2">
            <dt className="w-14 shrink-0 text-tertiary">身体信号</dt>
            <dd className="min-w-0 flex-1 text-secondary">{loop.body_signal}</dd>
          </div>
        ) : null}
        {loop.action_plan ? (
          <div className="flex gap-2">
            <dt className="w-14 shrink-0 text-tertiary">应对预案</dt>
            <dd className="min-w-0 flex-1 text-primary">{loop.action_plan}</dd>
          </div>
        ) : null}
      </dl>

      {loop.linked_advantages.length > 0 || loop.linked_principles.length > 0 ? (
        <div className="mt-2.5 space-y-1">
          {loop.linked_advantages.length > 0 ? (
            <p className="text-[11px] text-tertiary">
              用到的优势：{loop.linked_advantages.map((item) => item.name).join('、')}
            </p>
          ) : null}
          {loop.linked_principles.length > 0 ? (
            <p className="text-[11px] text-tertiary">
              引用的原则：{loop.linked_principles.map((item) => item.content).join('、')}
            </p>
          ) : null}
        </div>
      ) : null}

      <RateMeter
        className="mt-3"
        rate={loop.hold_rate_30d}
        holdCount={loop.hold_count_30d}
        triggerCount={loop.trigger_count_30d}
      />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="outline" loading={busy} disabled={busy} onClick={() => void toggleStatus()}>
          {toggleLabel}
        </Button>
        <Button variant="subtle" onClick={() => onRecord(loop)}>
          记录一次
        </Button>
        <button
          type="button"
          onClick={() => setLogsOpen((value) => !value)}
          aria-expanded={logsOpen}
          className="ml-auto flex h-11 items-center gap-1 rounded-lg px-2 text-[13px] text-tertiary hover:bg-elevated"
        >
          演练日志
          <ChevronDownIcon className={cn('transition-transform', logsOpen ? 'rotate-0' : '-rotate-90')} />
        </button>
      </div>

      {logsOpen ? (
        <div className="mt-1 border-t border-light pt-1">
          <LoopLogList loopId={loop.id} reloadKey={logsReloadKey} />
        </div>
      ) : null}

      {error ? <p className="mt-2 text-xs text-danger">{error}</p> : null}
    </article>
  );
}
