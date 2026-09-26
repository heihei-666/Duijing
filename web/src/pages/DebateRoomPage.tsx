import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import type { DebateMessage, DebateRoom } from '@/api/types';
import { Button } from '@/components/common/Button';
import { DebateComposer } from '@/features/debate/DebateComposer';
import { InviteSheet } from '@/features/debate/InviteSheet';
import { MessageBubble } from '@/features/debate/MessageBubble';
import { ReviewCard } from '@/features/debate/ReviewCard';
import { RoomActions } from '@/features/debate/RoomActions';
import { RoomHeader } from '@/features/debate/RoomHeader';
import {
  DEBATE_MESSAGE_MAX_CHARS,
  abandonDebateRound,
  countChars,
  dismissDebateObservations,
  finishDebate,
  getDebateRoom,
  inviteToDebate,
  pauseDebate,
  resumeDebate,
  sendDebateMessage,
  type DebateInviteResult,
  type ReviewCardFull,
} from '@/features/debate/api';
import { useDebateStream, type RoundDoneInfo } from '@/features/debate/useDebateStream';
import { useAuthStore } from '@/store/auth';

/**
 * 辩论房（方案 3.1 / 契约 3 章 + 10 章）。
 *
 * 发送一轮的流程严格按契约：
 *   1. POST /api/debates/{id}/messages  → 用户消息落库
 *   2. 立刻 new EventSource(GET /api/debates/{id}/stream?after_seq=…)  → AI 回复
 *   3. token 事件逐字追加到临时气泡（关键体验，不攒到最后整段显示）
 *   4. message 事件用服务端完整消息替换临时气泡
 *   5. done 事件关闭连接；is_last_round 为真时提示可以结束了
 *   6. error 事件显示错误并允许重试
 *   7. 卸载 / 换房间关闭连接（在 useDebateStream 里统一兜住）
 *
 * 进入页面先 GET 详情：room + messages（+ 发起人可见的 review）。
 * 如果最后一条是用户消息且房间还 active，说明上次生成中途断线，这里自动续接一次流。
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
    if (info.is_last_round) {
      setNotice('这已经是最后一轮。可以点「结束并复盘」，也可以继续辩。');
    }
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
        setNotice('已暂停。数据都留着，回来点「继续」。');
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
            onTogglePause={() => void handleTogglePause()}
            onInvite={() => void handleInvite()}
            onFinish={() => void handleFinish()}
          />

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

          {room.status === 'finished' && !review && room.is_owner ? (
            <p className="mt-5 rounded-xl bg-elevated px-3 py-2 text-xs leading-relaxed text-secondary">
              还没有复盘卡片。点上面的「结束并复盘」生成一份。
            </p>
          ) : null}

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
          notice={notice}
        />
      </div>

      <InviteSheet
        open={inviteOpen}
        invite={invite}
        loading={inviting}
        error={inviteError}
        onClose={() => setInviteOpen(false)}
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
