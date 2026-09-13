/**
 * Stallion-X 外壳重构的回归测试。
 *
 * 外壳组件会引入样式表，无法在 bun 中直接渲染，因此这里覆盖两类内容：
 * 1. 可独立测试的纯逻辑：动效策略、页面搜索快捷键；
 * 2. 源码契约：外壳不再挂载页面切换动画、不再引入上游 layout.scss、四种语言都有外壳新增文案。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { prefersReducedMotion } from '@/hooks/motion';
import { LANGUAGE_ORDER } from '@/utils/constants';
import { isSupportedLanguage } from '@/utils/language';
import { getNavSearchShortcutLabel, isNavSearchShortcut } from '@/utils/sidebarShortcut';

const root = resolve(import.meta.dir, '..');
const readSource = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('动效策略', () => {
  test('全局固定为减弱动效，JS 入场与数字滚动全部降级', () => {
    expect(prefersReducedMotion()).toBe(true);
  });

  test('外壳直接渲染路由，不再挂载 PageTransition', () => {
    const layout = readSource('src/components/layout/MainLayout.tsx');
    expect(layout).not.toMatch(/import\s+\{[^}]*PageTransition[^}]*\}/);
    expect(layout).not.toContain('<PageTransition');
    expect(layout).toContain('<MainRoutes />');
  });

  test('全局样式不再引入上游 layout.scss，由 stallion-x/shell 接管外壳', () => {
    const globalScss = readSource('src/styles/global.scss');
    expect(globalScss).not.toMatch(/@use\s+'\.\/layout\.scss'/);
    expect(readSource('src/styles/stallion-x.scss')).toContain("@use './stallion-x/shell'");
  });
});

describe('页面搜索快捷键', () => {
  test('⌘K 与 Ctrl+K 均可触发，大小写不敏感', () => {
    expect(isNavSearchShortcut({ key: 'k', metaKey: true, ctrlKey: false })).toBe(true);
    expect(isNavSearchShortcut({ key: 'K', metaKey: false, ctrlKey: true })).toBe(true);
  });

  test('缺少修饰键或按键不是 K 时不触发', () => {
    expect(isNavSearchShortcut({ key: 'k', metaKey: false, ctrlKey: false })).toBe(false);
    expect(isNavSearchShortcut({ key: 'b', metaKey: true, ctrlKey: false })).toBe(false);
  });

  test('按平台返回展示文案', () => {
    expect(getNavSearchShortcutLabel(true)).toBe('⌘K');
    expect(getNavSearchShortcutLabel(false)).toBe('Ctrl K');
  });
});

describe('界面语言', () => {
  test('只提供简体中文与英文两种可选语言', () => {
    expect([...LANGUAGE_ORDER]).toEqual(['zh-CN', 'en']);
  });

  test('繁体中文与俄文不再是可选语言，已保存的值会被回落', () => {
    expect(isSupportedLanguage('zh-CN')).toBe(true);
    expect(isSupportedLanguage('en')).toBe(true);
    expect(isSupportedLanguage('zh-TW')).toBe(false);
    expect(isSupportedLanguage('ru')).toBe(false);
  });
});

describe('外壳文案', () => {
  const requiredKeys = [
    'header.search_placeholder',
    'header.search_title',
    'header.search_empty',
    'header.search_group_pages',
    'sidebar.skip_to_content',
    'sidebar.ui_version',
    'sidebar.server_version',
    'nav_group_hints.gateway',
    'nav_group_hints.observe',
    'nav_group_hints.control',
  ];

  for (const locale of ['zh-CN', 'en', 'zh-TW', 'ru']) {
    test(`${locale} 包含外壳新增的全部文案`, () => {
      const messages = JSON.parse(readSource(`src/i18n/locales/${locale}.json`));
      for (const key of requiredKeys) {
        const value = key
          .split('.')
          .reduce<unknown>(
            (node, segment) => (node as Record<string, unknown> | undefined)?.[segment],
            messages
          );
        expect(typeof value, `${locale}:${key}`).toBe('string');
      }
    });
  }
});
