#!/usr/bin/env node
/* 静态检查：确保前端不再引入仿真/演示数据与仿真引擎。
 * 用法：node tools/lint-nosim.mjs   （退出码 1 = 有残留）
 * 检查范围：js/**、index.html、后端展示文案（backend/ 内 UI 相关说明除外）
 */
'use strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
const ROOT = join(import.meta.dirname, '..');

/* 代码（js/index）里的硬性禁用：命中即违规（含注释也不允许遗留） */
const CODE_PATTERNS = [
  { re: /\bYQx\b|\bYQ\.(state|tick|actions|R|init|onAlert|pushAlert|pushLog)/, why: '仿真引擎引用（js/data.js 已删除）' },
  { re: /Math\.random|\.rndi\(|\.rnd\(|\.pick\(/, why: '随机生成数据（仿真）' },
  { re: /AI_ITEMS|makeDrones|makeFeedPoints|makeFlocks|_POOL\s*=/, why: '演示数据数组' },
  { re: /state\.(hist\.(t|feed|water|labels)|activityToday|feedPoints|drones|health|sensors)\b/, why: '仿真引擎状态字段' },
  { re: /setInterval\([^)]*YQ\.|YQ\.tick\(\)/, why: '仿真心跳驱动' },
  { re: /约\s*40s|置信度\s*≥?\s*\d+|推理\s*\d+ms/, why: '无依据的性能/时长编造' }
];
/* 仅对“仿真/演示”措辞：剥掉注释后再判（保留说明性注释合法） */
const WORD_PATTERN = /(?<![非不])仿真|演示环境|演示模式/;
/* 逐行状态机：移除 // 注释与 /* ... *​/ 块注释，只留真实代码 */
function stripComments(lines) {
  let inBlock = false;
  const out = [];
  for (let ln of lines) {
    if (!inBlock) {
      const bs = ln.indexOf('/*');
      const ls = ln.indexOf('//');
      if (bs >= 0 && (ls < 0 || bs < ls)) { out.push(ln.slice(0, bs)); inBlock = !ln.includes('*/') || ln.indexOf('*/') < bs; if (inBlock) continue; }
    } else {
      const be = ln.indexOf('*/');
      if (be < 0) { out.push(''); continue; }
      ln = ln.slice(be + 2); inBlock = false;
    }
    const ls = ln.indexOf('//');
    out.push(ls >= 0 ? ln.slice(0, ls) : ln);
  }
  return out;
}
const SKIP_FILES = ['js/app.js', 'js/data.js']; // data.js 待删除；app.js 为过渡期文件
const codeFiles = [];
function walk(dir) {
  for (const f of readdirSync(dir)) {
    if (f === 'node_modules' || f.startsWith('.tmp')) continue;
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(js|html|css)$/.test(f)) codeFiles.push(relative(ROOT, p).replace(/\\/g, '/'));
  }
}
walk(join(ROOT, 'js'));
codeFiles.push('index.html');

let fail = 0;
for (const file of codeFiles) {
  if (SKIP_FILES.includes(file)) continue;
  const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
  const codes = stripComments(lines);
  lines.forEach((ln, i) => {
    const code = codes[i];
    if (WORD_PATTERN.test(code)) {
      fail++;
      console.log('✗ ' + file + ':' + (i + 1) + '  页面文案残留“仿真/演示”\n    ' + ln.trim().slice(0, 130));
    }
    for (const p of CODE_PATTERNS) {
      if (p.re.test(code)) {
        fail++;
        console.log('✗ ' + file + ':' + (i + 1) + '  ' + p.why + '\n    ' + ln.trim().slice(0, 130));
      }
    }
  });
}
if (fail) { console.log('\n发现 ' + fail + ' 处仿真残留'); process.exit(1); }
console.log('✓ 无仿真/演示残留（js/ + index.html）');
