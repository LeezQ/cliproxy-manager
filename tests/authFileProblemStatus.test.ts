import { describe, expect, test } from 'bun:test';
import {
  hasAuthFileStatusWarning,
  isProblemAuthFile,
  isStaleAuthFileError,
} from '../src/features/authFiles/constants';
import type { AuthFileItem } from '../src/types';

const authFile = (overrides: Partial<AuthFileItem> = {}): AuthFileItem => ({
  name: 'credential.json',
  type: 'codex',
  ...overrides,
});

describe('auth file problem status', () => {
  test('does not classify a deliberately disabled credential as a problem', () => {
    expect(
      isProblemAuthFile(
        authFile({
          disabled: true,
          status: 'disabled',
          statusMessage: 'disabled via management API',
        })
      )
    ).toBe(false);
  });

  test('also respects the backend disabled status when the boolean is absent', () => {
    expect(
      isProblemAuthFile(
        authFile({
          status: ' DISABLED ',
          statusMessage: 'disabled via management API',
        })
      )
    ).toBe(false);
  });

  test('ignores healthy status messages', () => {
    expect(isProblemAuthFile(authFile({ status: 'active', statusMessage: 'ok' }))).toBe(false);
  });

  test('detects warning messages, unavailable credentials, and error status', () => {
    expect(isProblemAuthFile(authFile({ statusMessage: 'quota exhausted' }))).toBe(true);
    expect(isProblemAuthFile(authFile({ unavailable: true }))).toBe(true);
    expect(isProblemAuthFile(authFile({ status: 'error' }))).toBe(true);
  });
});

/** 构造 recent_requests：按时间从旧到新，每桶 10 分钟。 */
const buckets = (...pairs: Array<[number, number]>) =>
  pairs.map(([success, failed]) => ({ success, failed }));

const OVERLOADED =
  '{"error":{"type":"service_unavailable_error","code":"server_is_overloaded"}}';

describe('stale auth file errors', () => {
  // 真实案例：冷门模型撞过一次过载，账号 status 停在 error，但主力模型持续成功
  const staleCredential = authFile({
    status: 'error',
    statusMessage: OVERLOADED,
    unavailable: false,
    recent_requests: buckets([0, 0], [5, 1], [4, 0], [6, 0]),
  });

  test('treats a lingering error on a still-working credential as stale', () => {
    expect(isStaleAuthFileError(staleCredential)).toBe(true);
    expect(hasAuthFileStatusWarning(staleCredential)).toBe(false);
    expect(isProblemAuthFile(staleCredential)).toBe(false);
  });

  test('keeps hard failures as problems even with recent successes', () => {
    const invalidated = { ...staleCredential, unavailable: true };
    expect(isStaleAuthFileError(invalidated)).toBe(false);
    expect(hasAuthFileStatusWarning(invalidated)).toBe(true);
    expect(isProblemAuthFile(invalidated)).toBe(true);
  });

  test('only counts successes within the last 30 minutes', () => {
    // 成功全落在更早的分桶，最近 3 桶只有失败
    const failingNow = authFile({
      status: 'error',
      statusMessage: OVERLOADED,
      recent_requests: buckets([8, 0], [3, 0], [0, 2], [0, 1], [0, 3]),
    });
    expect(isStaleAuthFileError(failingNow)).toBe(false);
    expect(isProblemAuthFile(failingNow)).toBe(true);
  });

  test('stays conservative when there is no recent traffic at all', () => {
    const idle = authFile({ status: 'error', statusMessage: OVERLOADED });
    expect(isStaleAuthFileError(idle)).toBe(false);
    expect(isProblemAuthFile(idle)).toBe(true);
  });

  test('accepts the camelCase recentRequests field as well', () => {
    const camel = authFile({
      status: 'error',
      statusMessage: OVERLOADED,
      recentRequests: buckets([2, 0]),
    });
    expect(isStaleAuthFileError(camel)).toBe(true);
  });

  test('never marks a healthy credential as stale', () => {
    const healthy = authFile({ status: 'active', recent_requests: buckets([3, 0]) });
    expect(isStaleAuthFileError(healthy)).toBe(false);
    expect(isProblemAuthFile(healthy)).toBe(false);
  });
});
