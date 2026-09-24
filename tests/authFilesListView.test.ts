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
