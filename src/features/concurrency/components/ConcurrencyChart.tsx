/**
 * 各账号并发的时间曲线：分行小图（small multiples），每个账号一行。
 *
 * 为什么不画在一张图里：几条阶梯线在 0–10 的小范围里反复交叉，叠在一起像一团乱麻，
 * 看不出哪个号在什么时段忙（dataviz 规范的「多线缠绕」反模式）。分行后：
 * - 所有行共用同一个 y 刻度（行高相同、最大值相同），行与行之间可以直接比高低；
 * - 时间轴对齐，只在最底下画一次刻度；
 * - 账号名直接写在每行左侧，身份不只靠颜色；浅色下对比度不足 3:1 的两种颜色因此也有文字补偿；
 * - 每个点是一个时间桶内的峰值，用阶梯面积：并发是整数，斜线会暗示不存在的中间值。
 * 悬停或键盘左右键移动竖线（贯穿所有行），吸附到最近的时间桶，提示框列出这一刻各账号的值。
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConcurrencyAccount, ConcurrencyStats } from '@/services/api/accountStats';
import { alignedTimeTicks, integerTicks, timeTickStepMs } from '@/features/concurrency/logic';
import styles from '@/features/concurrency/components/ConcurrencyChart.module.scss';

/** 每行的高度与行间距 */
const ROW_H = 56;
const ROW_GAP = 10;
/** 左侧账号名、右侧刻度、底部时间轴的留白 */
const LABEL_W = 150;
const RIGHT_W = 28;
const AXIS_H = 24;

type Props = {
  stats: ConcurrencyStats;
  accounts: ConcurrencyAccount[];
  slots: Map<string, number>;
};

/** 邮箱只显示 @ 前面的部分。 */
const shortName = (email: string) => email.split('@')[0] || email;

const pad2 = (n: number) => String(n).padStart(2, '0');
const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const mmdd = (ms: number) => {
  const d = new Date(ms);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

export function ConcurrencyChart({ stats, accounts, slots }: Props) {
  const { t } = useTranslation();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  // 宽度跟随容器；高度按行数固定，文字不会像 viewBox 缩放那样被拉伸
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      setWidth(Math.round(entries[0].contentRect.width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const starts = stats.bucketStartsMs;
  const bucketMs = stats.bucketMinutes * 60_000;
  const startMs = starts[0] ?? 0;
  const endMs = Math.max(stats.generatedAtMs ?? 0, (starts[starts.length - 1] ?? 0) + bucketMs);
  // 所有行共用一个上限，行与行才能直接比较
  const yTicks = integerTicks(Math.max(1, ...accounts.flatMap((a) => a.buckets)));
  const yMax = yTicks[yTicks.length - 1];

  // 窄屏时把账号名放到每行上方，绘图区占满宽度
  const narrow = width > 0 && width < 520;
  const labelW = narrow ? 0 : LABEL_W;
  const rowStride = ROW_H + ROW_GAP + (narrow ? 16 : 0);
  const plotLeft = labelW;
  const plotW = Math.max(0, width - labelW - RIGHT_W);
  const height = accounts.length * rowStride - ROW_GAP + AXIS_H;

  const x = (ms: number) => plotLeft + ((ms - startMs) / (endMs - startMs || 1)) * plotW;
  const rowTop = (i: number) => i * rowStride + (narrow ? 16 : 0);
  const y = (i: number, v: number) => rowTop(i) + ROW_H - (v / yMax) * ROW_H;

  const xTicks = useMemo(
    () => alignedTimeTicks(startMs, endMs, timeTickStepMs(endMs - startMs)),
    [startMs, endMs]
  );
  const multiDay = endMs - startMs > 26 * 3_600_000;

  /**
   * 第一个有日志覆盖的桶：更早的时段 CPA 日志已轮转删除，不画线（画成 0 会被误读成空闲），
   * 只留灰色底。
   */
  const firstCovered =
    stats.logFromMs === null
      ? 0
      : Math.max(
          0,
          starts.findIndex((ms) => ms + bucketMs > (stats.logFromMs as number))
        );

  /** 阶梯轮廓：第 k 个桶在 [start_k, start_{k+1}) 上保持该桶的峰值。 */
  const stepPath = (account: ConcurrencyAccount, i: number) => {
    let d = '';
    account.buckets.forEach((v, k) => {
      if (k < firstCovered) return;
      const x0 = x(
        k === firstCovered ? Math.max(starts[k], stats.logFromMs ?? starts[k]) : starts[k]
      );
      const x1 = x(k + 1 < starts.length ? starts[k + 1] : endMs);
      d += k === firstCovered ? `M${x0},${y(i, v)}H${x1}` : `V${y(i, v)}H${x1}`;
    });
    return d;
  };
  /** 面积起点：与轮廓一致，从有日志的时刻开始。 */
  const coveredStartX = x(
    firstCovered === 0 ? startMs : Math.max(starts[firstCovered], stats.logFromMs ?? startMs)
  );
  /** 面积：轮廓加上回到基线的闭合段。 */
  const areaPath = (account: ConcurrencyAccount, i: number) =>
    account.buckets.length === 0
      ? ''
      : `${stepPath(account, i)}V${rowTop(i) + ROW_H}H${coveredStartX}Z`;

  const indexAt = (clientX: number) => {
    const el = wrapRef.current;
    if (!el || starts.length === 0) return null;
    const px = clientX - el.getBoundingClientRect().left;
    const ms = startMs + ((px - plotLeft) / (plotW || 1)) * (endMs - startMs);
    const k = Math.floor((ms - startMs) / bucketMs);
    return Math.min(starts.length - 1, Math.max(0, k));
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) =>
    setHoverIndex(indexAt(event.clientX));

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (starts.length === 0) return;
    const step = event.shiftKey ? 12 : 1;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const delta = event.key === 'ArrowLeft' ? -step : step;
      setHoverIndex((prev) =>
        Math.min(starts.length - 1, Math.max(0, (prev ?? starts.length - 1) + delta))
      );
    } else if (event.key === 'Escape') {
      setHoverIndex(null);
    }
  };

  const hoverX = hoverIndex !== null ? x(starts[hoverIndex] + bucketMs / 2) : null;
  const tooltipOnLeft = hoverX !== null && hoverX > width * 0.6;
  const noDataUntil =
    stats.logFromMs !== null && stats.logFromMs > startMs ? x(stats.logFromMs) : null;

  return (
    <div
      ref={wrapRef}
      className={styles.plot}
      tabIndex={0}
      role="img"
      aria-label={t('concurrency.chart_label', { hours: stats.hours })}
      onPointerMove={onPointerMove}
      onPointerLeave={() => setHoverIndex(null)}
      onKeyDown={onKeyDown}
      onBlur={() => setHoverIndex(null)}
    >
      {width > 0 && (
        <svg width={width} height={height} className={styles.svg} aria-hidden="true">
          {accounts.map((a, i) => {
            const slot = slots.get(a.name) ?? 0;
            const top = rowTop(i);
            return (
              <g key={a.name}>
                {/* 账号名：宽屏在左侧，窄屏在行上方 */}
                <text
                  x={0}
                  y={narrow ? top - 5 : top + ROW_H / 2}
                  className={narrow ? styles.rowLabelTop : styles.rowLabel}
                >
                  {shortName(a.email)}
                </text>
                {noDataUntil !== null && (
                  // 日志没覆盖到的时段：浅色遮罩，避免把「没有数据」读成「并发为 0」
                  <rect
                    x={plotLeft}
                    y={top}
                    width={Math.max(0, noDataUntil - plotLeft)}
                    height={ROW_H}
                    className={styles.noData}
                  />
                )}
                {/* 上限虚线与基线：每行同一个上限，数值写在右侧 */}
                <line
                  x1={plotLeft}
                  x2={plotLeft + plotW}
                  y1={top}
                  y2={top}
                  className={styles.grid}
                />
                <text x={plotLeft + plotW + 6} y={top} className={styles.yLabel}>
                  {yMax}
                </text>
                <path d={areaPath(a, i)} className={styles.area} data-slot={slot} />
                <path d={stepPath(a, i)} className={styles.line} data-slot={slot} />
                <line
                  x1={plotLeft}
                  x2={plotLeft + plotW}
                  y1={top + ROW_H}
                  y2={top + ROW_H}
                  className={styles.baseline}
                />
              </g>
            );
          })}

          {xTicks.map((ms) => (
            <text key={`x${ms}`} x={x(ms)} y={height - 6} className={styles.xLabel}>
              {multiDay && new Date(ms).getHours() === 0 ? mmdd(ms) : hhmm(ms)}
            </text>
          ))}

          {hoverX !== null && (
            <line
              x1={hoverX}
              x2={hoverX}
              y1={0}
              y2={height - AXIS_H}
              className={styles.crosshair}
            />
          )}
        </svg>
      )}

      {hoverIndex !== null && hoverX !== null && (
        <div
          className={styles.tooltip}
          style={
            tooltipOnLeft ? { right: width - hoverX + 12, top: 0 } : { left: hoverX + 12, top: 0 }
          }
        >
          <div className={styles.tooltipTime}>
            {multiDay ? `${mmdd(starts[hoverIndex])} ` : ''}
            {hhmm(starts[hoverIndex])}–{hhmm(starts[hoverIndex] + bucketMs)}
          </div>
          {accounts.map((a) => (
            <div key={a.name} className={styles.tooltipRow}>
              <span className={styles.swatch} data-slot={slots.get(a.name) ?? 0} />
              <span className={styles.tooltipName}>{shortName(a.email)}</span>
              <span className={styles.tooltipValue}>{a.buckets[hoverIndex] ?? 0}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
