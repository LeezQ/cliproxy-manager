import { useTranslation } from 'react-i18next';
import { IconLayoutGrid, IconLayoutRows } from '@/components/ui/icons';
import type { LayoutMode } from '@/components/common/layoutMode';
import styles from '@/components/common/LayoutToggle.module.scss';

export type LayoutToggleProps = {
  value: LayoutMode;
  onChange: (mode: LayoutMode) => void;
  className?: string;
};

/**
 * 「卡片 / 列表」布局切换：两个只含图标的分段按钮，文字说明放在 title 与 aria-label。
 * 外观与工具栏里的其它分段控件一致（36px 高、浅灰底、选中项白底描边）。
 */
export function LayoutToggle({ value, onChange, className }: LayoutToggleProps) {
  const { t } = useTranslation();
  const options = [
    { mode: 'card', label: t('common.layout_card'), Icon: IconLayoutGrid },
    { mode: 'list', label: t('common.layout_list'), Icon: IconLayoutRows },
  ] as const;

  return (
    <div
      className={[styles.toggle, className].filter(Boolean).join(' ')}
      role="group"
      aria-label={t('common.layout_label')}
    >
      {options.map(({ mode, label, Icon }) => {
        const isActive = value === mode;
        return (
          <button
            key={mode}
            type="button"
            className={`${styles.option} ${isActive ? styles.optionActive : ''}`}
            aria-pressed={isActive}
            title={label}
            aria-label={label}
            onClick={() => onChange(mode)}
          >
            <Icon size={15} />
          </button>
        );
      })}
    </div>
  );
}
