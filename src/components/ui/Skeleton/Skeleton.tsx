import type { CSSProperties, HTMLAttributes } from 'react';
import styles from '@/components/ui/Skeleton/Skeleton.module.scss';

interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  width?: number | string;
  height?: number | string;
  rounded?: number | string;
}

/** 骨架屏占位块：可直接传入宽高与圆角，默认 8px 圆角 + shimmer */
export function Skeleton({ width, height, rounded, className, style, ...rest }: SkeletonProps) {
  const merged: CSSProperties = {
    ...style,
    width: width ?? style?.width,
    height: height ?? style?.height,
    borderRadius: rounded ?? style?.borderRadius,
  };
  const cls = [styles.skeleton, className].filter(Boolean).join(' ');
  return <div className={cls} style={merged} aria-hidden="true" {...rest} />;
}
