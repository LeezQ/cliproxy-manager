/**
 * 认证文件「列表视图」的纯逻辑：套餐识别与按提供商分组。
 *
 * 列表视图一行一个凭证，账号多时需要一眼分清套餐和所属提供商，
 * 这里的函数不依赖 React，便于单独测试。
 */

import type { AuthFileItem } from '@/types';
import { normalizeProviderKey } from '@/features/authFiles/constants';

/**
 * 凭证文件名末尾携带的套餐后缀，例如 `codex-xxxx-user@mail.com-pro.json`。
 * 后端落盘时按账号套餐命名；新账号尚未发出请求时可能先记成 free，
 * 跑过请求后后端会改名，因此这里只作展示用途，不参与任何调度判断。
 */
const PLAN_SUFFIXES = ['pro', 'plus', 'free', 'team', 'business', 'enterprise', 'max'] as const;

const PLAN_SUFFIX_PATTERN = new RegExp(`-(${PLAN_SUFFIXES.join('|')})\\.json$`, 'i');

/** 从文件名后缀识别套餐，识别不到返回空串。 */
export const deriveAuthFilePlan = (file: AuthFileItem): string => {
  const name = typeof file.name === 'string' ? file.name.trim() : '';
  const match = PLAN_SUFFIX_PATTERN.exec(name);
  return match ? match[1].toLowerCase() : '';
};

/** 付费高档位：列表里用主色强调，帮助一眼分出承载量大的账号。 */
const PREMIUM_PLANS = new Set(['pro', 'team', 'business', 'enterprise', 'max']);

export const isPremiumAuthFilePlan = (plan: string): boolean => PREMIUM_PLANS.has(plan);

/** 套餐的展示文本：首字母大写，如 pro → Pro。 */
export const formatAuthFilePlan = (plan: string): string =>
  plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : '';

export type AuthFileProviderGroup = {
  /** 归一化后的提供商 key，如 codex、claude。 */
  provider: string;
  files: AuthFileItem[];
};

/**
 * 按提供商分组，保持两层原有顺序：
 * - 分组按该提供商在列表中首次出现的位置排列；
 * - 组内保持传入顺序（即页面当前的排序结果）。
 */
export const groupAuthFilesByProvider = (files: AuthFileItem[]): AuthFileProviderGroup[] => {
  const groups = new Map<string, AuthFileItem[]>();
  for (const file of files) {
    const provider = normalizeProviderKey(String(file.type ?? file.provider ?? 'unknown'));
    const bucket = groups.get(provider);
    if (bucket) {
      bucket.push(file);
    } else {
      groups.set(provider, [file]);
    }
  }
  return Array.from(groups, ([provider, grouped]) => ({ provider, files: grouped }));
};
