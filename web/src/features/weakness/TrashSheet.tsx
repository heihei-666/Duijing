import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/common/Button';
import { EmptyState } from '@/components/common/EmptyState';
import { Sheet } from '@/components/common/Sheet';
import { formatMonthDay } from '@/lib/date';
import {
  getArchive,
  restoreWeakness,
  type WeaknessCardData,
} from '@/features/weakness/api';

interface TrashSheetProps {
  open: boolean;
  onClose: () => void;
  /** 恢复成功后通知列表页刷新 */
  onRestored: (message: string) => void;
}

/**
 * 垃圾桶（方案 3.8）：暂存的弱点放 60 天，过期物理删除。
 * 这里只做弱点——优势 / 原则的恢复入口在资产页对应分区里。
 */
export function TrashSheet({ open, onClose, onRestored }: TrashSheetProps) {
  const [cards, setCards] = useState<WeaknessCardData[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setCards(null);
    try {
      const data = await getArchive();
      setCards(data.weaknesses);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '垃圾桶加载失败');
      setCards([]);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  async function handleRestore(card: WeaknessCardData) {
    setBusyId(card.id);
    setError(null);
    try {
      await restoreWeakness(card.id);
      setCards((current) => (current ? current.filter((item) => item.id !== card.id) : current));
      onRestored('已从垃圾桶恢复');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '恢复失败，请稍后再试');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Sheet open={open} title="垃圾桶" onClose={onClose}>
      <div className="max-h-[58vh] space-y-3 overflow-y-auto pb-4">
        <p className="text-xs text-tertiary">暂存的弱点保留 60 天，到期自动删除。</p>

        {cards === null ? (
          <p className="py-4 text-center text-[13px] text-tertiary">正在读取…</p>
        ) : cards.length === 0 ? (
          <EmptyState title="垃圾桶是空的" />
        ) : (
          <ul className="space-y-2.5">
            {cards.map((card) => {
              const remaining = card.expires_in_days ?? card.days_until_delete ?? null;
              return (
                <li
                  key={card.id}
                  className="rounded-xl border border-light bg-elevated px-4 py-3 opacity-90"
                >
                  <p className="text-[15px] text-primary">{card.name}</p>
                  <p className="mt-1 text-[11px] text-tertiary">
                    {card.archived_at ? `${formatMonthDay(card.archived_at.slice(0, 10))} 移入 · ` : ''}
                    {typeof remaining === 'number' ? `还有 ${remaining} 天删除` : '保留 60 天'}
                  </p>
                  <Button
                    variant="outline"
                    className="mt-2"
                    loading={busyId === card.id}
                    disabled={busyId !== null}
                    onClick={() => void handleRestore(card)}
                  >
                    恢复
                  </Button>
                </li>
              );
            })}
          </ul>
        )}

        {error ? <p className="text-xs text-danger">{error}</p> : null}
      </div>
    </Sheet>
  );
}
