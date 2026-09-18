// 玄枢 · 模块注册表
//
// 每个模块 = 一位独立角色（人设 + 输出纪律 + 安全口径）+ 专属知识库（RAG 检索目录）
// + 可选的工具脚本（排盘/抽牌这类「死规矩」一律由脚本算，不让模型口算）。
//
// 设计原则（承接 Numerologist_skills 的工程化思路）：
//   1. 排盘、历法换算、抽牌等固定计算 → 一律跑 scripts/xuanshu/ 下的脚本，AI 只解读不脑补；
//   2. 流派与口径（子时换日、置闰、规则集）在 system prompt 里向用户声明；
//   3. 信息不全先追问，不硬排；
//   4. 模块之间人设与知识库物理隔离：RAG 检索只取该模块目录（knowledge/xuanshu/ + 中医 knowledge/）。
//
// 启用状态：模块需要在管理后台开启（site settings: module_enabled_<id>），
// 且对用户单独开通（user_modules 表）。两者都满足才可使用。

import path from 'node:path';
import fs from 'node:fs';

// 本模块所在目录（仅源码/ESM 模式可得）。
// 桌面版把服务端打成 CJS 单文件（sea.cjs）后 import.meta.url 会是 undefined，
// 直接 fileURLToPath(undefined) 会抛 ERR_INVALID_ARG_TYPE 让服务起不来，
// 所以这里必须容错：拿不到就返回空串，由下面的候选路径兜底。
const __dirnameSafe = (() => {
  try {
    // 用动态形式访问，避免 esbuild 在 CJS 输出下静态求值时报错
    const metaUrl = typeof import.meta !== 'undefined' ? import.meta.url : undefined;
    if (!metaUrl) return '';
    return path.dirname(new URL(metaUrl).pathname);
  } catch {
    return '';
  }
})();

// 脚本目录解析顺序：
//   1. XUANSHU_SCRIPTS_DIR 环境变量（桌面版 Tauri resources 传入）
//   2. 源码树相对路径（node 直接跑 src/index.js 的开发/服务器模式）
//   3. cwd 相对路径（SEA/CJS bundle：import.meta 不可用时的兜底）
function resolveScriptsDir() {
  if (process.env.XUANSHU_SCRIPTS_DIR) return process.env.XUANSHU_SCRIPTS_DIR;
  const candidates = [
    __dirnameSafe ? path.resolve(__dirnameSafe, '../../scripts/xuanshu') : null,
    path.resolve(process.cwd(), 'scripts/xuanshu'),
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return candidates[0] || path.resolve(process.cwd(), 'scripts/xuanshu');
}
export const SCRIPTS_DIR = resolveScriptsDir();

export const MODULES = [
  {
    id: 'tcm',
    name: '岐黄问诊',
    tagline: '倪海厦经方视角 · 六经辨证 · 经方选药',
    icon: 'stethoscope',
    color: '#b4552d',
    // 中医是本系统的原始核心，也是站点的默认模块：站点开启即全员可用（无需逐个发牌）
    defaultGrant: true,
    // RAG 走全局知识库（cases/modules/skill 等既有目录）
    ragDirs: ['global'],
    tools: [],
    toolName: '',
    disclaimer: '本内容由 AI 生成，仅供中医学习参考，不构成医疗建议。急危重症请立即拨打 120 或前往急诊。',
    emptyQuote: '「中医很简单，就是阴阳气血。你搞懂了，一通百通。」',
    placeholder: '描述你的症状，或按倪师的思路问诊…',
    emptyHint: '点击右上方问诊单，或直接描述症状…',
    suggestions: ['我感冒了，怕冷没汗', '总是失眠，心慌', '胃口不好，肚子胀', '手脚冰凉，腰酸'],
  },
  {
    id: 'bazi',
    name: '四柱八字',
    tagline: '子平命理 · 脚本排盘 · 大运流年',
    icon: 'bagua',
    color: '#7c5cbf',
    ragDirs: ['xuanshu'],
    ragPrefix: 'bazi',
    tools: ['bazi_pai_pan.py'],
    toolName: '排盘脚本',
    disclaimer: '命理分析展示的是倾向与结构，不是绝对命定；健康、财务、法律问题请以现实专业意见为准。',
    emptyQuote: '「命自天降，运由己造。知命而不认命，方是问命的正途。」',
    placeholder: '告诉我出生日期、时辰和性别，我来为你排盘解读…',
    emptyHint: '直接说出出生信息，或先问我怎么算…',
    suggestions: ['帮我排一下八字', '看看我今年流年运势', '我的喜用神是什么', '分析下我的事业财运'],
  },
  {
    id: 'qimen',
    name: '奇门遁甲',
    tagline: '时家转盘 · 置闰法 · 脚本定局',
    icon: 'compass',
    color: '#2e7d6b',
    ragDirs: ['xuanshu'],
    ragPrefix: 'qimen',
    tools: ['qimen_cli.py'],
    toolName: '排盘脚本',
    disclaimer: '奇门分析供参考，重大决策（疾病、法律、投资）请务必咨询现实专业人士。',
    emptyQuote: '「奇门不问假事。你到底想判断什么？说清楚，再起局。」',
    placeholder: '说清你要测的事、时间和所在城市，我来起局…',
    emptyHint: '直接说出要测的事，或先问我奇门能看什么…',
    suggestions: ['帮我起一局看项目能否落地', '什么时候动身比较合适', '往哪个方向走更有利', '讲讲奇门的用神'],
  },
  {
    id: 'ziwei',
    name: '紫微斗数',
    tagline: '三合派安星 · 四化推演 · 大限流年',
    icon: 'star',
    color: '#a3497e',
    ragDirs: ['xuanshu'],
    ragPrefix: 'ziwei',
    tools: [],
    toolName: '',
    disclaimer: '斗数展示倾向与课题，不作绝对定论；重大决定请以现实条件为准。',
    emptyQuote: '「紫微看的是星盘结构，不是命数审判。先告诉我你的出生信息。」',
    placeholder: '告诉我出生年月日、时辰和性别，我来排盘…',
    emptyHint: '直接给出出生信息，或先问我斗数术语…',
    suggestions: ['帮我排一张紫微命盘', '我的夫妻宫怎么样', '看看这十年大限', '什么是四化'],
  },
  {
    id: 'yinyuan',
    name: '月老姻缘',
    tagline: '八字合婚 · 生肖配对 · 姻缘签诗',
    icon: 'heart',
    color: '#c14f5c',
    ragDirs: ['xuanshu'],
    ragPrefix: 'yinyuan',
    tools: [],
    toolName: '',
    disclaimer: '姻缘测算以娱乐与自省为主，不说宿命、不制造焦虑；感情问题请回到真实相处中解决。',
    emptyQuote: '「千里姻缘一线牵。你问的是他/她，还是你自己？」',
    placeholder: '说清你的问题：合婚、求签还是看桃花？…',
    emptyHint: '说出你们的出生信息或直接求一支签…',
    suggestions: ['帮我合一下八字', '求一支姻缘签', '我们生肖配不配', '我的桃花什么时候来'],
  },
  {
    id: 'fengshui',
    name: '堪舆风水',
    tagline: '玄空飞星 · 八宅明镜 · 阳宅布局',
    icon: 'home',
    color: '#3a6ea5',
    ragDirs: ['xuanshu'],
    ragPrefix: 'fengshui',
    tools: [],
    toolName: '',
    disclaimer: '风水为辅、人为为主；布局建议不替代建筑、消防等专业意见。',
    emptyQuote: '「峦头为体，理气为用。先说说你的房子：坐向、楼层、入伙年份。」',
    placeholder: '描述房子坐向、入伙年份和想解决的问题…',
    emptyHint: '说出你的房子情况，或先问我风水概念…',
    suggestions: ['帮我看看新房布局', '玄空飞星怎么排', '我的命卦是什么', '书房应该放哪'],
  },
  {
    id: 'tarot',
    name: '塔罗占卜',
    tagline: '脚本抽牌 · 正逆位 · 牌阵解读',
    icon: 'card',
    color: '#6b5b95',
    ragDirs: ['xuanshu'],
    ragPrefix: 'tarot',
    tools: ['tarot_draw.py'],
    toolName: '抽牌脚本',
    disclaimer: '塔罗是镜子不是水晶球：牌面反映当下能量，你的选择随时可以改变走向；不做医疗、法律、投资判断。',
    emptyQuote: '「塔罗是镜子，不是水晶球。想问什么？说具体点。」',
    placeholder: '说出你的问题，选一个牌阵，我来为你抽牌…',
    emptyHint: '直接说出问题，或让我推荐牌阵…',
    suggestions: ['帮我抽一张今日指引', '用三牌阵看这段关系', '我该不该换工作', '最近事业卡住了'],
  },
  {
    id: 'fodao',
    name: '佛门问学',
    tagline: '预置祖师教学 · 经证引注 · 教义问答',
    icon: 'lotus',
    color: '#8d6e63',
    ragDirs: ['xuanshu'],
    ragPrefix: 'master-',
    // 点名找祖师：用户提到的名字/别称 → 对应知识目录，检索时对这些目录加权，
    // 避免「印光」被同为净土系的蕅益/宗喀巴等挤掉（15 位祖师容量下这是主要失真来源）
    masterAliases: {
      '慧能': 'huineng', '六祖': 'huineng', '坛经': 'huineng',
      '玄奘': 'xuanzang', '唯识': 'xuanzang', '法相': 'xuanzang',
      '鸠摩罗什': 'kumarajiva', '罗什': 'kumarajiva',
      '龙树': 'nagarjuna', '中观': 'nagarjuna',
      '智顗': 'zhiyi', '智者大师': 'zhiyi', '天台': 'zhiyi',
      '法藏': 'fazang', '华严': 'fazang',
      '蕅益': 'ouyi',
      '印光': 'yinguang', '净土': 'yinguang',
      '虚云': 'xuyun', '禅宗': 'xuyun', '参禅': 'xuyun', '打坐': 'xuyun',
      '阿底峡': 'atisha', '噶当': 'atisha', '三士道': 'atisha',
      '宗喀巴': 'tsongkhapa', '格鲁': 'tsongkhapa', '菩提道次第': 'tsongkhapa',
      '米拉日巴': 'milarepa', '噶举': 'milarepa', '大手印': 'milarepa',
      '觉音': 'buddhaghosa', '清净道论': 'buddhaghosa', '上座部': 'buddhaghosa',
      '马哈希': 'mahasi-sayadaw', '内观': 'mahasi-sayadaw', '毗婆舍那': 'mahasi-sayadaw',
      '阿姜查': 'ajahn-chah', '森林': 'ajahn-chah', '正念': 'ajahn-chah',
    },
    tools: [],
    toolName: '',
    disclaimer: '内容依据历史佛教文献生成，仅供学习参考；如需正式修行指导，请亲近善知识。',
    emptyQuote: '「何期自性，本自清净。想向哪位祖师请益？」',
    placeholder: '说出你想请教的祖师或经义问题…',
    emptyHint: '告诉我你想向哪位祖师请益…',
    suggestions: ['想向慧能大师请教顿悟', '帮我讲讲《坛经》', '玄奘法师的唯识是什么', '禅宗与净土的区别'],
  },
];

export const MODULE_IDS = MODULES.map((m) => m.id);
export const DEFAULT_MODULE = 'tcm';

export function getModule(id) {
  return MODULES.find((m) => m.id === id) || null;
}

// 从用户文本中识别被点名的祖师 → 返回其知识目录前缀（供检索加权）。
// 用于 fodao 这类「多角色共用一个模块」的场景：用户说「请印光大师开示」时，
// 必须优先取印光的教法，而不是被同宗派的其他祖师挤掉。
export function detectBoostDirs(mod, text) {
  const aliases = mod?.masterAliases;
  if (!aliases || !text) return [];
  const dirs = new Set();
  for (const [alias, slug] of Object.entries(aliases)) {
    if (text.includes(alias)) dirs.add(`xuanshu/master-${slug}/`);
  }
  return [...dirs];
}
