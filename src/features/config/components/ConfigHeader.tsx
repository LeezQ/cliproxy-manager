import { Fragment, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/components/common/PageHeader';
import { Button } from '@/components/ui/Button';
import { IconRefreshCw } from '@/components/ui/icons';
import type { HeaderMetaSegment } from '@/features/config/uiState';
import styles from '@/features/config/components/ConfigHeader.module.scss';

export type ConfigHeaderProps = {
  /** 标题下方计数/状态行的段落序列（uiState.buildHeaderMeta 的产物）。 */
  meta: HeaderMetaSegment[];
  reloadDisabled: boolean;
  reloading: boolean;
  onReload: () => void;
  /** 放在「重新加载」按钮之前的页面级操作（字段/源码搜索 + 可视化/源码切换）。 */
  extraActions?: ReactNode;
};

/**
 * 配置面板头部：统一使用全站 PageHeader（标题 + 一句话说明 + 计数/状态 meta 行）。
 * 右侧操作区依次为：搜索、模式切换、重新加载；保存动作不常驻 —— 由 FloatingSaveBar 在 dirty 时承载。
 */
export function ConfigHeader({
  meta,
  reloadDisabled,
  reloading,
  onReload,
  extraActions,
}: ConfigHeaderProps) {
  const { t } = useTranslation();
  // meta 段落语义色：仅状态类（待保存 / 错误 / 已同步）上色，计数保持次级文字色
  const toneClass: Record<HeaderMetaSegment['tone'], string> = {
    muted: styles.metaMuted,
    warning: styles.metaWarning,
    error: styles.metaError,
    ok: styles.metaOk,
  };

  return (
    <PageHeader
      className={styles.header}
      title={t('config_management.title')}
      description={t('config_management.description', {
        defaultValue: '以可视化表单或 YAML 源码编辑 CLI Proxy API 的服务端配置',
      })}
      meta={
        <span className={styles.meta}>
          {meta.map((segment, index) => (
            <Fragment key={segment.key}>
              {index > 0 ? (
                <span className={styles.metaDot} aria-hidden="true">
                  ·
                </span>
              ) : null}
              <span className={toneClass[segment.tone]}>
                {segment.count !== undefined
                  ? t(segment.labelKey, { count: segment.count })
                  : t(segment.labelKey)}
              </span>
            </Fragment>
          ))}
        </span>
      }
      actions={
        <>
          {extraActions}
          <Button variant="secondary" onClick={onReload} disabled={reloadDisabled}>
            {/* 刷新中保留旋转：属于加载状态反馈，规范允许 */}
            <IconRefreshCw size={14} className={reloading ? styles.spinning : undefined} />
            {t('config_management.reload')}
          </Button>
        </>
      }
    />
  );
}
