import { useState } from 'react';

import type { LoopLogResult } from '@/api/types';
import { Button } from '@/components/common/Button';
import { Sheet } from '@/components/common/Sheet';
import { cn } from '@/lib/cn';
import { ratePercent, rateText } from '@/lib/rateColor';
import {
  addLoopLog,
  RESULT_LABELS,
  type LoopData,
  type LoopLogCreateResponse,
} from '@/features/weakness/api';
import { TextAreaField } from '@/features/weakness/TextAreaField';

interface RecordLogSheetProps {
  loop: LoopData;
  onClose: () => void;
  /** 记录成功后通知详情页静默刷新（回环可能已进入待修订） */
  onRecorded: () => void;
  /** 用户在降级提示里显式点了「确认移入暂存」——只有这个动作会调归档接口 */
  onConfirmDowngrade: () => Promise<void>;
}

const RESULTS: LoopLogResult[] = ['hold', 'break', 'not_triggered'];

/** 三个结果按钮的语义色：撑住=success、破功=danger、未触发=中性 */
const RESULT_BUTTON_CLASS: Record<LoopLogResult, string> = {
  hold: 'border-success text-success hover:bg-success-light',
  break: 'border-danger text-danger hover:bg-danger-light',
  not_triggered: 'border-light text-secondary hover:bg-elevated',
};

/**
 * 记录一次演练（POST /api/loops/{id}/logs）——系统里唯一能改变经验数据的入口。
 * 三个按钮：撑住 / 破功 / 未触发。
 *
 * 两条硬规则（方案第九章 7、8 条）在这里落地：
 *   · 破功后服务端返回 alternative_action → 用 --info-light 底突出显示，并提示回环已进入待修订
 *   · 撑住率达标返回 suggest_downgrade → 用 --warning-light 底提示，**只有用户点确认才归档**
 */
export function RecordLogSheet({
  loop,
  onClose,
  onRecorded,
  onConfirmDowngrade,
}: RecordLogSheetProps) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<LoopLogResult | null>(null);
  const [response, setResponse] = useState<LoopLogCreateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downgradeBusy, setDowngradeBusy] = useState(false);
  /** null = 还没选；archived = 用户确认降级；kept = 用户选择先留着 */
  const [downgradeChoice, setDowngradeChoice] = useState<'archived' | 'kept' | null>(null);

  async function record(result: LoopLogResult) {
    setBusy(result);
    setError(null);
    try {
      const data = await addLoopLog(loop.id, { result, note: note.trim() });
      setResponse(data);
      onRecorded();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '记录失败，请稍后再试');
    } finally {
      setBusy(null);
    }
  }

  async function confirmDowngrade() {
    setDowngradeBusy(true);
    setError(null);
    try {
      await onConfirmDowngrade();
      setDowngradeChoice('archived');
      onRecorded();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败，请稍后再试');
    } finally {
      setDowngradeBusy(false);
    }
  }

  return (
    <Sheet open title="记录一次演练" onClose={onClose}>
      <div className="max-h-[58vh] space-y-4 overflow-y-auto pb-4">
        <p className="text-[13px] leading-relaxed text-secondary">{loop.trigger_scene}</p>

        {response === null ? (
          <>
            <TextAreaField
              label="一行复盘（选填）"
              placeholder="这次是怎么应对的？"
              rows={2}
              maxLength={2000}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />

            <div className="space-y-2">
              <p className="text-[13px] text-secondary">这次的结果</p>
              <div className="flex gap-2">
                {RESULTS.map((result) => (
                  <Button
                    key={result}
                    variant="outline"
                    className={cn('flex-1', RESULT_BUTTON_CLASS[result])}
                    loading={busy === result}
                    disabled={busy !== null}
                    onClick={() => void record(result)}
                  >
                    {RESULT_LABELS[result]}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-tertiary">撑住率只统计撑住和破功，「未触发」不进分母。</p>
            </div>
          </>
        ) : (
          <div className="space-y-3">
            <p className="text-[15px] text-primary">
              已记录：
              <span
                className={cn(
                  'ml-1',
                  response.log.result === 'hold'
                    ? 'text-success'
                    : response.log.result === 'break'
                      ? 'text-danger'
                      : 'text-secondary',
                )}
              >
                {RESULT_LABELS[response.log.result]}
              </span>
              <span className="ml-3 text-[13px] text-tertiary">
                近 30 天撑住率 {rateText(response.hold_rate_30d)}
              </span>
            </p>

            {/* 记的是「未触发」时撑住率仍是 --（不进分母），这里说一句，避免被当成 0% */}
            {ratePercent(response.hold_rate_30d) === null ? (
              <p className="text-xs text-tertiary">这次没有触发，撑住率还是 --，先攒着。</p>
            ) : null}

            {response.alternative_action ? (
              <div className="rounded-xl bg-info-light px-4 py-3">
                <p className="text-xs text-info">AI 的替代动作</p>
                <p className="mt-1 text-[14px] leading-relaxed text-primary">
                  {response.alternative_action}
                </p>
                {response.needs_revision ? (
                  <p className="mt-1.5 text-xs text-tertiary">
                    这条回环已进入「待修订」，改好预案再启用。
                  </p>
                ) : null}
              </div>
            ) : null}

            {response.suggest_downgrade && downgradeChoice === null ? (
              <div className="rounded-xl bg-warning-light px-4 py-3">
                <p className="text-[13px] leading-relaxed text-primary">
                  {response.reason ?? '近 30 天撑住率已达降级标准。'}
                </p>
                <p className="mt-1 text-xs text-tertiary">
                  {response.hint ?? '确认后移入暂存，随时可以在垃圾桶恢复。'}
                </p>
                <div className="mt-2.5 flex gap-2">
                  <Button
                    variant="outline"
                    loading={downgradeBusy}
                    disabled={downgradeBusy}
                    onClick={() => void confirmDowngrade()}
                  >
                    确认移入暂存
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={downgradeBusy}
                    onClick={() => setDowngradeChoice('kept')}
                  >
                    先留着
                  </Button>
                </div>
              </div>
            ) : null}

            {downgradeChoice === 'kept' ? (
              <p className="text-xs text-tertiary">好，这条继续留着，撑住率会一直记着。</p>
            ) : null}
            {downgradeChoice === 'archived' ? (
              <p className="text-xs text-tertiary">已移入暂存，60 天内可以随时恢复。</p>
            ) : null}

            <Button fullWidth variant="outline" onClick={onClose}>
              完成
            </Button>
          </div>
        )}

        {error ? <p className="text-xs text-danger">{error}</p> : null}
      </div>
    </Sheet>
  );
}
