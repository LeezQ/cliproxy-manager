import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { IconSearch } from '@/components/ui/icons';

/** 可被搜索的导航项 */
export interface NavSearchItem {
  /** 路由路径，同时作为唯一键 */
  path: string;
  /** 页面名称 */
  title: string;
  /** 页面用途说明，同时参与匹配 */
  description: string;
  /** 额外检索词（如英文名、旧称），不展示 */
  keywords?: string;
  icon: ReactNode;
}

interface NavSearchDialogProps {
  open: boolean;
  items: NavSearchItem[];
  onClose: () => void;
  onSelect: (item: NavSearchItem) => void;
}

/**
 * 顶栏「搜索页面或功能」面板。
 *
 * 纯本地过滤，不发请求；输入框聚焦时方向键移动选中项、Enter 打开、Escape 关闭。
 * 面板直接出现、直接消失，不做入场动画。
 * 组件只在 open 为 true 时挂载（由父组件控制），因此每次打开都从空查询开始。
 */
export function NavSearchDialog({ open, items, onClose, onSelect }: NavSearchDialogProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  /** 打开时记录原焦点并聚焦输入框，关闭时把焦点还给触发按钮 */
  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => {
      previouslyFocusedRef.current?.focus?.();
    };
  }, [open]);

  /** 按名称、说明与检索词做不区分大小写的包含匹配 */
  const results = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    if (!term) return items;
    return items.filter((item) =>
      `${item.title} ${item.description} ${item.keywords ?? ''} ${item.path}`
        .toLocaleLowerCase()
        .includes(term)
    );
  }, [items, query]);

  if (!open || typeof document === 'undefined') return null;

  // 结果变少时选中项不越界
  const activeIndex = Math.min(selectedIndex, Math.max(results.length - 1, 0));

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedIndex(results.length ? (activeIndex + 1) % results.length : 0);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedIndex(results.length ? (activeIndex - 1 + results.length) % results.length : 0);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const target = results[activeIndex];
      if (target) onSelect(target);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  return createPortal(
    <div
      className="nav-search-overlay"
      onMouseDown={(event) => {
        // 只有点击遮罩本身才关闭，点击面板内部不关闭
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="nav-search-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t('header.search_title')}
      >
        <div className="nav-search-input-row">
          <IconSearch size={18} aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            placeholder={t('header.search_placeholder')}
            aria-label={t('header.search_placeholder')}
            aria-controls="nav-search-results"
            aria-activedescendant={
              results[activeIndex] ? `nav-search-${results[activeIndex].path}` : undefined
            }
            onChange={(event) => {
              setQuery(event.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
          />
          <span className="kbd">Esc</span>
        </div>

        <div className="nav-search-results" id="nav-search-results" role="listbox">
          {results.length === 0 ? (
            <div className="nav-search-empty">{t('header.search_empty')}</div>
          ) : (
            <>
              <div className="nav-search-group-title">{t('header.search_group_pages')}</div>
              {results.map((item, index) => (
                <button
                  key={item.path}
                  id={`nav-search-${item.path}`}
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  className={`nav-search-item ${index === activeIndex ? 'selected' : ''}`}
                  onMouseMove={() => setSelectedIndex(index)}
                  onClick={() => onSelect(item)}
                >
                  <span className="nav-search-item-icon" aria-hidden="true">
                    {item.icon}
                  </span>
                  <span className="nav-search-item-text">
                    <span className="nav-search-item-title">{item.title}</span>
                    <span className="nav-search-item-desc">{item.description}</span>
                  </span>
                </button>
              ))}
            </>
          )}
        </div>

        <div className="nav-search-footer" aria-hidden="true">
          <span>
            <span className="kbd">↑↓</span>
            {t('header.search_hint_select')}
          </span>
          <span>
            <span className="kbd">Enter</span>
            {t('header.search_hint_navigate')}
          </span>
          <span>
            <span className="kbd">Esc</span>
            {t('header.search_hint_close')}
          </span>
        </div>
      </div>
    </div>,
    document.body
  );
}
