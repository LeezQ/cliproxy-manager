import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { IconCheck } from '@/components/ui/icons';
import { useActionBarHeightVar } from '@/hooks/useActionBarHeightVar';
import type { ConfigStatusTone } from '@/features/config/uiState';
import styles from '@/features/config/components/FloatingSaveBar.module.scss';

export type FloatingSaveBarProps = {
  /** 有未保存修改时可见（与未保存离开守卫的 block 条件一致）。 */
  visible: boolean;
  statusText: string;
  statusTone: ConfigStatusTone;
  saving: boolean;
  saveDisabled: boolean;
  discardDisabled: boolean;
  onSave: () => void;
  onDiscard: () => void;
};

/**
 * 悬浮保存栏：portal 到 body 的底部居中操作条，仅在 dirty 时出现。
 * - 规范浮层：白底（--floating-surface）+ 1px 边框 + --floating-shadow，无毛玻璃；
 * - 显隐瞬时切换，不做上浮/位移动画（全站动效策略）；
 * - 实时高度写入 --config-action-bar-height 供页面底部留白。
 */
export function FloatingSaveBar(props: FloatingSaveBarProps) {
  const {
    visible,
    statusText,
    statusTone,
    saving,
    saveDisabled,
    discardDisabled,
    onSave,
    onDiscard,
  } = props;
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);

  // 只在可见时同步高度变量；隐藏（卸载）时由 hook 清除
  useActionBarHeightVar(containerRef, '--config-action-bar-height', visible);

  if (!visible || typeof document === 'undefined') return null;

  // 状态文案语义色：待保存琥珀、错误红、已同步绿，其余次级文字色
  const toneClass: Record<ConfigStatusTone, string> = {
    error: styles.statusError,
    warning: styles.statusWarning,
    busy: styles.statusBusy,
    muted: styles.statusMuted,
    ok: styles.statusOk,
  };

  return createPortal(
    <div className={styles.container} ref={containerRef}>
      <div className={styles.bar} role="group" aria-label={t('config_management.status_dirty')}>
        <span className={`${styles.status} ${toneClass[statusTone]}`} aria-live="polite">
          <span className={styles.statusDot} aria-hidden="true" />
          {statusText}
        </span>
        <div className={styles.actionsGroup}>
          <Button variant="secondary" onClick={onDiscard} disabled={discardDisabled}>
            {t('config_management.actions.discard')}
          </Button>
          {/* 保存中由 Button 的 loading 态显示旋转指示并禁用按钮 */}
          <Button onClick={onSave} disabled={saveDisabled} loading={saving}>
            {saving ? null : <IconCheck size={15} />}
            {t('config_management.actions.save')}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}
