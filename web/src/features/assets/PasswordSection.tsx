import { useState } from 'react';

import { apiRequest } from '@/api/client';
import { Button } from '@/components/common/Button';
import { Sheet } from '@/components/common/Sheet';

/**
 * 修改密码（方案 6.10）。
 *
 * 【为什么是「一行 + 弹层」而不是常驻表单】
 *
 * 第一版我把它做成了三个常驻输入框。那是错的，三条理由：
 *
 * 1. **形态不一致**。设置页从头到尾是「标签 → 说明 → 按钮」的行形态
 *    （导出、注销账号都是）。常驻表单是唯一的例外，把「设置页」变成了「表单页」。
 *
 * 2. **信息密度**。三个输入框常驻约占 200px 纵向空间，而这个功能
 *    用户一年可能只用一次。设置页应该让人一眼扫完所有选项，
 *    而不是被一个极少用的表单占掉小半屏。
 *
 * 3. **密码框不该长期停在屏幕上**。停留越久，被旁边人扫到、
 *    被录屏带进去的机会越多。**这是一条具体的安全论据，不只是审美。**
 *
 * 【为什么用弹层而不是像注销那样内联展开】
 *
 * 移动端键盘弹起时，内联展开的表单会被键盘遮住，用户得先滚动才能看到
 * 正在输入的框；弹层会随键盘上移，始终可见。
 *
 * 而且这符合应用既有的模式：**有始有终的表单任务用 Sheet**
 * （创建回环、邀请好友、提醒设置都是）。注销账号用内联是因为它是
 * 「危险动作 + 解释性文案」，需要停留、需要二次确认，性质不同。
 */
export function PasswordSection() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reset = () => {
    setCurrent('');
    setNext('');
    setConfirm('');
    setError(null);
  };

  const handleOpen = () => {
    reset();
    setOpen(true);
  };

  const handleClose = () => {
    setOpen(false);
    // 关闭时清空：密码不该在组件状态里多留一秒
    reset();
  };

  const submit = async () => {
    setError(null);

    // 本地先挡一道，省掉一次注定失败的往返；服务端仍会独立校验
    if (current === '') return setError('请输入当前密码');
    if (next !== confirm) return setError('两次输入的新密码不一致');
    if (next === current) return setError('新密码不能与当前密码相同');

    setBusy(true);
    try {
      await apiRequest<{ ok: boolean }>('/account/password', {
        method: 'PATCH',
        body: { current_password: current, new_password: next },
      });
      handleClose();
      setNotice('密码已修改，下次登录请用新密码。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '修改失败，请重试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl bg-surface px-4 py-4">
      <h3 className="text-[13px] text-secondary">账号安全</h3>

      <div className="mt-4 border-t border-light pt-3">
        <p className="text-[13px] text-secondary">修改密码</p>
        <p className="mt-1 text-xs leading-relaxed text-tertiary">
          需要先验证当前密码。改完之后，其他设备上已登录的会话不会立即失效，
          会在 7 天后自然过期。
        </p>

        {notice ? (
          <p className="mt-2 text-xs leading-relaxed text-success">{notice}</p>
        ) : null}

        <Button variant="outline" className="mt-2" onClick={handleOpen}>
          修改密码
        </Button>
      </div>

      <Sheet
        open={open}
        title="修改密码"
        onClose={handleClose}
        footer={
          <Button fullWidth loading={busy} disabled={busy} onClick={() => void submit()}>
            确认修改
          </Button>
        }
      >
        <div className="space-y-3">
          <label className="block">
            <span className="text-xs text-secondary">当前密码</span>
            <input
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(event) => setCurrent(event.target.value)}
              className="mt-1 w-full rounded-lg bg-inset px-3 py-2 text-[14px] text-primary"
            />
          </label>

          <label className="block">
            <span className="text-xs text-secondary">新密码（至少 8 位，不能是纯数字）</span>
            <input
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(event) => setNext(event.target.value)}
              className="mt-1 w-full rounded-lg bg-inset px-3 py-2 text-[14px] text-primary"
            />
          </label>

          <label className="block">
            <span className="text-xs text-secondary">确认新密码</span>
            <input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              className="mt-1 w-full rounded-lg bg-inset px-3 py-2 text-[14px] text-primary"
            />
          </label>

          {error ? (
            <p className="rounded-lg bg-elevated px-3 py-2 text-[13px] text-danger">{error}</p>
          ) : null}
        </div>
      </Sheet>
    </section>
  );
}
