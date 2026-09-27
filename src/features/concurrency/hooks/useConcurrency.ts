/**
 * 读取各账号并发，并按间隔自动刷新。
 *
 * 并发页和认证文件列表都用它。数据由服务器从 CPA 日志反推，服务端缓存 20 秒，
 * 所以刷新间隔不必小于 20 秒。服务未部署（404/502）时标为 unavailable，调用方静默降级。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { accountStatsApi, type ConcurrencyStats } from '@/services/api/accountStats';
import type { ApiError } from '@/types';

export type ConcurrencyState = {
  stats: ConcurrencyStats | null;
  loading: boolean;
  /** 'unavailable' 表示服务没部署；其它为一次性错误的说明 */
  error: string | null;
  refresh: () => Promise<void>;
};

const isUnavailable = (err: unknown): boolean => {
  const status = (err as ApiError | undefined)?.status;
  return status === 404 || status === 502 || status === 503;
};

export function useConcurrency(
  options: { enabled?: boolean; hours?: number; bucketMinutes?: number; refreshMs?: number } = {}
): ConcurrencyState {
  const { enabled = true, hours = 24, bucketMinutes = 5, refreshMs = 30_000 } = options;
  const [stats, setStats] = useState<ConcurrencyStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 请求序号：切换窗口时旧请求晚到，不能覆盖新窗口的数据
  const seqRef = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    try {
      const data = await accountStatsApi.getConcurrency(hours, bucketMinutes);
      if (seq !== seqRef.current) return;
      setStats(data);
      setError(null);
    } catch (err: unknown) {
      if (seq !== seqRef.current) return;
      console.warn('[concurrency] 读取账号并发失败', err);
      setError(
        isUnavailable(err) ? 'unavailable' : err instanceof Error ? err.message : String(err)
      );
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [hours, bucketMinutes]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    if (refreshMs <= 0) return;
    const timer = window.setInterval(() => {
      // 页面在后台时不刷新，回到前台的下一次定时再取
      if (document.visibilityState === 'visible') void refresh();
    }, refreshMs);
    return () => window.clearInterval(timer);
  }, [enabled, refresh, refreshMs]);

  return { stats, loading, error, refresh };
}
