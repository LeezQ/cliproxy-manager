/**
 * 账号并发页。
 *
 * 看每个账号同时在处理几个请求：当前值、今日峰值、窗口内峰值及时间、忙时平均，
 * 以及按时间桶的峰值曲线。数据由服务器从 CPA 日志反推（CPA 单机模式本身不统计），
 * 每 30 秒自动刷新。页面结构与降智检测页一致：工具卡片 → 曲线 → 数值表。
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconRefreshCw } from '@/components/ui/icons';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import type { ConcurrencyAccount } from '@/services/api/accountStats';
import { useConcurrency } from '@/features/concurrency/hooks/useConcurrency';
import {
  CONCURRENCY_WINDOWS,
  assignSeriesSlots,
  bucketMinutesFor,
  chartAccounts,
} from '@/features/concurrency/logic';
import { ConcurrencyChart } from '@/features/concurrency/components/ConcurrencyChart';
import styles from '@/features/concurrency/ConcurrencyPage.module.scss';

const pad2 = (n: number) => String(n).padStart(2, '0');
const formatTime = (ms: number | null) => {
  if (ms === null) return '—';
  const d = new Date(ms);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

export function ConcurrencyPage() {
  const { t } = useTranslation();
  const [hours, setHours] = useLocalStorage<number>('concurrencyPage.hours', 24);
  const windowHours = CONCURRENCY_WINDOWS.some((w) => w.hours === hours) ? hours : 24;
  const { stats, loading, error, refresh } = useConcurrency({
    hours: windowHours,
    bucketMinutes: bucketMinutesFor(windowHours),
  });

  const accounts = useMemo(() => chartAccounts(stats?.accounts ?? []), [stats]);
  const slots = useMemo(() => assignSeriesSlots(accounts), [accounts]);
  const totalCurrent = accounts.reduce((sum, a) => sum + a.current, 0);

  const windowLabel = (h: number) =>
    h < 48
      ? t('concurrency.window_hours', { count: h })
      : t('concurrency.window_days', { count: h / 24 });

  return (
    <div className={styles.page}>
      <h1 className={styles.srOnly}>{t('concurrency.title')}</h1>

      <section className={styles.toolCard}>
        <div className={styles.toolInfo}>
          <span className={styles.toolTitle}>{t('concurrency.title')}</span>
          <span className={styles.toolMeta}>
            {stats
              ? t('concurrency.meta', {
                  total: totalCurrent,
                  updated: formatTime(stats.generatedAtMs),
                })
              : t('concurrency.meta_loading')}
          </span>
        </div>
        <div className={styles.toolActions}>
          <div className={styles.windows} role="radiogroup" aria-label={t('concurrency.window')}>
            {CONCURRENCY_WINDOWS.map((w) => (
              <button
                key={w.hours}
                type="button"
                role="radio"
                aria-checked={windowHours === w.hours}
                className={`${styles.window} ${windowHours === w.hours ? styles.windowActive : ''}`}
                onClick={() => setHours(w.hours)}
              >
                {windowLabel(w.hours)}
              </button>
            ))}
          </div>
          <Button variant="secondary" size="sm" onClick={() => void refresh()} disabled={loading}>
            <IconRefreshCw
              size={14}
              aria-hidden="true"
              className={loading ? styles.spinning : undefined}
            />
            {t('concurrency.refresh')}
          </Button>
        </div>
      </section>

      {error === 'unavailable' ? (
        <div className={styles.panel}>
          <EmptyState
            title={t('concurrency.unavailable_title')}
            description={t('concurrency.unavailable_desc')}
          />
        </div>
      ) : error ? (
        <div className={styles.errorBanner} role="alert">
          {t('concurrency.load_failed', { message: error })}
        </div>
      ) : null}

      {stats && accounts.length > 0 && (
        <>
          <section className={styles.chartCard}>
            <div className={styles.chartHead}>
              <h2 className={styles.sectionTitle}>
                {t('concurrency.chart_title', { window: windowLabel(windowHours) })}
              </h2>
              <span className={styles.chartNote}>
                {t('concurrency.chart_note', { minutes: stats.bucketMinutes })}
              </span>
            </div>
            <ConcurrencyChart stats={stats} accounts={accounts} slots={slots} />
            {stats.logFromMs !== null && stats.bucketStartsMs[0] < stats.logFromMs && (
              <p className={styles.coverage}>
                {t('concurrency.coverage', { from: formatTime(stats.logFromMs) })}
              </p>
            )}
          </section>

          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>{t('concurrency.table_title')}</h2>
            <div className={styles.rows} role="table">
              <div className={`${styles.row} ${styles.headRow}`} role="row">
                <span role="columnheader">{t('concurrency.col_account')}</span>
                <span role="columnheader">{t('concurrency.col_current')}</span>
                <span role="columnheader">{t('concurrency.col_today_peak')}</span>
                <span role="columnheader">
                  {t('concurrency.col_window_peak', { window: windowLabel(windowHours) })}
                </span>
                <span role="columnheader" title={t('concurrency.avg_busy_hint')}>
                  {t('concurrency.col_avg_busy')}
                </span>
                <span role="columnheader">{t('concurrency.col_attempts')}</span>
              </div>
              {accounts.map((a) => (
                <AccountRow key={a.name} account={a} slot={slots.get(a.name) ?? 0} />
              ))}
            </div>
            <p className={styles.footnote}>{t('concurrency.footnote')}</p>
          </section>
        </>
      )}

      {stats && accounts.length === 0 && !error && (
        <div className={styles.panel}>
          <EmptyState title={t('concurrency.empty_title')} />
        </div>
      )}
    </div>
  );
}

/** 数值表的一行：色块与图例一致，数值用文字色。 */
function AccountRow({ account, slot }: { account: ConcurrencyAccount; slot: number }) {
  const { t } = useTranslation();
  const sub = [
    account.plan,
    !account.exists ? t('concurrency.removed') : account.disabled ? t('concurrency.disabled') : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className={styles.row} role="row">
      <span className={styles.cellAccount} role="cell">
        <span className={styles.swatch} data-slot={slot} aria-hidden="true" />
        <span className={styles.accountText}>
          <span className={styles.email} title={account.name}>
            {account.email}
          </span>
          {sub && <span className={styles.subline}>{sub}</span>}
        </span>
      </span>
      <span
        className={`${styles.num} ${account.current > 0 ? styles.numActive : styles.numMuted}`}
        role="cell"
      >
        {account.current}
      </span>
      <span className={styles.num} role="cell">
        {account.todayPeak}
      </span>
      <span className={styles.cellPeak} role="cell">
        <span className={styles.num}>{account.peak}</span>
        {account.peakAtMs !== null && (
          <span className={styles.subline}>{formatTime(account.peakAtMs)}</span>
        )}
      </span>
      <span className={styles.num} role="cell">
        {account.avgBusy !== null ? account.avgBusy.toFixed(1) : '—'}
      </span>
      <span className={`${styles.num} ${styles.numMuted}`} role="cell">
        {account.attempts.toLocaleString()}
      </span>
    </div>
  );
}
