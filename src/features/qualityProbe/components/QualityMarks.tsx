/**
 * 降智检测的两个小部件：结论徽标与走势方块。
 * 认证文件列表（每行一个小徽标）和降智检测页共用，保证同一结论处处同色同字。
 */

import { useTranslation } from 'react-i18next';
import type { QualityVerdict } from '@/services/api/qualityProbe';
import { QUALITY_VERDICT_KEY } from '@/features/qualityProbe/logic';
import styles from '@/features/qualityProbe/components/QualityMarks.module.scss';

const TONE: Record<QualityVerdict, string> = {
  pass: styles.tonePass,
  degraded: styles.toneDegraded,
  failed: styles.toneFailed,
};

/** 结论徽标：圆点 + 文字。title 用于悬停补充细节。 */
export function QualityVerdictBadge({
  verdict,
  title,
  className,
}: {
  verdict: QualityVerdict;
  title?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <span className={`${styles.badge} ${TONE[verdict]} ${className ?? ''}`} title={title}>
      <span className={styles.dot} aria-hidden="true" />
      {t(`quality_probe.${QUALITY_VERDICT_KEY[verdict]}`)}
    </span>
  );
}

/** 走势：每次检测一个小方块，旧的在左。空列表时显示破折号。 */
export function QualityTrend({ trend }: { trend: QualityVerdict[] }) {
  const { t } = useTranslation();
  if (trend.length === 0) return <span className={styles.trendEmpty}>—</span>;
  const label = t('quality_probe.trend_label', { count: trend.length });
  return (
    <span className={styles.trend} role="img" aria-label={label} title={label}>
      {trend.map((verdict, i) => (
        <span key={i} className={`${styles.cell} ${TONE[verdict]}`} />
      ))}
    </span>
  );
}
