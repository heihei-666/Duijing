/**
 * 辩论房 · SSE 流式接收（契约第 3 章 / 第 10 章）
 *
 * 服务端事件（`GET /api/debates/{id}/stream`）：
 *   event: token    data: {"delta": "我"}                  逐字增量 → 追加到「正在输入的 AI 气泡」
 *   event: message  data: {"message": {完整 AI 消息}}      已落库 → 用服务端消息替换临时气泡
 *   event: done     data: {"round": 2, "is_last_round": false}
 *   event: error    data: {"detail": "..."}
 *   event: ping     心跳（15s），不处理
 *
 * 三条硬要求，这里逐条落实：
 *   1. 逐字渲染 —— token 事件到达就 setState 追加，绝不缓存到结束再整段显示；
 *   2. 卸载/切房间必须 close —— 两条 useEffect 兜住组件卸载与 roomId 变化；
 *   3. 断线不重复生成 —— 依赖服务端「这一轮已生成过 AI 回复就不重复生成」的幂等保护，
 *      EventSource 自动重连即可补齐；但重连次数封顶，避免服务端持续报错时无限重连。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { DebateMessage } from '@/api/types';

import { debateStreamUrl } from './api';

/** EventSource 自动重连的次数上限；超过就交给用户手动重试 */
const MAX_RECONNECT = 3;

interface TokenPayload {
  delta?: string;
}

interface MessagePayload {
  message?: DebateMessage;
}

interface DonePayload {
  round?: number;
  is_last_round?: boolean;
}

interface ErrorPayload {
  detail?: string;
}

/** done 事件里对前端有用的两个字段 */
export interface RoundDoneInfo {
  round: number;
  is_last_round: boolean;
}

interface UseDebateStreamOptions {
  roomId: number;
  /** 收到服务端完整消息（已落库） */
  onMessage: (message: DebateMessage) => void;
  /** 这一轮流结束 */
  onRoundDone: (info: RoundDoneInfo) => void;
}

export interface DebateStreamState {
  /** 正在接收 AI 回复 */
  streaming: boolean;
  /** 已经收到的增量文本；用于渲染临时气泡 */
  streamText: string;
  /** 流内错误（服务端 error 事件 / 连接断开），非空时可重试 */
  error: string | null;
  /** 开始接收；afterSeq 用于续传（服务端目前忽略，由服务端自己做幂等保护） */
  start: (afterSeq?: number) => void;
  /** 主动关闭（离开页面、暂停、重试前） */
  close: () => void;
}

function parseJson<T>(raw: unknown): T | null {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function useDebateStream({
  roomId,
  onMessage,
  onRoundDone,
}: UseDebateStreamOptions): DebateStreamState {
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const sourceRef = useRef<EventSource | null>(null);
  /** 每次开流 +1：回调里比对，丢弃过期连接的迟到事件 */
  const sessionRef = useRef(0);
  /** 最新的 roomId：渲染期同步，用来识别「房间已经切走」的过期闭包 */
  const roomIdRef = useRef(roomId);
  roomIdRef.current = roomId;
  /** 组件是否还挂着：卸载后到达的 start() 不能再开连接 */
  const mountedRef = useRef(true);
  /** 回调放 ref，父组件每次渲染都换函数引用也不会重开连接 */
  const handlerRef = useRef({ onMessage, onRoundDone });
  handlerRef.current = { onMessage, onRoundDone };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const close = useCallback(() => {
    sessionRef.current += 1;
    if (sourceRef.current) {
      sourceRef.current.close();
      sourceRef.current = null;
    }
    setStreaming(false);
  }, []);

  const start = useCallback(
    (afterSeq?: number) => {
      // 卸载之后（发言请求才回来的情况）或房间已经切走时，绝不再开新连接：
      // 那时 hook 的清理已经跑过，新连接没人关得掉。
      if (!mountedRef.current || roomIdRef.current !== roomId) return;

      // 同一时刻只保留一条连接：重试、续接、切轮次前都先关掉旧的
      close();
      const session = sessionRef.current;
      setError(null);
      setStreamText('');
      setStreaming(true);

      const source = new EventSource(debateStreamUrl(roomId, afterSeq));
      sourceRef.current = source;
      let reconnects = 0;

      const alive = () => sessionRef.current === session && sourceRef.current === source;

      const fail = (message: string) => {
        if (!alive()) return;
        close();
        setError(message);
      };

      source.addEventListener('token', (event) => {
        if (!alive()) return;
        const payload = parseJson<TokenPayload>((event as MessageEvent).data);
        const delta = payload?.delta;
        if (typeof delta === 'string' && delta !== '') {
          // 逐字追加：这是本页最关键的体验，不能攒到最后一次性显示
          setStreamText((previous) => previous + delta);
        }
      });

      source.addEventListener('message', (event) => {
        if (!alive()) return;
        const payload = parseJson<MessagePayload>((event as MessageEvent).data);
        if (!payload?.message) return;
        // 先清空临时气泡、再写入服务端完整消息：同一次事件里批处理，
        // 不会出现「临时气泡 + 正式气泡」两条并存的闪烁
        setStreamText('');
        handlerRef.current.onMessage(payload.message);
      });

      source.addEventListener('done', (event) => {
        if (!alive()) return;
        const payload = parseJson<DonePayload>((event as MessageEvent).data);
        close();
        handlerRef.current.onRoundDone({
          round: typeof payload?.round === 'number' ? payload.round : 0,
          is_last_round: Boolean(payload?.is_last_round),
        });
      });

      source.addEventListener('error', (event) => {
        if (!alive()) return;

        // 服务端显式 error 事件带 data；连接层错误是原生 Event，没有 data
        const raw = (event as MessageEvent).data;
        if (typeof raw === 'string' && raw !== '') {
          fail(parseJson<ErrorPayload>(raw)?.detail ?? 'AI 生成失败，请重试');
          return;
        }

        if (source.readyState === EventSource.CLOSED) {
          fail('连接已断开，请重试');
          return;
        }

        // 自动重连中：服务端有幂等保护，重连只会补齐没收到的那条 AI 消息
        reconnects += 1;
        if (reconnects > MAX_RECONNECT) fail('连接不稳定，已停止接收，请重试');
      });
    },
    [close, roomId],
  );

  // 卸载时关闭连接（否则会泄漏 SSE 连接，服务端也会一直生成下去）
  useEffect(() => () => close(), [close]);

  // 同一个页面组件被复用到另一个房间时（/debates/1 → /debates/2）也要关掉旧连接
  useEffect(() => {
    close();
  }, [close, roomId]);

  return { streaming, streamText, error, start, close };
}
