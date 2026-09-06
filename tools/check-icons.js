// 校验项目引用的所有图标 key 均存在于 js/icons.js
const fs = require('fs');
const path = require('path');
const root = 'C:/Users/f2211/Desktop/平台';
const defsSrc = fs.readFileSync(path.join(root, 'js', 'icons.js'), 'utf8');
const defs = new Set([...defsSrc.matchAll(/"([a-z0-9-]+)":/g)].map((m) => m[1]));
const used = new Set();
function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); }
    else if (/\.(js|html)$/.test(e.name) && !e.name.includes('echarts') && !e.name.includes('icons.js') && !e.name.includes('build-icons')) {
      const s = fs.readFileSync(p, 'utf8');
      for (const m of s.matchAll(/I\(\s*'([a-z0-9-]+)'/g)) used.add(m[1]);
      for (const m of s.matchAll(/I\(\s*"([a-z0-9-]+)"/g)) used.add(m[1]);
      for (const m of s.matchAll(/(?:ico|icon)\s*:\s*'([a-z0-9-]+)'/g)) used.add(m[1]);
      for (const m of s.matchAll(/ico\.(innerHTML)\s*=\s*I\('([a-z0-9-]+)'/g)) used.add(m[2]);
    }
  }
}
walk(path.join(root, 'js'));
walk(path.join(root, 'assets') === 'x' ? '' : root, true);
const miss = [...used].filter((k) => !defs.has(k));
console.log('referenced keys: ' + used.size + ' / in lib: ' + defs.size);
if (miss.length) { console.log('MISSING FROM LIB: ' + miss.join(', ')); process.exitCode = 1; }
else console.log('all referenced icons present ✓');
