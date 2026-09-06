// 天气与云图接口冒烟
(async () => {
  const base = 'http://127.0.0.1:8600';
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: '123456' }) }).then((r) => r.json());
  const h = { authorization: 'Bearer ' + login.token };
  const wx = await fetch(base + '/api/weather', { headers: h }).then((r) => r.json());
  console.log('weather ok:', wx.ok, '| src:', wx.source, '| current:', JSON.stringify(wx.current ? { temp: wx.current.temp, code: wx.current.code, wind: wx.current.wind, cloud: wx.current.cloud } : null));
  if (wx.ok && wx.daily) console.log('daily days:', wx.daily.length, 'first:', JSON.stringify(wx.daily[0]).slice(0, 140));
  const cs = await fetch(base + '/api/cloudsat', { headers: h }).then((r) => r.json());
  console.log('cloudsat ok:', cs.ok, '| provider:', cs.provider);
  if (cs.ok) {
    console.log('frames:', cs.frames.length, 'latest:', JSON.stringify(cs.latest).slice(0, 150));
    const img = await fetch(cs.frames[0].url, { signal: AbortSignal.timeout(20000), headers: { referer: 'https://www.nmc.cn/' } });
    console.log('frame img fetch ->', img.status, (img.headers.get('content-type') || ''));
  }
  // 气象站遥测注入检查
  const tel = await fetch(base + '/api/devices/SEN-03/telemetry?limit=1', { headers: h }).then((r) => r.json());
  console.log('SEN-03 telemetry rows:', tel.length, tel[0] ? tel[0].extra.slice(0, 120) : 'none');
})();
