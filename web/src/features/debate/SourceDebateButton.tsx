import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import type { DebateRoom } from '@/api/types';
import { Button, type ButtonVariant } from '@/components/common/Button';
import { cn } from '@/lib/cn';

import { createDebateFromSource, payloadFromSource, type DebateSourceRef } from './api';

const DEFAULT_LABEL: Record<DebateSourceRef['kind'], string> = {
  loop: '用辩论练这个',
  event_card: '就此辩一场',
};

interface SourceDebateButtonProps {
  source: DebateSourceRef;
  /** 按钮文案；不传按来源取默认（回环「用辩论练这个」/ 事件卡「就此辩一场」） */
  label?: string;
  /**
   * 默认 outline：同屏可能有好几个（每条回环、每条事件卡各一个），
   * 用实底主色会把焦点稀释掉，只剩「哪个才是主要动作」的困惑。
   * 放进更轻的位置时（如事件卡的次行）可以传 ghost。
   */
  variant?: ButtonVariant;
  /**
   * 加在外层容器上（对齐 / 外边距用）。
   * ⚠️ 别用 className 去改按钮尺寸或字号：`lib/cn.ts` 只做字符串拼接，
   * 不是 tailwind-merge，Tailwind 里同组工具类的胜负由生成顺序决定，不靠谱。
   */
  className?: string;
  disabled?: boolean;
  /** 不跳转、把房间交给调用方处理时用（默认跳 /debates/{id}） */
  onCreated?: (room: DebateRoom) => void;
}

/**
 * 「从这条回环 / 这张事件卡起一场辩论」——一个按钮把闭环接上：
 *   辩论房 → 观察 → 弱点 → 回环 → **演练**
 *
 * 点一下就发起，不需要用户输入任何东西：从回环起辩时后端会用它的
 * 触发场景 / 身体信号 / 预案拼出场景并让 AI 出题（app/api/debates.py
 * 的 `_scene_from_source`），并把该回环的上下文一并带进辩论里。
 *
 * 为什么不用 `useDebateCreate` 之类的共享 hook：这里只有「点 → POST → 跳房」
 * 三步，且失败要留在原地显示一句中文错误，写成一个组件比散在各页里的
 * loading 状态更好收口。
 */
export function SourceDebateButton({
  source,
  label,
  variant = 'outline',
  className,
  disabled = false,
  onCreated,
}: SourceDebateButtonProps) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const data = await createDebateFromSource(payloadFromSource(source));
      if (onCreated) {
        onCreated(data.room);
        setBusy(false);
        return;
      }
      // 新房间已经有 AI 开场白，直接进房间
      navigate(`/debates/${data.room.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '没能开起来，请稍后再试');
      setBusy(false);
    }
  }

  return (
    <span className={cn('inline-flex flex-col items-start gap-1', className)}>
      <Button
        variant={variant}
        loading={busy}
        disabled={disabled || busy}
        onClick={() => void start()}
      >
        {busy ? '正在开局…' : (label ?? DEFAULT_LABEL[source.kind])}
      </Button>
      {error ? <span className="text-xs leading-relaxed text-danger">{error}</span> : null}
    </span>
  );
}
