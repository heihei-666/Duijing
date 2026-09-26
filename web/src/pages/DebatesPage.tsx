import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import type { DebateRoom } from '@/api/types';
import { Button } from '@/components/common/Button';
import { EmptyState } from '@/components/common/EmptyState';
import { DebateListItem } from '@/features/debate/DebateListItem';
import { NewDebateSheet } from '@/features/debate/NewDebateSheet';
import {
  createDebateFromSource,
  getDebateSuggestion,
  listDebates,
  type DebateSuggestion,
} from '@/features/debate/api';
import { PlusIcon } from '@/features/debate/icons';

/**
 * 辩论 Tab（方案 3.1）。三个分区：
 *   新辩论 —— 入口按钮 + Sheet 表单。Sheet 里四个辩题来源：
 *             从回环起辩（P1）/ 刚发生的事（P2）/ 描述场景 / 自己出题（P0），
 *             前两个是一键发起，不需要用户输入
 *   进行中 —— status_filter=active,paused
 *   历史   —— status_filter=finished
 *
 * 查询参数用 `status_filter`（逗号分隔多值）而不是契约表里写的 `status`：
 * 后端 `GET /api/debates` 读的是 status_filter，传 status 会被忽略并返回全部，
 * 详见 features/debate/api.ts 文件头。
 */
export default function DebatesPage() {
  const navigate = useNavigate();

  const [active, setActive] = useState<DebateRoom[]>([]);
  const [history, setHistory] = useState<DebateRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  /**
   * 辩题来源 P3 的建议。只在「连续几天没开辩 + 有弱点」时后端才给，
   * 其余情况 reason 会说明原因，这里就不显示。
   */
  const [suggestion, setSuggestion] = useState<DebateSuggestion | null>(null);
  const [startingSuggestion, setStartingSuggestion] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [current, finished] = await Promise.all([
        listDebates('active,paused'),
        listDebates('finished'),
      ]);
      setActive(current.rooms ?? []);
      setHistory(finished.rooms ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '辩论列表加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    getDebateSuggestion()
      .then((data) => {
        if (!cancelled && data.reason === 'ok' && data.topic) setSuggestion(data);
      })
      // 建议拿不到就算了，它只是锦上添花，不该影响辩论页本身
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  /** 一键接下 AI 出的这道题。 */
  const acceptSuggestion = useCallback(async () => {
    if (!suggestion) return;
    setStartingSuggestion(true);
    try {
      // 返回的是 { room, first_message } 信封，不是 room 本身
      const { room } = await createDebateFromSource({
        topic: suggestion.topic,
        stance: suggestion.stance,
      });
      navigate(`/debates/${room.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '没能开始，请稍后再试');
      setStartingSuggestion(false);
    }
  }, [navigate, suggestion]);

  const openRoom = useCallback(
    (id: number) => {
      navigate(`/debates/${id}`);
    },
    [navigate],
  );

  return (
    <section className="space-y-6">
      <header className="space-y-1.5">
        <h1 className="text-lg font-medium text-primary">辩论</h1>
        <p className="text-[13px] leading-relaxed text-secondary">
          和 AI 辩一轮，照见自己在被追问时的样子。
        </p>
      </header>

      {/*
        AI 出的题放在最上面 —— 它比「开一场新的辩论」更具体：
        用户不需要想辩什么，看一眼就能决定接不接。
        但它只是建议，所以「先不用」必须同样显眼，不能做成隐藏入口。
      */}
      {suggestion ? (
        <section className="rounded-2xl border border-info-light bg-surface p-4 shadow-card">
          <p className="text-xs text-info">AI 给你出了一道题</p>
          <p className="mt-2 text-[15px] leading-relaxed text-primary">{suggestion.topic}</p>
          <p className="mt-1.5 text-xs leading-relaxed text-tertiary">
            这几天没开辩，这道题基于你在留意的
            {suggestion.based_on ? `「${suggestion.based_on.weakness_name}」` : '弱点库'}
            。
          </p>
          <div className="mt-3 flex gap-2">
            <Button onClick={() => void acceptSuggestion()} loading={startingSuggestion}>
              就辩这个
            </Button>
            <Button variant="ghost" onClick={() => setSuggestion(null)} disabled={startingSuggestion}>
              先不用
            </Button>
          </div>
        </section>
      ) : null}

      <div className="space-y-2.5">
        <h2 className="text-xs text-tertiary">新辩论</h2>
        <Button size="lg" fullWidth onClick={() => setSheetOpen(true)}>
          <PlusIcon />
          开一场新的辩论
        </Button>
        <p className="text-xs leading-relaxed text-tertiary">
          从正在练的回环、刚记下的一件事起辩，也可以自己出题。回合数由 AI 按辩题复杂度决定，落在 4–8 轮。
        </p>
      </div>

      {error ? (
        <div className="rounded-2xl border border-light bg-surface p-6 text-center shadow-card">
          <p className="text-[13px] text-secondary">{error}</p>
          <Button variant="outline" className="mt-4" onClick={() => void load()}>
            重试
          </Button>
        </div>
      ) : loading ? (
        <DebatesSkeleton />
      ) : (
        <>
          <section className="space-y-2.5">
            <h2 className="flex items-baseline justify-between text-xs text-tertiary">
              <span>进行中</span>
              {active.length > 0 ? <span className="tabular-nums">{active.length}</span> : null}
            </h2>
            {active.length === 0 ? (
              <EmptyState title="现在没有进行中的辩论" hint="开一场，随时能暂停，回来接着辩。" />
            ) : (
              <ul className="space-y-2.5">
                {active.map((room) => (
                  <DebateListItem key={room.id} room={room} onOpen={openRoom} />
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-2.5">
            <h2 className="flex items-baseline justify-between text-xs text-tertiary">
              <span>历史</span>
              {history.length > 0 ? <span className="tabular-nums">{history.length}</span> : null}
            </h2>
            {history.length === 0 ? (
              <EmptyState title="还没有结束的辩论" hint="结束并复盘后，会留在这里。" />
            ) : (
              <ul className="space-y-2.5">
                {history.map((room) => (
                  <DebateListItem key={room.id} room={room} onOpen={openRoom} />
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      <NewDebateSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        onCreated={(room) => {
          setSheetOpen(false);
          // 新房间已经有 AI 开场白，直接进房间（进入后 GET 详情会带上第一条消息）
          navigate(`/debates/${room.id}`);
        }}
      />
    </section>
  );
}

/** 骨架屏只用中性底色，不闪彩色 */
function DebatesSkeleton() {
  return (
    <div className="space-y-2.5" aria-busy>
      <div className="h-4 w-16 animate-pulse rounded bg-elevated" />
      <div className="h-20 animate-pulse rounded-2xl bg-elevated" />
      <div className="h-20 animate-pulse rounded-2xl bg-elevated" />
    </div>
  );
}
