/**
 * 配额页列表行账号下方那一行的数据：套餐、续期时间、剩余主动重置次数。
 *
 * 卡片里这三项是纵向三行 chip，放进列表会让每行高出一倍；列表只要一行摘要，
 * 完整信息（续期的绝对时间、每次重置的到期明细）仍在卡片视图。
 * 目前只有 Codex 有这些字段，其它提供商返回 null，由调用方退回显示提供商名。
 */

import type { TFunction } from 'i18next';
import type { CodexQuotaState } from '@/types';
import { resolvePlanTier, resolveResetMs, type CodexPlanTier } from '@/utils/quota';
import { getCodexPlanLabel } from '@/features/quota/providers/codex/planLabel';
import type { QuotaCardState } from '@/features/quota/providers';
import type { QuotaProviderType } from '@/features/quota/providers/types';

export type QuotaRowSummary = {
  /** 套餐展示名，如「Pro 20x」 */
  plan: string | null;
  /** elite / premium 用于配色，与卡片的套餐徽标同一套分档 */
  tier: CodexPlanTier;
  /** 续期时间（毫秒时间戳），无法解析为 null */
  renewsAtMs: number | null;
  /** 剩余主动重置次数，未知为 null */
  resets: number | null;
};

export function summarizeQuotaPlan(
  type: QuotaProviderType,
  quota: QuotaCardState | undefined,
  t: TFunction
): QuotaRowSummary | null {
  if (type !== 'codex' || !quota || quota.status !== 'success') return null;
  const codex = quota as CodexQuotaState;
  const plan = getCodexPlanLabel(t, codex.planType);
  const renewsAtMs = codex.subscriptionActiveUntil
    ? resolveResetMs([codex.subscriptionActiveUntil])
    : null;
  const resets =
    typeof codex.rateLimitResetCreditsAvailableCount === 'number'
      ? codex.rateLimitResetCreditsAvailableCount
      : null;
  if (!plan && renewsAtMs === null && resets === null) return null;
  return { plan, tier: resolvePlanTier(codex.planType), renewsAtMs, resets };
}
