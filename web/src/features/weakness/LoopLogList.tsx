import { useCallback, useEffect, useState } from 'react';

import { cn } from '@/lib/cn';
import type { LoopLogResult } from '@/api/types';
import { EmptyState } from '@/components/common/EmptyState';
import { formatMonthDay } from '@/lib/date';
import { listLoopLogs, RESULT_LABELS, type LoopLogData } from '@/features/weakness/api';

/** 演练结果配色：撑住=success、破功=danger、未触发=中性（配色方案 二·功能色） */
export const RESULT_CLASS: Record<LoopLogResult, string> = {
  hold: 'text-success',
  break: 'text-danger',
  not_triggered: 'text-tertiary',
};

interface LoopLogListProps {
  loopId: number;
  /** 父级记录成功后 +1，触发重新拉取 */
  reloadKey?: number;
}

/** 演练日志（GET /api/loops/{id}/logs）。展开时才请求，避免详情页一次拉一堆。 */
export function LoopLogList({ loopId, reloadKey = 0 }: LoopLogListProps) {
  const [logs, setLogs] = useState<LoopLogData[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await listLoopLogs(loopId);
      setLogs(data.logs);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '日志加载失败');
      setLogs([]);
    }
  }, [loopId]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  if (error) return <p className="py-2 text-xs text-danger">{error}</p>;
  if (logs === null) return <p className="py-2 text-xs text-tertiary">正在读取…</p>;
  if (logs.length === 0) return <EmptyState title="还没有演练记录" hint="练过一次就记一笔。" />;

  return (
    <ul className="divide-y divide-light">
      {logs.map((log) => (
        <li key={log.id} className="flex gap-3 py-2">
          <span className="w-12 shrink-0 text-[11px] leading-5 text-tertiary">
            {log.date ? formatMonthDay(log.date) : ''}
          </span>
          <span className={cn('w-12 shrink-0 text-[12px] leading-5', RESULT_CLASS[log.result])}>
            {RESULT_LABELS[log.result]}
          </span>
          <span className="min-w-0 flex-1 text-[12px] leading-5 text-secondary">
            {log.note || <span className="text-tertiary">—</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}
