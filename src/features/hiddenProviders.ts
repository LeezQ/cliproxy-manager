/**
 * Stallion-X 不对外展示的上游提供商。
 *
 * 与裁剪页面的做法一致：上游的类型、接口、配额逻辑与登录流程原样保留，
 * 合并上游时不产生冲突；只在界面入口处按本文件过滤，用户看不到对应的
 * 登录卡片、配额 tab 与配置项。需要恢复某个提供商时，把它的 id 从
 * HIDDEN_PROVIDER_IDS 里删掉即可，无需改动其他代码。
 *
 * 当前过滤的入口：
 * - `src/pages/OAuthPage.tsx`：OAuth 登录卡片
 * - `src/features/quota/constants.ts`：配额页的提供商 tab
 * - `src/features/config/components/sections/SectionAdvanced.tsx`：配置面板中的专属配置块
 */
export const HIDDEN_PROVIDER_IDS: ReadonlySet<string> = new Set(['devin']);

/** 判断某个提供商是否在本 fork 中隐藏 */
export const isHiddenProvider = (providerId: string): boolean =>
  HIDDEN_PROVIDER_IDS.has(providerId);
