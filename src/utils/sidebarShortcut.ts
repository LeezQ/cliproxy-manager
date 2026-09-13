export function isSidebarToggleShortcut(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  target?: EventTarget | null;
}): boolean {
  if (!(event.metaKey || event.ctrlKey) || (event.key !== 'b' && event.key !== 'B')) {
    return false;
  }
  const target = event.target as HTMLElement | null;
  if (
    target &&
    (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
  ) {
    return false;
  }
  return true;
}

export function getSidebarShortcutLabel(isMac: boolean): string {
  return isMac ? '⌘B' : 'Ctrl+B';
}

/**
 * 顶栏页面搜索快捷键：⌘K（macOS）/ Ctrl+K（其他平台）。
 * 与主站一致，输入框聚焦时同样生效，便于在任意位置快速跳转页面。
 */
export function isNavSearchShortcut(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
}): boolean {
  return (event.metaKey || event.ctrlKey) && (event.key === 'k' || event.key === 'K');
}

/** 页面搜索快捷键的展示文案 */
export function getNavSearchShortcutLabel(isMac: boolean): string {
  return isMac ? '⌘K' : 'Ctrl K';
}
