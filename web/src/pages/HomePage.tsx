import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { observationApi, statusApi } from '@/api/client';
import type { StatusBar, TodayLoop } from '@/api/types';
import { Button } from '@/components/common/Button';
import { ActionSection } from '@/features/status-bar/ActionSection';
import { EnergySheet } from '@/features/status-bar/EnergySheet';
import { EventCardHero } from '@/features/status-bar/EventCardHero';
import { GreetingLine } from '@/features/status-bar/GreetingLine';
import { ObservationSection } from '@/features/status-bar/ObservationSection';
import { PastYouSection } from '@/features/status-bar/PastYouSection';
import { QuickDebateSheet } from '@/features/status-bar/QuickDebateSheet';
import { QuickEventCardSheet } from '@/features/status-bar/QuickEventCardSheet';
import { StatusHeader } from '@/features/status-bar/StatusHeader';
import { TodayLoopsSection } from '@/features/status-bar/TodayLoopsSection';

/**
 * 首页 = 状态栏（方案 3.7 / API GET /api/status-bar）。
 *
 * 【本轮重排的理由（真实用户反馈）】
 *
 * 反馈是「不知道每天来干嘛」。原来首页第一行动是「和 AI 辩一轮」，
 * 门槛高到只有状态最好的那 5 分钟才够得上；而「记一笔」只要一句话。
 * 留存不是靠每天辩一场建立的，是靠「今天也来了一下」建立的。
 *
 * 所以现在的顺序是：
 *   日期 → 一句问候 → **记一笔（最低门槛）** → 过去的你（锚点）
 *   → 今天练什么 → AI 观察 → 辩一轮（门槛最高，放最后）
 *
 * 分工（每块各自收形，空状态不喧哗）：
 *   记一笔   → QuickEventCardSheet（一句话，不跳页）
 *   今天练什么 → QuickDebateSheet（随机辩题 + 两个立场 → 直接进辩论房）
 *   AI 观察  → 直接在这块里「加入 / 忽略」
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

      {/* 先说话，再给数据 —— 首页不该像一个业绩看板 */}
      <GreetingLine text={data.greeting} />

      {/*
        入口顺序按**门槛从低到高**排：先一句话（事件卡），再一场辩论。
        原来第一行动是「和 AI 辩一轮」，它要求用户正好处在状态最好的 5 分钟，
        而留存从来不是靠那 5 分钟建立的，是靠「今天也来了一下」。
      */}
      <EventCardHero onRecord={() => setQuickRecordOpen(true)} />

      {/* 「过去的你」：跨时间对比。历史不足时服务端给 null，整块不渲染 */}
      {data.past_you ? <PastYouSection data={data.past_you} /> : null}

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
        // 全新用户**不给**这个按钮：上面已经有「记一笔」主按钮了，
        // 同屏两个「记一笔」会让人不知道该点哪个（这是看真实截图才发现的，
        // 光读代码看不出来）。空态退回纯解释文案。
        onQuickRecord={isFreshStart ? undefined : () => setQuickRecordOpen(true)}
        spacious={isFreshStart}
      />

      {/*
        全新用户：底部快捷按钮与卡片里的行动重复，同屏两个主色按钮会稀释焦点，
        所以这个阶段藏起来，只留卡片里的入口。

        一旦用户留下任何痕迹就恢复——包括「记了几笔事件卡」这种情况：
        那种用户的两张卡片仍然是空的（事件卡要等夜间扫描才会变成观察），
        但他显然已经开始用了，不该再按全新用户对待。
      */}
      {isFreshStart ? (
        <p className="pt-1 text-center text-[11px] text-disabled">这是你的第一站</p>
      ) : (
        // 这里只剩辩论入口：记一笔已经提到首页最上面（EventCardHero），
        // 同屏两个「记一笔」会让用户犹豫点哪个。
        <ActionSection onDebate={() => navigate('/debates')} />
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
