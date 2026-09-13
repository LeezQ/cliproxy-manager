import type { ChangeEvent, ReactNode } from 'react';
import { IconCheck } from '@/components/ui/icons';
import styles from '@/components/ui/SelectionCheckbox.module.scss';

interface SelectionCheckboxProps {
  checked: boolean;
  onChange: (value: boolean) => void;
  label?: ReactNode;
  ariaLabel?: string;
  title?: string;
  disabled?: boolean;
  className?: string;
  labelClassName?: string;
}

/**
 * 复选框（shadcn Checkbox 风格）：16px 方框 / 4px 圆角 / 选中主色底 + 对勾。
 * 原生 input 视觉隐藏但保留焦点与读屏语义，可选渲染右侧文字标签。
 */
export function SelectionCheckbox({
  checked,
  onChange,
  label,
  ariaLabel,
  title,
  disabled = false,
  className,
  labelClassName,
}: SelectionCheckboxProps) {
  const rootClassName = [styles.root, disabled ? styles.disabled : '', className]
    .filter(Boolean)
    .join(' ');
  const boxClassName = [styles.box, checked ? styles.boxChecked : ''].filter(Boolean).join(' ');
  const textClassName = [styles.label, labelClassName].filter(Boolean).join(' ');

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    onChange(event.target.checked);
  };

  return (
    <label className={rootClassName} title={title}>
      <input
        className={styles.input}
        type="checkbox"
        checked={checked}
        onChange={handleChange}
        aria-label={ariaLabel}
        disabled={disabled}
      />
      <span className={boxClassName}>{checked ? <IconCheck size={12} /> : null}</span>
      {label ? <div className={textClassName}>{label}</div> : null}
    </label>
  );
}
