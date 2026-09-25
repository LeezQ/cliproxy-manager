/**
 * 降智检测页。
 *
 * 服务器上的 cpa-account 每 3 小时给每个账号出一道固定逻辑题（糖果题，正确答案 21），
 * 本页展示：各账号的汇总（最近一次结论、正确率、推理 token 中位数、走势），
 * 以及按时间排列的原始记录，用来回答「哪个号、什么时候被降智」。
 * 也可以在这里手动触发一轮检测，检测在服务器后台执行，离开页面不影响。
 *
 * 页面结构与配额页一致：工具卡片（说明 + 操作）→ 账号列表 → 记录列表。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Select } from '@/components/ui/Select';
import { IconRefreshCw } from '@/components/ui/icons';
import { useNotificationStore } from '@/stores';
import {
  qualityProbeApi,
  type QualityAccountSummary,
  type QualityRecord,
} from '@/services/api/qualityProbe';
import { useQualityProbe } from '@/features/qualityProbe/hooks/useQualityProbe';
import {
  formatQualityElapsed,
  formatQualityTime,
  isDegradedReasoningMark,
} from '@/features/qualityProbe/logic';
import { QualityTrend, QualityVerdictBadge } from '@/features/qualityProbe/components/QualityMarks';
import styles from '@/features/qualityProbe/QualityProbePage.module.scss';

/** 记录列表一次最多取多少条。 */
const RECORDS_LIMIT = 100;
/** 统计窗口（天）。 */
const SUMMARY_DAYS = 7;

export function QualityProbePage() {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const probe = useQualityProbe({ days: SUMMARY_DAYS });
  const { summary, job, error, loading } = probe;

  const [records, setRecords] = useState<QualityRecord[]>([]);
  const [recordsError, setRecordsError] = useState<string | null>(null);
  const [recordFilter, setRecordFilter] = useState('all');

  const running = job?.status === 'running';
  const mark = summary?.degradedReasoningMark ?? 516;

  const loadRecords = useCallback(async () => {
    try {
      setRecords(await qualityProbeApi.getRecords(RECORDS_LIMIT));
      setRecordsError(null);
    } catch (err: unknown) {
      console.warn('[qualityProbe] 读取检测记录失败', err);
      setRecordsError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // 汇总每刷新一次（首次加载、检测结束）就同步刷新记录
  useEffect(() => {
    if (summary) void loadRecords();
  }, [summary, loadRecords]);

  const handleRun = async (target: string) => {
    const err = await probe.run(target);
    if (err) {
      showNotification(t('quality_probe.start_failed', { message: err }), 'error');
    } else {
      showNotification(t('quality_probe.started'), 'success');
    }
  };

  const handleRefresh = async () => {
    await probe.refresh();
  };

  const filterOptions = useMemo(
    () => [
      { value: 'all', label: t('quality_probe.records_all') },
      ...(summary?.accounts ?? []).map((a) => ({ value: a.email, label: a.email || a.name })),
    ],
    [summary, t]
  );

  const visibleRecords = useMemo(
    () => (recordFilter === 'all' ? records : records.filter((r) => r.email === recordFilter)),
    [records, recordFilter]
  );

  // 检测进行中：正在跑的账号用于在行内显示「检测中」
  const pendingSet = useMemo(() => new Set(running ? job.pending : []), [running, job]);

  const unavailable = error === 'unavailable';

  return (
    <div className={styles.page}>
      <h1 className={styles.srOnly}>{t('quality_probe.title')}</h1>

      <section className={styles.toolCard}>
        <div className={styles.toolInfo}>
          <span className={styles.toolTitle}>{t('quality_probe.title')}</span>
          {summary && (
            <span className={styles.toolMeta}>
              {t('quality_probe.intro', {
                answer: summary.expectedAnswer,
                model: summary.model,
                effort: summary.effort,
                days: summary.days,
              })}
            </span>
          )}
        </div>
        <div className={styles.toolActions}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handleRefresh()}
            disabled={loading}
          >
            <IconRefreshCw
              size={14}
              aria-hidden="true"
              className={loading ? styles.spinning : undefined}
            />
            {t('quality_probe.refresh')}
          </Button>
          <Button
            size="sm"
            onClick={() => void handleRun('all')}
            disabled={unavailable || running || probe.starting || !summary?.accounts.length}
          >
            {t('quality_probe.run_all')}
          </Button>
        </div>

        {running && (
          <div className={styles.jobBanner} role="status">
            <IconRefreshCw size={14} aria-hidden="true" className={styles.spinning} />
            <span>
              {t('quality_probe.running', {
                done: job.records.length,
                total: job.records.length + job.pending.length,
              })}
            </span>
            <span className={styles.jobHint}>{t('quality_probe.running_hint')}</span>
          </div>
        )}
      </section>

      {unavailable ? (
        <div className={styles.panel}>
          <EmptyState
            title={t('quality_probe.unavailable_title')}
            description={t('quality_probe.unavailable_desc')}
          />
        </div>
      ) : error ? (
        <div className={styles.errorBanner} role="alert">
          {t('quality_probe.load_failed', { message: error })}
        </div>
      ) : null}

      {summary && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>
            {t('quality_probe.accounts_title')}
            <span className={styles.sectionCount}>{summary.accounts.length}</span>
          </h2>
          {summary.accounts.length === 0 ? (
            <div className={styles.panel}>
              <EmptyState title={t('quality_probe.empty_title')} />
            </div>
          ) : (
            <div className={styles.rows} role="table">
              <div className={`${styles.accountRow} ${styles.headRow}`} role="row">
                <span role="columnheader">{t('quality_probe.col_account')}</span>
                <span role="columnheader">{t('quality_probe.col_last')}</span>
                <span role="columnheader">{t('quality_probe.col_rate')}</span>
                <span role="columnheader">{t('quality_probe.col_trend')}</span>
                <span role="columnheader" className={styles.srOnly}>
                  {t('quality_probe.col_actions')}
                </span>
              </div>
              {summary.accounts.map((account) => (
                <AccountRow
                  key={account.name || account.email}
                  account={account}
                  mark={mark}
                  testing={pendingSet.has(account.email) || pendingSet.has(account.name)}
                  disabled={running || probe.starting}
                  onRun={() => void handleRun(account.name)}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {summary && (
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>
              {t('quality_probe.records_title')}
              <span className={styles.sectionCount}>{visibleRecords.length}</span>
            </h2>
            <div className={styles.recordFilter}>
              <Select
                value={recordFilter}
                options={filterOptions}
                onChange={setRecordFilter}
                ariaLabel={t('quality_probe.records_filter')}
                size="sm"
              />
            </div>
          </div>
          {recordsError && (
            <div className={styles.errorBanner} role="alert">
              {t('quality_probe.load_failed', { message: recordsError })}
            </div>
          )}
          {visibleRecords.length === 0 ? (
            <div className={styles.panel}>
              <EmptyState title={t('quality_probe.records_empty')} />
            </div>
          ) : (
            <div className={styles.rows} role="table">
              <div className={`${styles.recordRow} ${styles.headRow}`} role="row">
                <span role="columnheader">{t('quality_probe.col_time')}</span>
                <span role="columnheader">{t('quality_probe.col_account')}</span>
                <span role="columnheader">{t('quality_probe.col_verdict')}</span>
                <span role="columnheader">{t('quality_probe.col_answer')}</span>
                <span role="columnheader">{t('quality_probe.col_reasoning')}</span>
                <span role="columnheader">{t('quality_probe.col_elapsed')}</span>
                <span role="columnheader">{t('quality_probe.col_detail')}</span>
              </div>
              {visibleRecords.map((record, i) => (
                <RecordRow key={`${record.ts}-${record.name}-${i}`} record={record} mark={mark} />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

/** 账号汇总行：账号 | 最近一次 | 正确率 + 推理中位 | 走势 | 测一次。 */
function AccountRow({
  account,
  mark,
  testing,
  disabled,
  onRun,
}: {
  account: QualityAccountSummary;
  mark: number;
  testing: boolean;
  disabled: boolean;
  onRun: () => void;
}) {
  const { t } = useTranslation();
  const last = account.last;
  const rateTone =
    account.rate === null
      ? styles.muted
      : account.rate === 100
        ? styles.ratePass
        : account.rate === 0
          ? styles.rateFail
          : styles.rateMixed;

  return (
    <div className={styles.accountRow} role="row">
      <div className={styles.cellAccount} role="cell">
        <span className={styles.email} title={account.name}>
          {account.email || account.name}
        </span>
        <span className={styles.subline}>
          {[account.plan, account.exit].filter(Boolean).join(' · ') || '—'}
        </span>
      </div>

      <div className={styles.cellLast} role="cell">
        {testing ? (
          <span className={styles.testing}>
            <IconRefreshCw size={12} aria-hidden="true" className={styles.spinning} />
            {t('quality_probe.testing')}
          </span>
        ) : last ? (
          <>
            <QualityVerdictBadge verdict={last.verdict} title={last.error || last.answerTail} />
            <span className={styles.subline}>
              {last.verdict === 'failed' ? (
                <span className={styles.truncate} title={last.error}>
                  {last.error || '—'}
                </span>
              ) : (
                <>
                  <span>{t('quality_probe.answer', { value: last.answer ?? '—' })}</span>
                  <ReasoningValue tokens={last.reasoningTokens} mark={mark} />
                </>
              )}
              <span>{formatQualityTime(last.ts)}</span>
            </span>
          </>
        ) : (
          <span className={styles.muted}>{t('quality_probe.never_tested')}</span>
        )}
      </div>

      <div className={styles.cellRate} role="cell">
        <span className={`${styles.rate} ${rateTone}`}>
          {account.rate === null ? '—' : `${account.rate}%`}
        </span>
        <span className={styles.subline}>
          {account.valid > 0 && (
            <span>
              {t('quality_probe.rate_value', { passed: account.passed, valid: account.valid })}
            </span>
          )}
          {account.medianReasoning !== null && (
            <span>{t('quality_probe.reasoning_median', { value: account.medianReasoning })}</span>
          )}
        </span>
      </div>

      <div className={styles.cellTrend} role="cell">
        <QualityTrend trend={account.trend} />
      </div>

      <div className={styles.cellActions} role="cell">
        <Button variant="secondary" size="sm" onClick={onRun} disabled={disabled}>
          {t('quality_probe.run_one')}
        </Button>
      </div>
    </div>
  );
}

/** 推理 token；恰好等于降智特征值时加一个标记并在悬停里解释。 */
function ReasoningValue({ tokens, mark }: { tokens: number | null; mark: number }) {
  const { t } = useTranslation();
  const hit = isDegradedReasoningMark(tokens, mark);
  return (
    <span
      className={hit ? styles.reasoningMark : undefined}
      title={hit ? t('quality_probe.reasoning_mark_hint', { mark }) : undefined}
    >
      {t('quality_probe.reasoning', { value: tokens ?? '—' })}
    </span>
  );
}

/** 记录行：时间 | 账号 | 结论 | 答案 | 推理 | 耗时 | 说明。 */
function RecordRow({ record, mark }: { record: QualityRecord; mark: number }) {
  const hit = isDegradedReasoningMark(record.reasoningTokens, mark);
  const detail = record.verdict === 'failed' ? record.error : record.answerTail;
  return (
    <div className={styles.recordRow} role="row">
      <span className={styles.mono} role="cell">
        {formatQualityTime(record.ts)}
      </span>
      <span className={styles.truncate} role="cell" title={record.email}>
        {record.email || record.name}
      </span>
      <span role="cell">
        <QualityVerdictBadge verdict={record.verdict} />
      </span>
      <span className={styles.mono} role="cell">
        {record.answer ?? '—'}
      </span>
      <span className={`${styles.mono} ${hit ? styles.reasoningMark : ''}`} role="cell">
        {record.reasoningTokens ?? '—'}
      </span>
      <span className={styles.mono} role="cell">
        {formatQualityElapsed(record.elapsed)}
      </span>
      <span className={`${styles.truncate} ${styles.detail}`} role="cell" title={detail}>
        {detail || '—'}
      </span>
    </div>
  );
}
