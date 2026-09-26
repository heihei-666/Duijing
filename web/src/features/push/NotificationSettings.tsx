/**
 * 对镜 · 设置页「通知」块
 *
 * 产品约束（方案 3.9）：默认不推送，唯一例外是用户主动预约的辩论提醒。
 * 因此这一块刻意做得很克制——
 *   · 没有彩色图标、没有徽章、没有「立即开启」的诱导
 *   · 不自动申请权限，只有用户点开关才 requestPermission
 *   · 状态如实展示：没开就说没开，开了会说明它只用来干一件事
 *
 * 之所以给「发一条测试通知」，是因为 Web Push 的失败几乎都是静默的：
 * 用户以为开了、到点却没响。给一个能当场验证的按钮，比让他猜要好。
 */

import { Button } from '@/components/common/Button';
import { cn } from '@/lib/cn';

import { usePushNotifications } from './usePushNotifications';

export function NotificationSettings() {
  const push = usePushNotifications();
  const { environment, loading, busy, error, notice, permission, subscribed, localSubscribed, deviceCount, canEnable } =
    push;

  const toggling = busy === 'enable' || busy === 'disable';
  const canToggle = busy === null && (subscribed || canEnable);

  async function handleToggle() {
    if (!canToggle) return;
    if (subscribed) {
      await push.disable();
    } else {
      await push.enable();
    }
  }

  function statusText(): string {
    if (loading) return '正在读取…';
    // 环境不支持时先解释清楚原因（iOS 需要先添加到主屏幕），而不是只报错
    if (!environment.supported) return environment.hint ?? '当前环境不支持通知。';
    if (busy === 'enable') return '正在开启…';
    if (busy === 'disable') return '正在关闭…';
    if (!canEnable) return '服务端还没有配置推送，暂时无法开启。';
    if (subscribed) {
      return deviceCount > 1 ? `已开启 · 共 ${deviceCount} 台设备` : '已开启 · 这台设备会收到提醒';
    }
    if (permission === 'denied') return '通知权限被浏览器拒绝了，需要到浏览器（或系统）设置里重新允许。';
    if (localSubscribed) return '浏览器已允许通知，但还没登记到你的账号——打开上面的开关即可。';
    return deviceCount > 0 ? `未开启 · 另有 ${deviceCount} 台设备已开启` : '未开启 · 这台设备不会收到提醒';
  }

  return (
    <section className="rounded-2xl border border-light bg-surface px-4 py-4 shadow-card">
      <h3 className="text-[13px] text-secondary">通知</h3>

      {/* 整行都是开关的触控目标（48px > 44px），视觉上只有一个朴素的滑块 */}
      <button
        type="button"
        role="switch"
        aria-checked={subscribed}
        aria-label="到点提醒我"
        disabled={!canToggle}
        onClick={() => void handleToggle()}
        className={cn(
          'mt-1 flex min-h-[48px] w-full items-center justify-between gap-3 text-left',
          canToggle ? 'cursor-pointer' : 'cursor-not-allowed',
        )}
      >
        <span className={cn('text-[15px]', canEnable || subscribed ? 'text-primary' : 'text-disabled')}>
          到点提醒我
        </span>
        <span
          aria-hidden
          className={cn(
            'relative h-6 w-11 shrink-0 rounded-full transition-colors',
            subscribed ? 'bg-primary' : 'bg-inset',
            toggling && 'opacity-60',
          )}
        >
          <span
            className={cn(
              'absolute top-0.5 h-5 w-5 rounded-full bg-surface shadow-card transition-transform',
              subscribed ? 'translate-x-[22px]' : 'translate-x-0.5',
            )}
          />
        </span>
      </button>

      <p className="text-xs leading-relaxed text-tertiary">{statusText()}</p>

      {/* 这句话是这一块存在的理由，不要删 */}
      <p className="mt-2 text-xs leading-relaxed text-tertiary">
        只在你主动预约的时间提醒你，其他时候不会打扰。
      </p>

      {error ? <p className="mt-2 text-xs leading-relaxed text-danger">{error}</p> : null}
      {notice ? <p className="mt-2 text-xs leading-relaxed text-secondary">{notice}</p> : null}

      <div className="mt-3">
        <Button
          variant="outline"
          fullWidth
          loading={busy === 'test'}
          disabled={!canEnable || busy !== null}
          onClick={() => void push.sendTest()}
        >
          发一条测试通知
        </Button>
        <p className="mt-2 text-xs leading-relaxed text-tertiary">
          不确定通没通的时候点一下，通知栏里出现就是通了。
        </p>
      </div>
    </section>
  );
}
