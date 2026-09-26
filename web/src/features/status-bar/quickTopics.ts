/**
 * 即兴辩论题池（首页 Cold start 改造 · 任务 2）。
 *
 * 选题目标准（三条同时满足，否则不进池子）：
 *   1. 零背景知识 —— 不问政策、不问专业、不问新闻，任何人张口就能说；
 *   2. 谁都有话说 —— 工作 / 关系 / 情绪 / 决策 / 自律，都是自己身上发生过的事；
 *   3. 有真实张力 —— 两边都站得住，不是「显然 A 对」的假选择。
 *
 * 刻意排除：「该不该支持某项政策」「XX 行业该不该被监管」这类需要背景知识的题目。
 *
 * 一道题只有两个立场（按钮就两个，点哪个都立刻开局），
 * 立场文案要短到能当按钮，并且自带态度、不用再解释。
 */

export interface QuickTopic {
  /** 辩题，一句话，自带问号 */
  topic: string;
  /** 恰好两个立场，直接作为按钮文案与 POST /api/debates 的 stance */
  stances: [string, string];
}

export const QUICK_TOPICS: readonly QuickTopic[] = [
  { topic: '早睡靠自律还是靠环境？', stances: ['靠自律', '靠环境'] },
  { topic: '工作里该不该把情绪写在脸上？', stances: ['写在脸上', '收起来'] },
  { topic: '朋友总是迟到，该不该说出来？', stances: ['说出来', '不说了'] },
  { topic: '做重要决定，该信直觉还是先列利弊？', stances: ['信直觉', '列利弊'] },
  { topic: '难过的时候，找人倾诉还是自己消化？', stances: ['找人倾诉', '自己消化'] },
  { topic: '工作和生活该不该彻底分开？', stances: ['该分开', '分不开'] },
  { topic: '别人夸你，该不该当真？', stances: ['该当真', '听听就好'] },
  { topic: '一件事第一次没做好，还要不要再来一次？', stances: ['再来一次', '换个方向'] },
  { topic: '关系里，实话该不该全说？', stances: ['全说', '留一点'] },
  { topic: '给自己定计划，该定紧一点还是松一点？', stances: ['紧一点', '松一点'] },
];

/** 随机取一个题目下标；传 exclude 时保证换一题不会又抽到同一题 */
export function pickQuickTopicIndex(exclude?: number): number {
  const total = QUICK_TOPICS.length;
  if (total <= 1) return 0;

  const start = Math.floor(Math.random() * total);
  if (exclude === undefined || start !== exclude) return start;

  // 抽到同一题就从它的下一位顺延，避免连续两次看到同一题
  return (start + 1) % total;
}

/** 按下标取题，越界回退到第一题（不抛错，Sheet 不该因为一个下标挂掉） */
export function getQuickTopic(index: number): QuickTopic {
  if (!Number.isInteger(index) || index < 0 || index >= QUICK_TOPICS.length) {
    return QUICK_TOPICS[0];
  }
  return QUICK_TOPICS[index];
}
