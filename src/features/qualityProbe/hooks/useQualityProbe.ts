/**
 * 降智检测的数据与操作：读取汇总、触发检测、检测进行中轮询任务进度。
 *
 * 认证文件页和降智检测页都用它：前者只读汇总（在每行显示最近一次结论），
 * 后者还会触发检测。检测由服务器后台执行，单个账号高推理强度下可能要几分钟，
 * 所以这里轮询任务状态，任务结束后再刷新一次汇总。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { qualityProbeApi, type QualityJob, type QualitySummary } from '@/services/api/qualityProbe';
import type { ApiError } from '@/types';

/** 检测进行中的轮询间隔。 */
const JOB_POLL_INTERVAL_MS = 5000;

export type QualityProbeState = {
  summary: QualitySummary | null;
  loading: boolean;
  /** 读取失败的原因；接口不存在（服务器没装 cpa-account serve）时为 'unavailable' */
  error: string | null;
  job: QualityJob | null;
  /** 触发检测中（请求已发出、尚未返回） */
  starting: boolean;
  refresh: () => Promise<void>;
  /** 开始检测；target 为 all 或凭证文件名。返回错误信息，成功为 null。 */
  run: (target: string) => Promise<string | null>;
};

/** 404 / 502 说明 Caddy 没转发或服务没起来，属于「功能不可用」而非一次性错误。 */
const isUnavailable = (err: unknown): boolean => {
  const status = (err as ApiError | undefined)?.status;
  return status === 404 || status === 502 || status === 503;
};

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : typeof err === 'string' ? err : 'unknown error';

export function useQualityProbe(options: { enabled?: boolean; days?: number } = {}) {
  const { enabled = true, days = 7 } = options;
  const [summary, setSummary] = useState<QualitySummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<QualityJob | null>(null);
  const [starting, setStarting] = useState(false);
  // 请求序号：快速切换天数或重复刷新时，只采用最后一次请求的结果
  const requestSeq = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const data = await qualityProbeApi.getSummary(days);
      if (seq !== requestSeq.current) return;
      setSummary(data);
      setJob(data.job);
      setError(null);
    } catch (err: unknown) {
      if (seq !== requestSeq.current) return;
      console.warn('[qualityProbe] 读取降智检测汇总失败', err);
      setError(isUnavailable(err) ? 'unavailable' : errorMessage(err));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
  }, [enabled, refresh]);

  // 检测进行中：定时拉任务进度；从 running 变成 done 时刷新汇总
  const running = job?.status === 'running';
  useEffect(() => {
    if (!enabled || !running) return;
    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const next = await qualityProbeApi.getJob();
        if (cancelled) return;
        setJob(next);
        if (next?.status !== 'running') void refresh();
      } catch (err: unknown) {
        // 单次轮询失败不打断，下一轮再试
        console.warn('[qualityProbe] 读取检测进度失败', err);
      }
    }, JOB_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled, running, refresh]);

  const run = useCallback(async (target: string): Promise<string | null> => {
    setStarting(true);
    try {
      const started = await qualityProbeApi.run(target);
      setJob(started);
      return null;
    } catch (err: unknown) {
      console.error('[qualityProbe] 开始检测失败', err);
      // 409：已有任务在跑，把它的进度接过来显示
      const details = (err as ApiError | undefined)?.details;
      if (details && typeof details === 'object' && 'job' in details) {
        try {
          setJob(await qualityProbeApi.getJob());
        } catch (jobErr: unknown) {
          console.warn('[qualityProbe] 读取进行中的检测失败', jobErr);
        }
      }
      return errorMessage(err);
    } finally {
      setStarting(false);
    }
  }, []);

  const state: QualityProbeState = { summary, loading, error, job, starting, refresh, run };
  return state;
}
