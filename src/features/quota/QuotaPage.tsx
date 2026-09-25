/**
 * 额度查询页：提供商 tabs + 统一卡网格。
 *
 * 保留的行为契约（重设计不改）：
 * - 现有提供商保持点击加载；Devin 首次可见时主动查询一次，不轮询；
 * - cacheGeneration 会话隔离 + request-id 去重（见 useQuotaBatchLoader）；
 * - 文件列表变化后按 provider 剪枝额度缓存（已删文件不残留）；
 * - useHeaderRefresh 单槽位：本页唯一注册者，全局刷新 = 重取文件列表。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authFilesApi } from '@/services/api';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconRefreshCw, IconSearch, IconX } from '@/components/ui/icons';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useNow } from '@/hooks/useNow';
import { useAuthStore, useQuotaStore, useThemeStore } from '@/stores';
import type { AuthFileItem, ResolvedTheme } from '@/types';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { ProviderTabs } from '@/features/authFiles/components/ProviderTabs';
import { getTypeLabel } from '@/features/authFiles/constants';
import { QuotaCard } from '@/features/quota/components/QuotaCard';
import { QuotaRow } from '@/features/quota/components/QuotaRow';
import { LayoutToggle } from '@/components/common/LayoutToggle';
import type { LayoutMode } from '@/components/common/layoutMode';
import { QuotaTimeline } from '@/features/quota/components/QuotaTimeline';
import {
  QUOTA_PAGE_SIZE,
  QUOTA_SORT_MODES,
  QUOTA_TAB_ORDER,
  type QuotaSortMode,
  type QuotaTabId,
} from '@/features/quota/constants';
import {
  buildTabCounts,
  canRefreshQuotaAfterList,
  classifyQuotaFiles,
  filterEntriesByTab,
  filterEntriesBySearch,
  groupQuotaEntriesByType,
  paginate,
  sortQuotaEntries,
  type QuotaFileEntry,
} from '@/features/quota/logic';
import { nextRecoveryMs } from '@/features/quota/resetSchedule';
import { isHiddenProvider } from '@/features/hiddenProviders';
import { QUOTA_ADAPTERS, getQuotaSetter, type QuotaCardState } from '@/features/quota/providers';
import type { QuotaProviderType } from '@/features/quota/providers/types';
import { useDevinQuotaAutoLoad } from '@/features/quota/providers/devin/useDevinQuotaAutoLoad';
import { useQuotaActions } from '@/features/quota/hooks/useQuotaActions';
import { useQuotaBatchLoader } from '@/features/quota/hooks/useQuotaBatchLoader';
import { readQuotaUiState, writeQuotaUiState } from '@/features/quota/uiState';
import styles from '@/features/quota/QuotaPage.module.scss';

// 界面上的 tab 会过滤掉本 fork 不展示的提供商（见 features/hiddenProviders.ts），
// 分组顺序与统计仍使用完整的 QUOTA_TAB_ORDER，隐藏提供商的缓存与恢复逻辑不受影响
const TAB_IDS: string[] = ['all', ...QUOTA_TAB_ORDER.filter((type) => !isHiddenProvider(type))];
const SKELETON_CARD_COUNT = 6;
const SKELETON_ROW_COUNT = 6;

/**
 * Existing providers display filenames; Devin's card and timeline share an
 * identity-aware display label. Keep the filename fallback stable for memoization.
 */
const displayNameFor = (name: string) => name;

export function QuotaPage() {
  const { t } = useTranslation();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const resolvedTheme: ResolvedTheme = useThemeStore((state) => state.resolvedTheme);

  const [files, setFiles] = useState<AuthFileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<QuotaTabId>(() => readQuotaUiState()?.tab ?? 'all');
  const [sortMode, setSortMode] = useState<QuotaSortMode>(
    () => readQuotaUiState()?.sortMode ?? 'default'
  );
  // 默认列表布局：账号多时一屏能看更多；切换过的选择在本会话内记住
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(
    () => readQuotaUiState()?.layoutMode ?? 'list'
  );
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  const disableControls = connectionStatus !== 'connected';

  /* ---------- 文件列表 ---------- */

  const sessionGeneration = useQuotaStore((state) => state.cacheGeneration);
  const [filesGeneration, setFilesGeneration] = useState<number | null>(null);
  const listRequestRef = useRef(0);
  const loadFiles = useCallback(async () => {
    const requestId = ++listRequestRef.current;
    if (connectionStatus !== 'connected') {
      setFiles([]);
      setFilesGeneration(null);
      setLoading(false);
      return;
    }
    const isCurrent = () =>
      requestId === listRequestRef.current &&
      sessionGeneration === useQuotaStore.getState().cacheGeneration;
    setLoading(true);
    setError('');
    try {
      const data = await authFilesApi.list();
      if (!isCurrent()) return;
      setFiles(data?.files || []);
      setFilesGeneration(sessionGeneration);
    } catch (err: unknown) {
      if (!isCurrent()) return;
      console.error('[quota] 加载认证文件列表失败', err);
      const message = err instanceof Error ? err.message : t('notification.refresh_failed');
      setError(message);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [connectionStatus, sessionGeneration, t]);

  useHeaderRefresh(loadFiles);

  useEffect(() => {
    void loadFiles();
    return () => {
      listRequestRef.current += 1;
    };
  }, [loadFiles]);

  /* ---------- 额度缓存 ----------
   * 排在归类/排序之前：「最快恢复优先」要读它算排序键。 */

  const antigravityQuota = useQuotaStore((state) => state.antigravityQuota);
  const claudeQuota = useQuotaStore((state) => state.claudeQuota);
  const codexQuota = useQuotaStore((state) => state.codexQuota);
  const devinQuota = useQuotaStore((state) => state.devinQuota);
  const kimiQuota = useQuotaStore((state) => state.kimiQuota);
  const metaQuota = useQuotaStore((state) => state.metaQuota);
  const xaiQuota = useQuotaStore((state) => state.xaiQuota);

  const quotaByType = useMemo<Record<QuotaProviderType, Record<string, QuotaCardState>>>(
    () =>
      ({
        antigravity: antigravityQuota,
        claude: claudeQuota,
        codex: codexQuota,
        devin: devinQuota,
        kimi: kimiQuota,
        meta: metaQuota,
        xai: xaiQuota,
      }) as unknown as Record<QuotaProviderType, Record<string, QuotaCardState>>,
    [antigravityQuota, claudeQuota, codexQuota, devinQuota, kimiQuota, metaQuota, xaiQuota]
  );

  const getQuota = useCallback(
    (entry: QuotaFileEntry): QuotaCardState | undefined =>
      quotaByType[entry.type][getQuotaCacheKey(entry.file)],
    [quotaByType]
  );

  /* ---------- 归类 / 过滤 / 排序 / 分页 ---------- */

  // 只在「最快恢复优先」下订阅分钟时钟。默认序下不门控的话，pageItems 每分钟
  // 换一次身份，会反复空转下面那个「刷新全部」的 loading 下降沿 effect。
  const tick = useNow(sortMode !== 'default');
  const sortNow = sortMode === 'default' ? 0 : tick;

  const entries = useMemo(() => classifyQuotaFiles(files), [files]);
  const tabCounts = useMemo(() => buildTabCounts(entries), [entries]);
  const filteredEntries = useMemo(
    () => filterEntriesBySearch(filterEntriesByTab(entries, tab), search),
    [entries, tab, search]
  );
  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    setPage(1);
  }, []);

  const resolveNextRecovery = useCallback(
    (entry: QuotaFileEntry) => nextRecoveryMs(entry.type, getQuota(entry), sortNow),
    [getQuota, sortNow]
  );
  // 排序在分页之前：否则「最快恢复」只在当前页内成立。
  const sortedEntries = useMemo(
    () => sortQuotaEntries(filteredEntries, sortMode, resolveNextRecovery),
    [filteredEntries, sortMode, resolveNextRecovery]
  );

  const { pageItems, currentPage, totalPages } = useMemo(
    () => paginate(sortedEntries, page, QUOTA_PAGE_SIZE),
    [sortedEntries, page]
  );

  const handleTabChange = useCallback((next: string) => {
    setTab(next as QuotaTabId);
    setPage(1);
    writeQuotaUiState({ tab: next as QuotaTabId });
  }, []);

  const handleLayoutModeChange = useCallback((next: LayoutMode) => {
    setLayoutMode(next);
    writeQuotaUiState({ layoutMode: next });
  }, []);

  const handleSortModeChange = useCallback((next: string) => {
    setSortMode(next as QuotaSortMode);
    setPage(1);
    writeQuotaUiState({ sortMode: next as QuotaSortMode });
  }, []);

  const sortOptions = useMemo(
    () =>
      QUOTA_SORT_MODES.map((mode) => ({ value: mode, label: t(`quota_management.sort_${mode}`) })),
    [t]
  );

  // 剪枝：文件列表落定后，各 provider 缓存只保留仍存在的凭证
  useEffect(() => {
    if (loading || error || filesGeneration !== sessionGeneration) return;
    const survivorsByType = new Map<QuotaProviderType, Set<string>>(
      QUOTA_TAB_ORDER.map((type) => [type, new Set<string>()])
    );
    entries.forEach((entry) => survivorsByType.get(entry.type)?.add(getQuotaCacheKey(entry.file)));

    QUOTA_TAB_ORDER.forEach((type) => {
      const survivors = survivorsByType.get(type) ?? new Set<string>();
      const setQuota = getQuotaSetter(QUOTA_ADAPTERS[type]);
      setQuota((prev) => {
        const staleKeys = Object.keys(prev).filter((name) => !survivors.has(name));
        if (staleKeys.length === 0) return prev;
        const next = { ...prev };
        staleKeys.forEach((name) => delete next[name]);
        return next;
      });
    });
  }, [entries, error, filesGeneration, loading, sessionGeneration]);

  /* ---------- 加载与操作 ---------- */

  const { batchLoading, loadQuota } = useQuotaBatchLoader();
  const { resettingQuotaName, refreshQuota, resetQuota } = useQuotaActions(disableControls);

  const pendingRefreshRef = useRef<number | null>(null);
  const prevLoadingRef = useRef(loading);

  // 刷新全部：先重取文件列表，待其落定（loading 下降沿）再批量拉当前页额度
  const handleRefreshAll = useCallback(() => {
    if (disableControls) return;
    pendingRefreshRef.current = sessionGeneration;
    void loadFiles();
  }, [disableControls, loadFiles, sessionGeneration]);

  useEffect(() => {
    const wasLoading = prevLoadingRef.current;
    prevLoadingRef.current = loading;

    const requestedSession = pendingRefreshRef.current;
    if (requestedSession === null) return;
    if (requestedSession !== sessionGeneration) {
      pendingRefreshRef.current = null;
      return;
    }
    if (loading || !wasLoading) return;

    pendingRefreshRef.current = null;
    if (
      canRefreshQuotaAfterList(
        requestedSession,
        sessionGeneration,
        filesGeneration,
        Boolean(error),
        disableControls
      )
    ) {
      void loadQuota(pageItems);
    }
  }, [disableControls, error, filesGeneration, loading, loadQuota, pageItems, sessionGeneration]);

  useDevinQuotaAutoLoad(
    pageItems,
    disableControls ||
      loading ||
      batchLoading ||
      Boolean(error) ||
      filesGeneration !== sessionGeneration,
    loadQuota
  );

  const canUseActions = !disableControls && !loading && filesGeneration === sessionGeneration;

  /* ---------- 渲染 ---------- */

  const isEmpty = !loading && filteredEntries.length === 0;

  // 卡片与列表行共用同一套 props，避免两处各写一遍、日后改漏
  const itemProps = (entry: QuotaFileEntry) => ({
    entry,
    quota: getQuota(entry),
    resolvedTheme,
    canRefresh: canUseActions && !entry.file.disabled,
    resetting: resettingQuotaName === getQuotaCacheKey(entry.file),
    onRefresh: () => void refreshQuota(entry.file, QUOTA_ADAPTERS[entry.type]),
    onReset: () => resetQuota(entry.file, QUOTA_ADAPTERS[entry.type]),
  });

  return (
    <div className={styles.page}>
      {/*
        标题区已去掉（大块标题 + 统计卡占高度又重复 tabs 上的数量）。
        保留一个视觉隐藏的 h1，屏幕阅读器与页面大纲仍能识别这是「配额管理」页。
      */}
      <h1 className={styles.srOnly}>{t('quota_management.title')}</h1>

      <section className={styles.workbench}>
        {/* 筛选卡片：与认证文件页同构——头部一整行是提供商 tabs（可横向滚动），
            下方工具栏放搜索框与排序下拉，两类控件分层，互不争夺视觉焦点 */}
        <div className={styles.filterCard}>
          <div className={styles.tabsRow}>
            <ProviderTabs
              className={styles.tabs}
              types={TAB_IDS}
              counts={tabCounts}
              active={tab}
              resolvedTheme={resolvedTheme}
              onChange={handleTabChange}
            />
            {/* 页面主操作放在 tabs 行右端，与认证文件页「删除全部」的位置一致 */}
            <div className={styles.tabsAction}>
              <Button
                size="sm"
                onClick={handleRefreshAll}
                disabled={disableControls || loading || batchLoading}
              >
                <IconRefreshCw
                  size={14}
                  aria-hidden="true"
                  className={loading || batchLoading ? styles.spinning : undefined}
                />
                {t('quota_management.refresh_all_credentials')}
              </Button>
            </div>
          </div>

          <div className={styles.toolbar}>
            <div className={styles.search}>
              <IconSearch size={16} className={styles.searchIcon} aria-hidden="true" />
              <input
                ref={searchInputRef}
                className={styles.searchInput}
                type="search"
                value={search}
                onChange={(event) => handleSearchChange(event.target.value)}
                placeholder={t('quota_management.search_placeholder')}
                aria-label={t('quota_management.search_label')}
              />
              {search && (
                <button
                  type="button"
                  className={styles.clearSearch}
                  aria-label={t('quota_management.search_clear')}
                  title={t('quota_management.search_clear')}
                  onClick={() => {
                    handleSearchChange('');
                    searchInputRef.current?.focus();
                  }}
                >
                  <IconX size={14} aria-hidden="true" />
                </button>
              )}
            </div>
            <div className={styles.toolbarEnd}>
              <div className={styles.sort}>
                <Select
                  value={sortMode}
                  options={sortOptions}
                  onChange={handleSortModeChange}
                  ariaLabel={t('quota_management.sort_label')}
                  size="sm"
                />
              </div>
              <LayoutToggle value={layoutMode} onChange={handleLayoutModeChange} />
            </div>
          </div>
        </div>

        {error && (
          <div className={styles.errorBanner} role="alert">
            {error}
          </div>
        )}

        {loading ? (
          layoutMode === 'list' ? (
            <div className={styles.listSkeleton} aria-hidden="true">
              {Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => (
                <Skeleton key={index} height={56} rounded={6} />
              ))}
            </div>
          ) : (
            <div className={styles.grid} aria-hidden="true">
              {Array.from({ length: SKELETON_CARD_COUNT }, (_, index) => (
                <Skeleton key={index} height={168} rounded={8} />
              ))}
            </div>
          )
        ) : isEmpty ? (
          <EmptyState
            title={
              search.trim()
                ? t('quota_management.search_empty_title')
                : tab === 'all'
                  ? t('quota_management.empty_title')
                  : t(`${QUOTA_ADAPTERS[tab].i18nPrefix}.empty_title`)
            }
            description={
              search.trim()
                ? t('quota_management.search_empty_desc')
                : tab === 'all'
                  ? t('quota_management.empty_desc')
                  : t(`${QUOTA_ADAPTERS[tab].i18nPrefix}.empty_desc`)
            }
            action={
              search.trim() ? (
                <Button variant="secondary" size="sm" onClick={() => handleSearchChange('')}>
                  {t('quota_management.search_clear')}
                </Button>
              ) : tab === 'all' ? undefined : (
                <Button variant="secondary" size="sm" onClick={() => handleTabChange('all')}>
                  {t('auth_files.filter_all')}
                </Button>
              )
            }
          />
        ) : layoutMode === 'list' ? (
          <div className={styles.list}>
            {groupQuotaEntriesByType(pageItems).map((group) => (
              <section key={group.type} className={styles.listGroup}>
                <h3 className={styles.listGroupTitle}>
                  {getTypeLabel(t, group.type)}
                  <span className={styles.listGroupCount}>{group.entries.length}</span>
                </h3>
                <div className={styles.listRows} role="table">
                  {group.entries.map((entry) => (
                    <QuotaRow key={`${entry.type}:${getQuotaCacheKey(entry.file)}`} {...itemProps(entry)} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <div className={styles.grid}>
            {pageItems.map((entry) => (
              <QuotaCard key={`${entry.type}:${getQuotaCacheKey(entry.file)}`} {...itemProps(entry)} />
            ))}
          </div>
        )}

        {!loading && filteredEntries.length > QUOTA_PAGE_SIZE && (
          <div className={styles.pagination}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPage(Math.max(1, currentPage - 1))}
              disabled={currentPage <= 1}
            >
              {t('auth_files.pagination_prev')}
            </Button>
            <div className={styles.pageInfo}>
              {t('auth_files.pagination_info', {
                current: currentPage,
                total: totalPages,
                count: filteredEntries.length,
              })}
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPage(Math.min(totalPages, currentPage + 1))}
              disabled={currentPage >= totalPages}
            >
              {t('auth_files.pagination_next')}
            </Button>
          </div>
        )}

        {/* 时间线只比较当前页凭证，避免大量凭证一次性生成无界泳道。 */}
        <QuotaTimeline
          entries={pageItems}
          quotaFor={getQuota}
          displayNameFor={displayNameFor}
          resolvedTheme={resolvedTheme}
        />
      </section>
    </div>
  );
}
