import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { apiRequest } from '@/api/client';
import { Button } from '@/components/common/Button';

/**
 * 辩论邀请落地页 —— `/debate/join/:token`
 *
 * 为什么必须有这个页面：后端 `POST /api/debates/{id}/invite` 生成的链接是
 * `{base_url}/debate/join/{token}`，在此之前前端只有 `/join/:code`（注册邀请码页），
 * 两者路径不同 —— 邀请链接点开会直接落到 404，整条多人辩论链路是断的。
 *
 * 被邀请者需要登录（已与产品确认）：未登录时 RequireAuth 会先跳到
 * `/login?from=/debate/join/xxx`，登录后自动回到这里继续加入。
 */

interface JoinResult {
  room: { id: number; topic: string; participant_count?: number };
}

type Phase = 'joining' | 'done' | 'error';

export default function DebateJoinPage() {
  const { token = '' } = useParams<{ token: string }>();
  const navigate = useNavigate();

  const [phase, setPhase] = useState<Phase>('joining');
  const [message, setMessage] = useState('正在加入辩论房…');

  // 防止 React 严格模式下重复发起加入请求
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    let cancelled = false;

    async function join() {
      try {
        const result = await apiRequest<JoinResult>(`/debates/join/${token}`, {
          method: 'POST',
        });
        if (cancelled) return;

        setPhase('done');
        setMessage('已加入，正在进入辩论房…');
        // 用 replace，避免用户点返回又回到这个中间页再次触发加入
        navigate(`/debates/${result.room.id}`, { replace: true });
      } catch (error) {
        if (cancelled) return;
        setPhase('error');
        setMessage(error instanceof Error ? error.message : '加入失败，请重试');
      }
    }

    void join();
    return () => {
      cancelled = true;
    };
  }, [token, navigate]);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-base px-6">
      <section className="w-full max-w-sm rounded-2xl border border-light bg-surface p-6 text-center">
        {phase === 'error' ? (
          <>
            <h1 className="text-base font-medium text-primary">没能加入这个辩论房</h1>
            <p className="mt-2 text-[13px] leading-relaxed text-secondary">{message}</p>
            <p className="mt-1 text-xs text-tertiary">
              邀请链接可能已失效，或房间人数已满（最多 4 人）。
            </p>
            <div className="mt-5 space-y-2">
              <Button variant="primary" fullWidth onClick={() => navigate('/debates')}>
                去看看别的辩论
              </Button>
              <Button variant="ghost" fullWidth onClick={() => navigate('/')}>
                回到首页
              </Button>
            </div>
          </>
        ) : (
          <>
            {/* 中性色加载态，不喧哗 */}
            <div
              aria-hidden
              className="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-light border-t-primary"
            />
            <p className="mt-4 text-[13px] text-secondary">{message}</p>
          </>
        )}
      </section>
    </main>
  );
}
