import { useTranslation } from 'react-i18next';
import { PageHeader, PageHeaderStat } from '@/components/common/PageHeader';
import { Button } from '@/components/ui/Button';
import { IconRefreshCw } from '@/components/ui/icons';
import styles from '@/features/quota/components/QuotaHeader.module.scss';

export type QuotaHeaderProps = {
  totalCount: number;
  loadedCount: number;
  attentionCount: number;
  refreshing: boolean;
  disableControls: boolean;
  onRefreshAll: () => void;
};

/**
 * 额度页标题区：统一走 PageHeader（标题 + 一句话说明 | 统计卡片 …… 刷新全部）。
 *
 * - 三枚统计卡：凭证总数（中性）、已加载（健康色）、需关注（有异常时走故障色）；
 * - 数字直接到位，不做滚动计数；
 * - 「刷新全部」为页面主操作，刷新中图标保留旋转作为唯一的进行态反馈。
 */
export function QuotaHeader(props: QuotaHeaderProps) {
  const { totalCount, loadedCount, attentionCount, refreshing, disableControls, onRefreshAll } =
    props;
  const { t } = useTranslation();

  return (
    <PageHeader
      title={t('quota_management.title')}
      description={t('quota_management.description')}
      stats={
        <>
          <PageHeaderStat
            label={t('quota_management.stat_credentials', { defaultValue: 'Credentials' })}
            value={totalCount}
            tone="neutral"
          />
          <PageHeaderStat
            label={t('quota_management.stat_loaded', { defaultValue: 'Loaded' })}
            value={loadedCount}
            tone={loadedCount > 0 ? 'success' : 'neutral'}
          />
          <PageHeaderStat
            label={t('quota_management.stat_attention', { defaultValue: 'Needs attention' })}
            value={attentionCount}
            tone={attentionCount > 0 ? 'danger' : 'neutral'}
          />
        </>
      }
      actions={
        <Button variant="primary" onClick={onRefreshAll} disabled={disableControls || refreshing}>
          <IconRefreshCw
            size={16}
            aria-hidden="true"
            className={refreshing ? styles.spinning : undefined}
          />
          {t('quota_management.refresh_all_credentials')}
        </Button>
      }
    />
  );
}
