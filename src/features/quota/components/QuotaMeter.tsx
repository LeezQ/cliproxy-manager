/**
 * 额度水位条（原 QuotaProgressBar 的类型化后继）。
 *
 * 扁平进度条：轨道退居背景（muted 底），填充按剩余量三档语义着色
 * （≥70 健康 / ≥30 紧张 / <30 耗尽），宽度变化直接到位、不做过渡与铺开动画。
 * percent === null 渲染空轨道 —— 未知不着色（Medium 类在 width 0 下不可见，行为与旧版一致）。
 */

import type { QuotaClassMap } from '@/features/quota/types';

export const QUOTA_PROGRESS_HIGH_THRESHOLD = 70;
export const QUOTA_PROGRESS_MEDIUM_THRESHOLD = 30;

export interface QuotaMeterProps {
  percent: number | null;
  classes: QuotaClassMap;
  /**
   * 行序号。旧版用于逐行入场级差，动效移除后不再消费；
   * 保留该可选属性以兼容各 provider Body 与认证文件页的既有调用。
   */
  index?: number;
}

export function QuotaMeter({ percent, classes }: QuotaMeterProps) {
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  const normalized = percent === null ? null : clamp(percent, 0, 100);
  const fillClass =
    normalized === null
      ? classes.quotaBarFillMedium
      : normalized >= QUOTA_PROGRESS_HIGH_THRESHOLD
        ? classes.quotaBarFillHigh
        : normalized >= QUOTA_PROGRESS_MEDIUM_THRESHOLD
          ? classes.quotaBarFillMedium
          : classes.quotaBarFillLow;
  const widthPercent = Math.round((normalized ?? 0) * 100) / 100;

  return (
    <div className={classes.quotaBar}>
      <div
        className={`${classes.quotaBarFill} ${fillClass}`}
        style={{ width: `${widthPercent}%` }}
      />
    </div>
  );
}
