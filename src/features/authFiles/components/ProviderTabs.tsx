import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { IconFilterAll } from '@/components/ui/icons';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  getTypeLabel,
  isThemeSurfaceIconProvider,
  type ResolvedTheme,
} from '@/features/authFiles/constants';
import { scrollProviderTabs } from '@/features/authFiles/components/providerTabsWheel';
import styles from '@/features/authFiles/components/ProviderTabs.module.scss';

export type ProviderTabsProps = {
  types: string[];
  counts: Record<string, number>;
  active: string;
  resolvedTheme: ResolvedTheme;
  onChange: (type: string) => void;
  /** 外层容器附加类名：嵌入筛选卡片时用于对齐卡片内边距 */
  className?: string;
};

/**
 * 提供商过滤 tabs：水平排布，支持鼠标滚轮与触屏横向滚动。
 * 规范中的下划线式 tab：品牌色只出现在图标上，激活态为主文字色 + 2px 主色下划线。
 * 认证文件页与配额页共用。
 */
export function ProviderTabs({
  types,
  counts,
  active,
  resolvedTheme,
  onChange,
  className,
}: ProviderTabsProps) {
  const { t } = useTranslation();
  const tabsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const strip = tabsRef.current;
    if (!strip) return;
    const onWheel = (event: WheelEvent) => scrollProviderTabs(strip, event);
    // React 的 wheel 事件是被动监听，无法 preventDefault；这里挂本地非被动监听阻止页面随之滚动。
    strip.addEventListener('wheel', onWheel, { passive: false });
    return () => strip.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <div
      ref={tabsRef}
      className={[styles.tabs, className].filter(Boolean).join(' ')}
      role="group"
      aria-label={t('auth_files.filter_all')}
    >
      {types.map((type) => {
        const isActive = active === type;
        const label = type === 'all' ? t('auth_files.filter_all') : getTypeLabel(t, type);
        const iconSrc = type === 'all' ? null : getAuthFileIcon(type, resolvedTheme);

        return (
          <button
            key={type}
            type="button"
            className={`${styles.tab} ${isActive ? styles.tabActive : ''}`}
            aria-pressed={isActive}
            onClick={() => onChange(type)}
          >
            {type === 'all' ? (
              <IconFilterAll className={styles.tabGlyph} size={15} />
            ) : (
              <span
                className={styles.tabIconWrap}
                style={
                  // 与 AI 提供商界面一致：Kimi 图标底座随主题切换颜色
                  isThemeSurfaceIconProvider(type)
                    ? { background: getThemeSurfaceIconBackground(resolvedTheme) }
                    : undefined
                }
              >
                {iconSrc ? (
                  <img src={iconSrc} alt="" className={styles.tabIcon} />
                ) : (
                  <span className={styles.tabIconFallback}>{label.slice(0, 1).toUpperCase()}</span>
                )}
              </span>
            )}
            <span className={styles.tabLabel}>{label}</span>
            <span className={styles.tabCount}>{counts[type] ?? 0}</span>
          </button>
        );
      })}
    </div>
  );
}
