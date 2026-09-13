import type { ReactNode } from 'react';
import styles from '@/components/common/PageHeader.module.scss';

interface PageHeaderProps {
  /** 页面标题（渲染为 h1） */
  title: ReactNode;
  /** 对当前页面任务的一句话说明 */
  description?: ReactNode;
  /** 紧跟标题块右侧的统计条，传入一个或多个 PageHeaderStat，会合并成一条带分隔线的横条 */
  stats?: ReactNode;
  /** 标题下方的补充信息行（如计数、状态文字） */
  meta?: ReactNode;
  /** 页面级操作按钮，靠右对齐 */
  actions?: ReactNode;
  className?: string;
}

/**
 * 页面标题区（Stallion-X 主站 PageHeader 的 SCSS 版本）。
 *
 * 固定为「标题 + 说明 | 统计条 …… 操作按钮」的稳定结构，
 * 避免各页面各自实现大小不一的标题与散落的按钮。
 * 操作按钮始终贴在右上角，与标题首行对齐；空间不足时统计条先换到标题下方，按钮不会被挤到左侧。
 */
export function PageHeader({
  title,
  description,
  stats,
  meta,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <header className={[styles.header, className].filter(Boolean).join(' ')}>
      <div className={styles.main}>
        <div className={styles.titleBlock}>
          <h1 className={styles.title}>{title}</h1>
          {description ? <p className={styles.description}>{description}</p> : null}
          {meta ? <div className={styles.meta}>{meta}</div> : null}
        </div>
        {stats ? <div className={styles.stats}>{stats}</div> : null}
      </div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </header>
  );
}

interface PageHeaderStatProps {
  /** 统计项说明，如「消耗额度 · 共 0 条」 */
  label: ReactNode;
  /** 统计值，使用等宽数字展示 */
  value: ReactNode;
  /** 值的语义色：默认主色，success / danger 用于健康与异常 */
  tone?: 'primary' | 'neutral' | 'success' | 'danger';
}

/** 统计条中的一格：小号说明在左、等宽数值在右，多格之间由容器绘制分隔线 */
export function PageHeaderStat({ label, value, tone = 'primary' }: PageHeaderStatProps) {
  return (
    <div className={styles.stat}>
      <span className={styles.statLabel}>{label}</span>
      <span className={`${styles.statValue} ${styles[`tone-${tone}`] ?? ''}`}>{value}</span>
    </div>
  );
}
