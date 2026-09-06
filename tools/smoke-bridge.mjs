// 网关桥上报（模拟 bridge 载荷）→ 设备 config 合并 → 前端可读字段验证
(async () => {
  const base = 'http://127.0.0.1:8600';
  const gw = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'gateway01', password: 'gw-8600-secret' }) }).then((r) => r.json());
  const h = { 'content-type': 'application/json', authorization: 'Bearer ' + gw.token };
  // 模拟 drone_bridge.py 的 2 秒遥测载荷
  for (let i = 0; i < 3; i++) {
    const lat = 34.9611 + i * 0.0004, lon = 104.4522 + i * 0.0005;
    await fetch(base + '/api/telemetry', { method: 'POST', headers: h, body: JSON.stringify({
      deviceId: 'DRONE-01', lat, lon, alt: 50 + i, batt: 70 - i, status: 'patrol',
      extra: { mode: 'GUIDED', armed: true, speed: 6.3 + i * 0.1 }
    }) });
  }
  const dev = await fetch(base + '/api/devices/DRONE-01', { headers: { authorization: 'Bearer ' + gw.token } }).then((r) => r.json());
  const cfg = JSON.parse(dev.config || '{}');
  console.log('device:', dev.status, dev.lat.toFixed(6), dev.lon.toFixed(6), 'batt', dev.batt);
  console.log('config tel_*:', JSON.stringify({ mode: cfg.tel_mode, armed: cfg.tel_armed, speed: cfg.tel_speed }));
  const tel = await fetch(base + '/api/devices/DRONE-01/telemetry?limit=3', { headers: { authorization: 'Bearer ' + gw.token } }).then((r) => r.json());
  console.log('telemetry rows:', tel.length, 'last extra:', tel[0].extra.slice(0, 130));
  if (Math.abs(dev.lat - 34.9619) > 1e-6 || cfg.tel_speed !== 6.5 || cfg.tel_mode !== 'GUIDED') { console.log('FAIL mismatch'); process.exitCode = 1; }
  else console.log('✅ 桥上报→数据库→前端读取字段 全链路 OK');
})();
