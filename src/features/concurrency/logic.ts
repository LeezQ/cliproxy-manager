/**
 * 并发页的纯函数：时间窗口、账号配色、坐标刻度、认证文件列表的匹配。不依赖 React，便于单测。
 */

import type { ConcurrencyAccount } from '@/services/api/accountStats';

/** 可选的统计窗口（小时）及对应的桶宽（分钟）：每个窗口都控制在约 300 个点以内。 */
export const CONCURRENCY_WINDOWS = [
  { hours: 6, bucketMinutes: 1 },
  { hours: 24, bucketMinutes: 5 },
  { hours: 72, bucketMinutes: 15 },
  { hours: 168, bucketMinutes: 30 },
] as const;

export type ConcurrencyWindowHours = (typeof CONCURRENCY_WINDOWS)[number]['hours'];

export const bucketMinutesFor = (hours: number): number =>
  CONCURRENCY_WINDOWS.find((w) => w.hours === hours)?.bucketMinutes ?? 5;

/** 分类色槽位数（与 CSS 里的 --series-1..8 对应）。超过的账号循环会造成同色，改为灰色。 */
export const SERIES_SLOTS = 8;

/**
 * 给账号分配固定的颜色槽位：按凭证文件名排序后依次分配。
 * 颜色跟随账号而不是数值排名——切换时间窗口或数值变化时，同一个账号颜色不变。
 * 返回 1..SERIES_SLOTS；超出的账号返回 0（用中性灰，靠图例和表格区分）。
 */
export const assignSeriesSlots = (accounts: ConcurrencyAccount[]): Map<string, number> => {
  const slots = new Map<string, number>();
  [...accounts]
    .map((a) => a.name)
    .sort((a, b) => a.localeCompare(b))
    .forEach((name, i) => slots.set(name, i < SERIES_SLOTS ? i + 1 : 0));
  return slots;
};

/** 图上要画的账号：现存的账号，加上已删除但窗口内有流量的。 */
export const chartAccounts = (accounts: ConcurrencyAccount[]): ConcurrencyAccount[] =>
  accounts.filter((a) => a.exists || a.attempts > 0);

/** y 轴整数刻度：0..max，最多约 5 格，步长取 1/2/5 的倍数。 */
export const integerTicks = (max: number): number[] => {
  const top = Math.max(1, Math.ceil(max));
  const rough = top / 5;
  const pow = 10 ** Math.floor(Math.log10(Math.max(rough, 1)));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= rough) ?? pow * 10;
  const ticks: number[] = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  if (ticks[ticks.length - 1] < top) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
};

/** x 轴时间刻度间隔（毫秒）：让一屏大约 6–8 个标签。 */
export const timeTickStepMs = (spanMs: number): number => {
  const hour = 3_600_000;
  const candidates = [hour / 4, hour / 2, hour, 2 * hour, 3 * hour, 6 * hour, 12 * hour, 24 * hour];
  return candidates.find((step) => spanMs / step <= 8) ?? 24 * hour;
};

/** 刻度落在本地时间的整点（或整 15 分钟）上。 */
export const alignedTimeTicks = (startMs: number, endMs: number, stepMs: number): number[] => {
  const offset = new Date(startMs).getTimezoneOffset() * 60_000;
  const first = Math.ceil((startMs - offset) / stepMs) * stepMs + offset;
  const ticks: number[] = [];
  for (let t = first; t <= endMs; t += stepMs) ticks.push(t);
  return ticks;
};

/** 按邮箱（优先）或凭证文件名匹配认证文件列表里的账号。 */
export const buildConcurrencyIndex = (
  accounts: ConcurrencyAccount[]
): Map<string, ConcurrencyAccount> => {
  const index = new Map<string, ConcurrencyAccount>();
  for (const a of accounts) index.set(`name:${a.name}`, a);
  for (const a of accounts) if (a.exists) index.set(`email:${a.email.toLowerCase()}`, a);
  return index;
};

export const findConcurrency = (
  index: Map<string, ConcurrencyAccount>,
  file: { name?: string; email?: string }
): ConcurrencyAccount | undefined =>
  (file.name ? index.get(`name:${file.name}`) : undefined) ??
  (typeof file.email === 'string' && file.email
    ? index.get(`email:${file.email.trim().toLowerCase()}`)
    : undefined);
