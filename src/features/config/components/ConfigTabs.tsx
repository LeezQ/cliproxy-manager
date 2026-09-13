import { useEffect, useRef, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CONFIG_TAB_IDS,
  configPanelDomId,
  configTabDomId,
  type ConfigTabId,
} from '@/features/config/constants';
import styles from '@/features/config/components/ConfigTabs.module.scss';

export type ConfigTabsProps = {
  active: ConfigTabId;
  /** 每 tab 校验错误数（uiState.countSectionErrors 的产物），>0 显示失败色徽章。 */
  errorCounts: Partial<Record<ConfigTabId, number>>;
  /** 有待保存修改的 tabs（uiState.resolveDirtyTabs 的产物），显示琥珀脏点。 */
  dirtyTabs: ReadonlySet<ConfigTabId>;
  disabled?: boolean;
  onChange: (id: ConfigTabId) => void;
};

/**
 * 分区 tabs：规范下划线式（2px 主色下划线），标签 + 错误徽章 + 脏点；不加图标，减少视觉噪音并节省横向空间。
 * 「常用」是首 tab；tab 切换是高频操作，零动画。
 */
export function ConfigTabs({
  active,
  errorCounts,
  dirtyTabs,
  disabled = false,
  onChange,
}: ConfigTabsProps) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement | null>(null);
  const buttonRefs = useRef<Partial<Record<ConfigTabId, HTMLButtonElement | null>>>({});

  // 移动端横滚时把激活 tab 带回视野中央（瞬时滚动，不做平滑动画）；无溢出时不动，避免无谓的页面滚动。
  useEffect(() => {
    const scroller = listRef.current;
    const button = buttonRefs.current[active];
    if (!scroller || !button) return;
    if (scroller.scrollWidth <= scroller.clientWidth) return;
    button.scrollIntoView({
      behavior: 'auto',
      block: 'nearest',
      inline: 'center',
    });
  }, [active]);

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const count = CONFIG_TAB_IDS.length;
    const currentIndex = CONFIG_TAB_IDS.indexOf(active);
    let nextIndex = -1;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % count;
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + count) % count;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = count - 1;
    if (nextIndex < 0) return;
    event.preventDefault();
    const nextId = CONFIG_TAB_IDS[nextIndex];
    onChange(nextId);
    buttonRefs.current[nextId]?.focus();
  };

  return (
    <div
      className={styles.tabs}
      role="tablist"
      aria-label={t('config_management.title')}
      ref={listRef}
    >
      {CONFIG_TAB_IDS.map((id) => {
        const isActive = active === id;
        const errorCount = errorCounts[id] ?? 0;
        const isDirty = dirtyTabs.has(id);
        const tabLabel = t(`config_management.visual.sections.${id}.title`);
        const accessibleLabel = [
          tabLabel,
          errorCount > 0 ? t('config_management.meta_errors', { count: errorCount }) : null,
          isDirty ? t('config_management.status_dirty_short') : null,
        ]
          .filter(Boolean)
          .join(', ');

        return (
          <button
            key={id}
            ref={(node) => {
              buttonRefs.current[id] = node;
            }}
            type="button"
            role="tab"
            id={configTabDomId(id)}
            aria-selected={isActive}
            aria-controls={configPanelDomId(id)}
            aria-label={accessibleLabel}
            tabIndex={isActive ? 0 : -1}
            className={`${styles.tab} ${isActive ? styles.tabActive : ''}`}
            disabled={disabled}
            onClick={() => onChange(id)}
            onKeyDown={handleKeyDown}
          >
            <span className={styles.tabLabel}>{tabLabel}</span>
            {errorCount > 0 ? (
              <span className={styles.tabBadge} aria-hidden="true">
                {errorCount}
              </span>
            ) : null}
            {isDirty ? <span className={styles.tabDirtyDot} aria-hidden="true" /> : null}
          </button>
        );
      })}
    </div>
  );
}
