import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Stallion-X 品牌字体：须在全局样式之前引入，保证 @font-face 先于使用处声明
import '@fontsource-variable/geist/wght.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import '@fontsource/ibm-plex-sans-condensed/latin-500.css';
import '@fontsource/ibm-plex-sans-condensed/latin-600.css';
import '@/styles/global.scss';
import { INLINE_LOGO_JPEG } from '@/assets/logoInline';
import App from './App.tsx';

document.title = 'CLI Proxy API Management Center';
document.documentElement.setAttribute('translate', 'no');
document.documentElement.classList.add('notranslate');

const faviconEl = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
if (faviconEl) {
  faviconEl.href = INLINE_LOGO_JPEG;
  faviconEl.type = 'image/jpeg';
} else {
  const newFavicon = document.createElement('link');
  newFavicon.rel = 'icon';
  newFavicon.type = 'image/jpeg';
  newFavicon.href = INLINE_LOGO_JPEG;
  document.head.appendChild(newFavicon);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
