/**
 * 降智检测的纯函数：账号匹配、时间与数字格式化。不依赖 React，便于单测。
 */

import type { QualityAccountSummary, QualityVerdict } from '@/services/api/qualityProbe';

/**
 * 按邮箱和凭证文件名建立索引，给认证文件列表逐行查找用。
 * 优先邮箱：在面板上删掉重加的账号文件名会变（带新的随机前缀），邮箱不变。
 */
export const buildQualityIndex = (
  accounts: QualityAccountSummary[]
): Map<string, QualityAccountSummary> => {
  const index = new Map<string, QualityAccountSummary>();
  for (const account of accounts) {
    if (account.name) index.set(`name:${account.name}`, account);
  }
  // 邮箱后写，同名冲突时以邮箱匹配为准
  for (const account of accounts) {
    if (account.email) index.set(`email:${account.email.toLowerCase()}`, account);
  }
  return index;
};

export const findQualityAccount = (
  index: Map<string, QualityAccountSummary>,
  file: { name?: string; email?: string }
): QualityAccountSummary | undefined => {
  const email = typeof file.email === 'string' ? file.email.trim().toLowerCase() : '';
  return (
    (email ? index.get(`email:${email}`) : undefined) ??
    (file.name ? index.get(`name:${file.name}`) : undefined)
  );
};

/** 「MM-DD HH:mm」，同一年内足够区分，列表里省宽度。解析失败原样返回。 */
export const formatQualityTime = (ts: string): string => {
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return ts;
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** 耗时：60 秒以内显示「42s」，更长显示「3m05s」。 */
export const formatQualityElapsed = (seconds: number | null): string => {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m${String(s).padStart(2, '0')}s`;
};

/**
 * 推理 token 是否恰好停在降智特征值上。只认精确相等：
 * 实测也出现过 1034 这种接近倍数的值，但没有足够证据把它归为同一种截断，不强行标注。
 */
export const isDegradedReasoningMark = (tokens: number | null, mark: number): boolean =>
  tokens !== null && mark > 0 && tokens === mark;

/** 结论 → i18n 键后缀。 */
export const QUALITY_VERDICT_KEY: Record<QualityVerdict, string> = {
  pass: 'verdict_pass',
  degraded: 'verdict_degraded',
  failed: 'verdict_failed',
};
