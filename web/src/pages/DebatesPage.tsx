import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import type { DebateRoom } from '@/api/types';
import { Button } from '@/components/common/Button';
import { EmptyState } from '@/components/common/EmptyState';
import { DebateListItem } from '@/features/debate/DebateListItem';
import { NewDebateSheet } from '@/features/debate/NewDebateSheet';
import { listDebates } from '@/features/debate/api';
import { PlusIcon } from '@/features/debate/icons';

/**
 * 辩论 Tab（方案 3.1）。三个分区：
 *   新辩论 —— 入口按钮 + Sheet 表单（自己出题 / 描述场景，都属于 P0）
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

      <div className="space-y-2.5">
        <h2 className="text-xs text-tertiary">新辩论</h2>
        <Button size="lg" fullWidth onClick={() => setSheetOpen(true)}>
          <PlusIcon />
          开一场新的辩论
        </Button>
        <p className="text-xs leading-relaxed text-tertiary">
          自己出题，或者描述一个场景。回合数由 AI 按辩题复杂度决定，落在 4–8 轮。
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
