import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/common/Button';
import { Sheet } from '@/components/common/Sheet';
import { cn } from '@/lib/cn';
import {
  listAllLoops,
  updatePrinciple,
  type LoopOption,
  type PrincipleData,
} from '@/features/assets/api';

interface LoopPickerSheetProps {
  principle: PrincipleData;
  onClose: () => void;
  onSaved: (message: string) => void;
}

/**
 * 关联回环（PATCH /api/principles/{id} 的 linked_loop_ids）。
 * 一条原则可关联多个回环（方案 3.6）。
 * 契约没有全局回环列表接口，这里按需拉取（见 assets/api.ts 的 listAllLoops）。
 */
export function LoopPickerSheet({ principle, onClose, onSaved }: LoopPickerSheetProps) {
  const [loops, setLoops] = useState<LoopOption[] | null>(null);
  const [selected, setSelected] = useState<number[]>(principle.linked_loop_ids);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    setLoops(null);
    try {
      setLoops(await listAllLoops());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '回环列表加载失败');
      setLoops([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function toggle(id: number) {
    setSelected((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await updatePrinciple(principle.id, { linked_loop_ids: selected });
      onSaved(selected.length > 0 ? `已关联 ${selected.length} 条回环` : '已取消全部关联');
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败，请稍后再试');
      setSaving(false);
    }
  }

  return (
    <Sheet
      open
      title="关联回环"
      onClose={onClose}
      footer={
        <Button fullWidth loading={saving} disabled={saving} onClick={() => void save()}>
          保存
        </Button>
      }
    >
      <div className="max-h-[52vh] space-y-2 overflow-y-auto pb-2">
        {loops === null ? (
          <p className="py-4 text-center text-[13px] text-tertiary">正在读取回环…</p>
        ) : loops.length === 0 ? (
          <p className="py-4 text-center text-[13px] text-secondary">
            还没有可关联的回环，先去弱点里建一条。
          </p>
        ) : (
          <ul className="space-y-2">
            {loops.map((loop) => {
              const active = selected.includes(loop.id);
              return (
                <li key={loop.id}>
                  <button
                    type="button"
                    aria-pressed={active}
                    onClick={() => toggle(loop.id)}
                    className={cn(
                      'flex min-h-[44px] w-full items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors',
                      active ? 'border-primary bg-primary-light' : 'border-light bg-surface hover:bg-elevated',
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px]',
                        active ? 'border-primary bg-primary text-on-brand' : 'border-strong',
                      )}
                    >
                      {active ? '✓' : ''}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] text-primary">
                        {loop.triggerScene}
                      </span>
                      <span className="block truncate text-[11px] text-tertiary">
                        {loop.weaknessName}
                      </span>
                    </span>
                  </button>
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
