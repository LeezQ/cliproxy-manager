import { describe, expect, test } from 'bun:test';
import { parseLogLine } from '../src/pages/hooks/logParsing';
import {
  buildLogRequestRows,
  describeAuthFile,
  servingAttempt,
  summarizeUpstreamError,
} from '../src/pages/hooks/logRequestTable';

// 与 CPA main.log 的真实格式一致（账号与 IP 换成示例值）
const A = 'codex-84a1f226-a@example.com-pro.json';
const B = 'codex-a865c0f3-b@example.org-plus.json';
const failoverLines = [
  `[2026-09-26 16:35:56] [d352b3d4] [info ] [selector.go:1202] session-affinity: LCP cache miss, new binding | session=lcp:v1:3... auth=${A} provider=mixed model=gpt-5.6-sol`,
  `[2026-09-26 16:36:16] [d352b3d4] [warn ] [conductor_execution.go:1946] 502 |        20.87s | upstream execution failed: provider=codex model=gpt-5.6-sol auth=provider=codex auth_file=${A} err={"error":{"type":"service_unavailable_error","code":"server_is_overloaded","message":"Our servers are currently overloaded."}}`,
  `[2026-09-26 16:36:16] [d352b3d4] [info ] [selector.go:1202] session-affinity: LCP cache miss, new binding | session=lcp:v1:3... auth=${B} provider=mixed model=gpt-5.6-sol`,
  `[2026-09-26 16:36:33] [d352b3d4] [info ] [gin_logger.go:103] 200 |       37.237s |  203.0.113.45 | POST    "/v1/chat/completions"`,
];

describe('log request table', () => {
  test('merges lines of one request and records the failover chain', () => {
    const rows = buildLogRequestRows(failoverLines.map(parseLogLine));
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.requestId).toBe('d352b3d4');
    expect(row.statusCode).toBe(200);
    expect(row.latency).toBe('37.237s');
    expect(row.ip).toBe('203.0.113.45');
    expect(row.method).toBe('POST');
    expect(row.path).toBe('/v1/chat/completions');
    expect(row.model).toBe('gpt-5.6-sol');
    expect(row.level).toBe('warn');
    expect(row.attempts.map((a) => a.account)).toEqual(['a@example.com', 'b@example.org']);
    expect(row.attempts[0].failed?.code).toBe('server_is_overloaded');
    expect(row.attempts[0].failed?.status).toBe(502);
    expect(row.attempts[0].affinity).toBe('new');
    expect(servingAttempt(row)?.account).toBe('b@example.org');
  });

  test('keeps interleaved requests apart and marks affinity hits', () => {
    const lines = [
      `[2026-09-26 16:36:13] [11befa5d] [info ] [selector.go:1168] session-affinity: LCP cache hit | session=lcp:v1:5... prefix=2 auth=${A} provider=mixed model=gpt-5.6-sol`,
      failoverLines[0],
      `[2026-09-26 16:36:14] [11befa5d] [info ] [gin_logger.go:103] 200 |       1.2s |  203.0.113.45 | POST    "/v1/responses"`,
    ].map(parseLogLine);
    const rows = buildLogRequestRows(lines);
    expect(rows.map((r) => r.requestId)).toEqual(['11befa5d', 'd352b3d4']);
    expect(rows[0].attempts[0].affinity).toBe('hit');
    // 还没有最终响应的请求：状态码为空
    expect(rows[1].statusCode).toBeUndefined();
  });

  test('gin lines without a request id become standalone rows; other lines are dropped', () => {
    const lines = [
      `[2026-09-26 16:36:11] [--------] [info ] [gin_logger.go:103] 200 |          69ms |   127.0.0.1 | GET     "/v0/management/auth-files"`,
      `[2026-09-26 16:36:12] [--------] [info ] [model_updater.go:138] models updated`,
    ].map(parseLogLine);
    const rows = buildLogRequestRows(lines);
    expect(rows).toHaveLength(1);
    expect(rows[0].requestId).toBeUndefined();
    expect(rows[0].path).toBe('/v0/management/auth-files');
  });

  test('all attempts failed: no serving account', () => {
    const rows = buildLogRequestRows(failoverLines.slice(0, 2).map(parseLogLine));
    expect(servingAttempt(rows[0])).toBeUndefined();
  });
});

describe('helpers', () => {
  test('describeAuthFile strips provider, hash and plan', () => {
    expect(describeAuthFile(A)).toEqual({ account: 'a@example.com', plan: 'pro' });
    expect(describeAuthFile('gemini-user.json')).toEqual({ account: 'gemini-user', plan: '' });
  });

  test('summarizeUpstreamError handles JSON and network errors', () => {
    expect(summarizeUpstreamError('err={"detail":"Unable to verify access."}')).toEqual({
      code: 'upstream_error',
      message: 'Unable to verify access.',
    });
    expect(
      summarizeUpstreamError(
        'duration=3ms err=Post "https://chatgpt.com/backend-api/codex/responses": utls: dial upstream: socks connect tcp'
      ).code
    ).toBe('network_error');
  });
});
