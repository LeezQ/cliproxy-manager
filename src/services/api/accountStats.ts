/**
 * 账号统计 API（目前是并发）。
 *
 * 与降智检测一样，后端不是 CPA 本身，而是服务器上的 `cpa-account serve`，由 Caddy 把
 * `/v0/management/account-stats/*` 转发过去，因此直接复用 apiClient 的前缀与管理密钥。
 *
 * CPA 单机模式不统计每个凭证正在处理的请求数，这里的数据由服务器从 CPA 日志反推：
 * 每次选号（selector）到它结束（上游失败或最终响应）算一个区间，按账号叠加即为并发。
 * 日志时间只精确到秒，短请求的并发会略偏高。详见 DEPLOYMENT.md 7.7。
 */

import { apiClient } from './client';
import { isRecord } from '@/utils/helpers';

export interface ConcurrencyAccount {
  /** 凭证文件名 */
  name: string;
  email: string;
  plan: string;
  /** 账号已被删除、只在日志里出现过时为 false */
  exists: boolean;
  disabled: boolean;
  /** 正在处理的请求数 */
  current: number;
  /** 统计窗口内的峰值及其时间（毫秒时间戳） */
  peak: number;
  peakAtMs: number | null;
  /** 今天（服务器时区 0 点起）的峰值 */
  todayPeak: number;
  /** 忙时平均：只算手上有请求的时间，反映「干活时同时接几个」 */
  avgBusy: number | null;
  /** 窗口内被选中的次数（含失败后换号的） */
  attempts: number;
  /** 每个时间桶内的峰值，与 bucketStartsMs 一一对应 */
  buckets: number[];
}

export interface ConcurrencyStats {
  generatedAtMs: number | null;
  hours: number;
  bucketMinutes: number;
  bucketStartsMs: number[];
  /** 读到的最早一行日志的时间：早于它的时段没有数据 */
  logFromMs: number | null;
  accounts: ConcurrencyAccount[];
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const timeMs = (value: unknown): number | null => {
  const text = str(value);
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
};

export const normalizeConcurrencyAccount = (value: unknown): ConcurrencyAccount | null => {
  if (!isRecord(value)) return null;
  const name = str(value.name);
  if (!name) return null;
  return {
    name,
    email: str(value.email) || name,
    plan: str(value.plan),
    exists: value.exists !== false,
    disabled: value.disabled === true,
    current: num(value.current) ?? 0,
    peak: num(value.peak) ?? 0,
    peakAtMs: timeMs(value.peak_at),
    todayPeak: num(value.today_peak) ?? 0,
    avgBusy: num(value.avg_busy),
    attempts: num(value.attempts) ?? 0,
    buckets: Array.isArray(value.buckets) ? value.buckets.map((b) => num(b) ?? 0) : [],
  };
};

export const normalizeConcurrencyStats = (value: unknown): ConcurrencyStats => {
  const data = isRecord(value) ? value : {};
  const bucketStartsMs = Array.isArray(data.bucket_starts)
    ? data.bucket_starts.map(timeMs).filter((ms): ms is number => ms !== null)
    : [];
  return {
    generatedAtMs: timeMs(data.generated_at),
    hours: num(data.hours) ?? 24,
    bucketMinutes: num(data.bucket_minutes) ?? 5,
    bucketStartsMs,
    logFromMs: timeMs(data.log_from),
    accounts: Array.isArray(data.accounts)
      ? data.accounts
          .map(normalizeConcurrencyAccount)
          .filter((a): a is ConcurrencyAccount => a !== null)
          // 桶数与时间轴不一致的账号数据按时间轴截齐，避免图表错位
          .map((a) => ({ ...a, buckets: a.buckets.slice(0, bucketStartsMs.length) }))
      : [],
  };
};

export const accountStatsApi = {
  /**
   * 各账号并发。hours 为统计窗口，bucketMinutes 为图表每个点代表的时长
   * （后端只接受 1 / 5 / 10 / 15 / 30 / 60）。服务器端缓存 20 秒。
   */
  async getConcurrency(hours = 24, bucketMinutes = 5): Promise<ConcurrencyStats> {
    const data = await apiClient.get('/account-stats/concurrency', {
      params: { hours, bucket: bucketMinutes },
    });
    return normalizeConcurrencyStats(data);
  },
};
