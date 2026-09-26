/**
 * 把逐行日志按请求 ID 合并成「一行一个请求」，给日志页的表格视图用。
 *
 * CPA 的一个请求会写出好几行，靠第二个方括号里的 8 位请求 ID 关联：
 *   selector.go            选中了哪个凭证（auth=<凭证文件>，含会话亲和命中 / 新建）
 *   conductor_execution.go 上游失败（auth_file=<凭证文件> err=...），随后换下一个凭证重试
 *   gin_logger.go          最终响应：状态码 | 耗时 | 客户端 IP | 方法 "路径"
 * 逐行看时很难回答「这个请求最后是哪个账号处理的、中间失败了几次」，合并后一目了然。
 *
 * 没有请求 ID 的 gin 行（如本机管理调用，ID 为 --------）各自成一行；其余无 ID 的行
 * （启动信息、定时任务）不进表格，只在「日志行」视图里看。
 */

import type { HttpMethod, ParsedLogLine } from '@/pages/hooks/logTypes';

/** 一次选号及其结果。 */
export type LogRequestAttempt = {
  /** 凭证文件名，如 codex-84a1f226-a@example.com-pro.json */
  authFile: string;
  /** 从文件名里取出的账号（通常是邮箱）；取不到时为文件名 */
  account: string;
  /** 从文件名后缀取出的套餐（pro / plus …），没有则为空 */
  plan: string;
  model?: string;
  /** 会话亲和：hit 复用了之前的账号，new 新绑定，fork 分叉会话沿用父会话账号 */
  affinity?: 'hit' | 'new' | 'fork';
  /** 这次尝试失败了：上游状态码与错误码 */
  failed?: { status?: number; latency?: string; code: string; message: string };
};

export type LogRequestRow = {
  /** 请求 ID；无 ID 的独立行用 line-<序号> */
  id: string;
  /** 真实的 8 位请求 ID，可用于下载该请求的详细日志；无 ID 为 undefined */
  requestId?: string;
  /** 第一行的时间（请求开始） */
  startedAt?: string;
  /** 最终响应；请求还在进行时没有 */
  statusCode?: number;
  latency?: string;
  ip?: string;
  method?: HttpMethod;
  path?: string;
  model?: string;
  /** 按时间顺序的每次选号；最后一个没有 failed 的就是最终处理请求的账号 */
  attempts: LogRequestAttempt[];
  /** 最高日志级别，用于整行着色 */
  level: 'info' | 'warn' | 'error';
  /** 合并前的原始行，展开详情与搜索用 */
  lines: ParsedLogLine[];
};

const NO_REQUEST_ID = '--------';

const AUTH_FILE_REGEX = /\bauth_file=(\S+?\.json)\b/;
const AUTH_REGEX = /\bauth=(\S+?\.json)\b/;
const MODEL_REGEX = /\bmodel=([^\s|]+)/;
const ERROR_CODE_REGEX = /"code"\s*:\s*"([^"]+)"/;
const ERROR_TYPE_REGEX = /"type"\s*:\s*"([^"]+)"/;
const ERROR_MESSAGE_REGEX = /"message"\s*:\s*"([^"]*)/;
const ERROR_DETAIL_REGEX = /"detail"\s*:\s*"([^"]*)/;

/** 凭证文件名 → 账号与套餐：<provider>-<8 位 hex>-<账号>-<套餐>.json，各段都可能缺。 */
export const describeAuthFile = (file: string): { account: string; plan: string } => {
  let base = file.replace(/\.json$/i, '');
  base = base.replace(/^[a-z0-9]+-[0-9a-f]{8}-/i, '');
  const planMatch = base.match(/-(pro|plus|team|business|free|enterprise|max|ultra)$/i);
  const plan = planMatch ? planMatch[1].toLowerCase() : '';
  if (planMatch) base = base.slice(0, -planMatch[0].length);
  return { account: base || file, plan };
};

/** 上游错误里最有用的一小段：错误码 + 说明。非 JSON 的网络错误取 err= 之后的开头。 */
export const summarizeUpstreamError = (text: string): { code: string; message: string } => {
  const errIndex = text.indexOf('err=');
  const errText = errIndex >= 0 ? text.slice(errIndex + 4) : text;
  const code = errText.match(ERROR_CODE_REGEX)?.[1] ?? errText.match(ERROR_TYPE_REGEX)?.[1];
  const message =
    errText.match(ERROR_MESSAGE_REGEX)?.[1] ?? errText.match(ERROR_DETAIL_REGEX)?.[1] ?? '';
  if (code) return { code, message };
  // 只有 detail 的 JSON（如 {"detail":"Unable to verify ..."}）：没有错误码，但说明可用
  if (message) return { code: 'upstream_error', message };
  // 网络层错误（如代理拨号失败）没有 JSON，取最后一个冒号后的原因作错误码
  const plain = errText.trim();
  if (/dial|connect|timeout|EOF|reset|refused/i.test(plain)) {
    return { code: 'network_error', message: plain.slice(0, 240) };
  }
  return { code: 'upstream_error', message: plain.slice(0, 240) };
};

const isSelectorLine = (line: ParsedLogLine) => (line.source ?? '').startsWith('selector.go');
const isGinLine = (line: ParsedLogLine) => (line.source ?? '').startsWith('gin_logger.go');
const isUpstreamFailure = (line: ParsedLogLine) => line.raw.includes('upstream execution failed');

const affinityOf = (text: string): LogRequestAttempt['affinity'] => {
  if (/fork/i.test(text)) return 'fork';
  if (/cache hit/i.test(text)) return 'hit';
  if (/new binding|bound to new auth/i.test(text)) return 'new';
  return undefined;
};

const levelRank = { info: 0, warn: 1, error: 2 } as const;

/** 解析器保留了 gin 日志里路径两侧的引号（"/v1/responses"），表格里去掉。 */
const cleanPath = (path?: string): string | undefined => path?.replace(/^"(.*)"$/, '$1');

const toRowLevel = (level: ParsedLogLine['level']): LogRequestRow['level'] =>
  level === 'error' || level === 'fatal' ? 'error' : level === 'warn' ? 'warn' : 'info';

/**
 * 合并。输入按时间顺序（日志文件本身的顺序），输出按请求首次出现的顺序。
 */
export const buildLogRequestRows = (lines: ParsedLogLine[]): LogRequestRow[] => {
  const rows: LogRequestRow[] = [];
  const byId = new Map<string, LogRequestRow>();

  lines.forEach((line, index) => {
    const requestId =
      line.requestId && line.requestId !== NO_REQUEST_ID ? line.requestId : undefined;

    if (!requestId) {
      // 无 ID：只有 gin 行（一个完整的请求）单独成行
      if (!isGinLine(line)) return;
      rows.push({
        id: `line-${index}`,
        startedAt: line.timestamp,
        statusCode: line.statusCode,
        latency: line.latency,
        ip: line.ip,
        method: line.method,
        path: cleanPath(line.path),
        attempts: [],
        level: toRowLevel(line.level),
        lines: [line],
      });
      return;
    }

    let row = byId.get(requestId);
    if (!row) {
      row = {
        id: requestId,
        requestId,
        startedAt: line.timestamp,
        attempts: [],
        level: 'info',
        lines: [],
      };
      byId.set(requestId, row);
      rows.push(row);
    }
    row.lines.push(line);
    const lineLevel = toRowLevel(line.level);
    if (levelRank[lineLevel] > levelRank[row.level]) row.level = lineLevel;

    const text = line.raw;
    const model = text.match(MODEL_REGEX)?.[1];
    if (model && !row.model) row.model = model;

    if (isGinLine(line)) {
      row.statusCode = line.statusCode;
      row.latency = line.latency;
      row.ip = line.ip;
      row.method = line.method;
      row.path = cleanPath(line.path);
      return;
    }

    if (isSelectorLine(line)) {
      const authFile = text.match(AUTH_REGEX)?.[1];
      if (!authFile) return;
      row.attempts.push({
        authFile,
        ...describeAuthFile(authFile),
        model,
        affinity: affinityOf(text),
      });
      return;
    }

    if (isUpstreamFailure(line)) {
      const authFile = text.match(AUTH_FILE_REGEX)?.[1] ?? text.match(AUTH_REGEX)?.[1];
      const failure = {
        status: line.statusCode,
        latency: line.latency,
        ...summarizeUpstreamError(text),
      };
      // 失败记到最近一次选中同一凭证、且还没有结果的尝试上；找不到就补一条
      const target = [...row.attempts].reverse().find((a) => a.authFile === authFile && !a.failed);
      if (target) {
        target.failed = failure;
      } else if (authFile) {
        row.attempts.push({ authFile, ...describeAuthFile(authFile), model, failed: failure });
      }
    }
  });

  return rows;
};

/** 最终处理请求的尝试：最后一个没有失败记录的；全失败时返回 undefined。 */
export const servingAttempt = (row: LogRequestRow): LogRequestAttempt | undefined =>
  [...row.attempts].reverse().find((a) => !a.failed);
