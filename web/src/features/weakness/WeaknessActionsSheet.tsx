import { useState } from 'react';

import { Button } from '@/components/common/Button';
import { Sheet } from '@/components/common/Sheet';
import {
  archiveWeakness,
  restoreWeakness,
  updateWeakness,
  WEAKNESS_STATUS_LABELS,
  type WeaknessCardData,
} from '@/features/weakness/api';

interface WeaknessActionsSheetProps {
  card: WeaknessCardData;
  onClose: () => void;
  /** 操作成功后由列表页刷新并给一句反馈 */
  onDone: (message: string) => void;
  onOpenDetail: (card: WeaknessCardData) => void;
}

interface ActionSpec {
  key: string;
  label: string;
  hint: string;
  run: () => Promise<string>;
}

/**
 * 便签操作面板（移动端长按、桌面端点「···」打开）。
 * 只做四区内的状态流转：观察中 ↔ 改善中、移入暂存、从暂存恢复。
 * 「archived」不允许走 PATCH（服务端会拒绝），必须走归档/恢复接口，保证 60 天倒计时与流水正确。
 */
export function WeaknessActionsSheet({
  card,
  onClose,
  onDone,
  onOpenDetail,
}: WeaknessActionsSheetProps) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const actions: ActionSpec[] = [];

  if (card.status === 'ai_candidate') {
    actions.push({
      key: 'observe',
      label: '加入观察中',
      hint: '接受这条 AI 观察，开始留意它',
      run: async () => {
        await updateWeakness(card.id, { status: 'observing' });
        return '已加入观察中';
      },
    });
  }

  if (card.status === 'observing') {
    actions.push({
      key: 'improve',
      label: '开始改善',
      hint: '进入改善中，接着给它建一条回环',
      run: async () => {
        await updateWeakness(card.id, { status: 'improving' });
        return '已移到改善中';
      },
    });
  }

  if (card.status === 'improving') {
    actions.push({
      key: 'observe',
      label: '退回观察中',
      hint: '暂时不练了，但还留着',
      run: async () => {
        await updateWeakness(card.id, { status: 'observing' });
        return '已退回观察中';
      },
    });
  }

  if (card.status === 'archived') {
    actions.push({
      key: 'restore',
      label: '恢复',
      hint: '回到观察中，触发计数保留',
      run: async () => {
        await restoreWeakness(card.id);
        return '已恢复';
      },
    });
  } else {
    actions.push({
      key: 'archive',
      label: '移入暂存',
      hint: '放 60 天，期间随时可以恢复',
      run: async () => {
        const result = await archiveWeakness(card.id);
        return result.note ?? '已移入暂存';
      },
    });
  }

  async function runAction(action: ActionSpec) {
    setBusyKey(action.key);
    setError(null);
    try {
      const message = await action.run();
      onDone(message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败，请稍后再试');
      setBusyKey(null);
    }
  }

  return (
    <Sheet open title={card.name} onClose={onClose}>
      <div className="space-y-3 pb-3">
        <p className="text-xs text-tertiary">当前：{WEAKNESS_STATUS_LABELS[card.status]}</p>

        <ul className="space-y-2">
          {actions.map((action) => (
            <li key={action.key}>
              <button
                type="button"
                disabled={busyKey !== null}
                onClick={() => void runAction(action)}
                className="w-full rounded-xl border border-light bg-surface px-4 py-3 text-left transition-colors hover:bg-elevated disabled:opacity-60"
              >
                <span className="flex items-center gap-2 text-[15px] text-primary">
                  {action.label}
                  {busyKey === action.key ? (
                    <span
                      aria-hidden
                      className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
                    />
                  ) : null}
                </span>
                <span className="mt-0.5 block text-xs text-tertiary">{action.hint}</span>
              </button>
            </li>
          ))}
        </ul>

        <Button variant="ghost" fullWidth onClick={() => onOpenDetail(card)}>
          查看详情
        </Button>

        {error ? <p className="text-xs text-danger">{error}</p> : null}
      </div>
    </Sheet>
  );
}
