import { useId, type InputHTMLAttributes, type ReactNode } from 'react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  /** 渲染在标签正下方的小字行（如赞助跳转链接）。 */
  labelExtra?: ReactNode;
  /** 渲染在标签上方的占位行（用于与同排带 labelExtra 的字段保持输入框对齐）。 */
  topExtra?: ReactNode;
  hint?: string;
  error?: string;
  rightElement?: ReactNode;
}

/**
 * 表单输入框：标签 + 36px 输入框（全局 .input 样式）+ 提示 / 错误行。
 * rightElement 渲染在输入框内部右侧（如显示密钥按钮），此时输入框右侧自动预留空间避免文字被遮挡。
 */
export function Input({
  label,
  labelExtra,
  topExtra,
  hint,
  error,
  rightElement,
  className = '',
  id,
  ...rest
}: InputProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy =
    [rest['aria-describedby'], errorId, hintId].filter(Boolean).join(' ') || undefined;

  return (
    <div className="form-group">
      {topExtra}
      {label && <label htmlFor={inputId}>{label}</label>}
      {labelExtra}
      <div style={{ position: 'relative' }}>
        <input
          id={inputId}
          className={`input ${className}`.trim()}
          aria-invalid={Boolean(error) || rest['aria-invalid']}
          aria-describedby={describedBy}
          {...rest}
          // 有右侧附加元素时预留右内边距；调用方显式传入的 style 优先
          style={rightElement ? { paddingRight: 44, ...rest.style } : rest.style}
        />
        {rightElement && (
          <div
            style={{
              position: 'absolute',
              right: 4,
              top: '50%',
              transform: 'translateY(-50%)',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            {rightElement}
          </div>
        )}
      </div>
      {hint && (
        <div id={hintId} className="hint">
          {hint}
        </div>
      )}
      {error && (
        <div id={errorId} className="error-box">
          {error}
        </div>
      )}
    </div>
  );
}
