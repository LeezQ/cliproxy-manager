import { describe, expect, test } from 'bun:test';
import {
  deriveAuthFilePlan,
  formatAuthFilePlan,
  groupAuthFilesByProvider,
  isPremiumAuthFilePlan,
} from '../src/features/authFiles/listView';
import { isAuthFilesLayoutMode } from '../src/features/authFiles/uiState';
import type { AuthFileItem } from '../src/types';

const file = (name: string, type = 'codex'): AuthFileItem => ({ name, type });

describe('auth file plan from file name', () => {
  test('reads the plan suffix the backend writes into the file name', () => {
    expect(deriveAuthFilePlan(file('codex-22f3db9e-user@privaterelay.appleid.com-pro.json'))).toBe(
      'pro'
    );
    expect(deriveAuthFilePlan(file('codex-a865c0f3-user@outlook.de-plus.json'))).toBe('plus');
    expect(deriveAuthFilePlan(file('codex-84a1f226-user@mail.com-free.json'))).toBe('free');
  });

  test('is case-insensitive and ignores names without a plan suffix', () => {
    expect(deriveAuthFilePlan(file('codex-x-user@mail.com-PRO.json'))).toBe('pro');
    expect(deriveAuthFilePlan(file('claude-user@mail.com.json'))).toBe('');
    // "pro" must be a suffix segment, not just any substring
    expect(deriveAuthFilePlan(file('codex-product-team.json.bak'))).toBe('');
  });

  test('formats and ranks plans for display', () => {
    expect(formatAuthFilePlan('pro')).toBe('Pro');
    expect(formatAuthFilePlan('')).toBe('');
    expect(isPremiumAuthFilePlan('pro')).toBe(true);
    expect(isPremiumAuthFilePlan('plus')).toBe(false);
    expect(isPremiumAuthFilePlan('free')).toBe(false);
  });
});

describe('grouping auth files by provider', () => {
  test('orders groups by first appearance and keeps the in-group order', () => {
    const files = [
      file('a.json', 'codex'),
      file('b.json', 'claude'),
      file('c.json', 'codex'),
      file('d.json', 'claude'),
    ];
    const groups = groupAuthFilesByProvider(files);
    expect(groups.map((group) => group.provider)).toEqual(['codex', 'claude']);
    expect(groups[0].files.map((f) => f.name)).toEqual(['a.json', 'c.json']);
    expect(groups[1].files.map((f) => f.name)).toEqual(['b.json', 'd.json']);
  });

  test('falls back to the provider field, then to unknown', () => {
    const groups = groupAuthFilesByProvider([
      { name: 'x.json', provider: 'codex' },
      { name: 'y.json' },
    ]);
    expect(groups.map((group) => group.provider)).toEqual(['codex', 'unknown']);
  });

  test('returns no groups for an empty page', () => {
    expect(groupAuthFilesByProvider([])).toEqual([]);
  });
});

describe('layout mode persistence guard', () => {
  test('accepts only the known layouts', () => {
    expect(isAuthFilesLayoutMode('card')).toBe(true);
    expect(isAuthFilesLayoutMode('list')).toBe(true);
    expect(isAuthFilesLayoutMode('table')).toBe(false);
    expect(isAuthFilesLayoutMode(undefined)).toBe(false);
  });
});

describe('quota page list view', () => {
  test('groups quota entries by provider in first-appearance order', async () => {
    const { groupQuotaEntriesByType } = await import('../src/features/quota/logic');
    const groups = groupQuotaEntriesByType([
      { file: file('a.json'), type: 'codex' },
      { file: file('b.json', 'claude'), type: 'claude' },
      { file: file('c.json'), type: 'codex' },
    ]);
    expect(groups.map((group) => group.type)).toEqual(['codex', 'claude']);
    expect(groups[0].entries.map((entry) => entry.file.name)).toEqual(['a.json', 'c.json']);
  });

  test('restores a valid layout from session state and drops unknown values', async () => {
    const { readQuotaUiState, writeQuotaUiState } = await import('../src/features/quota/uiState');
    const store = new Map<string, string>();
    const sessionStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    const previous = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = { sessionStorage };
    try {
      writeQuotaUiState({ layoutMode: 'card' });
      expect(readQuotaUiState()?.layoutMode).toBe('card');
      store.set('quotaPage.uiState', JSON.stringify({ layoutMode: 'table' }));
      expect(readQuotaUiState()?.layoutMode).toBeUndefined();
    } finally {
      (globalThis as { window?: unknown }).window = previous;
    }
  });
});

describe('quota row plan summary', () => {
  const t = ((key: string) => key) as unknown as import('i18next').TFunction;

  test('summarizes a loaded Codex quota into plan, renewal and resets', async () => {
    const { summarizeQuotaPlan } = await import('../src/features/quota/rowSummary');
    const summary = summarizeQuotaPlan(
      'codex',
      {
        status: 'success',
        windows: [],
        planType: 'pro',
        subscriptionActiveUntil: '2026-10-24T05:40:00Z',
        rateLimitResetCreditsAvailableCount: 2,
      } as never,
      t
    );
    expect(summary?.plan).toBe('codex_quota.plan_pro');
    expect(summary?.tier).toBe('elite');
    expect(summary?.renewsAtMs).toBe(Date.parse('2026-10-24T05:40:00Z'));
    expect(summary?.resets).toBe(2);
  });

  test('returns nothing until the quota has loaded, and for other providers', async () => {
    const { summarizeQuotaPlan } = await import('../src/features/quota/rowSummary');
    expect(summarizeQuotaPlan('codex', undefined, t)).toBeNull();
    expect(summarizeQuotaPlan('codex', { status: 'loading', windows: [] } as never, t)).toBeNull();
    expect(summarizeQuotaPlan('claude', { status: 'success' } as never, t)).toBeNull();
  });
});
