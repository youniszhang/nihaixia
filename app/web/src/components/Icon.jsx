// 统一图标集：内联 SVG（24×24 网格、currentColor 描边）。
//
// 为什么不用 emoji 当图标：同一个 emoji 在 Windows / Linux / 旧版 macOS 上字形宽度与风格
// 都不同（🩺 这类较新的符号还会变豆腐块），颜色不受 CSS 控制、基线偏低导致按钮里对不齐。
// 这里改成一套自绘线性图标：尺寸/颜色/描边全部跟随字号与 currentColor，跨平台一致。
//
// 用法：<Icon name="calendar-check" /> / <Icon name="users" size={20} className="..." />
// 装饰性图标统一 aria-hidden，语义交给按钮的 aria-label / 文案。

const ICONS = {
  // —— 导航 / 通用 ——
  menu: <><path d="M3 6h18" /><path d="M3 12h18" /><path d="M3 18h18" /></>,
  close: <><path d="M6 6l12 12" /><path d="M18 6L6 18" /></>,
  plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
  minus: <path d="M5 12h14" />,
  check: <path d="M4 12.5l5 5L20 6.5" />,
  'arrow-left': <><path d="M19 12H5" /><path d="M11 18l-6-6 6-6" /></>,
  'arrow-right': <><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></>,
  'chevron-down': <path d="M6 9l6 6 6-6" />,
  'chevron-right': <path d="M9 6l6 6-6 6" />,
  search: <><circle cx="11" cy="11" r="7" /><path d="M16.5 16.5L21 21" /></>,
  download: <><path d="M12 3v12" /><path d="M7 10l5 5 5-5" /><path d="M4 20h16" /></>,
  refresh: <><path d="M20 11a8 8 0 1 0-2.3 6.3" /><path d="M20 5v6h-6" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h.01" /></>,
  alert: <><path d="M12 4l9 16H3z" /><path d="M12 10v4" /><path d="M12 17h.01" /></>,
  sparkles: <><path d="M12 4l1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6z" /><path d="M18 16l.8 2.2L21 19l-2.2.8L18 22l-.8-2.2L15 19l2.2-.8z" /></>,
  logout: <><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" /><path d="M10 12H3" /><path d="M7 8l-4 4 4 4" /></>,
  user: <><circle cx="12" cy="8" r="3.6" /><path d="M4.5 20a7.5 7.5 0 0 1 15 0" /></>,
  users: <><circle cx="9" cy="8" r="3.2" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 5.2a3.2 3.2 0 0 1 0 5.6" /><path d="M17.5 14.3a6.5 6.5 0 0 1 4 5.7" /></>,
  shield: <><path d="M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6z" /><path d="M9 12l2 2 4-4" /></>,
  key: <><circle cx="8" cy="15" r="3.5" /><path d="M10.5 12.5L20 3" /><path d="M17 6l2 2" /><path d="M14.5 8.5l2 2" /></>,
  trash: <><path d="M4 7h16" /><path d="M9 7V5h6v2" /><path d="M6 7l1 13h10l1-13" /><path d="M10 11v6" /><path d="M14 11v6" /></>,
  edit: <><path d="M4 20h4l10-10-4-4L4 16z" /><path d="M14 6l4 4" /></>,
  copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 3v2.5" /><path d="M12 18.5V21" /><path d="M3 12h2.5" /><path d="M18.5 12H21" /><path d="M5.6 5.6l1.8 1.8" /><path d="M16.6 16.6l1.8 1.8" /><path d="M18.4 5.6l-1.8 1.8" /><path d="M7.4 16.6l-1.8 1.8" /></>,
  wrench: <><path d="M15 3a5 5 0 0 0-4.6 6.9L4 16.3V20h3.7l6.4-6.4A5 5 0 1 0 15 3z" /><path d="M15.5 7.5h.01" /></>,
  sliders: <><path d="M4 8h10" /><path d="M18 8h2" /><path d="M4 16h4" /><path d="M12 16h8" /><circle cx="16" cy="8" r="2" /><circle cx="10" cy="16" r="2" /></>,

  // —— 业务 ——
  chart: <><path d="M4 20V4" /><path d="M4 20h16" /><path d="M8 17v-5" /><path d="M13 17V8" /><path d="M18 17v-8" /></>,
  trending: <><path d="M4 17l5-5 3.5 3.5L20 8" /><path d="M15 8h5v5" /></>,
  message: <><path d="M20 12a7.5 7.5 0 0 1-10.9 6.7L4 20l1.3-4.1A7.5 7.5 0 1 1 20 12z" /></>,
  'message-plus': <><path d="M20 11.5A7.5 7.5 0 0 1 9.1 18L4 20l1.3-4.1A7.5 7.5 0 1 1 20 11.5z" /><path d="M12 8.5v6" /><path d="M9 11.5h6" /></>,
  clipboard: <><rect x="6" y="4" width="12" height="17" rx="2" /><path d="M9.5 4V3h5v1" /><path d="M9.5 10h5" /><path d="M9.5 14h5" /></>,
  stethoscope: <><path d="M6 3v5a4 4 0 0 0 8 0V3" /><path d="M10 12v3a4 4 0 0 0 8 0v-2" /><circle cx="18" cy="11" r="2" /></>,
  send: <><path d="M4 12l16-8-6 16-2.6-6.4z" /><path d="M11.4 13.6L20 4" /></>,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  'calendar-check': <><rect x="3.5" y="5" width="17" height="16" rx="2.5" /><path d="M3.5 10h17" /><path d="M8 3v4" /><path d="M16 3v4" /><path d="M9 15l2 2 4-4" /></>,
  coins: <><ellipse cx="9" cy="7" rx="5.5" ry="3" /><path d="M3.5 7v5c0 1.7 2.5 3 5.5 3s5.5-1.3 5.5-3V7" /><path d="M14.5 12.2c2.4.3 4.2 1.3 4.2 2.6v5c0 1.7-2.5 3-5.5 3s-5.5-1.3-5.5-3" /></>,
  gem: <><path d="M7 4h10l4 5-9 11L3 9z" /><path d="M3 9h18" /><path d="M9.5 4L8 9l4 11" /><path d="M14.5 4L16 9l-4 11" /></>,
  crown: <><path d="M3 8l3.5 3L12 5l5.5 6L21 8l-1.6 11H4.6z" /><path d="M4.6 19h14.8" /></>,
  gift: <><rect x="3.5" y="9" width="17" height="11" rx="2" /><path d="M3.5 13h17" /><path d="M12 9v11" /><path d="M12 9S10.5 4 8 4a2.2 2.2 0 0 0 0 5z" /><path d="M12 9s1.5-5 4-5a2.2 2.2 0 0 1 0 5z" /></>,
  flame: <><path d="M12 3s5 4.2 5 9a5 5 0 0 1-10 0c0-2 1-3.6 2-4.6" /><path d="M12 20a3 3 0 0 0 3-3c0-1.6-1.4-3-3-4.5-1.6 1.5-3 2.9-3 4.5a3 3 0 0 0 3 3z" /></>,
  card: <><rect x="3" y="5.5" width="18" height="13" rx="2.5" /><path d="M3 10h18" /><path d="M7 14.5h4" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  award: <><circle cx="12" cy="9" r="5.5" /><path d="M8.5 13.6L7 21l5-2.5L17 21l-1.5-7.4" /></>,
  zap: <path d="M13 3L5 14h5l-1 7 8-11h-5z" />,
  'credit-limit': <><circle cx="12" cy="12" r="8.5" /><path d="M12 8v4l3 2" /><path d="M4 4l16 16" /></>,
  link: <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 1 0-5.7-5.7L11.5 7" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 1 0 5.7 5.7L12.5 17" /></>,
  eye: <><path d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="3" /></>,
  'file-text': <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4" /><path d="M9 12h6" /><path d="M9 16h6" /></>,

  // —— 玄枢模块 ——
  bell: <><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6.5 2 6.5H4S6 14 6 9z" /><path d="M10 19a2.2 2.2 0 0 0 4 0" /></>,
  'user-plus': <><circle cx="10" cy="8" r="3.2" /><path d="M3 20a7 7 0 0 1 14 0" /><path d="M19 6v6" /><path d="M16 9h6" /></>,
  lock: <><rect x="5.5" y="10.5" width="13" height="9.5" rx="2" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" /></>,
  bagua: <><circle cx="12" cy="12" r="9" /><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" /><circle cx="12" cy="7.5" r="1.2" fill="var(--bg, #fff)" stroke="none" /><circle cx="12" cy="16.5" r="1.2" fill="currentColor" stroke="none" /></>,
  compass: <><circle cx="12" cy="12" r="9" /><path d="M15.5 8.5l-2.2 5.3-5.3 2.2 2.2-5.3z" /></>,
  star: <path d="M12 3.5l2.5 5.4 5.9.7-4.4 4 1.2 5.9L12 16.6l-5.2 2.9 1.2-5.9-4.4-4 5.9-.7z" />,
  heart: <path d="M12 20s-7.5-4.7-9-9.3C2 7.5 4 4.8 7 4.8c2 0 3.6 1.1 5 3.2 1.4-2.1 3-3.2 5-3.2 3 0 5 2.7 4 5.9-1.5 4.6-9 9.3-9 9.3z" />,
  home: <><path d="M4 11l8-7 8 7" /><path d="M6 9.5V20h12V9.5" /><path d="M10 20v-6h4v6" /></>,
  lotus: <><path d="M12 20c-2.5-1.6-4-4-4-7 0-2.5 1.5-5 4-7 2.5 2 4 4.5 4 7 0 3-1.5 5.4-4 7z" /><path d="M12 20c-4.5 0-8-2.5-9-6 2.3-.5 4.5 0 6.3 1.3" /><path d="M12 20c4.5 0 8-2.5 9-6-2.3-.5-4.5 0-6.3 1.3" /></>,
};

export const ICON_NAMES = Object.keys(ICONS);

export default function Icon({ name, size = 18, className = '', strokeWidth = 1.8, title }) {
  const inner = ICONS[name];
  if (!inner) return null;
  return (
    <svg
      className={`icon ${className}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : 'true'}
      role={title ? 'img' : undefined}
      focusable="false"
    >
      {title && <title>{title}</title>}
      {inner}
    </svg>
  );
}