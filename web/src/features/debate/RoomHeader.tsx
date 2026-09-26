import type { DebateRoom } from '@/api/types';

import { DEBATE_MAX_PARTICIPANTS } from './api';
import { BackIcon } from './icons';

interface RoomHeaderProps {
  room: DebateRoom;
  onBack: () => void;
}

/**
 * 轮次指示（配色方案 五：--text-tertiary）。
 *
 * max_rounds 是**计划**轮数，不是硬上限：辩到计划轮数后用户仍可以接着辩。
 * 所以辩超了必须如实写「第 8 轮 / 计划 4 轮」，不能写成「第 8 轮 / 共 4 轮」——
 * 那会让人以为自己看错了，或者以为轮次计数坏了。
 * 结束后同理，报实际辩了几轮，而不是当初计划的几轮。
 */
function roundLabel(room: DebateRoom): string {
  if (room.status === 'finished') {
    return room.current_round > 0 ? `已结束 · 共 ${room.current_round} 轮` : '已结束 · 未开辩';
  }
  if (room.current_round <= 0) return `开场 · 计划 ${room.max_rounds} 轮`;
  if (room.current_round > room.max_rounds) {
    return `第 ${room.current_round} 轮 / 计划 ${room.max_rounds} 轮`;
  }
  return `第 ${room.current_round} 轮 / 共 ${room.max_rounds} 轮`;
}

/**
 * 房间顶栏（吸顶，尽量薄，把纵向空间留给消息）：
 *   辩题栏 —— --text-primary 底 + 白字（配色方案 五）
 *   立场、轮次、人数 —— 中性色，不引入第三种彩色
 */
export function RoomHeader({ room, onBack }: RoomHeaderProps) {
  return (
    <header className="sticky top-0 z-20 border-b border-light bg-base px-4 pb-2.5 pt-3">
      <div className="flex items-start gap-1.5">
        <button
          type="button"
          onClick={onBack}
          aria-label="返回辩论列表"
          className="-ml-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-secondary hover:bg-elevated"
        >
          <BackIcon width={22} height={22} />
        </button>

        <div
          className="min-w-0 flex-1 rounded-xl px-3.5 py-2.5"
          style={{ backgroundColor: 'var(--text-primary)' }}
        >
          <p className="text-[15px] font-medium leading-snug text-on-brand">{room.topic}</p>
          {room.stance ? (
            <p className="mt-1 text-[12px] leading-relaxed text-white/75">我的立场：{room.stance}</p>
          ) : null}
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between gap-3 px-1 text-[12px] text-tertiary">
        <span className="tabular-nums">{roundLabel(room)}</span>
        <span className="flex items-center gap-2">
          {room.status === 'paused' ? (
            <span className="rounded-md bg-elevated px-1.5 py-0.5 text-[11px] text-secondary">
              已暂停
            </span>
          ) : null}
          <span className="tabular-nums">
            {room.participant_count}/{DEBATE_MAX_PARTICIPANTS} 人
          </span>
        </span>
      </div>
    </header>
  );
}
