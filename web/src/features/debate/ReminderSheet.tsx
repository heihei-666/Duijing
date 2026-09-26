/**
 * 对镜 · 「提醒我」面板（辩论房）
 *
 * 方案 3.9：默认不推送，唯一例外是用户主动预约的辩论提醒。
 * 所以这个面板的设计目标只有一个——让「约没约上、到点收不收得到」两件事
 * 都毫无歧义：
 *
 *   · 可选时间用后端给的 presets，不在前端拼日期时间（少一次弄错时区的机会）
 *   · `will_notify === false` 时**不关闭面板**，直接把「还没开启通知」摆出来，
 *     并给一个当场就能开的按钮。绝不出现「以为约好了，到点什么都没发生」
 */

import { Button } from '@/components/common/Button';
import { Sheet } from '@/components/common/Sheet';
import type { ReminderPreset } from '@/features/push/api';

import type { DebateReminder } from './api';

/** 推送相关的状态与动作，由页面从 usePushNotifications 里取好传进来 */
export interface ReminderPushState {
  /** 浏览器环境支持推送 */
  supported: boolean;
  /** 环境不支持时给用户的一句说明（例如 iOS 需要先添加到主屏幕） */
  hint: string | null;
  /** 本机已在服务端登记 */
  subscribed: boolean;
  /** 正在开启 */
  enabling: boolean;
  error: string | null;
  notice: string | null;
  onEnable: () => void;
  /** 去设置页看完整说明 */
  onOpenSettings: () => void;
}

interface ReminderSheetProps {
  open: boolean;
  presets: ReminderPreset[];
  /** 正在读取 presets */
  loading: boolean;
  /** 当前已有的预约 */
  reminder: DebateReminder | null;
  /** 正在提交的 preset key */
  savingPreset: string | null;
  cancelling: boolean;
  error: string | null;
  /** 该账号已登记的推送设备数 */
  deviceCount: number;
  push: ReminderPushState;
  onPick: (preset: string) => void;
  onCancelReminder: () => void;
  onClose: () => void;
}

export function ReminderSheet({
  open,
  presets,
  loading,
  reminder,
  savingPreset,
  cancelling,
  error,
  deviceCount,
  push,
  onPick,
  onCancelReminder,
  onClose,
}: ReminderSheetProps) {
  const busy = savingPreset !== null || cancelling;
  /** 已经约了，但这台设备（或任何设备）收不到 —— 必须说出来 */
  const willNotArrive = reminder !== null && deviceCount === 0 && !push.subscribed;

  return (
    <Sheet open={open} title="到点提醒我" onClose={onClose}>
      <div className="space-y-4">
        <p className="text-[13px] leading-relaxed text-secondary">
          选一个时间，到点我用一条通知来叫你。就这一次，不会有别的推送。
        </p>

        {reminder ? (
          <div className="rounded-xl border border-light bg-elevated px-3.5 py-3">
            <p className="text-xs text-tertiary">已预约</p>
            <p className="mt-1 text-[15px] text-primary">{reminder.remind_at_local}</p>
            <button
              type="button"
              disabled={busy}
              onClick={onCancelReminder}
              className="mt-2 flex min-h-[44px] items-center text-[13px] text-danger hover:opacity-80 disabled:opacity-50"
            >
              {cancelling ? '正在取消…' : '取消这次提醒'}
            </button>
          </div>
        ) : null}

        {willNotArrive ? (
          <div className="rounded-xl border border-light bg-surface px-3.5 py-3">
            <p className="text-[13px] leading-relaxed text-warning">
              已记下，但还没开启通知——到点你收不到。
            </p>
            {push.supported ? (
              <Button
                variant="outline"
                fullWidth
                className="mt-2.5"
                loading={push.enabling}
                disabled={push.enabling}
                onClick={push.onEnable}
              >
                开启通知
              </Button>
            ) : (
              <p className="mt-1.5 text-xs leading-relaxed text-tertiary">
                {push.hint ?? '当前环境不支持通知。'}
              </p>
            )}
            {push.error ? (
              <p className="mt-2 text-xs leading-relaxed text-danger">{push.error}</p>
            ) : null}
            {push.notice ? (
              <p className="mt-2 text-xs leading-relaxed text-secondary">{push.notice}</p>
            ) : null}
            <button
              type="button"
              onClick={push.onOpenSettings}
              className="mt-1 flex min-h-[44px] items-center text-xs text-tertiary hover:text-secondary"
            >
              或者到「资产 → 设置 → 通知」里慢慢弄
            </button>
          </div>
        ) : null}

        <div className="space-y-2">
          {presets.length === 0 ? (
            <p className="text-[13px] text-tertiary">
              {loading ? '正在读取可选时间…' : '没有拿到可选时间，请稍后再试。'}
            </p>
          ) : (
            presets.map((preset) => (
              <button
                key={preset.key}
                type="button"
                disabled={busy}
                onClick={() => onPick(preset.key)}
                className="flex min-h-[44px] w-full items-center justify-between rounded-xl border border-light bg-surface px-4 text-left text-[15px] text-primary transition-colors hover:bg-elevated disabled:opacity-50"
              >
                <span>{preset.label}</span>
                {savingPreset === preset.key ? (
                  <span className="text-xs text-tertiary">设置中…</span>
                ) : null}
              </button>
            ))
          )}
        </div>

        {error ? <p className="text-xs leading-relaxed text-danger">{error}</p> : null}

        <p className="text-xs leading-relaxed text-tertiary">
          提醒只发这一次。到点之后不会再催你，也不会用来推别的东西。
        </p>
      </div>
    </Sheet>
  );
}
