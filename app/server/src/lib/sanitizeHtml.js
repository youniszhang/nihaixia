// 学习章节 HTML 白名单净化器（服务端，入库前执行）
//
// 为什么在服务端做：前端 CSP（script-src 'self'）只是第二道防线，章节 HTML 会通过 API
// 原样分发给所有浏览器（含 PWA/桌面 WebView）。<script>/<iframe>/on* 事件属性/外链资源
// 一旦入库，等于把污染分发给全站用户。所以：
//   1. 生成后先经 sanitizeStudyHtml() 再入库；
//   2. 前端渲染放在 scoped 容器里（.study-doc），样式与站内主题隔离。
//
// 实现原则：不引第三方依赖（项目零 sanitize 库），白名单标签 + 白名单属性 + 协议过滤。
// 任何看不懂/不在名单里的东西一律丢弃——宁可让章节少个样式，不可放进一个脚本。

const ALLOWED_TAGS = new Set([
  // 结构
  'div', 'p', 'span', 'section', 'article', 'header', 'footer', 'br', 'hr',
  // 标题
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  // 列表
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  // 文本语义
  'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins', 'mark', 'small', 'sub', 'sup', 'abbr', 'kbd',
  'blockquote', 'q', 'cite', 'code', 'pre', 'figure', 'figcaption',
  // 链接（站内锚点；协议见 SAFE_HREF_RE）
  'a',
  // 表格（经方剂量表重灾区）
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  // 其他
  'details', 'summary',
]);

// 全局白名单属性（任意标签可用）
const GLOBAL_ATTRS = new Set(['class', 'id', 'title', 'lang', 'dir']);
// 标签专属白名单
const TAG_ATTRS = {
  a: new Set(['href', 'target', 'rel']),
  th: new Set(['colspan', 'rowspan', 'scope']),
  td: new Set(['colspan', 'rowspan']),
  col: new Set(['span']),
  ol: new Set(['start', 'reversed', 'type']),
  li: new Set(['value']),
  details: new Set(['open']),
};
// 允许的 href 协议（a 标签）：只放站内锚点与 mailto（学习卡片不需要外链，一律剥掉）
const SAFE_HREF_RE = /^#[-a-zA-Z0-9_.]*$|^mailto:[^\s"<>]*$/i;

// 数字类属性的合法形态
const NUM_ATTR_RE = /^[0-9]{1,4}$/;

// style 白名单：只保留安全声明（颜色/对齐/宽度等纯展示属性）。
// 不整体放行 style —— expression()/url(javascript:) 等历史注入载体必须挡在外面。
const SAFE_STYLE_RE = /^(?:color|background(?:-color)?|text-align|text-decoration|font-weight|font-style|font-size|line-height|width|max-width|min-width|height|max-height|border(?:-(?:left|right|top|bottom))?(?:-color|-width|-style|-collapse)?|margin(?:-(?:left|right|top|bottom))?|padding(?:-(?:left|right|top|bottom))?|vertical-align|white-space|letter-spacing|list-style(?:-type)?|display)\s*:\s*[^;{}<>&]*$/i;

function isSafeStyleValue(decl) {
  const m = /^([a-zA-Z-]+)\s*:\s*(.*)$/.exec(decl.trim());
  if (!m) return false;
  const [, prop, value] = m;
  if (!SAFE_STYLE_RE.test(decl.trim())) return false;
  // 值里禁掉任何 url/引号异常/控制字符（color:red 之外的任何资源加载都不要）
  if (/url\s*\(|javascript|expression|@import|["'\\<>]/i.test(value)) return false;
  return true;
}

function sanitizeAttrs(tagName, attrs) {
  const out = [];
  const tagAllowed = TAG_ATTRS[tagName];
  for (const [name, value] of attrs) {
    const n = name.toLowerCase();
    // 事件属性 / style 外的未知属性：直接丢
    if (n.startsWith('on') || n === 'style') {
      if (n === 'style') {
        // style 单独走白名单声明过滤
        const decls = String(value || '').split(';').map((s) => s.trim()).filter(Boolean);
        const safe = decls.filter(isSafeStyleValue);
        if (safe.length) out.push(['style', safe.join('; ')]);
      }
      continue;
    }
    if (!GLOBAL_ATTRS.has(n) && !(tagAllowed && tagAllowed.has(n))) continue;
    if (n === 'href' && !SAFE_HREF_RE.test(String(value || ''))) continue;
    if ((n === 'colspan' || n === 'rowspan' || n === 'span' || n === 'start' || n === 'value') && !NUM_ATTR_RE.test(String(value || ''))) continue;
    if (n === 'target') {
      // 只允许 _blank，且强制补 rel
      if (String(value) !== '_blank') continue;
      out.push(['rel', 'noopener noreferrer']);
      out.push(['target', '_blank']);
      continue;
    }
    out.push([n, String(value ?? '').slice(0, 500)]);
  }
  return out;
}

// 剥离 HTML 注释与 CDATA/处理指令（可能是模型幻觉出来的边界，也可能是注入载体）
function stripComments(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '');
}

/**
 * 净化学习章节 HTML：白名单标签 + 白名单属性 + style 声明白名单。
 * 返回安全 HTML 字符串（未命中白名单的标签剥掉、文本保留；
 * script/style 等危险容器标签连同内容整段删除）。
 */
export function sanitizeStudyHtml(html) {
  let src = stripComments(html);

  // 第 0 步：先删危险容器标签的「整段内容」（必须在标签剥离之前做，
  // 否则 <script> 被剥成文本后就再也认不出它是脚本内容了）
  for (const bad of ['script', 'style', 'iframe', 'object', 'embed', 'form', 'svg', 'math', 'textarea', 'noscript', 'template']) {
    src = src.replace(new RegExp(`<${bad}\\b[^>]*>[\\s\\S]*?<\\/${bad}>`, 'gi'), '');
    // 未闭合的：删开标签及到结尾的全部内容（模型输出截断时出现）
    src = src.replace(new RegExp(`<${bad}\\b[^>]*>[\\s\\S]*$`, 'gi'), '');
    src = src.replace(new RegExp(`<${bad}\\b[^>]*/?>`, 'gi'), '');
  }

  // 第 1 步：白名单标签扫描。文本节点原样保留。
  let out = '';
  let i = 0;
  const TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^<>]*)?)\/?>/g;
  let m;
  while ((m = TAG_RE.exec(src)) !== null) {
    const [full, rawTag, rawAttrs] = m;
    const tag = rawTag.toLowerCase();
    out += src.slice(i, m.index); // 标签前的文本
    i = m.index + full.length;
    if (!ALLOWED_TAGS.has(tag)) {
      continue; // 非白名单标签：剥标签本身，文本已在两侧保留
    }
    const closing = full.startsWith('</');
    if (closing) {
      out += `</${tag}>`;
      continue;
    }
    // 解析属性串（name="value" / name='value' / name=value / bare）
    const attrs = [];
    const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|[^\s"'>]+))?/g;
    let am;
    while ((am = ATTR_RE.exec(rawAttrs || '')) !== null) {
      attrs.push([am[1].toLowerCase(), am[3] ?? am[4] ?? (am[2] != null ? am[2] : '')]);
    }
    const safe = sanitizeAttrs(tag, attrs);
    const voidTags = new Set(['br', 'hr', 'col']);
    const attrStr = safe.map(([k, v]) => ` ${k}="${String(v).replace(/"/g, '&quot;')}"`).join('');
    out += `<${tag}${attrStr}>`;
  }
  out += src.slice(i);
  return out.trim();
}
