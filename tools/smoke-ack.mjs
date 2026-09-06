// 网关回执端点冒烟：指令下发 → 网关立即 ack → 模拟器不覆盖
(async () => {
  const base = 'http://127.0.0.1:8600';
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'gateway01', password: 'gw-8600-secret' }) }).then((r) => r.json());
  if (!login.token) { console.log('gateway login FAIL'); process.exitCode = 1; return; }
  const h = { 'content-type': 'application/json', authorization: 'Bearer ' + login.token };
  const admin = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: '123456' }) }).then((r) => r.json());
  const ah = { 'content-type': 'application/json', authorization: 'Bearer ' + admin.token };
  // 管理员下发指令（开发模式会先置 sent）
  const cmd = await fetch(base + '/api/devices/DRONE-01/command', { method: 'POST', headers: ah, body: JSON.stringify({ cmd: 'rtl', params: { t: Date.now() } }) }).then((r) => r.json());
  console.log('command created:', cmd.id, cmd.status);
  // 网关（device 账号）立即回执 ack
  const ack = await fetch(base + '/api/commands/' + cmd.id + '/ack', { method: 'POST', headers: h, body: JSON.stringify({ status: 'ack', msg: '真实网关执行完成 (drone_bridge.py)' }) });
  console.log('gateway ack ->', ack.status, JSON.stringify(await ack.json()));
  await new Promise((r) => setTimeout(r, 4500)); // 等模拟器周期过去，确认不覆盖
  const after = await fetch(base + '/api/commands?limit=5', { headers: h }).then((r) => r.json());
  const mine = after.find((c) => c.id === cmd.id);
  console.log('after simulator cycle:', mine.status, '|', mine.ack_msg);
  if (mine.status !== 'ack' || mine.ack_msg.indexOf('真实网关') < 0) { console.log('FAIL: 模拟器覆盖了网关回执'); process.exitCode = 1; }
  else console.log('✅ 网关回执闭环验证通过（模拟器不抢占已回执指令）');
  // 遥测携带 extra mode 验证
  const tel = await fetch(base + '/api/telemetry', { method: 'POST', headers: h, body: JSON.stringify({ deviceId: 'DRONE-01', lat: 34.9622, lon: 104.4533, alt: 48, batt: 73, status: 'flight', extra: { mode: 'GUIDED', armed: true } }) });
  console.log('telemetry with extra:', tel.status);
})();
