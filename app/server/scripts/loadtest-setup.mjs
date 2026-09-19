#!/usr/bin/env node
// 压测前置：批量创建虚拟用户（load0..loadN-1），密码统一 loadtest-123。
// 用法：node scripts/loadtest-setup.mjs --url http://127.0.0.1:18096 --count 2000
import { execFileSync } from 'node:child_process';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  // 注意：初始值是数组，必须 push [key, value] 二元组再交给 Object.fromEntries；
  // 直接 acc[key]=v 只是在数组上挂命名属性，fromEntries 会全部丢弃（flag 静默失效）
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
  return acc;
}, []));
const BASE = args.url || 'http://127.0.0.1:18096';
const COUNT = Number(args.count || 100);
const PWD = args.password || 'loadtest-123';
const ADMIN_PWD = args['admin-password'] || PWD;

// 管理员登录（走 api 即可；smoke 里已建好 admin）
let cookie = '';
const login = await fetch(BASE + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: ADMIN_PWD }),
});
if (!login.ok) {
  // 退化：试默认管理员口令
  const r2 = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: ADMIN_PWD }),
  });
  if (!r2.ok) { console.error('管理员登录失败（--admin-password）'); process.exit(1); }
  cookie = (r2.headers.get('set-cookie') || '').split(';')[0];
} else {
  cookie = (login.headers.get('set-cookie') || '').split(';')[0];
}

const CONC = 20;
let made = 0;
for (let i = 0; i < COUNT; i += CONC) {
  const batch = Array.from({ length: Math.min(CONC, COUNT - i) }, (_, k) => i + k);
  await Promise.all(batch.map(async (idx) => {
    const r = await fetch(BASE + '/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ username: `load${idx}`, password: PWD }),
    });
    if (r.ok || r.status === 409) made += 1; // 409 = 已存在，也算就位
  }));
}
console.log(`就位 ${made}/${COUNT} 个虚拟用户（load0..load${COUNT - 1}，密码 ${PWD}）`);
