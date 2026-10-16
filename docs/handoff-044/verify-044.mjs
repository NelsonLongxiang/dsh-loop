// 0.4.4 上线终验脚本（龙翔重启 3080 后运行：node docs/handoff-044/verify-044.mjs）
// 归档修正（2026-10-16）：本包 "type": "module"，原稿的 require 在 .mjs 下必然
// ReferenceError（脚本从未真正可跑）；改为 ESM import 后归档。
import http from 'node:http';
import fs from 'node:fs';
const get = (u) => new Promise(r => http.get(u, res => { let b=''; res.on('data',c=>b+=c); res.on('end',()=>r({code:res.statusCode, body:b})); }).on('error',e=>r({code:0,body:e.message})));
(async () => {
  const out = [];
  const route = await get('http://127.0.0.1:3080/plugins/dsh-loop/loops');
  const loops = JSON.parse(route.body||'{}').loops||[];
  out.push('1) route: ' + route.code + ' loops=' + loops.length);
  const now = Date.now();
  const od = loops.filter(l=>l.nextTickAt && now>l.nextTickAt).length;
  out.push('2) overdue=' + od + '/' + loops.length);
  let hist = 0;
  try { hist = fs.readFileSync('C:/Users/Administrator/.dsh/plugins-data/dsh-loop/loops.history.jsonl','utf8').trim().split('\n').filter(x=>x.includes('"remounted"')).length; } catch {}
  out.push('3) ledger remounted=' + hist);
  const bundle = await get('http://127.0.0.1:3080/plugins/@nelsonlongxiang/dsh-loop/client.js');
  out.push('4) bundle POLL_IDLE_MS=' + /POLL_IDLE_MS *= *(\d+e\d+)/.test(bundle.body) + ' code=' + bundle.code);
  console.log(out.join('\n'));
})();
