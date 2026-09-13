import type { ReactNode } from 'react';
import { FIELDS_ROOT_CLASS } from '@/features/config/components/fields/FieldPrimitives';
import styles from '@/features/config/components/SectionCard.module.scss';

export type SectionCardProps = {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
};

/**
 * 分区卡片：规范 Surface（白底 + 1px 边框 + 8px 圆角，无阴影、无入场动画）。
 * 头部为 16px/600 标题 + 14px 说明，内容区挂载表单控件宿主 class。
 */
export function SectionCard({ title, description, children }: SectionCardProps) {
  return (
    <section className={styles.card}>
      <header className={styles.header}>
        <h2 className={styles.title}>{title}</h2>
        {description ? <p className={styles.description}>{description}</p> : null}
      </header>
      <div className={`${styles.content} ${FIELDS_ROOT_CLASS}`}>{children}</div>
    </section>
  );
}
