/**
 * 配额页的列表行：一行一个凭证，账号多时一屏能看到更多。
 *
 * 列：账号（邮箱 + 一行套餐摘要）| 额度（各窗口横向并排）| 操作（重置 / 刷新）
 * 每行只有两行高：卡片里纵向三行的套餐 chip 在这里压成账号下方的一行摘要。
 * 与 QuotaCard 共用同一套 props 与状态判定，页面按布局模式二选一渲染。
 */

import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { IconAlertTriangle, IconRefreshCw } from '@/components/ui/icons';
import { buildResetDisplay, resolveQuotaErrorMessage } from '@/utils/quota';
import { useNow } from '@/hooks/useNow';
import { summarizeQuotaPlan } from '@/features/quota/rowSummary';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  getTypeLabel,
  isThemeSurfaceIconProvider,
} from '@/features/authFiles/constants';
import { deriveAuthFileIdentity } from '@/features/authFiles/identity';
import { bindQuotaClasses } from '@/features/quota/types';
import { QUOTA_ADAPTERS } from '@/features/quota/providers';
import { isQuotaRefreshDisabled } from '@/features/quota/logic';
import type { QuotaCardProps } from '@/features/quota/components/QuotaCard';
import cardBodyStyles from '@/features/quota/components/QuotaBody.module.scss';
import rowBodyOverrides from '@/features/quota/components/QuotaBodyRow.module.scss';
import styles from '@/features/quota/components/QuotaRow.module.scss';

/** 以卡片外衣为底、叠加行内布局覆盖项，绑定成类型化契约（缺键在模块初始化即抛）。 */
const rowQuotaClasses = bindQuotaClasses(
  { ...cardBodyStyles, ...rowBodyOverrides },
  'QuotaBodyRow.module.scss'
);

export type QuotaRowProps = QuotaCardProps;

export function QuotaRow(props: QuotaRowProps) {
  const { entry, quota, resolvedTheme, canRefresh, resetting, onRefresh, onReset } = props;
  const { t, i18n } = useTranslation();
  const now = useNow();
  const adapter = QUOTA_ADAPTERS[entry.type];
  const file = entry.file;
  // 账号列优先显示邮箱，比卡片标题用的完整文件名短得多，也和认证文件页一致
  const identity = deriveAuthFileIdentity(file);

  const status = quota?.status ?? 'idle';
  const loading = status === 'loading';
  const iconSrc = getAuthFileIcon(entry.type, resolvedTheme);
  const typeLabel = getTypeLabel(t, entry.type);
  const errorMessage = resolveQuotaErrorMessage(
    t,
    quota?.errorStatus,
    quota?.error || t('common.unknown_error')
  );
  // 账号下方的一行摘要：套餐 · 续期 · 剩余重置次数；拿不到时退回显示提供商名
  const summary = summarizeQuotaPlan(entry.type, quota, t);
  const renewal =
    summary?.renewsAtMs != null
      ? buildResetDisplay(null, summary.renewsAtMs, now, i18n.resolvedLanguage)
      : null;
  const planToneClass =
    summary?.tier === 'elite'
      ? styles.planElite
      : summary?.tier === 'premium'
        ? styles.planPremium
        : styles.plan;

  const showReset =
    status === 'success' &&
    Boolean(adapter.resetQuota) &&
    quota !== undefined &&
    Boolean(adapter.canResetQuota?.(quota));

  return (
    <div className={`${styles.row} ${file.disabled ? styles.rowDisabled : ''}`} role="row">
      <div className={styles.cellIdentity} role="cell">
        <span
          className={styles.avatar}
          title={typeLabel}
          style={
            isThemeSurfaceIconProvider(entry.type)
              ? { background: getThemeSurfaceIconBackground(resolvedTheme) }
              : undefined
          }
        >
          {iconSrc ? (
            <img src={iconSrc} alt={typeLabel} className={styles.avatarImage} />
          ) : (
            <span className={styles.avatarFallback}>{typeLabel.slice(0, 1).toUpperCase()}</span>
          )}
        </span>
        <span className={styles.identityText}>
          <span
            className={`${styles.account} ${identity.kind === 'fileName' ? styles.accountMono : ''}`}
            title={identity.fullName || identity.primary}
          >
            {identity.primary}
          </span>
          {summary ? (
            <span className={styles.summary}>
              {summary.plan && <span className={planToneClass}>{summary.plan}</span>}
              {renewal && (
                <span title={renewal.absolute}>
                  {t('quota_management.row_renews', {
                    when: renewal.relative ?? renewal.absolute,
                  })}
                </span>
              )}
              {summary.resets !== null && (
                <span className={summary.resets === 0 ? styles.summaryMuted : undefined}>
                  {t('quota_management.row_resets', { count: summary.resets })}
                </span>
              )}
            </span>
          ) : (
            <span className={styles.typeLabel}>{typeLabel}</span>
          )}
        </span>
      </div>

      <div className={styles.cellQuota} role="cell">
        {status === 'idle' ? (
          <button
            type="button"
            className={styles.loadButton}
            onClick={onRefresh}
            disabled={!canRefresh}
          >
            {t('auth_files.row_quota_load')}
          </button>
        ) : loading ? (
          <span className={styles.message} aria-busy="true">
            {t(`${adapter.i18nPrefix}.loading`)}
          </span>
        ) : status === 'error' ? (
          <span className={styles.error} role="alert" title={errorMessage}>
            <IconAlertTriangle size={14} aria-hidden="true" className={styles.errorIcon} />
            <span>{t(`${adapter.i18nPrefix}.load_failed`, { message: errorMessage })}</span>
          </span>
        ) : quota ? (
          <div className={styles.quotaBody}>
            <adapter.Body quota={quota} classes={rowQuotaClasses} />
          </div>
        ) : (
          <span className={styles.message}>{t(`${adapter.i18nPrefix}.idle`)}</span>
        )}
      </div>

      <div className={styles.cellActions} role="cell">
        {showReset && (
          <Button
            variant="secondary"
            size="sm"
            onClick={onReset}
            disabled={!canRefresh || loading || resetting}
            title={t('codex_quota.reset_button')}
            aria-label={t('codex_quota.reset_button')}
          >
            <IconRefreshCw
              size={14}
              aria-hidden="true"
              className={resetting ? styles.spinning : undefined}
            />
            {t('quota_management.row_reset')}
          </Button>
        )}
        {status !== 'idle' && (
          <Button
            variant="secondary"
            size="sm"
            onClick={onRefresh}
            disabled={isQuotaRefreshDisabled(canRefresh, loading, resetting)}
            title={t('auth_files.quota_refresh_hint')}
            aria-label={t('auth_files.quota_refresh_single')}
          >
            <IconRefreshCw
              size={14}
              aria-hidden="true"
              className={loading ? styles.spinning : undefined}
            />
            {t('quota_management.row_refresh')}
          </Button>
        )}
      </div>
    </div>
  );
}
