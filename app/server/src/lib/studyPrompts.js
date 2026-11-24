// 玄枢 · 学习练习 prompt（章节生成 / 出题 / 判题）
//
// 设计原则（与 modules/prompts.js 一致的工程纪律）：
//   1. 章节内容必须基于知识库摘录（RAG），查不到的内容如实声明，禁止编造；
//   2. 输出必须是「严格的 JSON 或纯 HTML 片段」，不包 markdown 代码栅栏（由服务端兼容剥离）；
//   3. 题目必须带答案与解析（服务端判题用，用户答题前不下发）；
//   4. 免责声明不进章节正文（前端统一展示）。

// —— 章节生成（HTML） ——
export function chapterPrompt(modName, topic, ragBlock) {
  return `你是「玄枢」学习中心的课程编写者，正在为「${modName}」模块编写一份学习章节。

【任务】
围绕主题「${topic}」，写一份系统、循序渐进的学习章节，供学员在线阅读。内容以知识库摘录为主要依据。

【内容要求】
1. 结构：章节标题（h2）→ 引入（为什么学/用在哪）→ 3~5 个小节（h3）→ 每节配 1 个表格或要点块 → 结尾「本章要点」列表。
2. 面向初学者：专业术语首次出现必须给白话解释；示例具体（有数字、有场景）。
3. 必须基于下方【知识库摘录】编写；摘录未覆盖的部分如确需包含，标注「（通义概述）」。
4. 尊重模块口径：沿用「${modName}」模块的流派、术语与禁忌。

【输出格式（严格遵守）】
- 只输出 HTML 片段，从 <h2> 开始，不要 <html>/<head>/<body>/<script>/<style> 标签。
- 允许的标签：h2 h3 h4 p ul ol li table thead tbody tr th td blockquote strong em span div details summary b i mark small。
- 不要 markdown 语法（**、##、\`\`\`），不要代码围栏。
- 篇幅 800~1500 字。

${ragBlock}`;
}

// —— 出题 ——
export function quizPrompt(modName, topic, ragBlock, count = 5) {
  return `你是「玄枢」学习中心的命题人，为「${modName}」模块的「${topic}」主题出 ${count} 道练习题，用于检验学员对本章内容的掌握。

【题目要求】
1. 题型混合：3 道单选题（type="single"，4 个选项）+ 1 道多选题（type="multi"，4~5 个选项）+ 1 道判断题（type="tf"，选项固定为 ["对","错"]）。总数 ${count} 道。
2. 题干清晰、无歧义；考察理解与应用，不出纯记忆死题。
3. 每题给正确答案：single 填选项字母（如 "B"）；multi 填逗号分隔的字母（如 "A,C"，顺序按字母升序）；tf 填 "对" 或 "错"。
4. 每题配解析（2~4 句）：为什么对、为什么其他选项错、学员容易在哪踩坑。
5. 题目内容必须基于【知识库摘录】；摘录未覆盖但确需考查的点，解析里标注「（通义概述）」。

【输出格式（严格遵守）】
只输出一个 JSON 数组，不要 markdown 代码围栏，不要任何解释文字。形如：
[
  {"type":"single","stem":"题干文本","options":["选项A内容","选项B内容","选项C内容","选项D内容"],"answer":"B","explanation":"解析文本"},
  {"type":"multi","stem":"…","options":["…","…","…","…"],"answer":"A,C","explanation":"…"},
  {"type":"tf","stem":"…","options":["对","错"],"answer":"对","explanation":"…"}
]

${ragBlock}`;
}

// 判题走客观比对，不需要 LLM（服务端直接对答案）。
