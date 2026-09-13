import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { Navigate, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { SelectionCheckbox } from '@/components/ui/SelectionCheckbox';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { IconEye, IconEyeOff } from '@/components/ui/icons';
import { useAuthStore, useLanguageStore, useNotificationStore } from '@/stores';
import { detectApiBaseFromLocation, normalizeApiBase } from '@/utils/connection';
import { LANGUAGE_LABEL_KEYS, LANGUAGE_ORDER } from '@/utils/constants';
import { isSupportedLanguage } from '@/utils/language';
import type { ApiError } from '@/types';
import styles from '@/pages/LoginPage.module.scss';

/**
 * 将 API 错误转换为本地化的用户友好消息
 */
type RedirectState = { from?: { pathname?: string } };

function getLocalizedErrorMessage(error: unknown, t: (key: string) => string): string {
  const apiError = error as Partial<ApiError>;
  const status = typeof apiError.status === 'number' ? apiError.status : undefined;
  const code = typeof apiError.code === 'string' ? apiError.code : undefined;
  const message =
    error instanceof Error
      ? error.message
      : typeof apiError.message === 'string'
        ? apiError.message
        : typeof error === 'string'
          ? error
          : '';

  const withHttpStatus = (summary: string) => {
    if (!status) {
      return summary;
    }

    const genericAxiosMessage = `Request failed with status code ${status}`;
    const detail = message.trim();
    const backendDetail =
      detail && detail !== genericAxiosMessage
        ? ` (${t('login.error_backend_detail')}: ${detail})`
        : '';

    return `HTTP ${status}: ${summary}${backendDetail}`;
  };

  // 根据 HTTP 状态码判断
  if (status === 401) {
    return withHttpStatus(t('login.error_unauthorized'));
  }
  if (status === 403) {
    return withHttpStatus(t('login.error_forbidden'));
  }
  if (status === 404) {
    return withHttpStatus(t('login.error_not_found'));
  }
  if (status && status >= 500) {
    return withHttpStatus(t('login.error_server'));
  }

  // 根据 axios 错误码判断
  if (code === 'ECONNABORTED' || message.toLowerCase().includes('timeout')) {
    return t('login.error_timeout');
  }
  if (code === 'ERR_NETWORK' || message.toLowerCase().includes('network error')) {
    return t('login.error_network');
  }
  if (code === 'ERR_CERT_AUTHORITY_INVALID' || message.toLowerCase().includes('certificate')) {
    return t('login.error_ssl');
  }

  // 检查 CORS 错误
  if (message.toLowerCase().includes('cors') || message.toLowerCase().includes('cross-origin')) {
    return t('login.error_cors');
  }

  // 默认错误消息
  return withHttpStatus(t('login.error_invalid'));
}

/**
 * 登录页（Stallion-X 风格）：冷灰底 + 居中白色登录卡片。
 * 卡片顶部品牌行与侧边栏一致（主色方块首字母 + 名称 + 副标题 + 语言切换）；
 * 自动登录检测 / 自动登录成功期间，卡片内显示静态品牌信息与加载旋转，不再使用入场与脉冲动画。
 */
export function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { showNotification } = useNotificationStore();
  const language = useLanguageStore((state) => state.language);
  const setLanguage = useLanguageStore((state) => state.setLanguage);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const login = useAuthStore((state) => state.login);
  const restoreSession = useAuthStore((state) => state.restoreSession);
  const storedBase = useAuthStore((state) => state.apiBase);
  const storedKey = useAuthStore((state) => state.managementKey);
  const storedRememberPassword = useAuthStore((state) => state.rememberPassword);

  const [apiBase, setApiBase] = useState('');
  const [managementKey, setManagementKey] = useState('');
  const [showCustomBase, setShowCustomBase] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [rememberPassword, setRememberPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [autoLoading, setAutoLoading] = useState(true);
  const [autoLoginSuccess, setAutoLoginSuccess] = useState(false);
  const [error, setError] = useState('');

  const detectedBase = useMemo(() => detectApiBaseFromLocation(), []);
  const languageOptions = useMemo(
    () =>
      LANGUAGE_ORDER.map((lang) => ({
        value: lang,
        label: t(LANGUAGE_LABEL_KEYS[lang]),
      })),
    [t]
  );
  const handleLanguageChange = useCallback(
    (selectedLanguage: string) => {
      if (!isSupportedLanguage(selectedLanguage)) {
        return;
      }
      setLanguage(selectedLanguage);
    },
    [setLanguage]
  );

  useEffect(() => {
    const init = async () => {
      try {
        const autoLoggedIn = await restoreSession();
        if (autoLoggedIn) {
          setAutoLoginSuccess(true);
          // 延迟跳转，让用户看到自动登录成功的状态提示
          setTimeout(() => {
            const redirect = (location.state as RedirectState | null)?.from?.pathname || '/';
            navigate(redirect, { replace: true });
          }, 1500);
        } else {
          setApiBase(storedBase || detectedBase);
          setManagementKey(storedKey || '');
          setRememberPassword(storedRememberPassword || Boolean(storedKey));
        }
      } finally {
        // 自动登录成功时 showSplash 仍由 autoLoginSuccess 维持，可无条件结束 loading
        setAutoLoading(false);
      }
    };

    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!managementKey.trim()) {
      setError(t('login.error_required'));
      return;
    }

    const baseToUse = apiBase ? normalizeApiBase(apiBase) : detectedBase;
    setLoading(true);
    setError('');
    try {
      await login({
        apiBase: baseToUse,
        managementKey: managementKey.trim(),
        rememberPassword,
      });
      showNotification(t('common.connected_status'), 'success');
      navigate('/', { replace: true });
    } catch (err: unknown) {
      const message = getLocalizedErrorMessage(err, t);
      setError(message);
      showNotification(`${t('notification.login_failed')}: ${message}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [
    apiBase,
    detectedBase,
    login,
    managementKey,
    navigate,
    rememberPassword,
    showNotification,
    t,
  ]);

  const handleSubmitKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Enter' && !loading) {
        event.preventDefault();
        handleSubmit();
      }
    },
    [loading, handleSubmit]
  );

  if (isAuthenticated && !autoLoading && !autoLoginSuccess) {
    const redirect = (location.state as RedirectState | null)?.from?.pathname || '/';
    return <Navigate to={redirect} replace />;
  }

  // 显示启动状态（自动登录检测中或自动登录成功）
  const showSplash = autoLoading || autoLoginSuccess;
  // 品牌名称与首字母：与侧边栏品牌行保持一致
  const brandName = t('title.abbr');

  /** 卡片顶部品牌行：主色方块 + 名称 / 副标题，右侧可放语言切换 */
  const brandRow = (
    <div className={styles.brandRow}>
      <span className={styles.brandMark} aria-hidden="true">
        {brandName.charAt(0)}
      </span>
      <div className={styles.brandText}>
        <span className={styles.brandTitle}>{brandName}</span>
        <span className={styles.brandSubtitle}>{t('sidebar.subtitle')}</span>
      </div>
      <Select
        className={styles.languageSelect}
        value={language}
        options={languageOptions}
        onChange={handleLanguageChange}
        fullWidth={false}
        size="sm"
        ariaLabel={t('language.switch')}
      />
    </div>
  );

  // 启动状态（自动登录检测中或自动登录成功）：只显示居中的加载转圈，不渲染卡片
  if (showSplash) {
    return (
      <div className={styles.splash} role="status" aria-live="polite">
        <LoadingSpinner size={28} className={styles.splashSpinner} />
        <span className={styles.srOnly}>{t('splash.title')}</span>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <main className={styles.card}>
        {brandRow}

        {/* 登录表单 */}
        <div className={styles.formContent}>
          <div className={styles.loginHeader}>
            <h1 className={styles.title}>{t('common.login')}</h1>
            <p className={styles.subtitle}>{t('login.subtitle')}</p>
          </div>

          {/* 当前连接地址（自动检测或已保存的地址） */}
          <div className={styles.connectionBox}>
            <div className={styles.label}>{t('login.connection_current')}</div>
            <div className={styles.value}>{apiBase || detectedBase}</div>
            <div className={styles.hint}>{t('login.connection_auto_hint')}</div>
          </div>

          <div className={styles.toggleAdvanced}>
            <SelectionCheckbox
              checked={showCustomBase}
              onChange={setShowCustomBase}
              ariaLabel={t('login.custom_connection_label')}
              label={t('login.custom_connection_label')}
              labelClassName={styles.toggleLabel}
            />
          </div>

          {showCustomBase && (
            <Input
              label={t('login.custom_connection_label')}
              placeholder={t('login.custom_connection_placeholder')}
              value={apiBase}
              onChange={(e) => setApiBase(e.target.value)}
              hint={t('login.custom_connection_hint')}
            />
          )}

          <Input
            autoFocus
            label={t('login.management_key_label')}
            placeholder={t('login.management_key_placeholder')}
            type={showKey ? 'text' : 'password'}
            name="cpa-management-key"
            autoComplete="current-password"
            value={managementKey}
            onChange={(e) => setManagementKey(e.target.value)}
            onKeyDown={handleSubmitKeyDown}
            rightElement={
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setShowKey((prev) => !prev)}
                aria-label={
                  showKey
                    ? t('login.hide_key', { defaultValue: '隐藏密钥' })
                    : t('login.show_key', { defaultValue: '显示密钥' })
                }
                title={
                  showKey
                    ? t('login.hide_key', { defaultValue: '隐藏密钥' })
                    : t('login.show_key', { defaultValue: '显示密钥' })
                }
              >
                {showKey ? <IconEyeOff size={16} /> : <IconEye size={16} />}
              </button>
            }
          />

          <div className={styles.toggleAdvanced}>
            <SelectionCheckbox
              checked={rememberPassword}
              onChange={setRememberPassword}
              ariaLabel={t('login.remember_password_label')}
              label={t('login.remember_password_label')}
              labelClassName={styles.toggleLabel}
            />
          </div>

          <Button fullWidth onClick={handleSubmit} loading={loading}>
            {loading ? t('login.submitting') : t('login.submit_button')}
          </Button>

          {error && (
            <div className={styles.errorBox} role="alert">
              {error}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
