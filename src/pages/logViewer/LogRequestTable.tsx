/**
 * 日志页的「按请求」表格：一行一个请求，直接看出由哪个账号处理、中途失败换了几次号。
 * 数据由 buildLogRequestRows 按请求 ID 合并逐行日志得到；点开一行看每次尝试的详情和原始日志。
 */

import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import {
  servingAttempt,
  type LogRequestAttempt,
  type LogRequestRow,
} from '@/pages/hooks/logRequestTable';
import styles from '@/pages/logViewer/LogRequestTable.module.scss';

/** 常见上游错误码 → i18n 键（短标签，放得进账号列）。其余原样显示错误码。 */
const ERROR_LABEL_KEYS: Record<string, string> = {
  server_is_overloaded: 'logs.req_err_overloaded',
  network_error: 'logs.req_err_network',
  server_error: 'logs.req_err_server',
  auth_unavailable: 'logs.req_err_auth',
  rate_limit_exceeded: 'logs.req_err_rate_limit',
  usage_limit_reached: 'logs.req_err_usage_limit',
};

/** 邮箱只显示 @ 前面的部分，完整名称放悬停提示。 */
const shortAccount = (account: string) => account.split('@')[0] || account;

const statusTone = (status?: number) => {
  if (status === undefined) return styles.statusPending;
  if (status >= 500) return styles.statusError;
  if (status >= 400) return styles.statusWarn;
  return styles.statusOk;
};

/** 时间只显示时分秒；日期在悬停提示里（日志通常只看最近一段）。 */
const timeOfDay = (ts?: string) => (ts ? (ts.split(' ')[1] ?? ts) : '');

type Props = {
  rows: LogRequestRow[];
  /** 可下载单个请求的详细日志（CPA 开启了请求日志）时提供 */
  onOpenRequestLog?: (requestId: string) => void;
  onCopyLine: (raw: string) => void;
};

export function LogRequestTable({ rows, onOpenRequestLog, onCopyLine }: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const errorLabel = (code: string) => (ERROR_LABEL_KEYS[code] ? t(ERROR_LABEL_KEYS[code]) : code);

  return (
    <div className={styles.table} role="table">
      <div className={`${styles.row} ${styles.head}`} role="row">
        <span role="columnheader">{t('logs.req_col_time')}</span>
        <span role="columnheader">{t('logs.req_col_status')}</span>
        <span role="columnheader">{t('logs.req_col_latency')}</span>
        <span role="columnheader">{t('logs.req_col_model')}</span>
        <span role="columnheader">{t('logs.req_col_account')}</span>
        <span role="columnheader">{t('logs.req_col_client')}</span>
        <span role="columnheader">{t('logs.req_col_request')}</span>
      </div>

      {rows.map((row) => {
        const open = expanded.has(row.id);
        const serving = servingAttempt(row);
        const failures = row.attempts.filter((a) => a.failed);
        const rowTone =
          row.level === 'error' ? styles.rowError : row.level === 'warn' ? styles.rowWarn : '';
        return (
          <Fragment key={row.id}>
            <div
              className={`${styles.row} ${styles.dataRow} ${rowTone} ${open ? styles.rowOpen : ''}`}
              role="row"
              tabIndex={0}
              aria-expanded={open}
              onClick={() => toggle(row.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  toggle(row.id);
                }
              }}
            >
              <span className={styles.mono} role="cell" title={row.startedAt}>
                {timeOfDay(row.startedAt)}
              </span>
              <span role="cell">
                <span className={`${styles.status} ${statusTone(row.statusCode)}`}>
                  {row.statusCode ?? t('logs.req_pending')}
                </span>
              </span>
              <span className={styles.mono} role="cell">
                {row.latency ?? '—'}
              </span>
              <span className={styles.truncate} role="cell" title={row.model}>
                {row.model ?? '—'}
              </span>
              <span className={styles.accountCell} role="cell">
                {failures.length === 1 && (
                  <span
                    className={styles.failedAccount}
                    title={`${failures[0].account}：${failures[0].failed?.status ?? ''} ${failures[0].failed?.code ?? ''}`}
                  >
                    <span className={styles.failedName}>{shortAccount(failures[0].account)}</span>
                    <span className={styles.failedReason}>
                      {errorLabel(failures[0].failed?.code ?? '')}
                    </span>
                    <span className={styles.arrow} aria-hidden="true">
                      →
                    </span>
                  </span>
                )}
                {/* 换了两次以上：收成一个标签，悬停看完整经过，避免一行里挤多个账号名 */}
                {failures.length > 1 && (
                  <span
                    className={styles.failedAccount}
                    title={failures
                      .map((a) => `${a.account}：${errorLabel(a.failed?.code ?? '')}`)
                      .join('\n')}
                  >
                    <span className={styles.failedReason}>
                      {t('logs.req_failovers', { count: failures.length })}
                    </span>
                    <span className={styles.arrow} aria-hidden="true">
                      →
                    </span>
                  </span>
                )}
                {serving ? (
                  <AccountName attempt={serving} />
                ) : row.attempts.length === 0 ? (
                  <span className={styles.muted}>—</span>
                ) : (
                  <span className={styles.muted}>{t('logs.req_all_failed')}</span>
                )}
              </span>
              <span className={styles.mono} role="cell">
                {row.ip ?? '—'}
              </span>
              <span className={styles.requestCell} role="cell" title={row.path}>
                {row.method && <span className={styles.method}>{row.method}</span>}
                <span className={styles.truncate}>{row.path ?? '—'}</span>
              </span>
            </div>

            {open && (
              <div className={styles.detail} role="row">
                <div className={styles.detailHead}>
                  {row.requestId && (
                    <span className={styles.mono}>
                      {t('logs.req_id')} {row.requestId}
                    </span>
                  )}
                  {row.startedAt && <span className={styles.mono}>{row.startedAt}</span>}
                  {row.requestId && onOpenRequestLog && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={(event) => {
                        event.stopPropagation();
                        onOpenRequestLog(row.requestId as string);
                      }}
                    >
                      {t('logs.req_open_request_log')}
                    </Button>
                  )}
                </div>

                {row.attempts.length > 0 && (
                  <ol className={styles.attempts}>
                    {row.attempts.map((a, i) => (
                      <li key={`${a.authFile}-${i}`} className={styles.attempt}>
                        <span className={styles.attemptIndex}>{i + 1}</span>
                        <span className={styles.attemptAccount} title={a.authFile}>
                          {a.account}
                          {a.plan && <span className={styles.plan}>{a.plan}</span>}
                        </span>
                        {a.affinity && (
                          <span className={styles.muted}>
                            {t(`logs.req_affinity_${a.affinity}`)}
                          </span>
                        )}
                        {a.failed ? (
                          <span className={styles.attemptFailed}>
                            {[a.failed.status, a.failed.latency, a.failed.code]
                              .filter(Boolean)
                              .join(' · ')}
                            {a.failed.message && (
                              <span className={styles.attemptMessage}> — {a.failed.message}</span>
                            )}
                          </span>
                        ) : (
                          <span className={styles.attemptOk}>
                            {row.statusCode !== undefined
                              ? t('logs.req_attempt_served')
                              : t('logs.req_pending')}
                          </span>
                        )}
                      </li>
                    ))}
                  </ol>
                )}

                <div className={styles.rawLines}>
                  {row.lines.map((line, i) => (
                    <div
                      key={i}
                      className={styles.rawLine}
                      title={t('logs.double_click_copy_hint')}
                      onDoubleClick={(event) => {
                        event.stopPropagation();
                        onCopyLine(line.raw);
                      }}
                    >
                      {line.raw}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

/** 处理请求的账号：短名 + 套餐；会话复用时加一个弱化标记。 */
function AccountName({ attempt }: { attempt: LogRequestAttempt }) {
  const { t } = useTranslation();
  return (
    <span className={styles.servingAccount} title={attempt.authFile}>
      <span className={styles.truncate}>{shortAccount(attempt.account)}</span>
      {attempt.plan && <span className={styles.plan}>{attempt.plan}</span>}
      {(attempt.affinity === 'hit' || attempt.affinity === 'fork') && (
        <span className={styles.reuse} title={t(`logs.req_affinity_${attempt.affinity}`)}>
          {t('logs.req_reused')}
        </span>
      )}
    </span>
  );
}
