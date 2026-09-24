/**
 * 页面布局取值：卡片网格或一行一项的列表。认证文件页与配额页共用。
 * 单独成文件，是因为组件文件同时导出常量会破坏 React Fast Refresh。
 */
export type LayoutMode = 'card' | 'list';

export const LAYOUT_MODES: readonly LayoutMode[] = ['card', 'list'];

export const isLayoutMode = (value: unknown): value is LayoutMode =>
  value === 'card' || value === 'list';
