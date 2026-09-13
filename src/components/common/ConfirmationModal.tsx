import { useTranslation } from 'react-i18next';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useNotificationStore } from '@/stores';

/** 确认弹窗正文样式：14px 次级文字，放宽行高便于阅读长提示 */
const MESSAGE_STYLE = {
  margin: 0,
  color: 'var(--text-secondary)',
  fontSize: 14,
  lineHeight: 1.6,
} as const;

/**
 * 全局确认弹窗：由 notificationStore.showConfirmation 驱动。
 * Stallion-X 重构：操作按钮移入 Modal 的 footer 区（右对齐，取消为次级按钮），正文使用令牌色。
 */
export function ConfirmationModal() {
  const { t } = useTranslation();
  const confirmation = useNotificationStore((state) => state.confirmation);
  const hideConfirmation = useNotificationStore((state) => state.hideConfirmation);
  const setConfirmationLoading = useNotificationStore((state) => state.setConfirmationLoading);

  const { isOpen, isLoading, options } = confirmation;

  if (!isOpen || !options) {
    return null;
  }

  const {
    title,
    message,
    onConfirm,
    onCancel,
    confirmText,
    cancelText,
    variant = 'primary',
  } = options;

  const handleConfirm = async () => {
    try {
      setConfirmationLoading(true);
      await onConfirm();
      hideConfirmation();
    } catch (error) {
      console.error('Confirmation action failed:', error);
      // Optional: show error notification here if needed,
      // but usually the calling component handles specific errors.
    } finally {
      setConfirmationLoading(false);
    }
  };

  const handleCancel = () => {
    if (isLoading) {
      return;
    }
    if (onCancel) {
      onCancel();
    }
    hideConfirmation();
  };

  return (
    <Modal
      open={isOpen}
      onClose={handleCancel}
      title={title}
      closeDisabled={isLoading}
      footer={
        <>
          <Button variant="secondary" onClick={handleCancel} disabled={isLoading}>
            {cancelText || t('common.cancel')}
          </Button>
          <Button variant={variant} onClick={handleConfirm} loading={isLoading}>
            {confirmText || t('common.confirm')}
          </Button>
        </>
      }
    >
      {typeof message === 'string' ? (
        <p style={MESSAGE_STYLE}>{message}</p>
      ) : (
        <div style={MESSAGE_STYLE}>{message}</div>
      )}
    </Modal>
  );
}
