import type { DebateRoom } from '@/api/types';
import { ChevronRightIcon } from '@/components/icons';
import { cn } from '@/lib/cn';
import { formatTimestamp } from '@/lib/date';

import { DEBATE_MAX_PARTICIPANTS } from './api';

interface DebateListItemProps {
  room: DebateRoom;
  onOpen: (id: number) => void;
}

/**
 * 辩论列表条目。进行中显示轮次进度，历史显示结束时间。
 * 整张卡是一个按钮（≥44px 触控目标），进度条用 --bg-inset 轨道 + --primary 填充，
 * 不引入第二种强调色（配色方案 十一·3：状态靠明度/透明度，不靠色相跳变）。
 */
export function DebateListItem({ room, onOpen }: DebateListItemProps) {
  const finished = room.status === 'finished' || room.status === 'abandoned';
  const paused = room.status === 'paused';
  const progress = room.max_rounds > 0
    ? Math.min(100, Math.round((room.current_round / room.max_rounds) * 100))
    : 0;

  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(room.id)}
        className={cn(
          'flex w-full items-start gap-3 rounded-2xl border border-light bg-surface px-4 py-3.5',
          'text-left shadow-card transition-colors hover:bg-elevated active:bg-inset',
        )}
      >
        <div className="min-w-0 flex-1">
          <p className="break-words text-[15px] font-medium leading-snug text-primary">
            {room.topic}
          </p>

          {room.stance ? (
            <p className="mt-1 break-words text-[13px] leading-relaxed text-secondary">
              我的立场：{room.stance}
            </p>
          ) : null}

          {finished ? (
            <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-tertiary">
              <span>共 {room.max_rounds} 轮</span>
              {room.finished_at ? <span>结束于 {formatTimestamp(room.finished_at)}</span> : null}
            </p>
          ) : (
            <>
              <div className="mt-2 flex items-center gap-2">
                <span className="h-1 flex-1 overflow-hidden rounded-full bg-inset">
                  <span
                    className="block h-full rounded-full bg-primary"
                    style={{ width: `${progress}%` }}
                  />
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-tertiary">
                  第 {room.current_round} 轮 / 共 {room.max_rounds} 轮
                </span>
              </div>

              <p className="mt-1.5 flex items-center gap-2 text-[11px] text-tertiary">
                <span className="tabular-nums">
                  参与 {room.participant_count}/{DEBATE_MAX_PARTICIPANTS} 人
                </span>
                {paused ? (
                  <span className="rounded-md bg-elevated px-1.5 py-0.5 text-secondary">
                    已暂停
                  </span>
                ) : null}
                {!room.is_owner ? <span>受邀加入</span> : null}
              </p>
            </>
          )}
        </div>

        <ChevronRightIcon className="mt-1 shrink-0 text-disabled" />
      </button>
    </li>
  );
}
