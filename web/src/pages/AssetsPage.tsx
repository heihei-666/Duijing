import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { AdvantageLibrary } from '@/features/assets/AdvantageLibrary';
import { EventCardHistory } from '@/features/assets/EventCardHistory';
import { PrincipleLibrary } from '@/features/assets/PrincipleLibrary';
import { SegmentedControl, type Segment } from '@/features/assets/SegmentedControl';
import { SettingsSection } from '@/features/assets/SettingsSection';

type TabKey = 'advantages' | 'principles' | 'events' | 'settings';

const SEGMENTS: Array<Segment<TabKey>> = [
  { key: 'advantages', label: '优势库' },
  { key: 'principles', label: '原则库' },
  { key: 'events', label: '事件卡' },
  { key: 'settings', label: '设置' },
];

const TAB_KEYS = SEGMENTS.map((segment) => segment.key);

function isTabKey(value: string | null): value is TabKey {
  return value !== null && (TAB_KEYS as string[]).includes(value);
}

/**
 * 资产（方案 2.2）：优势库 / 原则库 / 事件卡历史 / 设置。
 * 移动端用分段控件切换；`?tab=` 让「+ 记一笔」这类入口能直接落到对应分区
 * （弱点点「+ 记一笔」会跳 /assets?tab=events）。
 */
export default function AssetsPage() {
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<TabKey>(() => {
    const fromUrl = searchParams.get('tab');
    return isTabKey(fromUrl) ? fromUrl : 'advantages';
  });

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-lg font-medium text-primary">资产</h1>
        <p className="mt-1 text-[13px] leading-relaxed text-secondary">
          优势是拿来用的，原则是攒出来的。
        </p>
      </header>

      <SegmentedControl segments={SEGMENTS} value={tab} onChange={setTab} />

      {tab === 'advantages' ? <AdvantageLibrary /> : null}
      {tab === 'principles' ? <PrincipleLibrary /> : null}
      {tab === 'events' ? <EventCardHistory /> : null}
      {tab === 'settings' ? <SettingsSection /> : null}
    </div>
  );
}
