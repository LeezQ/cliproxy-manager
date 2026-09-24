/**
 * 为当前页的凭证批量读取出口信息（列表视图的「出口」列）。
 *
 * - 只处理传入的这一页，限制并发，避免一次性下载大量凭证文件；
 * - 结果按「文件名 + 修改时间 + 大小」缓存在模块级，切换页面 / 布局不重复下载，
 *   文件被改写（如在设置里改了代理）后键变化，自动重新读取；
 * - 缓存里只存摘要（出口 IP、网关、协议），不存凭证文本。
 */

import { useEffect, useMemo, useState } from 'react';
import { authFilesApi } from '@/services/api';
import type { AuthFileItem } from '@/types';
import { isRuntimeOnlyAuthFile } from '@/features/authFiles/constants';
import {
  authFileProxyCacheKey,
  readProxySummaryFromCredential,
  type ProxySummary,
} from '@/features/authFiles/proxyInfo';

type CredentialProxy = { configured: boolean; summary: ProxySummary | null } | 'error';

/** 同时下载的凭证文件数上限。 */
const MAX_CONCURRENT_DOWNLOADS = 4;

const cache = new Map<string, CredentialProxy>();
const inFlight = new Map<string, Promise<void>>();

const loadOne = (file: AuthFileItem, key: string): Promise<void> => {
  const pending = inFlight.get(key);
  if (pending) return pending;
  const task = authFilesApi
    .downloadText(file.name)
    .then((text) => {
      cache.set(key, readProxySummaryFromCredential(text));
    })
    .catch((err: unknown) => {
      // 下载失败只影响这一格的展示，记录后标为未知，不打断页面
      console.warn('[authFiles] 读取凭证出口失败:', file.name, err);
      cache.set(key, 'error');
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, task);
  return task;
};

/**
 * 返回 key → 凭证代理信息；尚未读完的键不在结果里（调用方显示加载态）。
 * enabled 为 false 时不发任何请求。
 */
export function useAuthFileProxies(
  files: AuthFileItem[],
  enabled: boolean
): Map<string, CredentialProxy> {
  const [version, setVersion] = useState(0);

  const targets = useMemo(
    () =>
      enabled
        ? files
            .filter((file) => !isRuntimeOnlyAuthFile(file))
            .map((file) => ({ file, key: authFileProxyCacheKey(file) }))
        : [],
    [enabled, files]
  );

  useEffect(() => {
    const missing = targets.filter(({ key }) => !cache.has(key));
    if (missing.length === 0) return;
    let cancelled = false;

    // 简单的并发池：同一时刻最多 MAX_CONCURRENT_DOWNLOADS 个下载在跑
    const queue = [...missing];
    const worker = async () => {
      while (queue.length > 0 && !cancelled) {
        const next = queue.shift();
        if (!next) return;
        await loadOne(next.file, next.key);
        if (!cancelled) setVersion((v) => v + 1);
      }
    };
    void Promise.all(
      Array.from({ length: Math.min(MAX_CONCURRENT_DOWNLOADS, queue.length) }, worker)
    );

    return () => {
      cancelled = true;
    };
  }, [targets]);

  return useMemo(() => {
    // version 变化代表模块缓存里新增了结果，需要重新汇总
    void version;
    const result = new Map<string, CredentialProxy>();
    for (const { key } of targets) {
      const value = cache.get(key);
      if (value !== undefined) result.set(key, value);
    }
    return result;
  }, [targets, version]);
}
