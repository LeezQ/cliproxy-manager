/**
 * 降智检测 API。
 *
 * 后端不是 CPA 本身，而是服务器上的 `cpa-account serve`（127.0.0.1:8318），由 Caddy 把
 * `/v0/management/quality-probe/*` 转发过去。挂在 /v0/management 下，是为了直接复用
 * apiClient 的 baseURL 与管理密钥请求头，并沿用 Caddy 的管理面 IP 白名单。
 *
 * 检测方式：给每个账号单独出一道固定的糖果逻辑题（正确答案 21），记录答案与推理 token。
 * 降智时推理 token 常被卡在 516，答案多为 29。详见仓库 DEPLOYMENT.md 7.6。
 *
 * 返回的数据都先经过 normalize：接口由独立脚本提供，字段缺失或类型不对时按「无数据」处理，
 * 不让一条坏记录把整个页面弄崩。
 */

import { apiClient } from './client';
import { isRecord } from '@/utils/helpers';

const BASE = '/quality-probe';

/** 单次检测的结论：答对 / 答错（降智）/ 没测成（超时、网络、过载、令牌）。 */
export type QualityVerdict = 'pass' | 'degraded' | 'failed';

/** 一条检测记录。 */
export interface QualityRecord {
  /** 检测开始时间（ISO 8601，带时区） */
  ts: string;
  email: string;
  name: string;
  plan: string;
  /** 本次请求实际使用的出口 IP */
  exit: string;
  model: string;
  effort: string;
  verdict: QualityVerdict;
  answer: number | null;
  reasoningTokens: number | null;
  outputTokens: number | null;
  /** 耗时（秒） */
  elapsed: number | null;
  /** 没测成时的原因 */
  error: string;
  /** 回答末尾一段，用来核对判定 */
  answerTail: string;
}

/** 单个账号在统计窗口内的汇总。 */
export interface QualityAccountSummary {
  email: string;
  name: string;
  plan: string;
  exit: string;
  /** 记录总数（含没测成的） */
  total: number;
  /** 有效次数：答对 + 答错 */
  valid: number;
  passed: number;
  /** 正确率 0–100；没有有效记录时为 null */
  rate: number | null;
  medianReasoning: number | null;
  last: QualityRecord | null;
  /** 最近一次拿到结论（正常或降智）的记录；从没测成过为 null */
  lastValid: QualityRecord | null;
  /** 最近若干次的结论，旧的在前 */
  trend: QualityVerdict[];
}

/** 网页触发的一轮检测。 */
export interface QualityJob {
  id: string;
  status: 'running' | 'done';
  /** all 或凭证文件名 */
  target: string;
  model: string;
  effort: string;
  startedAt: string;
  finishedAt: string | null;
  /** 还没出结果的账号 */
  pending: string[];
  records: QualityRecord[];
  error: string;
}

export interface QualitySummary {
  days: number;
  expectedAnswer: number;
  /** 社区观察到的降智特征值（推理 token） */
  degradedReasoningMark: number;
  model: string;
  effort: string;
  accounts: QualityAccountSummary[];
  job: QualityJob | null;
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** 有限数字，否则 null（耗时是小数，token 数是整数，都走这里）。 */
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** 后端用中文结论写日志（命令行直接可读），这里映射成前端的枚举。 */
const VERDICT_MAP: Record<string, QualityVerdict> = {
  正常: 'pass',
  降智: 'degraded',
  失败: 'failed',
};

export const normalizeQualityVerdict = (value: unknown): QualityVerdict =>
  VERDICT_MAP[str(value)] ?? 'failed';

export const normalizeQualityRecord = (value: unknown): QualityRecord | null => {
  if (!isRecord(value)) return null;
  const ts = str(value.ts);
  if (!ts) return null;
  return {
    ts,
    email: str(value.email),
    name: str(value.name),
    plan: str(value.plan),
    exit: str(value.exit),
    model: str(value.model),
    effort: str(value.effort),
    verdict: normalizeQualityVerdict(value.verdict),
    answer: num(value.answer),
    reasoningTokens: num(value.reasoning_tokens),
    outputTokens: num(value.output_tokens),
    elapsed: num(value.elapsed),
    error: str(value.error),
    answerTail: str(value.answer_tail),
  };
};

const normalizeRecords = (value: unknown): QualityRecord[] =>
  Array.isArray(value)
    ? value.map(normalizeQualityRecord).filter((r): r is QualityRecord => r !== null)
    : [];

export const normalizeQualityAccount = (value: unknown): QualityAccountSummary | null => {
  if (!isRecord(value)) return null;
  const email = str(value.email);
  const name = str(value.name);
  if (!email && !name) return null;
  return {
    email,
    name,
    plan: str(value.plan),
    exit: str(value.exit),
    total: num(value.total) ?? 0,
    valid: num(value.valid) ?? 0,
    passed: num(value.passed) ?? 0,
    rate: num(value.rate),
    medianReasoning: num(value.median_reasoning),
    last: normalizeQualityRecord(value.last),
    lastValid: normalizeQualityRecord(value.last_valid),
    trend: Array.isArray(value.trend) ? value.trend.map(normalizeQualityVerdict) : [],
  };
};

export const normalizeQualityJob = (value: unknown): QualityJob | null => {
  if (!isRecord(value)) return null;
  const id = str(value.id);
  if (!id) return null;
  return {
    id,
    status: value.status === 'running' ? 'running' : 'done',
    target: str(value.target),
    model: str(value.model),
    effort: str(value.effort),
    startedAt: str(value.started_at),
    finishedAt: str(value.finished_at) || null,
    pending: Array.isArray(value.pending) ? value.pending.map(str).filter(Boolean) : [],
    records: normalizeRecords(value.records),
    error: str(value.error),
  };
};

export const normalizeQualitySummary = (value: unknown): QualitySummary => {
  const data = isRecord(value) ? value : {};
  return {
    days: num(data.days) ?? 7,
    expectedAnswer: num(data.expected_answer) ?? 21,
    degradedReasoningMark: num(data.degraded_reasoning_mark) ?? 516,
    model: str(data.model),
    effort: str(data.effort),
    accounts: Array.isArray(data.accounts)
      ? data.accounts
          .map(normalizeQualityAccount)
          .filter((a): a is QualityAccountSummary => a !== null)
      : [],
    job: normalizeQualityJob(data.job),
  };
};

export const qualityProbeApi = {
  /** 各账号汇总 + 当前任务。 */
  async getSummary(days = 7): Promise<QualitySummary> {
    const data = await apiClient.get(`${BASE}/summary`, { params: { days } });
    return normalizeQualitySummary(data);
  },

  /** 最近的原始记录，新的在前。 */
  async getRecords(limit = 100, email?: string): Promise<QualityRecord[]> {
    const data = await apiClient.get(`${BASE}/records`, {
      params: email ? { limit, email } : { limit },
    });
    return normalizeRecords(isRecord(data) ? data.records : undefined);
  },

  /** 当前 / 最近一次网页触发的检测任务。 */
  async getJob(): Promise<QualityJob | null> {
    const data = await apiClient.get(`${BASE}/job`);
    return normalizeQualityJob(isRecord(data) ? data.job : undefined);
  },

  /**
   * 开始一轮检测，立即返回；结果通过 getJob 轮询。
   * target 为 all 或凭证文件名。已有任务在跑时后端返回 409。
   */
  async run(target: string): Promise<QualityJob | null> {
    const data = await apiClient.post(`${BASE}/run`, { target });
    return normalizeQualityJob(isRecord(data) ? data.job : undefined);
  },
};
