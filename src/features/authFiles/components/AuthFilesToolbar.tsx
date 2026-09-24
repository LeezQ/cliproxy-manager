import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { IconSearch, IconSlidersHorizontal } from '@/components/ui/icons';
import { LayoutToggle } from '@/components/common/LayoutToggle';
import { MAX_CARD_PAGE_SIZE, MIN_CARD_PAGE_SIZE } from '@/features/authFiles/constants';
import type {
  AuthFilesLayoutMode,
  AuthFilesSortMode,
  AuthFilesStatusFilterMode,
} from '@/features/authFiles/uiState';
import styles from '@/features/authFiles/components/AuthFilesToolbar.module.scss';

export type AuthFilesToolbarProps = {
  search: string;
  onSearchChange: (value: string) => void;
  statusFilterMode: AuthFilesStatusFilterMode;
  statusFilterOptions: Array<{ value: AuthFilesStatusFilterMode; label: string }>;
  onStatusFilterChange: (mode: AuthFilesStatusFilterMode) => void;
  sortMode: AuthFilesSortMode;
  sortOptions: Array<{ value: string; label: string }>;
  onSortModeChange: (value: string) => void;
  pageSizeInput: string;
  onPageSizeInputChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onPageSizeCommit: (rawValue: string) => void;
  compactMode: boolean;
  onCompactModeChange: (value: boolean) => void;
  layoutMode: AuthFilesLayoutMode;
  onLayoutModeChange: (mode: AuthFilesLayoutMode) => void;
};

/**
 * 工作区工具栏（位于筛选卡片内）：搜索、状态分段、排序、显示设置 popover。
 * 「删除筛选结果」移到了卡片顶部 tabs 行的右端（见 AuthFilesPage），避免中等宽度下单独换行。
 * 控件统一 36px 高 / 8px 圆角，按钮复用全局 Button。
 */
export function AuthFilesToolbar(props: AuthFilesToolbarProps) {
  const {
    search,
    onSearchChange,
    statusFilterMode,
    statusFilterOptions,
    onStatusFilterChange,
    sortMode,
    sortOptions,
    onSortModeChange,
    pageSizeInput,
    onPageSizeInputChange,
    onPageSizeCommit,
    compactMode,
    onCompactModeChange,
    layoutMode,
    onLayoutModeChange,
  } = props;
  const { t } = useTranslation();
  const [displaySettingsOpen, setDisplaySettingsOpen] = useState(false);
  const displaySettingsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!displaySettingsOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!displaySettingsRef.current?.contains(event.target as Node)) {
        setDisplaySettingsOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDisplaySettingsOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [displaySettingsOpen]);

  return (
    <div className={styles.toolbar}>
      <div className={styles.search}>
        <Input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={t('auth_files.search_placeholder')}
          aria-label={t('auth_files.search_label')}
          rightElement={<IconSearch className={styles.searchIcon} size={16} />}
        />
      </div>

      <div
        className={styles.segmented}
        role="group"
        aria-label={t('auth_files.problem_filter_label')}
      >
        {statusFilterOptions.map((option) => {
          const isActive = statusFilterMode === option.value;
          const isProblem = option.value === 'problem';
          return (
            <button
              key={option.value}
              type="button"
              className={`${styles.segment} ${isActive ? styles.segmentActive : ''} ${
                isProblem ? styles.segmentProblem : ''
              }`}
              aria-pressed={isActive}
              onClick={() => onStatusFilterChange(option.value)}
            >
              {option.label}
            </button>
          );
        })}
      </div>

      <div className={styles.sort}>
        <Select
          value={sortMode}
          options={sortOptions}
          onChange={onSortModeChange}
          ariaLabel={t('auth_files.sort_label')}
        />
      </div>

      {/* 切换布局是高频操作，放在工具栏上而不是藏进「显示选项」弹层 */}
      <LayoutToggle value={layoutMode} onChange={onLayoutModeChange} />

      <div className={styles.display} ref={displaySettingsRef}>
        <Button
          type="button"
          variant="secondary"
          className={displaySettingsOpen ? styles.displayButtonActive : undefined}
          aria-expanded={displaySettingsOpen}
          aria-controls="auth-files-display-settings"
          title={t('auth_files.display_options_label')}
          onClick={() => setDisplaySettingsOpen((open) => !open)}
        >
          <IconSlidersHorizontal size={16} />
          {t('auth_files.display_options_label')}
        </Button>

        {displaySettingsOpen && (
          <div id="auth-files-display-settings" className={styles.popover}>
            <div className={styles.popoverRow}>
              <label htmlFor="auth-files-page-size">{t('auth_files.page_size_label')}</label>
              <input
                id="auth-files-page-size"
                className={styles.pageSizeInput}
                type="number"
                min={MIN_CARD_PAGE_SIZE}
                max={MAX_CARD_PAGE_SIZE}
                step={1}
                value={pageSizeInput}
                onChange={onPageSizeInputChange}
                onBlur={(e) => onPageSizeCommit(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.currentTarget.blur();
                  }
                }}
              />
            </div>
            {/* 紧凑模式只作用于卡片布局；列表布局本身已是紧凑排列，这里不再展示 */}
            {layoutMode === 'card' && (
              <div className={styles.popoverRow}>
                <span>{t('auth_files.compact_mode_label')}</span>
                <ToggleSwitch
                  checked={compactMode}
                  onChange={onCompactModeChange}
                  ariaLabel={t('auth_files.compact_mode_label')}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
