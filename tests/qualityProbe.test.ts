import { describe, expect, test } from 'bun:test';
import {
  normalizeQualityRecord,
  normalizeQualitySummary,
  normalizeQualityVerdict,
} from '../src/services/api/qualityProbe';
import {
  buildQualityIndex,
  findQualityAccount,
  formatQualityElapsed,
  isDegradedReasoningMark,
} from '../src/features/qualityProbe/logic';

// 字段形状与服务器上 cpa-account 写入 quality.jsonl / 返回 /summary 的一致（snake_case、中文结论）
const rawRecord = {
  ts: '2026-09-26T00:14:50+08:00',
  email: 'a@example.com',
  name: 'codex-1111-a@example.com-pro.json',
  plan: 'pro',
  exit: '203.0.113.10',
  model: 'gpt-5.6-sol',
  effort: 'high',
  verdict: '降智',
  answer: 29,
  reasoning_tokens: 516,
  output_tokens: 820,
  elapsed: 41.2,
  error: '',
  answer_tail: '\\boxed{29}',
};

describe('quality probe normalize', () => {
  test('maps the Chinese verdicts written by the CLI', () => {
    expect(normalizeQualityVerdict('正常')).toBe('pass');
    expect(normalizeQualityVerdict('降智')).toBe('degraded');
    expect(normalizeQualityVerdict('失败')).toBe('failed');
    // 未知值不当成「正常」，按没测成处理
    expect(normalizeQualityVerdict('whatever')).toBe('failed');
  });

  test('converts a record to camelCase and keeps fractional elapsed', () => {
    const record = normalizeQualityRecord(rawRecord);
    expect(record).not.toBeNull();
    expect(record?.verdict).toBe('degraded');
    expect(record?.reasoningTokens).toBe(516);
    expect(record?.elapsed).toBe(41.2);
    expect(record?.answerTail).toBe('\\boxed{29}');
  });

  test('drops records without a timestamp and tolerates wrong types', () => {
    expect(normalizeQualityRecord({ ...rawRecord, ts: '' })).toBeNull();
    const record = normalizeQualityRecord({ ...rawRecord, answer: '29', reasoning_tokens: null });
    expect(record?.answer).toBeNull();
    expect(record?.reasoningTokens).toBeNull();
  });

  test('summary falls back to defaults and skips malformed accounts', () => {
    const summary = normalizeQualitySummary({
      days: 7,
      expected_answer: 21,
      model: 'gpt-5.6-sol',
      effort: 'high',
      accounts: [
        {
          email: 'a@example.com',
          name: 'codex-1111-a@example.com-pro.json',
          valid: 2,
          passed: 0,
          rate: 0,
          median_reasoning: 516,
          last: { ...rawRecord, verdict: '失败', answer: null },
          last_valid: rawRecord,
          trend: ['降智', '失败'],
        },
        null,
        { plan: 'plus' },
      ],
      job: { id: 'abc', status: 'running', pending: ['a@example.com'], records: [] },
    });
    expect(summary.accounts).toHaveLength(1);
    expect(summary.accounts[0].trend).toEqual(['degraded', 'failed']);
    expect(summary.accounts[0].last?.verdict).toBe('failed');
    expect(summary.accounts[0].lastValid?.verdict).toBe('degraded');
    expect(summary.degradedReasoningMark).toBe(516);
    expect(summary.job?.status).toBe('running');
    expect(summary.job?.pending).toEqual(['a@example.com']);

    expect(normalizeQualitySummary(null).accounts).toEqual([]);
  });
});

describe('quality probe logic', () => {
  const accounts = normalizeQualitySummary({
    accounts: [
      { email: 'A@Example.com', name: 'codex-old-a.json', valid: 1 },
      { email: 'b@example.com', name: 'codex-b.json', valid: 1 },
    ],
  }).accounts;
  const index = buildQualityIndex(accounts);

  test('matches by email first, case-insensitively', () => {
    // 面板上删掉重加后文件名会变，邮箱不变，仍应匹配到历史记录
    expect(
      findQualityAccount(index, { name: 'codex-new-a.json', email: 'a@example.com' })?.name
    ).toBe('codex-old-a.json');
  });

  test('falls back to the credential file name when email is missing', () => {
    expect(findQualityAccount(index, { name: 'codex-b.json' })?.email).toBe('b@example.com');
    expect(
      findQualityAccount(index, { name: 'codex-x.json', email: 'x@example.com' })
    ).toBeUndefined();
  });

  test('formats elapsed seconds compactly', () => {
    expect(formatQualityElapsed(41.2)).toBe('41s');
    expect(formatQualityElapsed(185)).toBe('3m05s');
    expect(formatQualityElapsed(null)).toBe('—');
  });

  test('only an exact 516 counts as the degradation mark', () => {
    expect(isDegradedReasoningMark(516, 516)).toBe(true);
    expect(isDegradedReasoningMark(1034, 516)).toBe(false);
    expect(isDegradedReasoningMark(null, 516)).toBe(false);
  });
});
