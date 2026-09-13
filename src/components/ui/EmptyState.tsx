import type { ReactNode } from 'react';
import styles from '@/components/ui/EmptyState.module.scss';

interface EmptyStateProps {
  /** 空态标题（小号弱化文字） */
  title: string;
  /** 补充说明，告诉用户何时会有数据或下一步做什么 */
  description?: string;
  /** 可选操作按钮（如重试、新建） */
  action?: ReactNode;
  /** 可选小图标；不传则不显示图标 */
  icon?: ReactNode;
}

/** 拼接 CSS Module 类名与保留的全局类名（全局类名供测试与页面级样式定位使用） */
const cx = (...names: Array<string | undefined>) => names.filter(Boolean).join(' ');

/**
 * 空状态（Stallion-X 表格空态风格）：居中展示「可选小图标 + 13px 标题 + 14px 说明 + 操作」，
 * 无虚线框与底色，放在卡片 / 表格内部使用。
 */
export function EmptyState({ title, description, action, icon }: EmptyStateProps) {
  return (
    <div className={cx('empty-state', styles.root)}>
      <div className={cx('empty-content', styles.content)}>
        {icon ? (
          <div className={cx('empty-icon', styles.icon)} aria-hidden="true">
            {icon}
          </div>
        ) : null}
        <div className={styles.text}>
          <div className={cx('empty-title', styles.title)}>{title}</div>
          {description && <div className={cx('empty-desc', styles.desc)}>{description}</div>}
        </div>
      </div>
      {action && <div className={cx('empty-action', styles.action)}>{action}</div>}
    </div>
  );
}
