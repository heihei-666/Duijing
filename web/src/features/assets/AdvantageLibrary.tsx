import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/common/Button';
import { EmptyState } from '@/components/common/EmptyState';
import {
  confirmAdvantage,
  listAdvantages,
  removeAdvantage,
  type AdvantageData,
} from '@/features/assets/api';

/**
 * 优势库（方案 3.5 / 配色方案 七）。
 * 待确认：--sticky-ai-bg 底 + --sticky-ai-text 字（AI 给的内容永远冷色）；
 * 已确认：白底暖黑字。
 * 确认按钮用 --success，移除是 --text-tertiary 的文字按钮；不用金色、不用奖杯。
 */
export function AdvantageLibrary() {
  const [pending, setPending] = useState<AdvantageData[] | null>(null);
  const [confirmed, setConfirmed] = useState<AdvantageData[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await listAdvantages(['pending', 'confirmed']);
      setPending(data.advantages.filter((item) => item.status === 'pending'));
      setConfirmed(data.advantages.filter((item) => item.status === 'confirmed'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '优势库加载失败');
      setPending([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleConfirm(item: AdvantageData) {
    setBusyId(item.id);
    setError(null);
    try {
      await confirmAdvantage(item.id);
      setNotice('已确认，之后建回环时会推荐它');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败，请稍后再试');
    } finally {
      setBusyId(null);
    }
  }

  async function handleRemove(item: AdvantageData) {
    setBusyId(item.id);
    setError(null);
    try {
      const result = await removeAdvantage(item.id);
      setNotice(result.note ?? '已移除');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败，请稍后再试');
    } finally {
      setBusyId(null);
    }
  }

  if (pending === null) return <p className="py-4 text-center text-[13px] text-tertiary">正在读取…</p>;

  return (
    <div className="space-y-4">
      <p className="text-xs leading-relaxed text-tertiary">
        AI 观察到就自动入库，不用你动手写。只有确认过的优势，才会在建回环时被推荐。
      </p>

      {notice ? <p className="text-xs text-tertiary">{notice}</p> : null}
      {error ? <p className="text-xs text-danger">{error}</p> : null}

      <section className="space-y-2">
        <h3 className="text-[13px] text-secondary">
          待确认 <span className="text-tertiary">{pending.length}</span>
        </h3>

        {pending.length === 0 ? (
          <EmptyState title="没有待确认的优势" hint="辩一轮，AI 会留意你做得好在哪。" />
        ) : (
          <ul className="space-y-2.5">
            {pending.map((item) => (
              <li key={item.id} className="rounded-xl bg-sticky-ai px-4 py-3 text-sticky-ai">
                <p className="text-[15px] leading-snug">{item.name}</p>
                <div className="mt-2 flex items-center gap-2">
                  <Button
                    variant="outline"
                    className="border-success text-success hover:bg-success-light"
                    loading={busyId === item.id}
                    disabled={busyId !== null}
                    onClick={() => void handleConfirm(item)}
                  >
                    确认
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-tertiary hover:bg-surface"
                    disabled={busyId !== null}
                    onClick={() => void handleRemove(item)}
                  >
                    移除
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-[13px] text-secondary">
          已确认 <span className="text-tertiary">{confirmed.length}</span>
        </h3>

        {confirmed.length === 0 ? (
          <EmptyState title="还没有确认过的优势" />
        ) : (
          <ul className="space-y-2.5">
            {confirmed.map((item) => (
              <li
                key={item.id}
                className="flex items-center gap-2 rounded-xl border border-light bg-surface px-4 py-3"
              >
                <p className="min-w-0 flex-1 text-[15px] leading-snug text-primary">{item.name}</p>
                <Button
                  size="sm"
                  variant="ghost"
                  className="shrink-0 text-tertiary"
                  disabled={busyId !== null}
                  onClick={() => void handleRemove(item)}
                >
                  移除
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
