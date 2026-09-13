import { Navigate, useRoutes, type Location } from 'react-router-dom';
import { AuthFilesPage } from '@/features/authFiles/AuthFilesPage';
import { AuthFilesOAuthExcludedEditPage } from '@/pages/AuthFilesOAuthExcludedEditPage';
import { AuthFilesOAuthModelAliasEditPage } from '@/pages/AuthFilesOAuthModelAliasEditPage';
import { OAuthPage } from '@/pages/OAuthPage';
import { QuotaPage } from '@/features/quota/QuotaPage';
import { ConfigPage } from '@/features/config/ConfigPage';
import { LogsPage } from '@/pages/LogsPage';

/**
 * Stallion-X 裁剪版路由表。
 *
 * 只保留 OAuth 登录、认证文件、配额管理、日志查看、配置面板五个功能。
 * 仪表盘、快速开始、AI 提供商、插件管理、插件商店、中心信息仅从路由摘除，
 * 对应源码目录原样保留：OAuthPage 仍依赖插件与提供商模块的工具函数，
 * 且不删目录可以让 `git merge upstream/main` 保持无冲突。
 * 旧路径统一重定向到认证文件页，避免书签或上游内部跳转落到空白页。
 */
const DEFAULT_ROUTE = '/auth-files';

const mainRoutes = [
  { path: '/', element: <Navigate to={DEFAULT_ROUTE} replace /> },
  { path: '/settings', element: <Navigate to="/config" replace /> },
  { path: '/api-keys', element: <Navigate to="/config" replace /> },
  { path: '/auth-files', element: <AuthFilesPage /> },
  { path: '/auth-files/oauth-excluded', element: <AuthFilesOAuthExcludedEditPage /> },
  { path: '/auth-files/oauth-model-alias', element: <AuthFilesOAuthModelAliasEditPage /> },
  { path: '/oauth', element: <OAuthPage /> },
  { path: '/quota', element: <QuotaPage /> },
  { path: '/config', element: <ConfigPage /> },
  { path: '/logs', element: <LogsPage /> },
  { path: '*', element: <Navigate to={DEFAULT_ROUTE} replace /> },
];

export function MainRoutes({ location }: { location?: Location }) {
  return useRoutes(mainRoutes, location);
}
