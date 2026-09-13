/** 加载旋转指示（规范保留的状态反馈动画），颜色继承 currentColor */
export function LoadingSpinner({
  size = 20,
  className = '',
}: {
  size?: number;
  className?: string;
}) {
  return (
    <div
      className={`loading-spinner${className ? ` ${className}` : ''}`}
      style={{ width: size, height: size, borderWidth: size / 7 }}
      role="status"
      aria-live="polite"
    />
  );
}
