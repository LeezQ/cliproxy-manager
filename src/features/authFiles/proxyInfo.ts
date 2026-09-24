/**
 * 凭证出口（代理）的展示信息。
 *
 * 管理接口的列表（GET /auth-files）不返回 proxy_url，只能下载凭证文件本身读取——
 * 与「设置」弹窗同一条路径。凭证文件里有 access / refresh token，所以这里的原则是：
 * 解析完立刻只留下「出口 IP、网关地址、协议」三样，代理账号密码和文件其余内容一概不保留。
 */

import type { AuthFileItem } from '@/types';

/** 可安全展示的代理摘要：不含任何认证信息。 */
export type ProxySummary = {
  /** 实际出网 IP / 主机。Decodo 这类「用户名锁定出口」的写法取用户名里的 IP。 */
  exit: string;
  /** 客户端连接的网关 host:port，用来区分供应商（如 isp.decodo.com:10001）。 */
  gateway: string;
  /** socks5h / socks5 / http / https */
  scheme: string;
};

export type AuthFileProxyInfo =
  /** 凭证自身配置了代理 */
  | ({ kind: 'proxy' } & ProxySummary)
  /** 凭证未配置，走 config.yaml 里的全局 proxy-url */
  | ({ kind: 'global' } & ProxySummary)
  /** 两处都没配：用服务器自身 IP 直连上游 */
  | { kind: 'direct' }
  /** 读取失败或凭证无法下载（如运行时虚拟凭证），不下结论 */
  | { kind: 'unknown' };

/** 用户名里锁定出口的写法：user-<账号>-ip-<出口IP> */
const PINNED_EXIT_PATTERN = /-ip-([0-9a-fA-F:.]+)$/;

/** URL 里的用户名是百分号编码的；编码不合法时按原样使用。 */
const decodeUsername = (raw: string): string => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

/**
 * 把代理地址压缩成可展示的摘要；无法解析返回 null。
 * 注意：返回值刻意不包含 username / password。
 */
export const summarizeProxyUrl = (raw: unknown): ProxySummary | null => {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const scheme = url.protocol.replace(/:$/, '').toLowerCase();
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!scheme || !host) return null;

  const pinned = PINNED_EXIT_PATTERN.exec(decodeUsername(url.username));

  return {
    exit: pinned ? pinned[1] : host,
    gateway: url.port ? `${host}:${url.port}` : host,
    scheme,
  };
};

/**
 * 从下载到的凭证文件文本里只取出 proxy_url 的摘要。
 * 文本本身（含令牌）不应被调用方保存，这里也不返回它的任何其余部分。
 */
export const readProxySummaryFromCredential = (
  rawText: string
): { configured: boolean; summary: ProxySummary | null } => {
  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch {
    return { configured: false, summary: null };
  }
  const value =
    json && typeof json === 'object' ? (json as Record<string, unknown>).proxy_url : undefined;
  const configured = typeof value === 'string' && value.trim() !== '';
  return { configured, summary: configured ? summarizeProxyUrl(value) : null };
};

/**
 * 结合凭证自身与全局配置，得出实际出口。
 * 凭证 proxy_url 优先于全局 proxy-url（与 CLIProxyAPI 的取值顺序一致）。
 */
export const resolveAuthFileProxy = (
  credential: { configured: boolean; summary: ProxySummary | null },
  globalProxyUrl: unknown
): AuthFileProxyInfo => {
  if (credential.configured) {
    return credential.summary ? { kind: 'proxy', ...credential.summary } : { kind: 'unknown' };
  }
  const global = summarizeProxyUrl(globalProxyUrl);
  return global ? { kind: 'global', ...global } : { kind: 'direct' };
};

/**
 * 缓存键：文件名 + 修改时间 + 大小。
 * 在「设置」里改代理会重写文件、改变修改时间，缓存随之失效。
 */
export const authFileProxyCacheKey = (file: AuthFileItem): string =>
  `${file.name}|${file.modified ?? ''}|${file.size ?? ''}`;
