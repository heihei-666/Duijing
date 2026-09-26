import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { observationApi, statusApi } from '@/api/client';
import type { StatusBar, TodayLoop } from '@/api/types';
import { Button } from '@/components/common/Button';
import { ActionSection } from '@/features/status-bar/ActionSection';
import { EnergySheet } from '@/features/status-bar/EnergySheet';
import { ObservationSection } from '@/features/status-bar/ObservationSection';
import { QuickDebateSheet } from '@/features/status-bar/QuickDebateSheet';
import { QuickEventCardSheet } from '@/features/status-bar/QuickEventCardSheet';
import { StatusHeader } from '@/features/status-bar/StatusHeader';
import { TodayLoopsSection } from '@/features/status-bar/TodayLoopsSection';

/**
 * 首页 = 状态栏（方案 3.7 / API GET /api/status-bar）。
 * 四块：日期+精力+连续天数 / 今天练什么 / AI 观察 / 两个入口。
 * 每块各自收形，空状态不喧哗。
 *
 * Cold start 改造：新用户注册后四块全是空的，光靠克制文案他不知道点哪。
 * 所以两个空状态各给一个「点了一定有结果」的入口，且都不跳页、不开新页面：
 *   今天练什么 → QuickDebateSheet（随机辩题 + 两个立场 → 直接进辩论房）
 *   AI 观察   → QuickEventCardSheet（只问一句话 → POST /api/event-cards）
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

  /** 即兴辩论 / 极简事件卡：两个空状态各自唤起一个 Sheet，都不跳页 */
  const [quickDebateOpen, setQuickDebateOpen] = useState(false);
  const [quickRecordOpen, setQuickRecordOpen] = useState(false);

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

  /**
   * 全新用户：两张卡片都空，且从未留下任何痕迹（由服务端判定）。
   * 这种情况下底部按钮与卡片内的行动重复，且会稀释焦点，所以隐藏。
   */
  const isFreshStart = data.is_fresh_start === true;

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

      <TodayLoopsSection
        loops={data.today_loops}
        onSelect={handleSelectLoop}
        onQuickDebate={() => setQuickDebateOpen(true)}
        spacious={isFreshStart}
      />

      <ObservationSection
        observations={data.observations}
        pendingId={pendingObservationId}
        error={observationError}
        onAccept={(id) => void handleObservation(id, 'accept')}
        onIgnore={(id) => void handleObservation(id, 'ignore')}
        onQuickRecord={() => setQuickRecordOpen(true)}
        spacious={isFreshStart}
      />

      {/*
        全新用户：底部两组全局快捷按钮与卡片里的行动重复
        （「和 AI 辩一轮」≈「开始」，「+ 记一笔」≈「记一笔」），
        同屏两个主色按钮会稀释「一个明确的行动」。
        所以这个阶段把它们藏起来，只留卡片里的两个入口；
        两张卡片也已经向下延伸填满原本的空间，不会显得头重脚轻。

        一旦用户留下任何痕迹就恢复显示——包括「记了几笔事件卡」这种情况：
        那种用户的两张卡片仍然是空的（事件卡要等夜间扫描才会变成观察），
        但他显然已经开始用了，不该再按全新用户对待。
      */}
      {isFreshStart ? (
        <p className="pt-1 text-center text-[11px] text-disabled">这是你的第一站</p>
      ) : (
        <ActionSection
          onDebate={() => navigate('/debates')}
          onRecord={() => navigate('/assets?tab=events')}
        />
      )}

      <QuickDebateSheet open={quickDebateOpen} onClose={() => setQuickDebateOpen(false)} />

      <QuickEventCardSheet
        open={quickRecordOpen}
        onClose={() => setQuickRecordOpen(false)}
        // 记完静默刷新：可能已经自动关联回环、写了日志，AI 观察块也可能变了
        onSaved={() => void load(true)}
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
