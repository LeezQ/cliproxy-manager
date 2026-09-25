import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { SelectionCheckbox } from '@/components/ui/SelectionCheckbox';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import {
  IconDownload,
  IconInfo,
  IconModelCluster,
  IconRefreshCw,
  IconSettings,
  IconTrash2,
} from '@/components/ui/icons';
import { ProviderStatusBar } from '@/components/providers/ProviderStatusBar';
import { statusBarDataFromRecentRequests } from '@/utils/recentRequests';
import {
  getAuthFileIcon,
  getAuthFileStatusMessage,
  getThemeSurfaceIconBackground,
  getTypeLabel,
  hasAuthFileStatusWarning,
  isRuntimeOnlyAuthFile,
  isStaleAuthFileError,
  isThemeSurfaceIconProvider,
  normalizeProviderKey,
  supportsAuthFileManualRefresh,
} from '@/features/authFiles/constants';
import { deriveAuthFileIdentity } from '@/features/authFiles/identity';
import { resolveAuthFileQuotaType } from '@/features/authFiles/logic';
import {
  deriveAuthFilePlan,
  formatAuthFilePlan,
  isPremiumAuthFilePlan,
} from '@/features/authFiles/listView';
import type { AuthFileCardProps } from '@/features/authFiles/components/AuthFileCard';
import type { AuthFileProxyInfo } from '@/features/authFiles/proxyInfo';
import type { QualityAccountSummary } from '@/services/api/qualityProbe';
import { QualityVerdictBadge } from '@/features/qualityProbe/components/QualityMarks';
import { formatQualityTime, QUALITY_VERDICT_KEY } from '@/features/qualityProbe/logic';
import { AuthFileQuotaSection } from '@/features/authFiles/components/AuthFileQuotaSection';
import { AuthFileCooldownSection } from '@/features/authFiles/components/AuthFileCooldownSection';
import cardStyles from '@/features/authFiles/components/AuthFileCard.module.scss';
import styles from '@/features/authFiles/components/AuthFileRow.module.scss';

/**
 * 请求状态方块条沿用卡片样式（含悬停提示与高亮），只把方块压矮以适配行高。
 * 卡片类名保留（卡片里 `.statusBlockActive .statusBlock` 这类后代规则仍要命中），
 * 再叠加行样式类；行样式用 `.statusBar .statusBlock` 两级选择器提高优先级来覆盖尺寸。
 */
const statusBarStyles: Record<string, string> = {
  ...cardStyles,
  statusBar: `${cardStyles.statusBar} ${styles.statusBar}`,
  statusBlock: `${cardStyles.statusBlock} ${styles.statusBlock}`,
  statusRate: `${cardStyles.statusRate} ${styles.statusRate}`,
};

/** 列表行与卡片共用同一套 props，页面按布局模式二选一渲染；另外多一份出口信息。 */
export type AuthFileRowProps = Omit<AuthFileCardProps, 'compact'> & {
  /** 出口（代理）信息；'loading' 表示凭证文件还在读取。 */
  proxy?: AuthFileProxyInfo | 'loading';
  /** 降智检测汇总；没测过或服务未部署时为 undefined，不显示徽标。 */
  quality?: QualityAccountSummary;
  /** 降智检测的统计窗口（天），用于悬停提示。 */
  qualityDays?: number;
};

/**
 * 认证文件的列表行：一行一个凭证，关键数据横向摊开，账号多时一屏能看到更多。
 *
 * 列：勾选 | 账号（邮箱 + 套餐 + 权重）| 状态 + 出口 | 请求健康度 | 额度 | 操作
 * 仅当有告警、历史错误或冷却时，行下方才多出一条说明，其余行保持同一高度。
 */
export function AuthFileRow(props: AuthFileRowProps) {
  const { t } = useTranslation();
  const {
    file,
    selected,
    resolvedTheme,
    disableControls,
    deleting,
    statusUpdating,
    manualRefreshing,
    quotaFilterType,
    statusBarCache,
    onShowModels,
    onDownload,
    onManualRefresh,
    onOpenPrefixProxyEditor,
    onDelete,
    onToggleStatus,
    onToggleSelect,
    proxy,
    quality,
    qualityDays,
  } = props;

  const isRuntimeOnly = isRuntimeOnlyAuthFile(file);
  const providerKey = normalizeProviderKey(String(file.type ?? file.provider ?? 'unknown'));
  const providerIcon = getAuthFileIcon(providerKey, resolvedTheme);
  const useThemeSurfaceIcon = isThemeSurfaceIconProvider(providerKey);
  const typeLabel = getTypeLabel(t, providerKey);
  const showModelsButton = !isRuntimeOnly || providerKey === 'aistudio';
  const showManualRefreshButton = !isRuntimeOnly && supportsAuthFileManualRefresh(providerKey);
  const isManualRefreshing = manualRefreshing[file.name] === true;
  const isStatusUpdating = statusUpdating[file.name] === true;

  const identity = deriveAuthFileIdentity(file);
  const plan = deriveAuthFilePlan(file);
  const planLabel = formatAuthFilePlan(plan);
  const weightValue = Number.isSafeInteger(file.weight) ? file.weight : undefined;
  const priorityValue = Number.isSafeInteger(file.priority) ? file.priority : undefined;

  const successCount = file.successCount ?? 0;
  const failureCount = file.failureCount ?? 0;
  const authIndexKey = typeof file.authIndex === 'string' ? file.authIndex : null;
  const statusData =
    (authIndexKey && statusBarCache.get(authIndexKey)) ||
    statusBarDataFromRecentRequests(file.recentRequests ?? []);

  const rawStatusMessage = getAuthFileStatusMessage(file);
  const hasStatusWarning = hasAuthFileStatusWarning(file);
  const isStaleError = isStaleAuthFileError(file);

  const quotaType = isRuntimeOnly ? null : resolveAuthFileQuotaType(file, quotaFilterType);

  // 状态列：文案判定与卡片（AuthFileCard 的 stateLabel）逐条一致，两种视图同一个号显示相同；
  // 只是改用圆点 + 文字，避免每行一个带框徽标造成视觉噪音
  const state = isRuntimeOnly
    ? { label: t('auth_files.type_virtual'), tone: styles.toneMuted }
    : file.disabled
      ? { label: t('auth_files.health_status_disabled'), tone: styles.toneMuted }
      : hasStatusWarning
        ? { label: t('auth_files.health_status_warning'), tone: styles.toneWarning }
        : rawStatusMessage
          ? { label: t('auth_files.health_status_healthy'), tone: styles.toneOk }
          : { label: t('auth_files.status_toggle_label'), tone: styles.toneOk };

  // 只有确实有说明要展示时才多出一行：告警、历史错误，或冷却信息（含「状态未知」）
  const hasNotice =
    Boolean(rawStatusMessage && (hasStatusWarning || isStaleError)) ||
    (file.cooldownSnapshot?.records?.length ?? 0) > 0 ||
    file.cooldownSnapshot?.records === null;

  const rowClasses = [
    styles.row,
    hasNotice ? styles.rowWithNotice : '',
    selected ? styles.rowSelected : '',
    file.disabled ? styles.rowDisabled : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={rowClasses} role="row">
      <div className={styles.cellSelect} role="cell">
        {!isRuntimeOnly && (
          <SelectionCheckbox
            checked={selected}
            onChange={() => onToggleSelect(file.name)}
            ariaLabel={t('auth_files.card_select', { name: file.name })}
            title={t('auth_files.card_select', { name: file.name })}
          />
        )}
      </div>

      <div className={styles.cellIdentity} role="cell">
        <span
          className={styles.avatar}
          style={
            useThemeSurfaceIcon
              ? { backgroundColor: getThemeSurfaceIconBackground(resolvedTheme) }
              : undefined
          }
          title={typeLabel}
        >
          {providerIcon ? (
            <img src={providerIcon} alt={typeLabel} className={styles.avatarImage} />
          ) : (
            <span className={styles.avatarFallback}>{typeLabel.slice(0, 1).toUpperCase()}</span>
          )}
        </span>
        <div className={styles.identityText}>
          <span
            className={`${styles.account} ${identity.kind === 'fileName' ? styles.accountMono : ''}`}
            title={identity.fullName || identity.primary}
          >
            {identity.primary}
          </span>
          <span className={styles.identityMeta}>
            {planLabel && (
              <span
                className={`${styles.plan} ${isPremiumAuthFilePlan(plan) ? styles.planPremium : ''}`}
              >
                {planLabel}
              </span>
            )}
            {weightValue !== undefined && (
              <span title={t('auth_files.weight_tooltip')}>
                {t('auth_files.row_weight', { value: weightValue })}
              </span>
            )}
            {priorityValue !== undefined && (
              <span title={t('auth_files.priority_hint')}>
                {t('auth_files.row_priority', { value: priorityValue })}
              </span>
            )}
            {quality?.last && <AuthFileQualityMark quality={quality} days={qualityDays} />}
            {typeof file.note === 'string' && file.note.trim() && (
              <span className={styles.note} title={file.note.trim()}>
                {file.note.trim()}
              </span>
            )}
          </span>
        </div>
      </div>

      {/* 状态与出口合为一列：几乎每行都是「启用」，单独占一列不划算；出口 IP 放第二行 */}
      <div className={styles.cellState} role="cell">
        <span className={`${styles.state} ${state.tone}`}>
          <span className={styles.stateDot} aria-hidden="true" />
          {state.label}
        </span>
        <AuthFileExitLine proxy={proxy} />
      </div>

      <div className={styles.cellHealth} role="cell">
        <span className={styles.counts}>
          <span className={successCount > 0 ? styles.countOk : undefined}>
            {t('stats.success')} {successCount}
          </span>
          <span className={failureCount > 0 ? styles.countFail : undefined}>
            {t('stats.failure')} {failureCount}
          </span>
        </span>
        <ProviderStatusBar statusData={statusData} styles={statusBarStyles} />
      </div>

      <div className={styles.cellQuota} role="cell">
        {quotaType ? (
          <AuthFileQuotaSection
            file={file}
            quotaType={quotaType}
            disableControls={disableControls}
            variant="row"
          />
        ) : (
          <span className={styles.empty} aria-label={t('auth_files.row_quota_unavailable')}>
            —
          </span>
        )}
      </div>

      <div className={styles.cellActions} role="cell">
        {!isRuntimeOnly && (
          <>
            {showModelsButton && (
              <Button
                variant="secondary"
                size="sm"
                className={styles.iconButton}
                onClick={() => onShowModels(file)}
                title={t('auth_files.models_button')}
                aria-label={t('auth_files.models_button')}
                disabled={disableControls}
              >
                <IconModelCluster size={15} />
              </Button>
            )}
            {showManualRefreshButton && (
              <Button
                variant="secondary"
                size="sm"
                className={styles.iconButton}
                onClick={() => onManualRefresh(file)}
                title={t('auth_files.manual_refresh_button')}
                aria-label={t('auth_files.manual_refresh_button')}
                disabled={
                  disableControls || file.disabled || isStatusUpdating || isManualRefreshing
                }
              >
                {isManualRefreshing ? <LoadingSpinner size={14} /> : <IconRefreshCw size={15} />}
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              className={styles.iconButton}
              onClick={() => onDownload(file.name)}
              title={t('auth_files.download_button')}
              aria-label={t('auth_files.download_button')}
              disabled={disableControls}
            >
              <IconDownload size={15} />
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className={styles.iconButton}
              onClick={() => onOpenPrefixProxyEditor(file)}
              title={t('auth_files.prefix_proxy_button')}
              aria-label={t('auth_files.prefix_proxy_button')}
              disabled={disableControls || isManualRefreshing}
            >
              <IconSettings size={15} />
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className={`${styles.iconButton} ${styles.iconButtonDanger}`}
              onClick={() => onDelete(file.name)}
              title={t('auth_files.delete_button')}
              aria-label={t('auth_files.delete_button')}
              disabled={disableControls || deleting === file.name || isManualRefreshing}
            >
              {deleting === file.name ? <LoadingSpinner size={14} /> : <IconTrash2 size={15} />}
            </Button>
            <ToggleSwitch
              ariaLabel={t('auth_files.card_toggle', { name: file.name })}
              checked={!file.disabled}
              disabled={disableControls || isStatusUpdating || isManualRefreshing}
              onChange={(value) => onToggleStatus(file, value)}
            />
          </>
        )}
      </div>

      {hasNotice && (
        <div className={styles.notice} role="cell">
          {rawStatusMessage && hasStatusWarning && (
            <p className={styles.noticeWarning} title={rawStatusMessage}>
              <IconInfo size={13} className={styles.noticeIcon} />
              <span>{rawStatusMessage}</span>
            </p>
          )}
          {rawStatusMessage && isStaleError && (
            <p className={styles.noticeStale} title={rawStatusMessage}>
              {t('auth_files.stale_error_prefix')}
              {rawStatusMessage}
            </p>
          )}
          <AuthFileCooldownSection snapshot={file.cooldownSnapshot} />
        </div>
      )}
    </div>
  );
}

/**
 * 出口：实际出网 IP；网关（用来区分代理供应商）放在悬停提示里以节省宽度。
 * 直连用告警色——凭证在面板上删掉重加会丢失 proxy_url，悄悄退回服务器自身 IP 出网，
 * 这是最需要一眼看出来的情况。
 */
function AuthFileExitLine({ proxy }: { proxy: AuthFileRowProps['proxy'] }) {
  const { t } = useTranslation();

  if (proxy === undefined || proxy === 'loading') {
    return <span className={styles.exitMuted}>{proxy === 'loading' ? '…' : '—'}</span>;
  }
  if (proxy.kind === 'unknown') {
    return (
      <span className={styles.exitMuted} title={t('auth_files.row_exit_unknown')}>
        —
      </span>
    );
  }
  if (proxy.kind === 'direct') {
    return (
      <span className={styles.exitDirect} title={t('auth_files.row_exit_direct_hint')}>
        {t('auth_files.row_exit_direct')}
      </span>
    );
  }

  const via =
    proxy.kind === 'global'
      ? t('auth_files.row_exit_global', { gateway: proxy.gateway })
      : `${proxy.scheme}://${proxy.gateway}`;
  return (
    <span className={styles.exitIp} title={via}>
      {proxy.exit}
    </span>
  );
}

/**
 * 降智检测的最近一次有效结论，放在账号列「套餐 · 权重」之后；点击跳到降智检测页看走势与记录。
 * 悬停提示里给出答案、推理 token 和统计窗口内的正确次数。
 */
function AuthFileQualityMark({ quality, days }: { quality: QualityAccountSummary; days?: number }) {
  const { t } = useTranslation();
  // 优先最近一次有效结论：偶发的上游过载只会记成「没测成」，不该盖住账号的真实状态
  const last = quality.lastValid ?? quality.last;
  if (!last) return null;
  const time = formatQualityTime(last.ts);
  const title =
    last.verdict === 'failed'
      ? t('quality_probe.row_badge_failed_title', { time, error: last.error || '—' })
      : t('quality_probe.row_badge_title', {
          time,
          verdict: t(`quality_probe.${QUALITY_VERDICT_KEY[last.verdict]}`),
          answer: last.answer ?? '—',
          reasoning: last.reasoningTokens ?? '—',
          days: days ?? 7,
          passed: quality.passed,
          valid: quality.valid,
        });
  return (
    <Link to="/quality-probe" className={styles.qualityLink} title={title}>
      <QualityVerdictBadge verdict={last.verdict} />
    </Link>
  );
}
