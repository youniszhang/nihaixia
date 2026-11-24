import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import Icon from './Icon.jsx';

// 玄枢 · 学习中心
//
// 视图状态机（组件内，无路由库——与 App.jsx 的做法一致）：
//   home    → 章节列表 + 统计 + 生成入口
//   study   → 阅读某章（HTML 经服务端白名单净化后渲染进 scoped 容器）
//   quiz    → 答题（单选/多选/判断；提交后判题 + 解析 + 错题联动）
//   wrongs  → 错题集（在集错题重练；连对 2 次自动移出）
//
// 安全约定：章节 HTML 由服务端 sanitizeStudyHtml 白名单净化后才入库，
// 这里用 dangerouslySetInnerHTML 渲染是「受控渲染」——内容来源是自家服务端，
// 且 CSP（script-src 'self'）兜底挡掉任何残留脚本。样式限制在 .study-doc 作用域内。

const QUIZ_TYPE_LABEL = { single: '单选', multi: '多选', tf: '判断' };
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

function pct(correct, total) {
  if (!total) return 0;
  return Math.round((correct / total) * 100);
}

// —— 题目组件（答题态 / 结果态共用） ——
// q: { id, index, type, stem, options }（服务端下发，不带答案）
// answer: 用户当前选择（按 q.id 键存）
// result: { id, index, correct, answer, explanation, removed? }
function QuizQuestion({ q, index, answer, result, onChange }) {
  const picked = (i) => {
    if (result) return; // 已判题，锁定
    if (q.type === 'single' || q.type === 'tf') onChange(q.id, LETTERS[i]);
    else {
      const cur = String(answer || '').split(',').filter(Boolean);
      const letter = LETTERS[i];
      const next = cur.includes(letter) ? cur.filter((x) => x !== letter) : [...cur, letter].sort();
      onChange(q.id, next.join(','));
    }
  };
  const isPicked = (i) => String(answer || '').split(',').includes(LETTERS[i]);
  const correctSet = result ? String(result.answer || '').split(',') : [];
  const optionCls = (i) => {
    const base = 'quiz-option';
    if (!result) return isPicked(i) ? `${base} picked` : base;
    const letter = LETTERS[i];
    if (correctSet.includes(letter)) return `${base} correct`;
    if (isPicked(i)) return `${base} wrong-pick`;
    return base;
  };
  const tfMap = q.type === 'tf' ? ['对', '错'] : null;
  return (
    <div className={`quiz-q ${result ? (result.correct ? 'was-correct' : 'was-wrong') : ''}`}>
      <div className="quiz-q-head">
        <span className={`quiz-q-type t-${q.type}`}>{QUIZ_TYPE_LABEL[q.type] || '单选'}</span>
        <span className="quiz-q-stem">{index + 1}. {q.stem}</span>
        {result && (
          <span className={`quiz-q-mark ${result.correct ? 'ok' : 'no'}`}>
            <Icon name={result.correct ? 'check-circle' : 'x-circle'} size={16} />
          </span>
        )}
      </div>
      <div className="quiz-options">
        {(tfMap || q.options || []).map((opt, i) => (
          <button key={i} type="button" className={optionCls(i)} onClick={() => picked(i)} disabled={Boolean(result)}>
            <span className="quiz-opt-letter">{LETTERS[i]}</span>
            <span className="quiz-opt-text">{opt}</span>
          </button>
        ))}
      </div>
      {result && (
        <div className="quiz-explain">
          <p><strong>正确答案：{result.answer}</strong></p>
          <p>{result.explanation}</p>
          {result.removed && <p className="quiz-removed-note">连续答对 2 次，已自动移出错题集</p>}
        </div>
      )}
    </div>
  );
}

export default function StudyPage({ module: mod, onBackToPortal }) {
  const [view, setView] = useState('home'); // home | study | quiz | wrongs
  const [data, setData] = useState(null);   // { chapters, stats }
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');

  // 生成
  const [topic, setTopic] = useState('');
  const [generating, setGenerating] = useState(false);
  const [genPreview, setGenPreview] = useState(''); // 流式预览（净化后的 HTML 在 done 才有，这里流式裸文本仅作进度感）
  const abortRef = useRef(null);

  // 阅读章节
  const [chapter, setChapter] = useState(null);   // { chapter }
  const [loadingCh, setLoadingCh] = useState(false);

  // 测验
  const [quiz, setQuiz] = useState(null);          // { chapter_id, questions }
  const [quizAnswers, setQuizAnswers] = useState({});
  const [quizResult, setQuizResult] = useState(null); // { results, correct, total, stats }
  const [quizBusy, setQuizBusy] = useState(false);

  // 错题集
  const [wrongs, setWrongs] = useState(null);
  const [wrongsQuiz, setWrongsQuiz] = useState(null);   // 进入重练模式：题目来自错题快照
  const [wrongsAnswers, setWrongsAnswers] = useState({});
  const [wrongsResult, setWrongsResult] = useState(null);

  function loadHome() {
    api.studyHome(mod.id).then(setData).catch((e) => setErr(e.message));
  }
  useEffect(() => { loadHome(); }, [mod.id]);
  useEffect(() => { setErr(''); setNotice(''); }, [view]);

  // —— 生成章节（SSE 流式） ——
  async function generate() {
    setErr(''); setNotice('');
    setGenerating(true); setGenPreview('');
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      let done = false;
      for await (const ev of api.streamStudyGenerate(mod.id, topic.trim(), ac.signal)) {
        if (ev.type === 'queue') setNotice(`排队中（第 ${ev.position} 位，预计 ${ev.est_wait_s}s）`);
        else if (ev.type === 'delta') {
          setGenPreview((s) => (s + ev.text).slice(-3000));
          setNotice('');
        } else if (ev.type === 'error') {
          setErr(ev.message || '生成失败');
        } else if (ev.type === 'done') {
          done = true;
          setNotice(`章节「${ev.chapter?.title || ''}」已生成`);
          loadHome();
          setView('study');
          setChapter({ chapter: ev.chapter });
          // 生成后自动出题体验更好，但题也要烧一次额度，改为用户主动触发
        }
      }
      if (!done && !err) setErr('生成被中断，请重试');
    } catch (e) {
      if (e.name !== 'AbortError') setErr(e.message);
    } finally {
      setGenerating(false); setGenPreview('');
      abortRef.current = null;
    }
  }

  async function openChapter(id) {
    setLoadingCh(true); setErr('');
    try {
      const d = await api.studyChapter(id);
      setChapter(d);
      setView('study');
    } catch (e) { setErr(e.message); }
    finally { setLoadingCh(false); }
  }

  async function removeChapter(id) {
    if (!window.confirm('删除该章节？其错题快照会保留。')) return;
    try {
      await api.studyDeleteChapter(id);
      loadHome();
      if (chapter?.chapter?.id === id) setView('home');
    } catch (e) { setErr(e.message); }
  }

  async function startQuiz() {
    const ch = chapter?.chapter;
    if (!ch) return;
    setQuizBusy(true); setErr(''); setQuizResult(null); setQuizAnswers({});
    try {
      const q = await api.studyQuiz(mod.id, ch.id, 5);
      setQuiz(q);
      setView('quiz');
    } catch (e) { setErr(e.message); }
    finally { setQuizBusy(false); }
  }

  async function submitQuiz() {
    const answered = Object.keys(quizAnswers).length;
    if (answered < quiz.questions.length && !window.confirm(`还有 ${quiz.questions.length - answered} 题未作答，确定提交？`)) return;
    setQuizBusy(true); setErr('');
    try {
      // answers 按题目顺序排列（服务端按下标对齐判题）
      const answers = quiz.questions.map((q) => quizAnswers[q.id] ?? (quizAnswers[q.index] || ''));
      const r = await api.studySubmit(mod.id, quiz.chapter_id, answers);
      setQuizResult(r);
      if (r.stats) setData((d) => ({ ...d, stats: r.stats }));
    } catch (e) { setErr(e.message); }
    finally { setQuizBusy(false); }
  }

  function openWrongs() {
    api.studyWrongs(mod.id, false).then((d) => {
      setWrongs(d);
      setWrongsQuiz(null); setWrongsAnswers({}); setWrongsResult(null);
      setView('wrongs');
    }).catch((e) => setErr(e.message));
  }

  function startWrongsQuiz() {
    const items = wrongs?.wrongs || [];
    if (!items.length) return;
    setWrongsQuiz(items.map((w, i) => ({
      // question_id 为负 = 章节已删的快照题（错题重练仍可用）
      id: w.question_id, index: i, type: w.type, stem: w.stem,
      options: (() => { try { return JSON.parse(w.options_json) || []; } catch { return []; } })(),
    })));
    setWrongsAnswers({});
    setWrongsResult(null);
  }

  async function submitWrongs() {
    setQuizBusy(true); setErr('');
    try {
      const answers = (wrongsQuiz || []).map((q) => wrongsAnswers[q.id ?? q.index] || '');
      const r = await api.studyWrongsSubmit(mod.id, answers);
      const resultMap = new Map((r.results || []).map((x) => [x.index, x]));
      setWrongsResult({ ...r, byIndex: resultMap });
      if (r.stats) setData((d) => ({ ...d, stats: r.stats }));
      api.studyWrongs(mod.id, false).then((d) => setWrongs(d)).catch(() => {});
    } catch (e) { setErr(e.message); }
    finally { setQuizBusy(false); }
  }

  const stats = data?.stats || {};

  return (
    <div className="study-shell">
      <header className="study-header">
        <button className="back-portal" onClick={onBackToPortal}>
          <Icon name="arrow-left" size={16} /> 返回门户
        </button>
        <div className="study-title">
          <span className="study-icon" style={{ background: mod.color }}><Icon name="book-open" size={20} /></span>
          <div>
            <strong>学习中心 · {mod.name}</strong>
            <small>{mod.tagline}</small>
          </div>
        </div>
        <nav className="study-tabs">
          <button className={view === 'home' ? 'on' : ''} onClick={() => setView('home')}><Icon name="book" size={15} /> 章节</button>
          <button className={view === 'wrongs' ? 'on' : ''} onClick={openWrongs}>
            <Icon name="alert" size={15} /> 错题集{stats.wrong_set ? ` (${stats.wrong_set})` : ''}
          </button>
        </nav>
      </header>

      {err && <p className="portal-error" role="alert">{err}</p>}
      {notice && <p className="portal-notice">{notice}</p>}

      <main className="study-main">
        {view === 'home' && (
          <>
            <section className="study-gen card">
              <h2><Icon name="sparkles" size={17} /> AI 出学习章节</h2>
              <p className="study-gen-hint">基于「{mod.name}」模块知识库生成 HTML 学习章节：内容可跟着学，学完可让 AI 出题测验。</p>
              <div className="study-gen-row">
                <input
                  className="field study-topic-input"
                  placeholder={`想学什么？如：${(mod.suggestions || [])[0] || mod.name + '基础'}`}
                  value={topic}
                  maxLength={120}
                  onChange={(e) => setTopic(e.target.value)}
                  disabled={generating}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !generating && topic.trim()) generate(); }}
                />
                {generating ? (
                  <button className="btn-primary" onClick={() => abortRef.current?.abort()}>
                    <Icon name="stop" size={15} /> 停止
                  </button>
                ) : (
                  <button className="btn-primary" disabled={!topic.trim()} onClick={generate}>
                    <Icon name="sparkles" size={15} /> 生成章节
                  </button>
                )}
              </div>
              {generating && (
                <div className="study-gen-streaming">
                  <div className="loading-spinner" />
                  <p>{genPreview ? genPreview.slice(-500) : '正在检索知识库并撰写章节…'}</p>
                </div>
              )}
            </section>

            <section className="study-stats-row">
              <div className="study-stat card"><b>{stats.chapters || 0}</b><span>章节</span></div>
              <div className="study-stat card"><b>{stats.answered || 0}</b><span>已答题</span></div>
              <div className="study-stat card"><b>{pct(stats.correct, stats.answered)}%</b><span>正确率</span></div>
              <div className="study-stat card"><b className={stats.wrong_set ? 'hot' : ''}>{stats.wrong_set || 0}</b><span>错题在集</span></div>
            </section>

            <section className="study-chapters">
              <h3>章节列表</h3>
              {!data ? (
                <div className="chat-loading"><div className="loading-spinner" /><p>加载中…</p></div>
              ) : !data.chapters?.length ? (
                <p className="study-empty">还没有章节。输入一个主题，让 AI 为你编写第一章。</p>
              ) : (
                <ul className="study-chapter-list">
                  {data.chapters.map((c) => (
                    <li key={c.id} className="study-chapter-item card">
                      <button className="study-chapter-main" onClick={() => openChapter(c.id)}>
                        <strong>{c.title}</strong>
                        <small>{c.topic && c.topic !== c.title ? `主题：${c.topic} · ` : ''}{String(c.created_at || '').slice(0, 10)} · 约 {Math.max(1, Math.round((c.content_len || 0) / 500))} 分钟阅读</small>
                      </button>
                      <div className="study-chapter-actions">
                        <button className="icon-btn" title="阅读" onClick={() => openChapter(c.id)}><Icon name="book-open" size={16} /></button>
                        <button className="icon-btn danger" title="删除" onClick={() => removeChapter(c.id)}><Icon name="trash" size={16} /></button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}

        {view === 'study' && (loadingCh || !chapter ? (
          <div className="chat-loading"><div className="loading-spinner" /><p>加载章节…</p></div>
        ) : (
          <article className="study-reader card">
            <header className="study-reader-head">
              <button className="back-portal" onClick={() => setView('home')}><Icon name="arrow-left" size={15} /> 目录</button>
              <h2>{chapter.chapter?.title}</h2>
              <div className="study-reader-actions">
                <button className="btn-primary" disabled={quizBusy} onClick={startQuiz}>
                  <Icon name="pencil-line" size={15} /> {quizBusy ? '出题中…' : 'AI 出题测验'}
                </button>
              </div>
            </header>
            {/* 章节正文：服务端白名单净化后的 HTML，scoped 容器渲染 */}
            <div className="study-doc" dangerouslySetInnerHTML={{ __html: chapter.chapter?.content_html || '<p>（本章内容为空）</p>' }} />
            <footer className="study-reader-foot">
              <p><Icon name="info" size={14} /> 本内容由 AI 基于知识库生成，仅供学习参考。</p>
              <button className="btn-primary" disabled={quizBusy} onClick={startQuiz}>
                <Icon name="pencil-line" size={15} /> {quizBusy ? '出题中…' : '学完了，测一测'}
              </button>
            </footer>
          </article>
        ))}

        {view === 'quiz' && (!quiz ? null : (
          <section className="study-quiz card">
            <header className="study-quiz-head">
              <h2><Icon name="pencil-line" size={17} /> 章节测验 · {chapter?.chapter?.title || ''}</h2>
              {quizResult ? (
                <div className={`quiz-score ${quizResult.correct / quizResult.total >= 0.6 ? 'pass' : 'fail'}`}>
                  {quizResult.correct} / {quizResult.total} · {pct(quizResult.correct, quizResult.total)} 分
                </div>
              ) : (
                <div className="quiz-progress">已答 {Object.keys(quizAnswers).length}/{quiz.questions.length}</div>
              )}
            </header>
            <div className="quiz-list">
              {quiz.questions.map((q, i) => (
                <QuizQuestion
                  key={q.id ?? q.index}
                  q={q}
                  index={i}
                  answer={quizAnswers[q.id ?? q.index]}
                  result={quizResult?.results?.find((x) => x.index === i)}
                  onChange={(qid, val) => setQuizAnswers((a) => ({ ...a, [qid]: val }))}
                />
              ))}
            </div>
            <footer className="quiz-actions">
              {!quizResult ? (
                <button className="btn-primary" disabled={quizBusy || !Object.keys(quizAnswers).length} onClick={submitQuiz}>
                  {quizBusy ? '判题中…' : '提交答卷'}
                </button>
              ) : (
                <>
                  <button className="btn-ghost" onClick={startQuiz}><Icon name="refresh" size={15} /> 重新出题</button>
                  <button className="btn-primary" onClick={() => setView('study')}><Icon name="book-open" size={15} /> 回到章节</button>
                  <button className="btn-ghost" onClick={openWrongs}><Icon name="alert" size={15} /> 看错题集</button>
                </>
              )}
            </footer>
          </section>
        ))}

        {view === 'wrongs' && (!wrongs ? (
          <div className="chat-loading"><div className="loading-spinner" /><p>加载错题集…</p></div>
        ) : !wrongsQuiz ? (
          <section className="study-wrongs card">
            <header className="study-quiz-head">
              <h2><Icon name="alert" size={17} /> 错题集 · {mod.name}</h2>
              <p className="study-wrongs-hint">答错自动入集；连续答对 2 次自动移出。</p>
            </header>
            {!wrongs.wrongs?.length ? (
              <p className="study-empty">错题集是空的——继续保持，或先去做一套测验。</p>
            ) : (
              <>
                <ul className="study-wrong-list">
                  {wrongs.wrongs.map((w, i) => {
                    const opts = (() => { try { return JSON.parse(w.options_json) || []; } catch { return []; } })();
                    return (
                      <li key={i} className={`study-wrong-item ${w.removed ? 'removed' : ''}`}>
                        <div className="study-wrong-stem">
                          <span className={`quiz-q-type t-${w.type}`}>{QUIZ_TYPE_LABEL[w.type] || '单选'}</span>
                          {w.stem}
                          {w.removed && <em className="study-wrong-tag">已移出</em>}
                        </div>
                        <ul className="study-wrong-opts">
                          {opts.map((o, j) => <li key={j}>{LETTERS[j]}. {o}</li>)}
                        </ul>
                        {w.explanation && <p className="study-wrong-explain">解析：{w.explanation}</p>}
                        {w.chapter_title && <small className="study-wrong-src">来自章节「{w.chapter_title}」</small>}
                      </li>
                    );
                  })}
                </ul>
                <footer className="quiz-actions">
                  <button className="btn-primary" onClick={startWrongsQuiz}>
                    <Icon name="repeat-2" size={15} /> 重练错题（{wrongs.wrongs.filter((w) => !w.removed).length} 题）
                  </button>
                </footer>
              </>
            )}
          </section>
        ) : (
          <section className="study-quiz card">
            <header className="study-quiz-head">
              <h2><Icon name="repeat-2" size={17} /> 错题重练</h2>
              {wrongsResult ? (
                <div className={`quiz-score ${wrongsResult.correct / wrongsResult.total >= 0.6 ? 'pass' : 'fail'}`}>
                  {wrongsResult.correct} / {wrongsResult.total} · {pct(wrongsResult.correct, wrongsResult.total)} 分
                </div>
              ) : (
                <div className="quiz-progress">已答 {Object.keys(wrongsAnswers).length}/{wrongsQuiz.length}</div>
              )}
            </header>
            <div className="quiz-list">
              {wrongsQuiz.map((q, i) => (
                <QuizQuestion
                  key={q.id ?? q.index}
                  q={q}
                  index={i}
                  answer={wrongsAnswers[q.id ?? q.index]}
                  result={wrongsResult?.byIndex?.get(i)}
                  onChange={(qid, val) => setWrongsAnswers((a) => ({ ...a, [qid]: val }))}
                />
              ))}
            </div>
            <footer className="quiz-actions">
              {!wrongsResult ? (
                <button className="btn-primary" disabled={quizBusy} onClick={submitWrongs}>
                  {quizBusy ? '判题中…' : '提交重练'}
                </button>
              ) : (
                <>
                  <button className="btn-ghost" onClick={() => { setWrongsQuiz(null); openWrongs(); }}>
                    <Icon name="arrow-left" size={15} /> 返回错题集
                  </button>
                  <button className="btn-ghost" onClick={() => setView('home')}><Icon name="book" size={15} /> 回章节目录</button>
                </>
              )}
            </footer>
          </section>
        ))}
      </main>
    </div>
  );
}
