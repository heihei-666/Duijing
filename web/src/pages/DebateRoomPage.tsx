import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import type { DebateMessage, DebateRoom } from '@/api/types';
import { Button } from '@/components/common/Button';
import { DebateComposer } from '@/features/debate/DebateComposer';
import { InviteSheet } from '@/features/debate/InviteSheet';
import { MessageBubble } from '@/features/debate/MessageBubble';
import { ReminderSheet } from '@/features/debate/ReminderSheet';
import { ReviewCard } from '@/features/debate/ReviewCard';
import { RoomActions } from '@/features/debate/RoomActions';
import { RoomHeader } from '@/features/debate/RoomHeader';
import {
  DEBATE_MESSAGE_MAX_CHARS,
  abandonDebateRound,
  cancelDebateReminder,
  countChars,
  dismissDebateObservations,
  finishDebate,
  getDebateReminder,
  getDebateRoom,
  inviteToDebate,
  pauseDebate,
  resumeDebate,
  sendDebateMessage,
  setDebateReminder,
  type DebateInviteResult,
  type DebateReminder,
  type ReviewCardFull,
} from '@/features/debate/api';
import { useDebateStream, type RoundDoneInfo } from '@/features/debate/useDebateStream';
import { usePushNotifications } from '@/features/push/usePushNotifications';
import { useAuthStore } from '@/store/auth';

/**
 * 辩论房（方案 3.1 / 契约 3 章 + 10 章）。
 *
 * 发送一轮的流程严格按契约：
 *   1. POST /api/debates/{id}/messages  → 用户消息落库
 *   2. 立刻 new EventSource(GET /api/debates/{id}/stream?after_seq=…)  → AI 回复
 *   3. token 事件逐字追加到临时气泡（关键体验，不攒到最后整段显示）
 *   4. message 事件用服务端完整消息替换临时气泡
 *   5. done 事件关闭连接；辩满计划轮数后底部常驻收尾提示（带可点的「结束并复盘」）
 *   6. error 事件显示错误并允许重试
 *   7. 卸载 / 换房间关闭连接（在 useDebateStream 里统一兜住）
 *
 * 进入页面先 GET 详情：room + messages（+ 发起人可见的 review）。
 * 如果最后一条是用户消息且房间还 active，说明上次生成中途断线，这里自动续接一次流。
 *
 * 「该收尾了」这件事由**房间状态推导**（见 wrapUpNotice），不靠 SSE 事件临时弹一下：
 * 那条提示以前只在 done 事件里 setNotice，用户一刷新就没了，而按钮又远在消息列表顶部，
 * 结果就是「提示说可以结束，但找不到能点的地方」。
 */
export default function DebateRoomPage() {
  const params = useParams<{ id: string }>();
  const navigate = useNavigate();
  const roomId = Number(params.id);
  const validRoomId = Number.isInteger(roomId) && roomId > 0;
  const currentUserId = useAuthStore((state) => state.user?.id ?? null);

  const [room, setRoom] = useState<DebateRoom | null>(null);
  const [messages, setMessages] = useState<DebateMessage[]>([]);
  const [review, setReview] = useState<ReviewCardFull | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [abandoning, setAbandoning] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [togglingPause, setTogglingPause] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [dismissing, setDismissing] = useState(false);

  const [actionError, setActionError] = useState<string | null>(null);
  /** 系统提示：最后一轮 / 已暂停 / 已结束 */
  const [notice, setNotice] = useState<string | null>(null);

  const [invite, setInvite] = useState<DebateInviteResult | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);

  /* ---------------------------------------------- 预约提醒（方案 3.9 唯一触达） */
  const [reminder, setReminder] = useState<DebateReminder | null>(null);
  const [reminderOpen, setReminderOpen] = useState(false);
  const [reminderError, setReminderError] = useState<string | null>(null);
  /** 正在提交的 preset key */
  const [savingPreset, setSavingPreset] = useState<string | null>(null);
  const [cancellingReminder, setCancellingReminder] = useState(false);
  /** POST 返回的 device_count：0 表示约了也收不到，必须如实提示 */
  const [reminderDeviceCount, setReminderDeviceCount] = useState(0);

  /**
   * 推送状态按需加载（auto: false）：进房间不该无端多两个请求，
   * 打开提醒面板时再 refresh()。
   */
  const pushNotifications = usePushNotifications({ auto: false });
  const { refresh: refreshPush, enable: enablePush } = pushNotifications;
  /** 服务端说的设备数与本机订阅状态取较大者，开启成功后警告要能立刻消失 */
  const reminderDeviceTotal = Math.max(reminderDeviceCount, pushNotifications.deviceCount);

  /** 列表追加消息：按 id 去重（SSE 的 message 事件可能与已有消息重复） */
  const upsertMessage = useCallback((incoming: DebateMessage) => {
    setMessages((previous) => {
      const index = previous.findIndex((item) => item.id === incoming.id);
      if (index === -1) {
        return [...previous, incoming].sort((a, b) => a.seq - b.seq);
      }
      const next = [...previous];
      next[index] = incoming;
      return next;
    });
  }, []);

  const handleRoundDone = useCallback((info: RoundDoneInfo) => {
    setRoom((previous) =>
      previous ? { ...previous, current_round: Math.max(previous.current_round, info.round) } : previous,
    );
    // 这里刻意不再 setNotice：辩满计划轮数后的收尾提示由 wrapUpNotice 常驻渲染，
    // 否则每多辩一轮就重复弹一次「这已经是最后一轮」，辩到第 8 轮会弹 5 次。
  }, []);

  const {
    streaming,
    streamText,
    error: streamError,
    start: startStream,
    close: closeStream,
  } = useDebateStream({ roomId, onMessage: upsertMessage, onRoundDone: handleRoundDone });

  /* ------------------------------------------------------------ 自动滚到底部 */
  const bottomRef = useRef<HTMLDivElement | null>(null);
  /** 用户是否停在底部附近；往上翻看历史时不再强行拉回底部 */
  const pinnedRef = useRef(true);

  useEffect(() => {
    const onScroll = () => {
      const gap =
        document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
      pinnedRef.current = gap < 160;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!pinnedRef.current) return;
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, streamText, review]);

  /* ---------------------------------------------------------------- 载入详情 */
  useEffect(() => {
    if (!validRoomId) {
      setLoading(false);
      setLoadError('辩论房地址不正确');
      return;
    }

    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setActionError(null);
    setReviewError(null);
    setNotice(null);
    setInvite(null);
    setRoom(null);
    setMessages([]);
    setReview(null);
    pinnedRef.current = true;

    void (async () => {
      try {
        const detail = await getDebateRoom(roomId);
        if (cancelled) return;
        const list = detail.messages ?? [];
        setRoom(detail.room);
        setMessages(list);
        setReview(detail.review ?? null);

        // 续接：上次发完言就断线的话，AI 回复还没拿到，这里补一次流
        const last = list[list.length - 1];
        if (detail.room.status === 'active' && last?.role === 'user') {
          startStream(last.seq);
        }
      } catch (cause) {
        if (!cancelled) {
          setLoadError(cause instanceof Error ? cause.message : '辩论房加载失败');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [roomId, validRoomId, startStream]);

  /* ------------------------------------------------- 读取已有的预约提醒 */
  // 独立于上面那次详情加载：提醒读失败不该影响房间本身（SSE / 消息逻辑完全不碰）
  useEffect(() => {
    if (!validRoomId) return;

    let cancelled = false;
    setReminder(null);
    setReminderError(null);
    setReminderDeviceCount(0);

    void (async () => {
      try {
        const result = await getDebateReminder(roomId);
        if (!cancelled) setReminder(result.reminder);
      } catch {
        // 读不到就当作没有预约；面板里的「提醒我」依然可用
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [roomId, validRoomId]);

  /* ------------------------------------------------------------------ 操作 */

  const handleSend = useCallback(async () => {
    const content = draft.trim();
    if (content === '' || countChars(content) > DEBATE_MESSAGE_MAX_CHARS) return;
    if (!room || room.status !== 'active' || streaming || sending) return;

    setSending(true);
    setActionError(null);
    setNotice(null);
    try {
      const result = await sendDebateMessage(roomId, content);
      upsertMessage(result.message);
      setDraft('');
      setRoom((previous) =>
        previous ? { ...previous, current_round: result.round } : previous,
      );
      // 契约顺序：先 POST 落库，再开 SSE 取 AI 回复
      startStream(result.message.seq);
    } catch (cause) {
      // 失败时不清空输入框，用户不用重打
      setActionError(cause instanceof Error ? cause.message : '发送失败，请稍后再试');
    } finally {
      setSending(false);
    }
  }, [draft, room, roomId, sending, streaming, startStream, upsertMessage]);

  const handleAbandon = useCallback(async () => {
    if (!room || room.status !== 'active') return;
    setAbandoning(true);
    setActionError(null);
    try {
      const result = await abandonDebateRound(roomId);
      // 后端返回的是本次写入的「（这轮我放弃）」用户消息（契约写的是 AI 回应，见 api.ts 文件头）
      upsertMessage(result.message);
      setDraft('');
      setRoom((previous) =>
        previous ? { ...previous, current_round: result.round } : previous,
      );
      // 放弃也是一次发言，照常开流让 AI 接住这一轮
      startStream(result.message.seq);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : '操作失败，请稍后再试');
    } finally {
      setAbandoning(false);
    }
  }, [room, roomId, startStream, upsertMessage]);

  const handleTogglePause = useCallback(async () => {
    if (!room) return;
    setTogglingPause(true);
    setActionError(null);
    try {
      const result =
        room.status === 'paused' ? await resumeDebate(roomId) : await pauseDebate(roomId);
      setRoom((previous) => (previous ? { ...previous, status: result.status } : previous));
      if (result.status === 'paused') {
        closeStream();
        // 提示与「继续」按钮都由 composerNotice 从房间状态推导，
        // 这样刷新后不会只剩一句「点上方继续」而上面什么都没有。
      } else {
        setNotice(null);
      }
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : '操作失败，请稍后再试');
    } finally {
      setTogglingPause(false);
    }
  }, [room, roomId, closeStream]);

  const handleFinish = useCallback(async () => {
    // 生成中直接结束：先关流，避免复盘和这一轮回复抢同一份上下文
    closeStream();
    setFinishing(true);
    setActionError(null);
    try {
      const result = await finishDebate(roomId);
      setReview(result.review);
      setRoom((previous) => (previous ? { ...previous, status: 'finished' } : previous));
      setNotice('这场辩论已经结束。');
      // 复盘生成时可能刚落库一条 AI 消息，再拉一次详情保证与服务端一致
      const detail = await getDebateRoom(roomId);
      setRoom(detail.room);
      setMessages(detail.messages ?? []);
      setReview(detail.review ?? result.review);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : '结束失败，请稍后再试');
    } finally {
      setFinishing(false);
    }
  }, [roomId, closeStream]);

  const handleInvite = useCallback(async () => {
    setInviting(true);
    setInviteError(null);
    setInviteOpen(true);
    try {
      setInvite(await inviteToDebate(roomId));
    } catch (cause) {
      setInviteError(cause instanceof Error ? cause.message : '邀请链接生成失败');
    } finally {
      setInviting(false);
    }
  }, [roomId]);

  const handleDismissObservations = useCallback(async () => {
    setDismissing(true);
    setReviewError(null);
    try {
      await dismissDebateObservations(roomId);
      setReview((previous) =>
        previous ? { ...previous, observations_dismissed: true } : previous,
      );
    } catch (cause) {
      setReviewError(cause instanceof Error ? cause.message : '操作失败，请稍后再试');
    } finally {
      setDismissing(false);
    }
  }, [roomId]);

  const handleRetryStream = useCallback(() => {
    const lastUser = [...messages].reverse().find((item) => item.role === 'user');
    startStream(lastUser?.seq);
  }, [messages, startStream]);

  /* ------------------------------- 底部提示（含就地操作，由房间状态推导） */

  /**
   * 底部（输入区上方）的提示，以及提示**自带的**操作按钮。
   *
   * 为什么要有这个：房间操作行（暂停 / 邀请 / 结束并复盘）在消息列表顶部，
   * 是刻意不吸顶的（见 RoomActions 注释，为了不让按钮一进房间就占掉半屏）。
   * 但「上面」在辩到第 8 轮时已经是好几屏之外了——提示里写「可以点结束并复盘」，
   * 用户低头找一圈什么也点不到。所以凡是提示里提到某个动作，动作就落在提示这一行。
   *
   * 另一条同样重要：这些提示全部由**房间状态推导**，不靠事件临时 setNotice。
   * 靠事件的话，用户一刷新页面提示就没了，又变回一个找不到出口的死胡同。
   *
   * max_rounds 是计划轮数不是硬上限（辩满了仍可继续），所以辩超了如实报多出来几轮。
   */
  const composerNotice = useMemo(() => {
    if (!room) return null;

    if (room.status === 'paused') {
      return {
        text: '已暂停。数据都留着，想接着辩就点「继续」。',
        action: {
          label: '继续',
          onClick: () => void handleTogglePause(),
          loading: togglingPause,
        },
      };
    }

    // 流式回复中不提前喊收尾：这一轮还没说完，这时按下按钮会掐断它
    if (
      room.status === 'active' &&
      room.is_owner &&
      !streaming &&
      room.current_round >= room.max_rounds
    ) {
      const over = room.current_round - room.max_rounds;
      return {
        text:
          over > 0
            ? `已经辩了 ${room.current_round} 轮，比计划的 ${room.max_rounds} 轮多 ${over} 轮。想收尾就生成复盘，也可以接着辩。`
            : `计划的 ${room.max_rounds} 轮辩完了。想收尾就生成复盘，也可以接着辩。`,
        action: {
          label: review ? '重新生成复盘' : '结束并复盘',
          onClick: () => void handleFinish(),
          loading: finishing,
        },
      };
    }

    // 兜底：房间已结束但复盘没落库（正常路径不出现，生成失败时房间仍是 active）
    if (room.status === 'finished' && room.is_owner && !review) {
      return {
        text: '这场辩论还没有复盘卡片。',
        action: {
          label: '结束并复盘',
          onClick: () => void handleFinish(),
          loading: finishing,
        },
      };
    }

    return null;
  }, [room, review, streaming, finishing, togglingPause, handleFinish, handleTogglePause]);

  /* ------------------------------------------------------------ 提醒相关操作 */

  const handleOpenReminder = useCallback(() => {
    setReminderOpen(true);
    setReminderError(null);
    // 打开时才拉 presets 与设备数，保证面板里的信息是新的
    void refreshPush();
  }, [refreshPush]);

  const handlePickReminder = useCallback(
    async (preset: string) => {
      setSavingPreset(preset);
      setReminderError(null);
      try {
        const result = await setDebateReminder(roomId, preset);
        setReminder(result.reminder);
        setReminderDeviceCount(result.device_count);
        // 约上了但收不到时**不关**面板：用户必须看见「还没开启通知」这句
        if (result.will_notify) setReminderOpen(false);
      } catch (cause) {
        setReminderError(cause instanceof Error ? cause.message : '预约失败，请稍后再试');
      } finally {
        setSavingPreset(null);
      }
    },
    [roomId],
  );

  const handleCancelReminder = useCallback(async () => {
    setCancellingReminder(true);
    setReminderError(null);
    try {
      await cancelDebateReminder(roomId);
      setReminder(null);
      setReminderDeviceCount(0);
      setReminderOpen(false);
    } catch (cause) {
      setReminderError(cause instanceof Error ? cause.message : '取消失败，请稍后再试');
    } finally {
      setCancellingReminder(false);
    }
  }, [roomId]);

  const handleEnablePush = useCallback(() => {
    void enablePush();
  }, [enablePush]);

  /* -------------------------------------------------------------- 渲染分支 */

  if (loading) {
    return (
      <RoomShell onBack={() => navigate('/debates')}>
        <RoomSkeleton />
      </RoomShell>
    );
  }

  if (loadError || !room) {
    return (
      <RoomShell onBack={() => navigate('/debates')}>
        <div className="rounded-2xl border border-light bg-surface p-6 text-center shadow-card">
          <p className="text-[13px] text-secondary">{loadError ?? '辩论房不存在'}</p>
          <Button variant="outline" className="mt-4" onClick={() => navigate('/debates')}>
            回到辩论列表
          </Button>
        </div>
      </RoomShell>
    );
  }

  return (
    <div className="min-h-screen bg-base">
      <div className="mx-auto flex min-h-screen w-full max-w-2xl flex-col">
        <RoomHeader room={room} onBack={() => navigate('/debates')} />

        <main className="flex-1 px-4 pb-6 pt-4">
          <RoomActions
            room={room}
            togglingPause={togglingPause}
            inviting={inviting}
            finishing={finishing}
            showOwnerActions={room.is_owner}
            hasReminder={reminder !== null}
            onTogglePause={() => void handleTogglePause()}
            onInvite={() => void handleInvite()}
            onFinish={() => void handleFinish()}
            onRemind={handleOpenReminder}
          />

          {/*
            已预约状态如实摆在这里：收得到就说收得到，收不到直说收不到，
            并给一条能走通的路（去设置里开启通知）。
          */}
          {reminder ? (
            <button
              type="button"
              onClick={() =>
                reminderDeviceTotal > 0
                  ? handleOpenReminder()
                  : navigate('/assets?tab=settings')
              }
              className="mt-3 flex min-h-[44px] w-full items-center justify-between gap-3 rounded-xl border border-light bg-surface px-3 text-left"
            >
              <span
                className={
                  reminderDeviceTotal > 0
                    ? 'text-xs leading-relaxed text-secondary'
                    : 'text-xs leading-relaxed text-warning'
                }
              >
                已约 {reminder.remind_at_local} 提醒
                {reminderDeviceTotal > 0 ? '，到点通知你。' : '，但还没开启通知，到点收不到。'}
              </span>
              <span className="shrink-0 text-xs text-brand">
                {reminderDeviceTotal > 0 ? '修改' : '去开启'}
              </span>
            </button>
          ) : null}

          {/* 读屏提示：只播报「正在回复」这个状态，不逐个 token 播报 */}
          <p className="sr-only" role="status" aria-live="polite">
            {streaming ? 'AI 正在回复' : ''}
          </p>

          <ol className="mt-4 space-y-3.5">
            {messages.map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                content={message.content}
                isOwn={message.user_id !== null && message.user_id === currentUserId}
              />
            ))}

            {/* 逐字生长的 AI 临时气泡；message 事件到达后由服务端完整消息替换 */}
            {streaming ? (
              <MessageBubble
                message={{
                  role: 'ai',
                  round: room.current_round,
                  user_id: null,
                  nickname: null,
                }}
                content={streamText}
                streaming
              />
            ) : null}
          </ol>

          {review ? (
            <div className="mt-5">
              <ReviewCard
                review={review}
                canDismiss={room.is_owner}
                dismissing={dismissing}
                error={reviewError}
                onDismiss={() => void handleDismissObservations()}
              />
            </div>
          ) : null}

          {/* 「还没有复盘卡片」不再在这里写一句话指向上方的按钮——
              那句话指向的按钮在消息列表顶部，辩到第 8 轮时已经在好几屏之外。
              现在由 DebateComposer 的 noticeAction 就地给出可点的按钮。 */}

          <div ref={bottomRef} aria-hidden className="h-px" />
        </main>

        <DebateComposer
          value={draft}
          onChange={setDraft}
          onSend={() => void handleSend()}
          sending={sending}
          streaming={streaming}
          status={room.status}
          streamError={streamError}
          onRetryStream={handleRetryStream}
          onAbandon={() => void handleAbandon()}
          abandoning={abandoning}
          error={actionError}
          notice={notice ?? composerNotice?.text ?? null}
          noticeAction={notice ? null : (composerNotice?.action ?? null)}
        />
      </div>

      <InviteSheet
        open={inviteOpen}
        invite={invite}
        loading={inviting}
        error={inviteError}
        onClose={() => setInviteOpen(false)}
      />

      <ReminderSheet
        open={reminderOpen}
        presets={pushNotifications.presets}
        loading={pushNotifications.loading}
        reminder={reminder}
        savingPreset={savingPreset}
        cancelling={cancellingReminder}
        error={reminderError}
        deviceCount={reminderDeviceTotal}
        push={{
          supported: pushNotifications.environment.supported,
          hint: pushNotifications.environment.hint,
          subscribed: pushNotifications.subscribed,
          enabling: pushNotifications.busy === 'enable',
          error: pushNotifications.error,
          notice: pushNotifications.notice,
          onEnable: handleEnablePush,
          onOpenSettings: () => {
            setReminderOpen(false);
            navigate('/assets?tab=settings');
          },
        }}
        onPick={(preset) => void handlePickReminder(preset)}
        onCancelReminder={() => void handleCancelReminder()}
        onClose={() => setReminderOpen(false)}
      />
    </div>
  );
}

/** 加载 / 出错时也保持房间的框架（顶栏 + 暖灰底），避免白屏闪烁 */
function RoomShell({ children, onBack }: { children: ReactNode; onBack: () => void }) {
  return (
    <div className="min-h-screen bg-base">
      <div className="mx-auto w-full max-w-2xl px-4 pb-6 pt-3">
        <button
          type="button"
          onClick={onBack}
          className="mb-4 flex h-11 items-center rounded-xl px-2 text-[13px] text-secondary hover:bg-elevated"
        >
          返回辩论列表
        </button>
        {children}
      </div>
    </div>
  );
}

function RoomSkeleton() {
  return (
    <div className="space-y-3.5" aria-busy>
      <div className="h-20 animate-pulse rounded-xl bg-elevated" />
      <div className="h-16 w-3/4 animate-pulse rounded-2xl bg-elevated" />
      <div className="ml-auto h-16 w-2/3 animate-pulse rounded-2xl bg-elevated" />
    </div>
  );
}
