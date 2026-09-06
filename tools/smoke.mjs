// 后端+前端资源冒烟
(async () => {
  const base = 'http://127.0.0.1:8600';
  try {
    const s1 = await fetch(base + '/api/sites').then((r) => r.json());
    const upd = await fetch(base + '/api/sites/' + s1[0].id, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lat: 34.96123, lon: 104.45211 }) }).then((r) => r.json());
    console.log('site updated:', upd.lat, upd.lon, upd.name);
    const idx = await fetch(base + '/').then((r) => r.text());
    console.log('nav devices:', idx.indexOf('data-page="devices"') >= 0, '| script:', idx.indexOf('pages/devices.js') >= 0);
    const assets = {};
    for (const p of ['js/pages/devices.js', 'js/satmap.js', 'js/icons.js', 'css/style.css']) assets[p] = (await fetch(base + '/' + p)).status;
    console.log('assets:', JSON.stringify(assets));
  } catch (e) { console.log('FAIL', e.message); process.exitCode = 1; }
})();
