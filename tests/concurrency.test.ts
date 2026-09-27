import { describe, expect, test } from 'bun:test';
import { normalizeConcurrencyStats } from '../src/services/api/accountStats';
import {
  alignedTimeTicks,
  assignSeriesSlots,
  bucketMinutesFor,
  buildConcurrencyIndex,
  chartAccounts,
  findConcurrency,
  integerTicks,
  timeTickStepMs,
} from '../src/features/concurrency/logic';

// 字段形状与服务器 cpa-account serve 的 /account-stats/concurrency 返回一致（snake_case）
const raw = {
  generated_at: '2026-09-27T21:00:00+08:00',
  hours: 24,
  bucket_minutes: 5,
  bucket_starts: ['2026-09-27T20:50:00+08:00', '2026-09-27T20:55:00+08:00'],
  log_from: '2026-09-26T20:32:13+08:00',
  accounts: [
    {
      name: 'codex-2222-b@example.com-pro.json',
      email: 'b@example.com',
      plan: 'pro',
      exists: true,
      disabled: false,
      current: 2,
      peak: 7,
      peak_at: '2026-09-27T10:26:00+08:00',
      today_peak: 7,
      avg_busy: 1.59,
      attempts: 5202,
      buckets: [3, 2, 9],
    },
    {
      name: 'codex-1111-a@example.com-plus.json',
      email: 'a@example.com',
      exists: false,
      attempts: 0,
      buckets: [0, 0],
    },
    { email: 'no-name' },
  ],
};

describe('concurrency normalize', () => {
  test('converts fields and trims buckets to the time axis', () => {
    const stats = normalizeConcurrencyStats(raw);
    expect(stats.bucketStartsMs).toHaveLength(2);
    expect(stats.accounts).toHaveLength(2);
    const b = stats.accounts[0];
    expect(b.todayPeak).toBe(7);
    expect(b.avgBusy).toBe(1.59);
    expect(b.peakAtMs).toBe(Date.parse('2026-09-27T10:26:00+08:00'));
    // 多出来的第三个桶没有对应时间，被截掉
    expect(b.buckets).toEqual([3, 2]);
    expect(stats.accounts[1].exists).toBe(false);
    expect(normalizeConcurrencyStats(null).accounts).toEqual([]);
  });
});

describe('concurrency logic', () => {
  const stats = normalizeConcurrencyStats(raw);

  test('removed accounts without traffic are not charted', () => {
    expect(chartAccounts(stats.accounts).map((a) => a.email)).toEqual(['b@example.com']);
  });

  test('series slots follow the account name, not the value order', () => {
    const slots = assignSeriesSlots(stats.accounts);
    // a 排在 b 前面：不管谁的并发高，a 总是槽位 1
    expect(slots.get('codex-1111-a@example.com-plus.json')).toBe(1);
    expect(slots.get('codex-2222-b@example.com-pro.json')).toBe(2);
    const many = Array.from({ length: 10 }, (_, i) => ({
      ...stats.accounts[0],
      name: `codex-${String(i).padStart(2, '0')}.json`,
    }));
    expect(assignSeriesSlots(many).get('codex-09.json')).toBe(0);
  });

  test('integer ticks cover the max with a round step', () => {
    expect(integerTicks(0)).toEqual([0, 1]);
    expect(integerTicks(7)).toEqual([0, 2, 4, 6, 8]);
    expect(integerTicks(10)).toEqual([0, 2, 4, 6, 8, 10]);
  });

  test('time ticks land on round local times', () => {
    const start = new Date(2026, 8, 27, 9, 13).getTime();
    const end = start + 24 * 3_600_000;
    const step = timeTickStepMs(end - start);
    expect(step).toBe(3 * 3_600_000);
    const ticks = alignedTimeTicks(start, end, step);
    expect(new Date(ticks[0]).getMinutes()).toBe(0);
    expect(ticks.length).toBeLessThanOrEqual(9);
  });

  test('bucket width per window', () => {
    expect(bucketMinutesFor(6)).toBe(1);
    expect(bucketMinutesFor(168)).toBe(30);
    expect(bucketMinutesFor(999)).toBe(5);
  });

  test('auth file rows match by file name first, then email', () => {
    const index = buildConcurrencyIndex(stats.accounts);
    expect(findConcurrency(index, { name: 'codex-2222-b@example.com-pro.json' })?.current).toBe(2);
    expect(
      findConcurrency(index, { name: 'codex-new.json', email: 'B@example.com' })?.current
    ).toBe(2);
    // 已删除账号不参与邮箱匹配，避免把旧文件的数据挂到同邮箱的新账号上
    expect(findConcurrency(index, { name: 'x.json', email: 'a@example.com' })).toBeUndefined();
  });
});
