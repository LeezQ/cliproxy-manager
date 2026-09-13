import { forwardRef, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { IconChevronLeft } from '@/components/ui/icons';
import styles from '@/components/common/SecondaryScreenShell.module.scss';

/** 二级页面外壳参数 */
export type SecondaryScreenShellProps = {
  title: ReactNode;
  onBack?: () => void;
  backLabel?: string;
  backAriaLabel?: string;
  rightAction?: ReactNode;
  isLoading?: boolean;
  loadingLabel?: ReactNode;
  className?: string;
  contentClassName?: string;
  topBarClassName?: string;
  children?: ReactNode;
};

/**
 * 二级编辑页外壳：顶部为「返回按钮 + 标题 + 右侧操作」的标题区（与 PageHeader 视觉一致），
 * 下方为内容区或加载态。ref 透传到最外层容器（页面用于绑定手势返回）。
 */
export const SecondaryScreenShell = forwardRef<HTMLDivElement, SecondaryScreenShellProps>(
  function SecondaryScreenShell(
    {
      title,
      onBack,
      backLabel = 'Back',
      backAriaLabel,
      rightAction,
      isLoading = false,
      loadingLabel = 'Loading...',
      className = '',
      contentClassName = '',
      topBarClassName = '',
      children,
    },
    ref
  ) {
    const containerClassName = [styles.container, className].filter(Boolean).join(' ');
    const contentClasses = [styles.content, contentClassName].filter(Boolean).join(' ');
    const titleTooltip = typeof title === 'string' ? title : undefined;
    const resolvedBackAriaLabel = backAriaLabel ?? backLabel;

    return (
      <div className={containerClassName} ref={ref}>
        <div className={[styles.topBar, topBarClassName].filter(Boolean).join(' ')}>
          {onBack ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={onBack}
              className={styles.backButton}
              aria-label={resolvedBackAriaLabel}
            >
              <span className={styles.backIcon}>
                <IconChevronLeft size={16} />
              </span>
              <span className={styles.backText}>{backLabel}</span>
            </Button>
          ) : (
            <div />
          )}
          {/* 标题：单行省略，字符串标题通过 title 属性提供完整文本 */}
          <h1 className={styles.topBarTitle} title={titleTooltip}>
            {title}
          </h1>
          <div className={styles.rightSlot}>{rightAction}</div>
        </div>

        {isLoading ? (
          <div className={styles.loadingState}>
            <LoadingSpinner size={16} />
            <span>{loadingLabel}</span>
          </div>
        ) : (
          <div className={contentClasses}>{children}</div>
        )}
      </div>
    );
  }
);
