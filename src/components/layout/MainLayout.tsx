import {
  ReactNode,
  RefObject,
  SVGProps,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type SyntheticEvent,
} from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { MainRoutes } from '@/router/MainRoutes';
import { authFilesApi } from '@/services/api';
import {
  IconCheck,
  IconSearch,
  IconSidebarAuthFiles,
  IconSidebarConfig,
  IconSidebarLogs,
  IconSidebarOauth,
  IconSidebarQuota,
} from '@/components/ui/icons';
import { NavSearchDialog, type NavSearchItem } from '@/components/layout/NavSearchDialog';
import {
  useAuthStore,
  useConfigStore,
  useLanguageStore,
  useNotificationStore,
  useThemeStore,
} from '@/stores';
import { AUTH_FILES_CHANGED_EVENT } from '@/features/authFiles/authFilesEvents';
import { triggerHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { LANGUAGE_LABEL_KEYS, LANGUAGE_ORDER } from '@/utils/constants';
import { isSupportedLanguage } from '@/utils/language';
import {
  getNavSearchShortcutLabel,
  getSidebarShortcutLabel,
  isNavSearchShortcut,
  isSidebarToggleShortcut,
} from '@/utils/sidebarShortcut';
import type { Theme } from '@/types';

/**
 * Stallion-X 应用外壳。
 *
 * 布局与 Stallion-X 主站（AppShell / AppSidebar / Header）保持一致：
 * - 左侧固定侧边栏：品牌区、按任务分组的导航、底部连接信息；可收起为图标栏（⌘B / Ctrl+B）。
 * - 右侧内容列：吸顶控制栏（侧边栏开关、页面搜索 ⌘K、刷新、语言、主题、登出）+ 页面内容。
 *
 * 与上游的差异：
 * - 只保留五个入口（认证文件、OAuth 登录、配额管理、日志查看、配置面板），插件页入口不再渲染。
 * - 移除页面切换动画（PageTransition）与顶部渐隐模糊层，路由切换直接渲染目标页面并回到顶部。
 */

/** 导航链接项 */
interface SidebarNavItem {
  path: string;
  labelKey: string;
  metaKey: string;
  /** 额外检索词，供页面搜索使用，不展示 */
  keywords?: string;
  badge?: number;
  badgeLabel?: string;
  icon: ReactNode;
}

/** 导航分组：名称 + 右侧说明 + 链接 */
interface SidebarNavGroup {
  id: string;
  labelKey: string;
  hintKey: string;
  items: SidebarNavItem[];
}

const NAV_TOOLTIP_ID = 'sidebar-nav-tooltip';

/** 顶栏内联图标的公共属性，与 lucide 图标规格一致 */
const headerIconProps: SVGProps<SVGSVGElement> = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': 'true',
  focusable: 'false',
};

const headerIcons = {
  panelLeft: (
    <svg {...headerIconProps}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
    </svg>
  ),
  menu: (
    <svg {...headerIconProps}>
      <path d="M4 7h16" />
      <path d="M4 12h16" />
      <path d="M4 17h16" />
    </svg>
  ),
  refresh: (
    <svg {...headerIconProps}>
      <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
    </svg>
  ),
  language: (
    <svg {...headerIconProps}>
      <path d="m5 8 6 6" />
      <path d="m4 14 6-6 2-3" />
      <path d="M2 5h12" />
      <path d="M7 2h1" />
      <path d="m22 22-5-10-5 10" />
      <path d="M14 18h6" />
    </svg>
  ),
  sun: (
    <svg {...headerIconProps}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" />
      <path d="m19.07 4.93-1.41 1.41" />
    </svg>
  ),
  moon: (
    <svg {...headerIconProps}>
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z" />
    </svg>
  ),
  square: (
    <svg {...headerIconProps}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
    </svg>
  ),
  monitor: (
    <svg {...headerIconProps}>
      <rect width="20" height="14" x="2" y="3" rx="2" />
      <path d="M8 21h8" />
      <path d="M12 17v4" />
    </svg>
  ),
  logout: (
    <svg {...headerIconProps}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  ),
};

/** 主题选项：跟随系统 / 浅色（Control Fog）/ 纯白 / 暗色（Night Relay） */
const THEME_OPTIONS: Array<{ key: Theme; labelKey: string; icon: ReactNode }> = [
  { key: 'auto', labelKey: 'theme.auto', icon: headerIcons.monitor },
  { key: 'light', labelKey: 'theme.light', icon: headerIcons.sun },
  { key: 'white', labelKey: 'theme.white', icon: headerIcons.square },
  { key: 'dark', labelKey: 'theme.dark', icon: headerIcons.moon },
];

/** 点击菜单外或按下 Escape 时关闭弹出菜单 */
function useMenuDismiss(
  open: boolean,
  menuRef: RefObject<HTMLDivElement | null>,
  onClose: () => void
) {
  useEffect(() => {
    if (!open) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open, menuRef, onClose]);
}

/** 从后端地址中取出 host:port 用于展示；解析失败时原样返回 */
const formatApiHost = (apiBase: string): string => {
  if (!apiBase) return '';
  try {
    return new URL(apiBase).host;
  } catch {
    return apiBase;
  }
};

/** 判断是否 macOS / iOS，用于展示 ⌘ 或 Ctrl 快捷键 */
const detectMac = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  const platform =
    (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData?.platform ||
    navigator.platform ||
    navigator.userAgent ||
    '';
  return /(Mac|iPhone|iPod|iPad)/i.test(platform);
};

export function MainLayout() {
  const { t } = useTranslation();
  const { showNotification } = useNotificationStore();
  const location = useLocation();
  const navigate = useNavigate();

  const logout = useAuthStore((state) => state.logout);
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const apiBase = useAuthStore((state) => state.apiBase);
  const serverVersion = useAuthStore((state) => state.serverVersion);

  const fetchConfig = useConfigStore((state) => state.fetchConfig);
  const clearCache = useConfigStore((state) => state.clearCache);

  const theme = useThemeStore((state) => state.theme);
  const setTheme = useThemeStore((state) => state.setTheme);
  const language = useLanguageStore((state) => state.language);
  const setLanguage = useLanguageStore((state) => state.setLanguage);

  /** 移动端抽屉是否打开 */
  const [sidebarOpen, setSidebarOpen] = useState(false);
  /** 桌面端是否收起为图标栏 */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [authFilesCount, setAuthFilesCount] = useState<number | null>(null);
  const [railTooltip, setRailTooltip] = useState<{
    targetID: string;
    label: string;
    meta?: string;
    top: number;
  } | null>(null);
  const [languageMenuOpen, setLanguageMenuOpen] = useState(false);
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);

  const contentRef = useRef<HTMLDivElement | null>(null);
  const authFilesCountRequestRef = useRef(0);
  const languageMenuRef = useRef<HTMLDivElement | null>(null);
  const themeMenuRef = useRef<HTMLDivElement | null>(null);

  const brandName = t('title.abbr');
  const isLogsPage = location.pathname.startsWith('/logs');
  // 移动端抽屉内始终展示完整标签
  const showSidebarLabels = !sidebarCollapsed || sidebarOpen;
  const isMac = useMemo(() => detectMac(), []);
  const sidebarShortcutText = getSidebarShortcutLabel(isMac);
  const searchShortcutText = getNavSearchShortcutLabel(isMac);
  const apiHost = formatApiHost(apiBase);

  // 路由切换后内容区回到顶部（替代原页面切换动画里的滚动位置管理）
  useLayoutEffect(() => {
    contentRef.current?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [location.pathname]);

  // 悬浮操作条（批量操作 / 保存栏）需要对齐内容列中心
  useLayoutEffect(() => {
    const updateContentCenter = () => {
      const el = contentRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      document.documentElement.style.setProperty(
        '--content-center-x',
        `${rect.left + rect.width / 2}px`
      );
    };

    updateContentCenter();

    const resizeObserver =
      typeof ResizeObserver !== 'undefined' && contentRef.current
        ? new ResizeObserver(updateContentCenter)
        : null;
    if (resizeObserver && contentRef.current) {
      resizeObserver.observe(contentRef.current);
    }
    window.addEventListener('resize', updateContentCenter);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', updateContentCenter);
      document.documentElement.style.removeProperty('--content-center-x');
    };
  }, []);

  const closeLanguageMenu = useCallback(() => setLanguageMenuOpen(false), []);
  const closeThemeMenu = useCallback(() => setThemeMenuOpen(false), []);
  useMenuDismiss(languageMenuOpen, languageMenuRef, closeLanguageMenu);
  useMenuDismiss(themeMenuOpen, themeMenuRef, closeThemeMenu);

  const handleThemeSelect = useCallback(
    (nextTheme: Theme) => {
      setTheme(nextTheme);
      setThemeMenuOpen(false);
    },
    [setTheme]
  );

  const handleLanguageSelect = useCallback(
    (nextLanguage: string) => {
      if (!isSupportedLanguage(nextLanguage)) {
        return;
      }
      setLanguage(nextLanguage);
      setLanguageMenuOpen(false);
    },
    [setLanguage]
  );

  useEffect(() => {
    fetchConfig().catch(() => {
      // 首次加载失败时忽略，登录流程会给出面向用户的提示
    });
  }, [fetchConfig]);

  /** 读取认证文件数量，用于侧边栏徽标；带请求序号防止旧响应覆盖新状态 */
  const loadAuthFilesCount = useCallback(async () => {
    const requestID = ++authFilesCountRequestRef.current;
    if (connectionStatus !== 'connected') {
      setAuthFilesCount(null);
      return;
    }

    try {
      const response = await authFilesApi.list();
      if (requestID !== authFilesCountRequestRef.current) return;
      setAuthFilesCount(Array.isArray(response?.files) ? response.files.length : null);
    } catch (error) {
      if (requestID !== authFilesCountRequestRef.current) return;
      console.error('[MainLayout] 读取认证文件数量失败', error);
      setAuthFilesCount(null);
    }
  }, [connectionStatus]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadAuthFilesCount();
    }, 0);

    window.addEventListener(AUTH_FILES_CHANGED_EVENT, loadAuthFilesCount);

    return () => {
      authFilesCountRequestRef.current += 1;
      window.clearTimeout(timer);
      window.removeEventListener(AUTH_FILES_CHANGED_EVENT, loadAuthFilesCount);
    };
  }, [apiBase, loadAuthFilesCount]);

  /** 导航分组：按「凭证接入 → 用量与排障 → 网关设置」的任务顺序组织 */
  const navGroups: SidebarNavGroup[] = [
    {
      id: 'gateway',
      labelKey: 'nav_groups.gateway',
      hintKey: 'nav_group_hints.gateway',
      items: [
        {
          path: '/auth-files',
          labelKey: 'nav.auth_files',
          metaKey: 'nav_meta.auth_files',
          keywords: 'auth files credentials 认证 凭证',
          badge: authFilesCount ?? undefined,
          badgeLabel:
            typeof authFilesCount === 'number'
              ? t('sidebar.auth_files_count', { count: authFilesCount })
              : undefined,
          icon: <IconSidebarAuthFiles size={17} />,
        },
        {
          path: '/oauth',
          labelKey: 'nav.oauth',
          metaKey: 'nav_meta.oauth',
          keywords: 'oauth login 登录 授权',
          icon: <IconSidebarOauth size={17} />,
        },
      ],
    },
    {
      id: 'observe',
      labelKey: 'nav_groups.observe',
      hintKey: 'nav_group_hints.observe',
      items: [
        {
          path: '/quota',
          labelKey: 'nav.quota_management',
          metaKey: 'nav_meta.quota_management',
          keywords: 'quota usage limit 配额 额度 用量',
          icon: <IconSidebarQuota size={17} />,
        },
        {
          path: '/logs',
          labelKey: 'nav.logs',
          metaKey: 'nav_meta.logs',
          keywords: 'logs request error 日志 请求 错误',
          icon: <IconSidebarLogs size={17} />,
        },
      ],
    },
    {
      id: 'control',
      labelKey: 'nav_groups.control',
      hintKey: 'nav_group_hints.control',
      items: [
        {
          path: '/config',
          labelKey: 'nav.config_management',
          metaKey: 'nav_meta.config_management',
          keywords: 'config yaml settings proxy api key 配置 设置 代理 密钥',
          icon: <IconSidebarConfig size={17} />,
        },
      ],
    },
  ];

  /** 页面搜索的数据源直接复用导航定义，避免两份入口清单漂移 */
  const searchItems: NavSearchItem[] = navGroups.flatMap((group) =>
    group.items.map((item) => ({
      path: item.path,
      title: t(item.labelKey),
      description: t(item.metaKey),
      keywords: `${t(group.labelKey)} ${item.keywords ?? ''}`,
      icon: item.icon,
    }))
  );

  const handleRefreshAll = async () => {
    clearCache();
    const results = await Promise.allSettled([
      fetchConfig(true),
      loadAuthFilesCount(),
      triggerHeaderRefresh(),
    ]);
    const rejected = results.find((result) => result.status === 'rejected');
    if (rejected && rejected.status === 'rejected') {
      const reason = rejected.reason;
      console.error('[MainLayout] 刷新全部数据失败', reason);
      const message =
        typeof reason === 'string' ? reason : reason instanceof Error ? reason.message : '';
      showNotification(
        `${t('notification.refresh_failed')}${message ? `: ${message}` : ''}`,
        'error'
      );
      return;
    }
    showNotification(t('notification.data_refreshed'), 'success');
  };

  /** 收起态下悬停或聚焦导航项时，在其右侧显示名称提示 */
  const showRailTooltip = useCallback(
    (event: SyntheticEvent<HTMLElement>, targetID: string, label: string, meta?: string) => {
      const rect = event.currentTarget.getBoundingClientRect();
      setRailTooltip({ targetID, label, meta, top: rect.top + rect.height / 2 });
    },
    []
  );
  const hideRailTooltip = useCallback(() => setRailTooltip(null), []);

  const toggleSidebar = useCallback(() => {
    hideRailTooltip();
    // 移动端切换抽屉，桌面端切换图标栏
    if (window.matchMedia?.('(max-width: 768px)').matches) {
      setSidebarOpen((prev) => !prev);
    } else {
      setSidebarCollapsed((prev) => !prev);
    }
  }, [hideRailTooltip]);

  // 全局快捷键：⌘B 收起侧边栏，⌘K 打开页面搜索
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isSidebarToggleShortcut(event)) {
        event.preventDefault();
        hideRailTooltip();
        setSidebarCollapsed((prev) => !prev);
        return;
      }
      if (isNavSearchShortcut(event)) {
        event.preventDefault();
        setSearchOpen((prev) => !prev);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [hideRailTooltip]);

  const handleSearchSelect = useCallback(
    (item: NavSearchItem) => {
      setSearchOpen(false);
      setSidebarOpen(false);
      navigate(item.path);
    },
    [navigate]
  );

  const renderNavBadge = (badge?: number, badgeLabel?: string) =>
    typeof badge === 'number' ? (
      <>
        {badge > 0 ? (
          <span className="nav-badge" aria-hidden="true">
            {badge > 99 ? '99+' : badge}
          </span>
        ) : null}
        {badgeLabel ? <span className="nav-badge-sr-only">{badgeLabel}</span> : null}
      </>
    ) : null;

  const renderNavLink = (item: SidebarNavItem) => {
    const itemLabel = t(item.labelKey);
    const itemMeta = t(item.metaKey);
    const accessibleLabel = item.badgeLabel ? `${itemLabel}, ${item.badgeLabel}` : itemLabel;
    // 收起态才挂载提示事件；NavLink 默认对子路径也判定激活，认证文件二级编辑页仍高亮其入口
    const railHandlers = showSidebarLabels
      ? {}
      : {
          onMouseEnter: (event: SyntheticEvent<HTMLElement>) =>
            showRailTooltip(event, item.path, itemLabel, itemMeta),
          onMouseLeave: hideRailTooltip,
          onFocus: (event: SyntheticEvent<HTMLElement>) =>
            showRailTooltip(event, item.path, itemLabel, itemMeta),
          onBlur: hideRailTooltip,
        };

    return (
      <NavLink
        key={item.path}
        to={item.path}
        className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
        onClick={() => {
          setSidebarOpen(false);
          hideRailTooltip();
        }}
        aria-label={showSidebarLabels ? undefined : accessibleLabel}
        aria-describedby={
          !showSidebarLabels && railTooltip?.targetID === item.path ? NAV_TOOLTIP_ID : undefined
        }
        {...railHandlers}
      >
        <span className="nav-icon">{item.icon}</span>
        {showSidebarLabels ? (
          <>
            <span className="nav-label">{itemLabel}</span>
            {renderNavBadge(item.badge, item.badgeLabel)}
          </>
        ) : (
          renderNavBadge(item.badge)
        )}
      </NavLink>
    );
  };

  const sidebarToggleLabel = sidebarCollapsed ? t('sidebar.expand') : t('sidebar.collapse');
  const mobileSidebarToggleLabel = sidebarOpen
    ? t('sidebar.toggle_collapse')
    : t('sidebar.toggle_expand');
  const connectionLabel =
    connectionStatus === 'connected'
      ? t('common.connected_status')
      : connectionStatus === 'connecting'
        ? t('common.connecting_status')
        : t('common.disconnected_status');
  const currentThemeIcon = THEME_OPTIONS.find((option) => option.key === theme)?.icon ?? headerIcons.sun;

  return (
    <div className={`app-shell ${sidebarCollapsed ? 'sidebar-is-collapsed' : ''}`}>
      {/* 键盘用户可跳过重复导航，直接进入页面内容 */}
      <a className="skip-link" href="#main-content">
        {t('sidebar.skip_to_content')}
      </a>

      <button
        type="button"
        className={`sidebar-backdrop ${sidebarOpen ? 'visible' : ''}`}
        onClick={() => setSidebarOpen(false)}
        aria-label={t('common.close')}
        aria-hidden={!sidebarOpen}
        tabIndex={sidebarOpen ? 0 : -1}
      />

      <aside
        className={`sidebar ${sidebarOpen ? 'open' : ''} ${sidebarCollapsed ? 'collapsed' : ''}`}
        aria-label={brandName}
      >
        {/* 品牌区：主色字标 + 名称 / 副标题 / 界面版本 */}
        <div className="sidebar-header" title="CLI Proxy API Management Center">
          <span className="sidebar-brand-mark" aria-hidden="true">
            {brandName.charAt(0)}
          </span>
          {showSidebarLabels && (
            <span className="sidebar-brand-text">
              <span className="sidebar-brand-title">{brandName}</span>
              <span className="sidebar-brand-subtitle">{t('sidebar.subtitle')}</span>
              <span className="sidebar-brand-build">
                {t('sidebar.ui_version', { version: __APP_VERSION__ || 'dev' })}
              </span>
            </span>
          )}
        </div>

        <nav className="nav-section">
          {navGroups.map((group, idx) => (
            <div className="nav-group" key={group.id}>
              {showSidebarLabels ? (
                <div className="nav-group-label">
                  <span>{t(group.labelKey)}</span>
                  <span className="nav-group-line" aria-hidden="true" />
                  <span className="nav-group-hint">{t(group.hintKey)}</span>
                </div>
              ) : (
                idx > 0 && <div className="nav-group-divider" aria-hidden="true" />
              )}
              {group.items.map(renderNavLink)}
            </div>
          ))}
        </nav>

        {/* 页脚：当前管理的后端实例与服务端版本 */}
        {showSidebarLabels && (
          <div className="sidebar-footer">
            <div className="sidebar-connection" title={apiBase}>
              <span className={`status-dot ${connectionStatus}`} aria-hidden="true" />
              <span className="sidebar-connection-label">{connectionLabel}</span>
              {apiHost ? <span className="sidebar-connection-host">{apiHost}</span> : null}
            </div>
            {serverVersion ? (
              <div className="sidebar-version">
                {t('sidebar.server_version', { version: serverVersion })}
              </div>
            ) : null}
          </div>
        )}
      </aside>

      {railTooltip && (
        <div
          id={NAV_TOOLTIP_ID}
          className="nav-tooltip"
          role="tooltip"
          style={{ top: railTooltip.top }}
        >
          <span className="nav-tooltip-label">{railTooltip.label}</span>
          {railTooltip.meta ? <span className="nav-tooltip-meta">{railTooltip.meta}</span> : null}
        </div>
      )}

      <div className={`content${isLogsPage ? ' content-logs' : ''}`} ref={contentRef}>
        <header className="main-header">
          <button
            type="button"
            className="header-icon-btn desktop-only"
            onClick={toggleSidebar}
            title={`${sidebarToggleLabel} (${sidebarShortcutText})`}
            aria-label={`${sidebarToggleLabel} (${sidebarShortcutText})`}
          >
            {headerIcons.panelLeft}
          </button>
          <button
            type="button"
            className="header-icon-btn mobile-only"
            onClick={toggleSidebar}
            title={mobileSidebarToggleLabel}
            aria-label={mobileSidebarToggleLabel}
            aria-expanded={sidebarOpen}
          >
            {headerIcons.menu}
          </button>

          <button
            type="button"
            className="header-search-trigger"
            onClick={() => setSearchOpen(true)}
            aria-label={t('header.search_placeholder')}
            aria-keyshortcuts="Meta+K Control+K"
          >
            <IconSearch size={16} aria-hidden="true" />
            <span className="header-search-placeholder">{t('header.search_placeholder')}</span>
            <span className="kbd">{searchShortcutText}</span>
          </button>

          <div className="header-spacer" />

          {/* 连接状态：颜色之外同时提供文字与 title */}
          <div className="header-connection desktop-only" title={apiBase}>
            <span className={`status-dot ${connectionStatus}`} aria-hidden="true" />
            <span>{connectionLabel}</span>
          </div>
          <span className="header-divider desktop-only" aria-hidden="true" />

          <button
            type="button"
            className="header-icon-btn"
            onClick={handleRefreshAll}
            title={t('header.refresh_all')}
            aria-label={t('header.refresh_all')}
          >
            {headerIcons.refresh}
          </button>

          <div className="header-menu" ref={languageMenuRef}>
            <button
              type="button"
              className="header-icon-btn"
              onClick={() => {
                setLanguageMenuOpen((prev) => !prev);
                setThemeMenuOpen(false);
              }}
              title={t('language.switch')}
              aria-label={t('language.switch')}
              aria-haspopup="menu"
              aria-expanded={languageMenuOpen}
            >
              {headerIcons.language}
            </button>
            {languageMenuOpen && (
              <div className="header-menu-popover" role="menu" aria-label={t('language.switch')}>
                <div className="header-menu-label">{t('language.switch')}</div>
                {LANGUAGE_ORDER.map((lang) => (
                  <button
                    key={lang}
                    type="button"
                    className={`header-menu-option ${language === lang ? 'active' : ''}`}
                    onClick={() => handleLanguageSelect(lang)}
                    role="menuitemradio"
                    aria-checked={language === lang}
                  >
                    <span className="header-menu-option-label">
                      {t(LANGUAGE_LABEL_KEYS[lang])}
                    </span>
                    {language === lang ? (
                      <span className="header-menu-check">
                        <IconCheck size={14} />
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="header-menu" ref={themeMenuRef}>
            <button
              type="button"
              className="header-icon-btn"
              onClick={() => {
                setThemeMenuOpen((prev) => !prev);
                setLanguageMenuOpen(false);
              }}
              title={t('theme.switch')}
              aria-label={t('theme.switch')}
              aria-haspopup="menu"
              aria-expanded={themeMenuOpen}
            >
              {currentThemeIcon}
            </button>
            {themeMenuOpen && (
              <div className="header-menu-popover" role="menu" aria-label={t('theme.switch')}>
                <div className="header-menu-label">{t('theme.switch')}</div>
                {THEME_OPTIONS.map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    className={`header-menu-option ${theme === option.key ? 'active' : ''}`}
                    onClick={() => handleThemeSelect(option.key)}
                    role="menuitemradio"
                    aria-checked={theme === option.key}
                  >
                    {option.icon}
                    <span className="header-menu-option-label">{t(option.labelKey)}</span>
                    {theme === option.key ? (
                      <span className="header-menu-check">
                        <IconCheck size={14} />
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            )}
          </div>

          <button
            type="button"
            className="header-icon-btn"
            onClick={logout}
            title={t('header.logout')}
            aria-label={t('header.logout')}
          >
            {headerIcons.logout}
          </button>
        </header>

        <main
          id="main-content"
          tabIndex={-1}
          className={`main-content${isLogsPage ? ' main-content-logs' : ''}`}
        >
          <MainRoutes />
        </main>
      </div>

      {searchOpen && (
        <NavSearchDialog
          open={searchOpen}
          items={searchItems}
          onClose={() => setSearchOpen(false)}
          onSelect={handleSearchSelect}
        />
      )}
    </div>
  );
}
