// 构建 js/icons.js：从 Tabler Icons 提取线性图标内容并打包（构建期脚本，运行一次后无需保留）
const fs = require('fs');
const path = require('path');
const SRC = process.argv[2] || (path.join(process.env.TEMP || '', 'dsh-icons', 'node_modules', '@tabler', 'icons', 'icons'));
const OUT = process.argv[3] || path.join('C:\\Users\\f2211\\Desktop\\平台', 'js', 'icons.js');

// 项目中实际使用的 Tabler 图标名（24px 线性风格）
const NAMES = ['layout-dashboard','video','drone','camera','search','bell','menu-2','user','users','heartbeat','heart','eggs','egg','package','battery',
  'alert-triangle','alert-octagon','info-circle','circle-check','circle-dot','x','check','clock','phone','qrcode','scan','activity','temperature','wind','sun','cloud','cloud-rain','cloud-snow','cloud-storm','snowflake','radar','droplet',
  'map','map-2','calendar','refresh','shield','shield-check','mountain','building','building-hospital','tree','radio','bolt','photo','disc','volume','player-play','player-stop',
  'chart-line','chart-bar','chart-pie','chart-dots','settings','gauge','scale','route','target','truck','clipboard','clipboard-check','medicine-syrup','stethoscope','report-medical','report-analytics','vaccine','ballpen','file-check','microscope','box','stack','list-check','bell-ringing','bell-plus','focus-2','movie','device-cctv','cpu','bulb','feather','moon','home-2','plane','wifi','link','fence','dog','door-exit','adjustments','soup','carrot','plant-2','leaf','arrow-up','arrow-down','arrow-left','arrow-right','chevron-right','pencil','refresh-off','files','route','calendar-time','arrow-up-right','sort-descending','zoom-in','antenna','satellite','zoom-out','current-location','plus','send','pencil','download'];

const missing = [];
const defs = {};
for (const n of NAMES) {
  const f = path.join(SRC, n + '.svg');
  if (!fs.existsSync(f)) { missing.push(n); continue; }
  const s = fs.readFileSync(f, 'utf8');
  const m = s.match(/<svg[^>]*>([\s\S]*)<\/svg>/);
  if (!m) { missing.push(n + '(parse)'); continue; }
  defs[n] = m[1].replace(/\n\s*/g, '').trim();
}
if (missing.length) {
  console.error('MISSING ICONS: ' + missing.join(', '));
  process.exit(1);
}

const out = `/* ============================================================
 * 图标库：Tabler Icons（MIT License）线性图标，24px 视图
 * 使用：I('video', 16) 返回内联 SVG，颜色继承 currentColor
 * ============================================================ */
(function (global) {
  'use strict';
  const DEFS = ${JSON.stringify(defs)};
  function I(name, size) {
    const content = DEFS[name] || DEFS['circle-dot'] || '';
    const px = size || 16;
    return '<svg class="ic" xmlns="http://www.w3.org/2000/svg" width="' + px + '" height="' + px + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + content + '</svg>';
  }
  I.has = function (name) { return !!DEFS[name]; };
  global.I = I;
})(window);
`;

fs.writeFileSync(OUT, out, 'utf8');
console.log('written: ' + OUT + ' (' + Object.keys(defs).length + ' icons)');
