// 鉴权冒烟（补测 401 / 错误密码 / device 账号遥测）
(async () => {
  const base = 'http://127.0.0.1:8600';
  const j = (r) => r.json();
  const st = async (p, o) => (await fetch(base + p, o)).status;
  console.log('no-token /api/devices ->', await st('/api/devices'));
  console.log('wrong password ->', await st('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'wrong' }) }));
  const gw = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'gateway01', password: 'gw-8600-secret' }) }).then(j);
  console.log('gateway01 login ->', gw.user.role);
  const tel = await fetch(base + '/api/telemetry', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + gw.token }, body: JSON.stringify({ deviceId: 'DRONE-01', lat: 34.9613, lon: 104.4522, alt: 52, batt: 69, status: 'patrol' }) });
  console.log('device-account telemetry ->', tel.status, (await tel.json()).ok);
  const admin = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: '123456' }) }).then(j);
  const ah = { 'content-type': 'application/json', authorization: 'Bearer ' + admin.token };
  const mk = await fetch(base + '/api/users', { method: 'POST', headers: ah, body: JSON.stringify({ username: 'tester', name: '测试员', role: 'operator', password: 'abc12345' }) });
  console.log('create user ->', mk.status);
  const list = await fetch(base + '/api/users', { headers: ah }).then(j);
  console.log('users ->', list.map((x) => x.username).join(','));
  const u2 = list.find((x) => x.username === 'tester');
  await fetch(base + '/api/users/' + u2.id, { method: 'DELETE', headers: ah });
  console.log('cleanup tester ok');
  const bad2 = await fetch(base + '/api/users', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + gw.token }, body: JSON.stringify({ username: 'x', password: 'x123456' }) });
  console.log('device-account create-user ->', bad2.status, '(expect 403)');
})();
