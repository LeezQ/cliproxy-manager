/**
 * 额度卡片：头部（提供商图标 + 文件名 + 提供商名）+ 四态 body + 动作 footer。
 *
 * 视觉：白底 + 1px 边框 + 8px 圆角，无阴影、无入场动画、悬停不抬升。
 * - idle：整个 body 是一个点击加载按钮（上游直连有速率考虑，不自动拉取）；
 * - loading：双幽灵行骨架（aria-busy，文字等价视觉隐藏）；
 * - error：故障徽标色条 + footer 刷新即重试；
 * - success：provider Body（穿 QuotaBody.module.scss 全页外衣）。
 */

import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { IconAlertTriangle, IconRefreshCw } from '@/components/ui/icons';
import type { ResolvedTheme } from '@/types';
import { resolveQuotaErrorMessage } from '@/utils/quota';
import { getQuotaDisplayName } from '@/utils/quota/identity';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  getTypeLabel,
  isThemeSurfaceIconProvider,
} from '@/features/authFiles/constants';
import { bindQuotaClasses } from '@/features/quota/types';
import { QUOTA_ADAPTERS, type QuotaCardState } from '@/features/quota/providers';
import { isQuotaRefreshDisabled, type QuotaFileEntry } from '@/features/quota/logic';
import bodyStyles from '@/features/quota/components/QuotaBody.module.scss';
import styles from '@/features/quota/components/QuotaCard.module.scss';

/** 额度页全页外衣：QuotaBody 模块绑定成类型化契约（缺键在模块初始化即抛）。 */
const quotaClasses = bindQuotaClasses(bodyStyles, 'QuotaBody.module.scss');

export type QuotaCardProps = {
  entry: QuotaFileEntry;
  quota?: QuotaCardState;
  resolvedTheme: ResolvedTheme;
  canRefresh: boolean;
  resetting: boolean;
  onRefresh: () => void;
  onReset: () => void;
};

export function QuotaCard(props: QuotaCardProps) {
  const { entry, quota, resolvedTheme, canRefresh, resetting, onRefresh, onReset } = props;
  const { t } = useTranslation();
  const adapter = QUOTA_ADAPTERS[entry.type];
  const file = entry.file;
  const displayName = getQuotaDisplayName(file);

  const status = quota?.status ?? 'idle';
  const loading = status === 'loading';
  const iconSrc = getAuthFileIcon(entry.type, resolvedTheme);
  const typeLabel = getTypeLabel(t, entry.type);
  const errorMessage = resolveQuotaErrorMessage(
    t,
    quota?.errorStatus,
    quota?.error || t('common.unknown_error')
  );
  const showReset =
    status === 'success' &&
    Boolean(adapter.resetQuota) &&
    quota !== undefined &&
    Boolean(adapter.canResetQuota?.(quota));

  return (
    <article className={styles.card}>
      <header className={styles.head}>
        <span
          className={styles.iconWrap}
          title={typeLabel}
          style={
            isThemeSurfaceIconProvider(entry.type)
              ? { background: getThemeSurfaceIconBackground(resolvedTheme) }
              : undefined
          }
        >
          {iconSrc ? (
            <img src={iconSrc} alt="" className={styles.icon} />
          ) : (
            <span className={styles.iconFallback}>{typeLabel.slice(0, 1).toUpperCase()}</span>
          )}
        </span>
        {/* 文件名为卡片标题，提供商名作为次级说明，身份一眼可辨 */}
        <span className={styles.headText}>
          <span className={styles.fileName} title={displayName}>
            {displayName}
          </span>
          <span className={styles.typeLabel}>{typeLabel}</span>
        </span>
      </header>

      <div className={styles.body}>
        {status === 'idle' ? (
          <button
            type="button"
            className={styles.idleBody}
            onClick={onRefresh}
            disabled={!canRefresh}
          >
            <IconRefreshCw size={16} aria-hidden="true" className={styles.idleGlyph} />
            <span className={styles.idleHint}>{t(`${adapter.i18nPrefix}.idle`)}</span>
          </button>
        ) : loading ? (
          <div className={styles.skeleton} aria-busy="true">
            <span className={styles.srOnly}>{t(`${adapter.i18nPrefix}.loading`)}</span>
            {[0, 1].map((row) => (
              <div key={row} className={styles.skeletonRow} aria-hidden="true">
                <span className={styles.skeletonLabel} />
                <span className={styles.skeletonTrack} />
              </div>
            ))}
          </div>
        ) : status === 'error' ? (
          <div className={styles.errorStrip} role="alert">
            <IconAlertTriangle size={16} aria-hidden="true" className={styles.errorGlyph} />
            <span className={styles.errorText}>
              {t(`${adapter.i18nPrefix}.load_failed`, { message: errorMessage })}
            </span>
          </div>
        ) : quota ? (
          <adapter.Body quota={quota} classes={quotaClasses} />
        ) : (
          <div className={styles.idleHint}>{t(`${adapter.i18nPrefix}.idle`)}</div>
        )}
      </div>

      {/* footer：次级描边小按钮（复用全局 Button），刷新中仅图标旋转 */}
      {status !== 'idle' && (
        <footer className={styles.actionRow}>
          {showReset && (
            <Button
              variant="secondary"
              size="sm"
              onClick={onReset}
              disabled={!canRefresh || loading || resetting}
              title={t('codex_quota.reset_button')}
            >
              <IconRefreshCw
                size={14}
                aria-hidden="true"
                className={resetting ? styles.spinning : undefined}
              />
              {t('codex_quota.reset_button')}
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={onRefresh}
            disabled={isQuotaRefreshDisabled(canRefresh, loading, resetting)}
            title={t('auth_files.quota_refresh_hint')}
          >
            <IconRefreshCw
              size={14}
              aria-hidden="true"
              className={loading ? styles.spinning : undefined}
            />
            {t('auth_files.quota_refresh_single')}
          </Button>
        </footer>
      )}
    </article>
  );
}
