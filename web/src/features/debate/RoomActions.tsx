import type { DebateRoom } from '@/api/types';
import { Button } from '@/components/common/Button';

interface RoomActionsProps {
  room: DebateRoom;
  /** 暂停 / 继续 请求中 */
  togglingPause: boolean;
  /** 邀请链接生成中 */
  inviting: boolean;
  /** 结束并生成复盘中 */
  finishing: boolean;
  /** 该用户是发起人才看得到「邀请」「结束并复盘」 */
  showOwnerActions: boolean;
  /** 是否已经约了提醒（按钮文案用） */
  hasReminder: boolean;
  /**
   * 能不能邀请别人（默认可以）。
   *
   * 访客不能：他没有好友关系，也没有正式的历史弱点可以分享，
   * 而且「邀请」会把人拉进一个**别人也在看**的房间 ——
   * 访客模式下这个房间是「只有你」的，第一场就多人会破坏这个承诺。
   */
  canInvite?: boolean;
  /**
   * 能不能约辩论提醒（默认可以）。
   *
   * 访客不能：提醒靠 Web Push，而访客大概率没开过通知权限；
   * 更要紧的是——**访客账号可能 7 天后就被清理**，
   * 给他约一个「明天提醒你」却收不到，是在骗他。
   */
  canRemind?: boolean;
  onTogglePause: () => void;
  onInvite: () => void;
  onFinish: () => void;
  onRemind: () => void;
}

/**
 * 房间操作行。刻意**不吸顶**：吸顶只留辩题与轮次，操作随内容滚动，
 * 手机上不至于一进房间就被按钮占掉半屏。
 * 所有按钮 h-11（44px），满足触控目标要求。
 */
export function RoomActions({
  room,
  togglingPause,
  inviting,
  finishing,
  showOwnerActions,
  hasReminder,
  canInvite = true,
  canRemind = true,
  onTogglePause,
  onInvite,
  onFinish,
  onRemind,
}: RoomActionsProps) {
  const finished = room.status === 'finished';
  const paused = room.status === 'paused';

  return (
    <div className="flex flex-wrap gap-2">
      {!finished ? (
        <Button
          variant="outline"
          loading={togglingPause}
          disabled={finishing}
          onClick={onTogglePause}
        >
          {paused ? '继续' : '暂停'}
        </Button>
      ) : null}

      {/* 预约提醒：方案 3.9 里唯一的主动触达入口，只在这里出现 */}
      {!finished && canRemind ? (
        <Button variant="outline" disabled={finishing || togglingPause} onClick={onRemind}>
          {hasReminder ? '已约提醒' : '提醒我'}
        </Button>
      ) : null}

      {showOwnerActions && !finished && canInvite ? (
        <Button variant="outline" loading={inviting} disabled={finishing} onClick={onInvite}>
          邀请
        </Button>
      ) : null}

      {showOwnerActions ? (
        <Button variant="outline" loading={finishing} disabled={togglingPause} onClick={onFinish}>
          {finished ? '重新生成复盘' : '结束并复盘'}
        </Button>
      ) : null}
    </div>
  );
}
