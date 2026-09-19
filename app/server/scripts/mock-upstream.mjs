#!/usr/bin/env node
// 压测用 mock 上游：OpenAI 兼容 /v1/chat/completions（SSE）。
// 可控变量：首字节延迟（--ttfb）、token 数（--tokens）、吐字间隔（--interval）。
// 用法：node scripts/mock-upstream.mjs --port 9099 --ttfb 300 --tokens 80 --interval 25
import http from 'node:http';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  // 注意：初始值是数组，必须 push [key, value] 二元组再交给 Object.fromEntries；
  // 直接 acc[key]=v 只是在数组上挂命名属性，fromEntries 会全部丢弃（flag 静默失效）
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
  return acc;
}, []));

const PORT = Number(args.port || 9099);
const TTFB = Number(args.ttfb ?? 300);
const TOKENS = Number(args.tokens ?? 80);
const INTERVAL = Number(args.interval ?? 25);

let active = 0;
let total = 0;

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ active, total }));
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    total += 1;
    active += 1;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    // 幂等收尾：req close 与正常结束都会走到，不能重复扣减（否则 active 变负数）
    let finished = false;
    const finish = () => { if (!finished) { finished = true; active -= 1; } };
    req.on('close', finish);
    setTimeout(() => {
      let i = 0;
      const send = () => {
        if (res.writableEnded) { finish(); return; }
        if (i >= TOKENS) {
          res.write('data: [DONE]\n\n');
          res.end();
          finish();
          return;
        }
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '测' } }] })}\n\n`);
        i += 1;
        setTimeout(send, INTERVAL);
      };
      send();
    }, TTFB);
  });
});
server.listen(PORT, () => console.log(`mock upstream on :${PORT} ttfb=${TTFB}ms tokens=${TOKENS} interval=${INTERVAL}ms`));
