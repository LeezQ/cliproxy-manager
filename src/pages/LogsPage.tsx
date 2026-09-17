import { useDeferredValue, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader, PageHeaderStat } from '@/components/common/PageHeader';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { lockScroll, unlockScroll } from '@/components/ui/scrollLock';
import {
  IconChevronDown,
  IconChevronUp,
  IconCode,
  IconDownload,
  IconEye,
  IconEyeOff,
  IconMaximize2,
  IconMinimize2,
  IconRefreshCw,
  IconSearch,
  IconSlidersHorizontal,
  IconTimer,
  IconTrash2,
  IconX,
} from '@/components/ui/icons';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useAuthStore, useConfigStore, useNotificationStore } from '@/stores';
import { logsApi, type ErrorLogFile, type LogsQuery } from '@/services/api/logs';
import { copyToClipboard } from '@/utils/clipboard';
import { getErrorMessage } from '@/utils/helpers';
import { downloadBlob } from '@/utils/download';
import { MANAGEMENT_API_PREFIX } from '@/utils/constants';
import { formatUnixTimestamp } from '@/utils/format';
import {
  HTTP_METHODS,
  STATUS_GROUPS,
  resolveStatusGroup,
  type LogState,
} from '@/pages/hooks/logTypes';
import { parseLogLine } from '@/pages/hooks/logParsing';
import { createLogRequestGuard, createLogRequestQueue } from '@/pages/hooks/logRequests';
import { errorLogViewerReducer } from '@/pages/hooks/errorLogViewer';
import { useLogFilters } from '@/pages/hooks/useLogFilters';
import { isNearBottom, useLogScroller } from '@/pages/hooks/useLogScroller';
import styles from '@/pages/LogsPage.module.scss';

// 初始只渲染最近 100 行，滚动到顶部再逐步加载更多（避免一次性渲染过多导致卡顿）
const INITIAL_DISPLAY_LINES = 100;
const MAX_BUFFER_LINES = 10000;
const LONG_PRESS_MS = 650;
const LONG_PRESS_MOVE_THRESHOLD = 10;

type LogPosition = Pick<LogsQuery, 'after' | 'cursor'>;

const getIncrementalAfter = (after: LogsQuery['after']): LogsQuery['after'] => {
  if (typeof after !== 'number') return after;
  return after > 1 ? after - 1 : undefined;
};

const buildLogsQuery = (incremental: boolean, position: LogPosition): LogsQuery => {
  const params: LogsQuery = { limit: MAX_BUFFER_LINES };
  if (!incremental) return params;

  if (position.cursor) {
    params.cursor = position.cursor;
  }

  const after = getIncrementalAfter(position.after);
  if (after !== undefined) {
    params.after = after;
  }

  return params;
};

const findLineOverlap = (currentLines: string[], incomingLines: string[]): number => {
  const maxOverlap = Math.min(currentLines.length, incomingLines.length);

  for (let size = maxOverlap; size > 0; size -= 1) {
    let matched = true;
    for (let i = 0; i < size; i += 1) {
      if (currentLines[currentLines.length - size + i] !== incomingLines[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return size;
  }

  return 0;
};

const mergeIncrementalLines = (currentLines: string[], incomingLines: string[]): string[] => {
  if (currentLines.length === 0 || incomingLines.length === 0) {
    return [...currentLines, ...incomingLines];
  }

  const overlap = findLineOverlap(currentLines, incomingLines);
  return [...currentLines, ...incomingLines.slice(overlap)];
};

const getErrorPayloadText = (err: unknown): string => {
  if (typeof err !== 'object' || err === null) return '';
  const payloads = [
    (err as { data?: unknown }).data,
    (err as { details?: unknown }).details,
  ].filter((payload) => payload !== undefined);
  return payloads
    .map((payload) => {
      if (typeof payload === 'string') return payload;
      try {
        return JSON.stringify(payload);
      } catch {
        return '';
      }
    })
    .join(' ');
};

const isLoggingToFileDisabledError = (err: unknown): boolean => {
  const text = `${getErrorMessage(err)} ${getErrorPayloadText(err)}`.toLowerCase();
  return text.includes('logging to file disabled');
};

const responseDataToText = async (data: unknown): Promise<string> => {
  if (data instanceof Blob) return data.text();
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (typeof data === 'string') return data;
  if (data === undefined || data === null) return '';

  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
};

type TabType = 'logs' | 'errors';

export function LogsPage() {
  const { t } = useTranslation();
  const { showNotification, showConfirmation } = useNotificationStore();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const apiBase = useAuthStore((state) => state.apiBase);
  const managementKey = useAuthStore((state) => state.managementKey);
  const config = useConfigStore((state) => state.config);
  const requestLogEnabled = config?.requestLog ?? false;
  const loggingToFileEnabled = config?.loggingToFile ?? false;
  const cpaNeedsFileLogging = !loggingToFileEnabled;
  const [fileLoggingRequired, setFileLoggingRequired] = useState(false);
  const showFileLoggingRequired = cpaNeedsFileLogging || fileLoggingRequired;

  const [activeTab, setActiveTab] = useState<TabType>('logs');
  const [logState, setLogState] = useState<LogState>({ buffer: [], visibleFrom: 0 });
  const [loading, setLoading] = useState(true);
  const [clearingLogs, setClearingLogs] = useState(false);
  const [error, setError] = useState('');
  const [autoRefresh, setAutoRefresh] = useLocalStorage('logsPage.autoRefresh', false);
  const [searchQuery, setSearchQuery] = useState('');
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [hideManagementLogs, setHideManagementLogs] = useLocalStorage(
    'logsPage.hideManagementLogs',
    true
  );
  const [showRawLogs, setShowRawLogs] = useLocalStorage('logsPage.showRawLogs', false);
  const [structuredFiltersExpanded, setStructuredFiltersExpanded] = useLocalStorage(
    'logsPage.structuredFiltersExpanded',
    true
  );
  const [errorLogs, setErrorLogs] = useState<ErrorLogFile[]>([]);
  const [loadingErrors, setLoadingErrors] = useState(false);
  const [errorLogsError, setErrorLogsError] = useState('');
  const [errorLogViewer, dispatchErrorLogViewer] = useReducer(errorLogViewerReducer, {
    status: 'closed',
  });
  const selectedErrorLog = errorLogViewer.status === 'closed' ? null : errorLogViewer.item;
  const [requestLogId, setRequestLogId] = useState<string | null>(null);
  const [requestLogDownloading, setRequestLogDownloading] = useState(false);
  const [fullscreenLogs, setFullscreenLogs] = useState(false);

  const [requests] = useState(() => ({
    session: createLogRequestGuard(),
    logs: createLogRequestQueue(),
    errors: createLogRequestGuard(),
    viewer: createLogRequestGuard(),
  }));
  const longPressRef = useRef<{
    timer: number | null;
    startX: number;
    startY: number;
    fired: boolean;
  } | null>(null);

  // 保存最新游标用于增量获取；新接口优先使用 cursor，旧接口继续使用 after。
  const logPositionRef = useRef<LogPosition>({});

  const resetLogPosition = () => {
    logPositionRef.current = {};
  };

  const updateLogPosition = (
    data: Awaited<ReturnType<typeof logsApi.fetchLogs>>,
    incremental: boolean
  ) => {
    const currentPosition = logPositionRef.current;
    const nextPosition: LogPosition = {};
    if (data.nextCursor) {
      nextPosition.cursor = data.nextCursor;
    }
    if (data.latestAfter !== undefined) {
      nextPosition.after = data.latestAfter;
    } else if (incremental && currentPosition.after !== undefined) {
      nextPosition.after = currentPosition.after;
    }
    logPositionRef.current = nextPosition;
  };

  const disableControls = connectionStatus !== 'connected';
  const refreshDisabled = disableControls || loading || clearingLogs || cpaNeedsFileLogging;
  const autoRefreshDisabled = disableControls || showFileLoggingRequired;
  const clearDisabled = disableControls || clearingLogs || showFileLoggingRequired;

  async function loadLogs(incremental = false) {
    // Queued reloads must read live context, not the render that started the old request.
    if (useAuthStore.getState().connectionStatus !== 'connected') {
      setLoading(false);
      return;
    }

    if (!useConfigStore.getState().config?.loggingToFile) {
      if (!incremental) {
        resetLogPosition();
        setFileLoggingRequired(false);
        setLogState({ buffer: [], visibleFrom: 0 });
        setError('');
        setLoading(false);
      }
      return;
    }

    const request = requests.logs.startRead(incremental);
    if (request === null) return;

    if (!incremental) {
      setLoading(true);
    }
    setError('');

    try {
      const stickToBottom = !incremental || isNearBottom(logViewerRef.current);
      if (stickToBottom) {
        requestScrollToBottom();
      }

      const params = buildLogsQuery(incremental, logPositionRef.current);
      const data = await logsApi.fetchLogs(params);
      if (!requests.logs.isCurrent(request)) return;
      setFileLoggingRequired(false);

      updateLogPosition(data, incremental);

      const newLines = Array.isArray(data.lines) ? data.lines : [];

      if (incremental && data.cursorReset) {
        const buffer = newLines.slice(-MAX_BUFFER_LINES);
        const visibleFrom = Math.max(buffer.length - INITIAL_DISPLAY_LINES, 0);
        setLogState({ buffer, visibleFrom });
      } else if (incremental && newLines.length > 0) {
        // 增量更新：追加新日志并限制缓冲区大小（避免内存与渲染膨胀）
        setLogState((prev) => {
          const prevRenderedCount = prev.buffer.length - prev.visibleFrom;
          const combined = mergeIncrementalLines(prev.buffer, newLines);
          const dropCount = Math.max(combined.length - MAX_BUFFER_LINES, 0);
          const buffer = dropCount > 0 ? combined.slice(dropCount) : combined;
          let visibleFrom = Math.max(prev.visibleFrom - dropCount, 0);

          // 若用户停留在底部（跟随最新日志），则保持“渲染窗口”大小不变，避免无限增长
          if (stickToBottom) {
            visibleFrom = Math.max(buffer.length - prevRenderedCount, 0);
          }

          return { buffer, visibleFrom };
        });
      } else if (!incremental) {
        // 全量加载：默认只渲染最后 100 行，向上滚动再展开更多
        const buffer = newLines.slice(-MAX_BUFFER_LINES);
        const visibleFrom = Math.max(buffer.length - INITIAL_DISPLAY_LINES, 0);
        setLogState({ buffer, visibleFrom });
      }
    } catch (err: unknown) {
      if (!requests.logs.isCurrent(request)) return;
      console.error('Failed to load logs:', err);
      if (isLoggingToFileDisabledError(err)) {
        if (!incremental) {
          resetLogPosition();
          setFileLoggingRequired(true);
          setLogState({ buffer: [], visibleFrom: 0 });
          setError('');
        }
        return;
      }
      if (!incremental) {
        setError(getErrorMessage(err) || t('logs.load_error'));
      }
    } finally {
      if (requests.logs.isCurrent(request)) {
        if (!incremental) setLoading(false);
        if (requests.logs.finish(request)) void loadLogs(false);
      }
    }
  }

  useHeaderRefresh(() => loadLogs(false));

  const clearLogs = async () => {
    if (cpaNeedsFileLogging) {
      showNotification(t('logs.cpa_file_logging_required'), 'warning');
      return;
    }
    if (fileLoggingRequired) {
      showNotification(t('logs.file_logging_required'), 'warning');
      return;
    }
    const session = requests.session.capture();
    showConfirmation({
      title: t('logs.clear_confirm_title', { defaultValue: 'Clear Logs' }),
      message: t('logs.clear_confirm'),
      variant: 'danger',
      confirmText: t('common.confirm'),
      onConfirm: async () => {
        if (!requests.session.isCurrent(session)) return;
        if (useAuthStore.getState().connectionStatus !== 'connected') return;
        if (!useConfigStore.getState().config?.loggingToFile) return;
        const request = requests.logs.startClear();
        if (request === null) return;
        setClearingLogs(true);
        setLoading(false);
        setError('');
        let clearFailed = false;
        try {
          await logsApi.clearLogs();
          if (!requests.logs.isCurrent(request)) return;
          setLogState({ buffer: [], visibleFrom: 0 });
          resetLogPosition();
          setFileLoggingRequired(false);
          showNotification(t('logs.clear_success'), 'success');
        } catch (err: unknown) {
          if (!requests.logs.isCurrent(request)) return;
          clearFailed = true;
          const message = getErrorMessage(err);
          showNotification(
            `${t('notification.delete_failed')}${message ? `: ${message}` : ''}`,
            'error'
          );
        } finally {
          if (requests.logs.isCurrent(request)) {
            setClearingLogs(false);
            // Clear superseded the old read; recover it even when deletion fails.
            if (requests.logs.finish(request, clearFailed)) void loadLogs(false);
          }
        }
      },
    });
  };

  const downloadLogs = () => {
    const text = logState.buffer.join('\n');
    downloadBlob({ filename: 'logs.txt', blob: new Blob([text], { type: 'text/plain' }) });
    showNotification(t('logs.download_success'), 'success');
  };

  const loadErrorLogs = async () => {
    if (useAuthStore.getState().connectionStatus !== 'connected') {
      setLoadingErrors(false);
      return;
    }
    const request = requests.errors.invalidate();
    setLoadingErrors(true);
    setErrorLogsError('');
    try {
      const res = await logsApi.fetchErrorLogs();
      if (!requests.errors.isCurrent(request)) return;
      // API 返回 { files: [...] }
      setErrorLogs(Array.isArray(res.files) ? res.files : []);
    } catch (err: unknown) {
      if (!requests.errors.isCurrent(request)) return;
      console.error('Failed to load error logs:', err);
      setErrorLogs([]);
      const message = getErrorMessage(err);
      setErrorLogsError(
        message ? `${t('logs.error_logs_load_error')}: ${message}` : t('logs.error_logs_load_error')
      );
    } finally {
      if (requests.errors.isCurrent(request)) setLoadingErrors(false);
    }
  };

  const downloadErrorLog = async (name: string) => {
    const session = requests.session.capture();
    try {
      const response = await logsApi.downloadErrorLog(name);
      if (!requests.session.isCurrent(session)) return;
      downloadBlob({ filename: name, blob: new Blob([response.data], { type: 'text/plain' }) });
      showNotification(t('logs.error_log_download_success'), 'success');
    } catch (err: unknown) {
      if (!requests.session.isCurrent(session)) return;
      const message = getErrorMessage(err);
      showNotification(
        `${t('notification.download_failed')}${message ? `: ${message}` : ''}`,
        'error'
      );
    }
  };

  const openErrorLog = async (item: ErrorLogFile) => {
    const requestId = requests.viewer.invalidate();
    dispatchErrorLogViewer({ type: 'open', item });

    try {
      const response = await logsApi.downloadErrorLog(item.name);
      const text = await responseDataToText(response.data);
      if (!requests.viewer.isCurrent(requestId)) return;
      dispatchErrorLogViewer({ type: 'ready', text });
    } catch (err: unknown) {
      if (!requests.viewer.isCurrent(requestId)) return;
      const message = getErrorMessage(err);
      dispatchErrorLogViewer({
        type: 'error',
        message: message
          ? `${t('logs.error_log_open_failed')}: ${message}`
          : t('logs.error_log_open_failed'),
      });
    }
  };

  const closeErrorLogViewer = () => {
    requests.viewer.invalidate();
    dispatchErrorLogViewer({ type: 'close' });
  };

  const copySelectedErrorLog = async () => {
    if (errorLogViewer.status !== 'ready' || !errorLogViewer.text) return;
    const session = requests.session.capture();
    const ok = await copyToClipboard(errorLogViewer.text);
    if (!requests.session.isCurrent(session)) return;
    showNotification(
      ok
        ? t('logs.error_log_copy_success')
        : t('logs.copy_failed', { defaultValue: 'Copy failed' }),
      ok ? 'success' : 'error'
    );
  };

  useEffect(() => {
    const resetLogs = () => {
      requests.logs.invalidate();
      logPositionRef.current = {};
      setLogState({ buffer: [], visibleFrom: 0 });
      setLoading(false);
      setClearingLogs(false);
      setError('');
      setFileLoggingRequired(false);
    };
    const resetErrors = () => {
      requests.errors.invalidate();
      setErrorLogs([]);
      setLoadingErrors(false);
      setErrorLogsError('');
    };
    const invalidateSession = () => {
      requests.session.invalidate();
      requests.logs.invalidate();
      requests.errors.invalidate();
      requests.viewer.invalidate();
      if (longPressRef.current?.timer) window.clearTimeout(longPressRef.current.timer);
      longPressRef.current = null;
    };

    // Store subscriptions invalidate synchronously, before a response can beat effect cleanup.
    const unsubscribeAuth = useAuthStore.subscribe((next, previous) => {
      if (
        next.apiBase === previous.apiBase &&
        next.managementKey === previous.managementKey &&
        next.connectionStatus === previous.connectionStatus &&
        next.isAuthenticated === previous.isAuthenticated
      )
        return;
      invalidateSession();
      resetLogs();
      resetErrors();
      dispatchErrorLogViewer({ type: 'close' });
      setRequestLogId(null);
      setRequestLogDownloading(false);
    });
    const unsubscribeConfig = useConfigStore.subscribe((next, previous) => {
      if (next.config?.loggingToFile !== previous.config?.loggingToFile) resetLogs();
      if (next.config?.requestLog !== previous.config?.requestLog) resetErrors();
    });
    return () => {
      unsubscribeAuth();
      unsubscribeConfig();
      invalidateSession();
    };
  }, [requests]);

  useEffect(() => {
    if (connectionStatus === 'connected') {
      resetLogPosition();
      setFileLoggingRequired(false);
      loadLogs(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionStatus, apiBase, managementKey, loggingToFileEnabled]);

  useEffect(() => {
    if (activeTab !== 'errors') return;
    if (connectionStatus !== 'connected') return;
    void loadErrorLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, connectionStatus, apiBase, managementKey, requestLogEnabled]);

  useEffect(() => {
    if (!autoRefresh || connectionStatus !== 'connected' || showFileLoggingRequired) {
      return;
    }
    const id = window.setInterval(() => {
      loadLogs(true);
    }, 8000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, connectionStatus, showFileLoggingRequired]);

  const visibleLines = useMemo(
    () => logState.buffer.slice(logState.visibleFrom),
    [logState.buffer, logState.visibleFrom]
  );

  const trimmedSearchQuery = deferredSearchQuery.trim();
  const isSearching = trimmedSearchQuery.length > 0;
  const baseLines = isSearching ? logState.buffer : visibleLines;

  const parsedSearchLines = useMemo(() => {
    let working = baseLines;

    if (hideManagementLogs) {
      working = working.filter((line) => !line.includes(MANAGEMENT_API_PREFIX));
    }

    if (trimmedSearchQuery) {
      const queryLowered = trimmedSearchQuery.toLowerCase();
      working = working.filter((line) => line.toLowerCase().includes(queryLowered));
    }

    return working.map((line) => parseLogLine(line));
  }, [baseLines, hideManagementLogs, trimmedSearchQuery]);

  const filters = useLogFilters({ parsedLines: parsedSearchLines });
  const structuredFiltersPanelId = 'logs-structured-filters';
  const structuredFilterCount =
    filters.methodFilters.length + filters.statusFilters.length + filters.pathFilters.length;

  const { filteredParsedLines, filteredLines, removedCount } = useMemo(() => {
    const filteredParsed = parsedSearchLines.filter((line) => {
      if (
        filters.methodFilterSet.size > 0 &&
        (!line.method || !filters.methodFilterSet.has(line.method))
      ) {
        return false;
      }

      const statusGroup = resolveStatusGroup(line.statusCode);
      if (
        filters.statusFilterSet.size > 0 &&
        (!statusGroup || !filters.statusFilterSet.has(statusGroup))
      ) {
        return false;
      }

      if (filters.pathFilterSet.size > 0 && (!line.path || !filters.pathFilterSet.has(line.path))) {
        return false;
      }

      return true;
    });

    return {
      filteredParsedLines: filteredParsed,
      filteredLines: filteredParsed.map((line) => line.raw),
      removedCount: Math.max(baseLines.length - filteredParsed.length, 0),
    };
  }, [
    baseLines,
    filters.methodFilterSet,
    filters.pathFilterSet,
    filters.statusFilterSet,
    parsedSearchLines,
  ]);

  const parsedVisibleLines = useMemo(
    () => (showRawLogs ? [] : filteredParsedLines),
    [filteredParsedLines, showRawLogs]
  );

  const rawVisibleText = useMemo(() => filteredLines.join('\n'), [filteredLines]);

  const { canLoadMore, handleLogScroll, logViewerRef, requestScrollToBottom } = useLogScroller({
    logState,
    setLogState,
    loading,
    isSearching,
    filteredLineCount: filteredLines.length,
    hasStructuredFilters: filters.hasStructuredFilters,
    showRawLogs,
  });

  const copyLogLine = async (raw: string) => {
    const ok = await copyToClipboard(raw);
    if (ok) {
      showNotification(t('logs.copy_success', { defaultValue: 'Copied to clipboard' }), 'success');
    } else {
      showNotification(t('logs.copy_failed', { defaultValue: 'Copy failed' }), 'error');
    }
  };

  const clearLongPressTimer = () => {
    if (longPressRef.current?.timer) {
      window.clearTimeout(longPressRef.current.timer);
      longPressRef.current.timer = null;
    }
  };

  const startLongPress = (event: ReactPointerEvent<HTMLDivElement>, id?: string) => {
    if (!requestLogEnabled) return;
    if (!id) return;
    if (requestLogId) return;
    clearLongPressTimer();
    longPressRef.current = {
      timer: window.setTimeout(() => {
        setRequestLogId(id);
        if (longPressRef.current) {
          longPressRef.current.fired = true;
          longPressRef.current.timer = null;
        }
      }, LONG_PRESS_MS),
      startX: event.clientX,
      startY: event.clientY,
      fired: false,
    };
  };

  const cancelLongPress = () => {
    clearLongPressTimer();
    longPressRef.current = null;
  };

  const handleLongPressMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = longPressRef.current;
    if (!current || current.timer === null || current.fired) return;
    const deltaX = Math.abs(event.clientX - current.startX);
    const deltaY = Math.abs(event.clientY - current.startY);
    if (deltaX > LONG_PRESS_MOVE_THRESHOLD || deltaY > LONG_PRESS_MOVE_THRESHOLD) {
      cancelLongPress();
    }
  };

  const closeRequestLogModal = () => {
    if (requestLogDownloading) return;
    setRequestLogId(null);
  };

  const downloadRequestLog = async (id: string) => {
    const session = requests.session.capture();
    setRequestLogDownloading(true);
    try {
      const response = await logsApi.downloadRequestLogById(id);
      if (!requests.session.isCurrent(session)) return;
      downloadBlob({
        filename: `request-${id}.log`,
        blob: new Blob([response.data], { type: 'text/plain' }),
      });
      showNotification(t('logs.request_log_download_success'), 'success');
      setRequestLogId(null);
    } catch (err: unknown) {
      if (!requests.session.isCurrent(session)) return;
      const message = getErrorMessage(err);
      showNotification(
        `${t('notification.download_failed')}${message ? `: ${message}` : ''}`,
        'error'
      );
    } finally {
      if (requests.session.isCurrent(session)) setRequestLogDownloading(false);
    }
  };

  useEffect(() => {
    return () => {
      if (longPressRef.current?.timer) {
        window.clearTimeout(longPressRef.current.timer);
        longPressRef.current.timer = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!fullscreenLogs) return;

    document.body.classList.add('logs-fullscreen-active');
    lockScroll();

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (document.querySelector('.modal-overlay')) return;
      setFullscreenLogs(false);
    };

    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.classList.remove('logs-fullscreen-active');
      unlockScroll();
    };
  }, [fullscreenLogs]);

  // 结构化日志行中，级别徽标对应的样式类（INFO 中性 / WARN 黄 / ERROR 红 / DEBUG、TRACE 弱中性）
  const getLevelClassName = (level?: string) => {
    switch (level) {
      case 'info':
        return styles.levelInfo;
      case 'warn':
        return styles.levelWarn;
      case 'error':
      case 'fatal':
        return styles.levelError;
      case 'debug':
        return styles.levelDebug;
      case 'trace':
        return styles.levelTrace;
      default:
        return '';
    }
  };

  // HTTP 状态码徽标：2xx 健康 / 3xx 中性 / 4xx 黄 / 5xx 故障
  const getStatusClassName = (statusCode: number) => {
    if (statusCode >= 200 && statusCode < 300) return styles.statusSuccess;
    if (statusCode >= 300 && statusCode < 400) return styles.statusInfo;
    if (statusCode >= 400 && statusCode < 500) return styles.statusWarn;
    return styles.statusError;
  };

  // 视图开关组：普通模式渲染在筛选卡片内，全屏模式渲染在日志卡片头部
  const logSwitches = (
    <div className={styles.switchGroup}>
      <ToggleSwitch
        checked={hideManagementLogs}
        onChange={setHideManagementLogs}
        label={
          <span className={styles.switchLabel}>
            <IconEyeOff size={16} />
            {t('logs.hide_management_logs', { prefix: MANAGEMENT_API_PREFIX })}
          </span>
        }
      />

      <ToggleSwitch
        checked={showRawLogs}
        onChange={setShowRawLogs}
        label={
          <span
            className={styles.switchLabel}
            title={t('logs.show_raw_logs_hint', {
              defaultValue: 'Show original log text for easier multi-line copy',
            })}
          >
            <IconCode size={16} />
            {t('logs.show_raw_logs', { defaultValue: 'Show raw logs' })}
          </span>
        }
      />

      <ToggleSwitch
        checked={autoRefresh}
        onChange={(value) => setAutoRefresh(value)}
        disabled={autoRefreshDisabled}
        label={
          <span className={styles.switchLabel}>
            <IconTimer size={16} />
            {t('logs.auto_refresh')}
          </span>
        }
      />
    </div>
  );

  // 日志操作按钮组（刷新 / 下载 / 清空 / 全屏）：始终放在日志卡片头部右侧，作用对象就是下方的日志列表
  const logActions = (
    <div className={styles.toolbar}>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => loadLogs(false)}
        disabled={refreshDisabled}
        className={styles.actionButton}
      >
        <IconRefreshCw size={14} />
        {t('logs.refresh_button')}
      </Button>
      <Button
        variant="secondary"
        size="sm"
        onClick={downloadLogs}
        disabled={logState.buffer.length === 0}
        className={styles.actionButton}
      >
        <IconDownload size={14} />
        {t('logs.download_button')}
      </Button>
      <Button
        variant="danger"
        size="sm"
        onClick={clearLogs}
        disabled={clearDisabled}
        className={styles.actionButton}
      >
        <IconTrash2 size={14} />
        {t('logs.clear_button')}
      </Button>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setFullscreenLogs((prev) => !prev)}
        className={styles.actionButton}
        aria-pressed={fullscreenLogs}
        title={fullscreenLogs ? t('logs.exit_fullscreen_button') : t('logs.fullscreen_button')}
      >
        {fullscreenLogs ? <IconMinimize2 size={14} /> : <IconMaximize2 size={14} />}
        {fullscreenLogs ? t('logs.exit_fullscreen_button') : t('logs.fullscreen_button')}
      </Button>
    </div>
  );

  return (
    <div className={styles.container}>
      {/* 页面标题区：标题 + 一句说明 + 当前缓冲日志行数 */}
      <PageHeader
        title={t('logs.title')}
        description={t('logs.page_description', {
          defaultValue:
            'Inspect CLI Proxy API output in real time and filter requests by method, status and path.',
        })}
        stats={
          <PageHeaderStat
            label={t('logs.stat_buffer_lines', { defaultValue: 'Buffered lines' })}
            value={logState.buffer.length.toLocaleString()}
            tone="neutral"
          />
        }
      />

      <div className={styles.tabSection}>
        {/* 下划线式 tab：日志内容 / 错误请求日志 */}
        <div className={styles.tabBar} role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'logs'}
            className={`${styles.tabItem} ${activeTab === 'logs' ? styles.tabActive : ''}`}
            onClick={() => setActiveTab('logs')}
          >
            {t('logs.log_content')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'errors'}
            className={`${styles.tabItem} ${activeTab === 'errors' ? styles.tabActive : ''}`}
            onClick={() => {
              setFullscreenLogs(false);
              setActiveTab('errors');
            }}
          >
            {t('logs.error_logs_modal_title')}
          </button>
        </div>

        <div className={styles.content}>
          {activeTab === 'logs' && (
            <>
              {showFileLoggingRequired && (
                <div className={styles.notice} role="status">
                  {t(
                    cpaNeedsFileLogging
                      ? 'logs.cpa_file_logging_required'
                      : 'logs.file_logging_required'
                  )}
                </div>
              )}
              {error && <div className="error-box">{error}</div>}

              {/* 筛选卡片：搜索 + 结构化筛选开关 + 操作按钮 / 视图开关 / 筛选 chips */}
              {!fullscreenLogs && (
                <section className={styles.filterCard}>
                  <div className={styles.filterRow}>
                    <div className={styles.searchWrapper}>
                      <Input
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder={t('logs.search_placeholder')}
                        aria-label={t('logs.search_placeholder')}
                        className={styles.searchInput}
                        rightElement={
                          searchQuery ? (
                            <button
                              type="button"
                              className={styles.searchClear}
                              onClick={() => setSearchQuery('')}
                              title="Clear"
                              aria-label="Clear"
                            >
                              <IconX size={16} />
                            </button>
                          ) : (
                            <IconSearch size={16} className={styles.searchIcon} />
                          )
                        }
                      />
                    </div>

                    <Button
                      type="button"
                      variant="secondary"
                      className={styles.filterPanelToggle}
                      onClick={() => setStructuredFiltersExpanded((prev) => !prev)}
                      aria-expanded={structuredFiltersExpanded}
                      aria-controls={structuredFiltersPanelId}
                      title={
                        structuredFiltersExpanded
                          ? t('logs.filter_panel_collapse')
                          : t('logs.filter_panel_expand')
                      }
                    >
                      <IconSlidersHorizontal size={16} />
                      <span>{t('logs.filter_panel_title')}</span>
                      {structuredFilterCount > 0 && (
                        <span className={styles.filterPanelCount}>
                          {t('logs.filter_panel_active_count', { count: structuredFilterCount })}
                        </span>
                      )}
                      {structuredFiltersExpanded ? (
                        <IconChevronUp size={16} />
                      ) : (
                        <IconChevronDown size={16} />
                      )}
                    </Button>

                    {/* 视图开关与搜索同一行，宽度不足时整体换行 */}
                    {logSwitches}
                  </div>

                  {structuredFiltersExpanded && (
                    <div id={structuredFiltersPanelId} className={styles.structuredFilters}>
                      <div className={styles.filterChipGroup}>
                        <span className={styles.filterChipLabel}>{t('logs.filter_method')}</span>
                        <div className={styles.filterChipList}>
                          {HTTP_METHODS.map((method) => {
                            const active = filters.methodFilters.includes(method);
                            const count = filters.methodCounts[method] ?? 0;
                            return (
                              <button
                                key={method}
                                type="button"
                                className={`${styles.filterChip} ${active ? styles.filterChipActive : ''}`}
                                onClick={() => filters.toggleMethodFilter(method)}
                                disabled={count === 0 && !active}
                                aria-pressed={active}
                              >
                                {method}
                                <span className={styles.filterChipCount}>{count}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      <div className={styles.filterChipGroup}>
                        <span className={styles.filterChipLabel}>{t('logs.filter_status')}</span>
                        <div className={styles.filterChipList}>
                          {STATUS_GROUPS.map((statusGroup) => {
                            const active = filters.statusFilters.includes(statusGroup);
                            const count = filters.statusCounts[statusGroup] ?? 0;
                            return (
                              <button
                                key={statusGroup}
                                type="button"
                                className={`${styles.filterChip} ${active ? styles.filterChipActive : ''}`}
                                onClick={() => filters.toggleStatusFilter(statusGroup)}
                                disabled={count === 0 && !active}
                                aria-pressed={active}
                              >
                                {t(`logs.filter_status_${statusGroup}`)}
                                <span className={styles.filterChipCount}>{count}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      <div className={styles.filterChipGroup}>
                        <span className={styles.filterChipLabel}>{t('logs.filter_path')}</span>
                        <div className={styles.filterChipList}>
                          {filters.pathOptions.length === 0 ? (
                            <span className={styles.filterChipHint}>
                              {t('logs.filter_path_empty')}
                            </span>
                          ) : (
                            filters.pathOptions.map(({ path, count }) => {
                              const active = filters.pathFilters.includes(path);
                              return (
                                <button
                                  key={path}
                                  type="button"
                                  className={`${styles.filterChip} ${active ? styles.filterChipActive : ''}`}
                                  onClick={() => filters.togglePathFilter(path)}
                                  aria-pressed={active}
                                  title={path}
                                >
                                  <span className={styles.filterChipText}>{path}</span>
                                  <span className={styles.filterChipCount}>{count}</span>
                                </button>
                              );
                            })
                          )}
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          className={styles.clearFiltersButton}
                          onClick={filters.clearStructuredFilters}
                          disabled={!filters.hasStructuredFilters}
                        >
                          {t('logs.clear_filters')}
                        </Button>
                      </div>
                    </div>
                  )}
                </section>
              )}

              {/* 日志列表卡片：头部统计条 + 卡片内滚动的日志行；全屏模式下固定铺满视口 */}
              <section
                className={[styles.logCard, fullscreenLogs ? styles.logCardFullscreen : '']
                  .filter(Boolean)
                  .join(' ')}
              >
                <div className={styles.logCardHead}>
                  <div className={styles.logCardMeta}>
                    <span className={styles.logCardTitle}>{t('logs.log_content')}</span>
                    <span>{t('logs.loaded_lines', { count: filteredLines.length })}</span>
                    {removedCount > 0 && (
                      <span className={styles.logCardMetaMuted}>
                        {t('logs.filtered_lines', { count: removedCount })}
                      </span>
                    )}
                  </div>
                  {/* 头部右侧：复制提示 + 操作按钮；全屏时筛选卡片隐藏，开关也并入这里 */}
                  <div className={styles.logCardTools}>
                    {fullscreenLogs ? (
                      logSwitches
                    ) : (
                      <span className={styles.logCardHint}>
                        {t('logs.double_click_copy_hint', { defaultValue: 'Double-click to copy' })}
                      </span>
                    )}
                    {logActions}
                  </div>
                </div>

                {loading ? (
                  <div className={styles.panelHint}>{t('logs.loading')}</div>
                ) : logState.buffer.length > 0 && filteredLines.length > 0 ? (
                  <div
                    ref={logViewerRef}
                    className={[styles.logPanel, fullscreenLogs ? styles.logPanelFullscreen : '']
                      .filter(Boolean)
                      .join(' ')}
                    onScroll={handleLogScroll}
                  >
                    {canLoadMore && (
                      <div className={styles.loadMoreBanner}>
                        <span>{t('logs.load_more_hint')}</span>
                        {/* 已载入 / 已过滤行数已在卡片头部展示，这里只提示隐藏的历史行数 */}
                        <div className={styles.loadMoreStats}>
                          <span className={styles.loadMoreCount}>
                            {t('logs.hidden_lines', { count: logState.visibleFrom })}
                          </span>
                        </div>
                      </div>
                    )}
                    {showRawLogs ? (
                      <pre className={styles.rawLog} spellCheck={false}>
                        {rawVisibleText}
                      </pre>
                    ) : (
                      <div className={styles.logList}>
                        {parsedVisibleLines.map((line, index) => {
                          const rowClassNames = [styles.logRow];
                          if (line.level === 'warn') rowClassNames.push(styles.rowWarn);
                          if (line.level === 'error' || line.level === 'fatal')
                            rowClassNames.push(styles.rowError);
                          return (
                            <div
                              key={`${logState.visibleFrom + index}-${line.raw}`}
                              className={rowClassNames.join(' ')}
                              onDoubleClick={() => {
                                void copyLogLine(line.raw);
                              }}
                              onPointerDown={(event) => startLongPress(event, line.requestId)}
                              onPointerUp={cancelLongPress}
                              onPointerLeave={cancelLongPress}
                              onPointerCancel={cancelLongPress}
                              onPointerMove={handleLongPressMove}
                              title={t('logs.double_click_copy_hint', {
                                defaultValue: 'Double-click to copy',
                              })}
                            >
                              <div className={styles.timestamp}>{line.timestamp || ''}</div>
                              <div className={styles.rowMain}>
                                {line.level && (
                                  <span
                                    className={[
                                      styles.badge,
                                      styles.levelBadge,
                                      getLevelClassName(line.level),
                                    ]
                                      .filter(Boolean)
                                      .join(' ')}
                                  >
                                    {line.level.toUpperCase()}
                                  </span>
                                )}

                                {line.source && (
                                  <span className={styles.source} title={line.source}>
                                    {line.source}
                                  </span>
                                )}

                                {line.requestId && (
                                  <span
                                    className={[styles.badge, styles.requestIdBadge].join(' ')}
                                    title={line.requestId}
                                  >
                                    {line.requestId}
                                  </span>
                                )}

                                {typeof line.statusCode === 'number' && (
                                  <span
                                    className={[
                                      styles.badge,
                                      styles.statusBadge,
                                      getStatusClassName(line.statusCode),
                                    ].join(' ')}
                                  >
                                    {line.statusCode}
                                  </span>
                                )}

                                {line.latency && (
                                  <span className={styles.pill}>{line.latency}</span>
                                )}
                                {line.ip && <span className={styles.pill}>{line.ip}</span>}

                                {line.method && (
                                  <span className={[styles.badge, styles.methodBadge].join(' ')}>
                                    {line.method}
                                  </span>
                                )}

                                {line.path && (
                                  <span className={styles.path} title={line.path}>
                                    {line.path}
                                  </span>
                                )}

                                {line.message && (
                                  <span className={styles.message}>{line.message}</span>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className={styles.panelEmpty}>
                    {logState.buffer.length > 0 ? (
                      <EmptyState
                        title={t('logs.search_empty_title')}
                        description={t('logs.search_empty_desc')}
                      />
                    ) : showFileLoggingRequired ? (
                      <EmptyState
                        title={t(
                          cpaNeedsFileLogging
                            ? 'logs.cpa_file_logging_required_title'
                            : 'logs.file_logging_required_title'
                        )}
                        description={t(
                          cpaNeedsFileLogging
                            ? 'logs.cpa_file_logging_required_desc'
                            : 'logs.file_logging_required_desc'
                        )}
                      />
                    ) : (
                      <EmptyState
                        title={t('logs.empty_title')}
                        description={t('logs.empty_desc')}
                      />
                    )}
                  </div>
                )}
              </section>
            </>
          )}

          {activeTab === 'errors' && (
            <section className={styles.errorCard}>
              {/* 错误请求日志卡片头：标题 + 说明 + 刷新 */}
              <div className={styles.errorCardHead}>
                <div className={styles.errorCardTitleBlock}>
                  <h2 className={styles.errorCardTitle}>{t('logs.error_logs_modal_title')}</h2>
                  <p className={styles.errorCardDesc}>{t('logs.error_logs_description')}</p>
                </div>
                <Button
                  variant="secondary"
                  onClick={loadErrorLogs}
                  loading={loadingErrors}
                  disabled={disableControls}
                >
                  <IconRefreshCw size={16} />
                  {t('common.refresh')}
                </Button>
              </div>

              {(requestLogEnabled || errorLogsError) && (
                <div className={styles.errorCardNotices}>
                  {requestLogEnabled && (
                    <div className={styles.notice} role="status">
                      {t('logs.error_logs_request_log_enabled')}
                    </div>
                  )}
                  {errorLogsError && <div className="error-box">{errorLogsError}</div>}
                </div>
              )}

              {/* 错误日志文件表格：文件名 / 大小 / 最后修改 / 操作，表格区域在卡片内滚动 */}
              <div className={styles.errorPanel}>
                <table className={styles.errorTable}>
                  <thead>
                    <tr>
                      <th>{t('logs.error_logs_name', { defaultValue: 'File name' })}</th>
                      <th className={styles.numCol}>{t('logs.error_logs_size')}</th>
                      <th>{t('logs.error_logs_modified')}</th>
                      <th className={styles.actionCol}>{t('common.action')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loadingErrors || errorLogs.length === 0 ? (
                      <tr className={styles.emptyRow}>
                        <td colSpan={4}>
                          {loadingErrors ? t('common.loading') : t('logs.error_logs_empty')}
                        </td>
                      </tr>
                    ) : (
                      errorLogs.map((item) => (
                        <tr key={item.name}>
                          <td className={styles.fileNameCell}>{item.name}</td>
                          <td className={`${styles.monoCell} ${styles.numCol}`}>
                            {item.size ? `${(item.size / 1024).toFixed(1)} KB` : '-'}
                          </td>
                          <td className={styles.monoCell}>
                            {item.modified ? formatUnixTimestamp(item.modified) : '-'}
                          </td>
                          <td className={styles.actionCol}>
                            <div className={styles.rowActions}>
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => {
                                  void openErrorLog(item);
                                }}
                                disabled={disableControls}
                              >
                                <IconEye size={16} />
                                {t('logs.error_logs_open')}
                              </Button>
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => downloadErrorLog(item.name)}
                                disabled={disableControls}
                              >
                                <IconDownload size={16} />
                                {t('logs.error_logs_download')}
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      </div>

      <Modal
        open={errorLogViewer.status !== 'closed'}
        onClose={closeErrorLogViewer}
        title={selectedErrorLog?.name ?? t('logs.error_log_view_title')}
        width={960}
        footer={
          <>
            <Button variant="secondary" onClick={closeErrorLogViewer}>
              {t('common.close')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                void copySelectedErrorLog();
              }}
              disabled={errorLogViewer.status !== 'ready' || !errorLogViewer.text}
            >
              {t('common.copy')}
            </Button>
            <Button
              onClick={() => {
                if (selectedErrorLog) {
                  void downloadErrorLog(selectedErrorLog.name);
                }
              }}
              disabled={errorLogViewer.status === 'closed' || errorLogViewer.status === 'loading'}
            >
              {t('logs.error_logs_download')}
            </Button>
          </>
        }
      >
        <div className={styles.errorLogViewer}>
          {selectedErrorLog && (
            <div className={styles.errorLogViewerMeta}>
              <span>
                {t('logs.error_logs_size')}:{' '}
                {selectedErrorLog.size ? `${(selectedErrorLog.size / 1024).toFixed(1)} KB` : '-'}
              </span>
              <span>
                {t('logs.error_logs_modified')}:{' '}
                {selectedErrorLog.modified ? formatUnixTimestamp(selectedErrorLog.modified) : '-'}
              </span>
            </div>
          )}
          {errorLogViewer.status === 'error' && (
            <div className="error-box">{errorLogViewer.message}</div>
          )}
          {errorLogViewer.status === 'loading' && <div className="hint">{t('common.loading')}</div>}
          {errorLogViewer.status === 'ready' &&
            (errorLogViewer.text ? (
              <pre className={styles.errorLogContent} spellCheck={false}>
                {errorLogViewer.text}
              </pre>
            ) : (
              <div className="hint">{t('logs.error_log_empty_content')}</div>
            ))}
        </div>
      </Modal>

      <Modal
        open={Boolean(requestLogId)}
        onClose={closeRequestLogModal}
        title={t('logs.request_log_download_title')}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={closeRequestLogModal}
              disabled={requestLogDownloading}
            >
              {t('common.cancel')}
            </Button>
            <Button
              onClick={() => {
                if (requestLogId) {
                  void downloadRequestLog(requestLogId);
                }
              }}
              loading={requestLogDownloading}
              disabled={!requestLogId}
            >
              {t('common.confirm')}
            </Button>
          </>
        }
      >
        {requestLogId ? t('logs.request_log_download_confirm', { id: requestLogId }) : null}
      </Modal>
    </div>
  );
}
