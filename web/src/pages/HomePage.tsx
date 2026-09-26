import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { observationApi, statusApi } from '@/api/client';
import type { StatusBar, TodayLoop } from '@/api/types';
import { Button } from '@/components/common/Button';
import { ActionSection } from '@/features/status-bar/ActionSection';
import { EnergySheet } from '@/features/status-bar/EnergySheet';
import { ObservationSection } from '@/features/status-bar/ObservationSection';
import { StatusHeader } from '@/features/status-bar/StatusHeader';
import { TodayLoopsSection } from '@/features/status-bar/TodayLoopsSection';

/**
 * 首页 = 状态栏（方案 3.7 / API GET /api/status-bar）。
 * 四块：日期+精力+连续天数 / 今天练什么 / AI 观察 / 两个入口。
 * 每块各自收形，空状态不喧哗。
 */
export default function HomePage() {
  const navigate = useNavigate();

  const [data, setData] = useState<StatusBar | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [energyOpen, setEnergyOpen] = useState(false);
  const [savingEnergy, setSavingEnergy] = useState(false);
  const [energyError, setEnergyError] = useState<string | null>(null);

  const [pendingObservationId, setPendingObservationId] = useState<number | null>(null);
  const [observationError, setObservationError] = useState<string | null>(null);

  /** silent = 后台刷新，不切成骨架屏（处理 AI 观察后用） */
  const load = useCallback(async (silent = false) => {
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    try {
      setData(await statusApi.getStatusBar());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '状态栏加载失败');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSaveEnergy = useCallback(async (energy: number) => {
    setSavingEnergy(true);
    setEnergyError(null);
    try {
      const saved = await statusApi.saveDailyState({ energy });
      // 用服务端返回值回填，避免前后端对「今天」的判定不一致
      setData((previous) => (previous ? { ...previous, energy: saved.energy } : previous));
      setEnergyOpen(false);
    } catch (cause) {
      setEnergyError(cause instanceof Error ? cause.message : '保存失败，请稍后再试');
    } finally {
      setSavingEnergy(false);
    }
  }, []);

  const handleObservation = useCallback(
    async (id: number, action: 'accept' | 'ignore') => {
      setPendingObservationId(id);
      setObservationError(null);
      try {
        if (action === 'accept') {
          await observationApi.accept(id);
        } else {
          await observationApi.ignore(id);
        }
        // 契约要求：处理完刷新状态栏（AI 观察块可能直接空了）；静默刷新，不闪骨架屏
        await load(true);
      } catch (cause) {
        setObservationError(cause instanceof Error ? cause.message : '操作失败，请稍后再试');
      } finally {
        setPendingObservationId(null);
      }
    },
    [load],
  );

  const handleSelectLoop = useCallback(
    (loop: TodayLoop) => {
      // TODO(弱点详情)：弱点详情页由同事实现；届时用 ?loop=<loop_id> 直接定位到该回环
      navigate(`/weaknesses/${loop.weakness_id}?loop=${loop.loop_id}`);
    },
    [navigate],
  );

  if (loading) return <HomeSkeleton />;

  if (error || !data) {
    return (
      <div className="rounded-2xl border border-light bg-surface p-6 text-center shadow-card">
        <p className="text-[13px] text-secondary">{error ?? '状态栏加载失败'}</p>
        <Button variant="outline" size="sm" className="mt-4" onClick={() => void load()}>
          重试
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <StatusHeader
        date={data.date}
        weekday={data.weekday}
        energy={data.energy}
        streakDays={data.streak_days}
        onEditEnergy={() => {
          setEnergyError(null);
          setEnergyOpen(true);
        }}
      />

      <TodayLoopsSection loops={data.today_loops} onSelect={handleSelectLoop} />

      <ObservationSection
        observations={data.observations}
        pendingId={pendingObservationId}
        error={observationError}
        onAccept={(id) => void handleObservation(id, 'accept')}
        onIgnore={(id) => void handleObservation(id, 'ignore')}
      />

      <ActionSection
        // TODO(辩论)：下一阶段直接进入新建辩论流程（POST /api/debates）
        onDebate={() => navigate('/debates')}
        // TODO(事件卡)：方案 3.4 的「记一笔」快速记录，落到资产页的事件卡入口
        // 带 ?tab=events 直接落到「事件卡」分区；
        // 不带的话用户还得在资产页再点一次分段控件，多一步无谓操作
        onRecord={() => navigate('/assets?tab=events')}
      />

      <EnergySheet
        open={energyOpen}
        value={data.energy}
        saving={savingEnergy}
        error={energyError}
        onClose={() => setEnergyOpen(false)}
        onSubmit={(energy) => void handleSaveEnergy(energy)}
      />
    </div>
  );
}

/** 首页骨架屏：只用中性底色，不闪烁彩色 */
function HomeSkeleton() {
  return (
    <div className="space-y-4" aria-busy>
      <div className="h-5 w-40 animate-pulse rounded bg-elevated" />
      <div className="h-28 animate-pulse rounded-2xl bg-elevated" />
      <div className="h-24 animate-pulse rounded-2xl bg-elevated" />
      <div className="h-24 animate-pulse rounded-2xl bg-elevated" />
    </div>
  );
}
