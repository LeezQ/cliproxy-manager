import type { Language } from '@/types';
import { STORAGE_KEY_LANGUAGE, SUPPORTED_LANGUAGES } from '@/utils/constants';

/** 判断是否为界面可选语言（仅简体中文与英文） */
export const isSupportedLanguage = (value: string): value is Language =>
  (SUPPORTED_LANGUAGES as readonly string[]).includes(value);

const parseStoredLanguage = (value: string): Language | null => {
  try {
    const parsed = JSON.parse(value);
    const candidate = parsed?.state?.language ?? parsed?.language ?? parsed;
    if (typeof candidate === 'string' && isSupportedLanguage(candidate)) {
      return candidate;
    }
  } catch {
    if (isSupportedLanguage(value)) {
      return value;
    }
  }
  return null;
};

const getStoredLanguage = (): Language | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const stored = localStorage.getItem(STORAGE_KEY_LANGUAGE);
    if (!stored) {
      return null;
    }
    return parseStoredLanguage(stored);
  } catch {
    return null;
  }
};

/**
 * 按浏览器语言选择初始语言：任何中文（含繁体地区）使用简体中文，其余一律英文。
 * Stallion-X 只提供中英文两种界面语言。
 */
const getBrowserLanguage = (): Language => {
  if (typeof navigator === 'undefined') {
    return 'zh-CN';
  }
  const raw = navigator.languages?.[0] || navigator.language || 'zh-CN';
  return raw.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
};

export const getInitialLanguage = (): Language => getStoredLanguage() ?? getBrowserLanguage();
