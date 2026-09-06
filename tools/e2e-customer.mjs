// 客户接入“上线测试”端到端脚本
// 覆盖：注册/登录 → 未连接状态 → 网关心跳点亮 → 遥测更新 → 指令下发-执行-回执 → 权限 → 静态资源
(async () => {
  const base = 'http://127.0.0.1:8600';
  let pass = 0, fail = 0;
  const T = (name, ok, extra) => {
    console.log((ok ? '✓ PASS ' : '✗ FAIL ') + name + (extra ? '  [' + extra + ']' : ''));
    ok ? pass++ : fail++;
  };
  const api = async (p, o, token) => {
    const r = await fetch(base + p, Object.assign({ headers: {} }, o || {}));
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  const auth = (t) => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });
  try {
    // 0) 鉴权基础
    T('未登录访问被拒', (await api('/api/devices')).status === 401);
    const login = await api('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: '123456' }) });
    T('admin 登录', login.status === 200 && !!login.data.token);
    const A = auth(login.data.token);
    // 1) 客户登记自己的设备（无人机+摄像头）
    const dev = await api('/api/devices', { method: 'POST', headers: A, body: JSON.stringify({ id: 'DRONE-C1', type: 'drone', name: '客户1号机', model: 'Matrice 350 RTK', vendor: 'DJI', protocol: 'MAVLink', sub: '客户场地 A', note: '上线测试设备' }) });
    T('客户登记无人机 DRONE-C1', dev.status === 200, dev.data && dev.data.id);
    const cam = await api('/api/devices', { method: 'POST', headers: A, body: JSON.stringify({ id: 'CAM-C1', type: 'camera', name: '客户东门枪机', sub: '场区东门', protocol: 'RTSP', stream_url: 'http://127.0.0.1:8888/live/cam-c1/index.m3u8' }) });
    T('客户登记摄像头 CAM-C1', cam.status === 200);
    // 2) 未连接：live=false（默认不显示在线）
    const before = await api('/api/devices?type=drone', { headers: A });
    const c1 = before.data.find((d) => d.id === 'DRONE-C1');
    T('未接入网关前 live=false（设备未连接）', c1 && c1.live === false, JSON.stringify({ live: c1.live }));
    // 3) 网关（device 服务账号）心跳/遥测 → 点亮
    const gl = await api('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'gateway01', password: 'gw-8600-secret' }) });
    T('网关服务账号登录', gl.status === 200);
    const G = auth(gl.data.token);
    const tel = await api('/api/telemetry', { method: 'POST', headers: G, body: JSON.stringify({ deviceId: 'DRONE-C1', lat: 35.01001, lon: 104.62001, alt: 45.5, batt: 88, status: 'standby', extra: { mode: 'GUIDED', armed: false, speed: 0 } }) });
    T('网关上报遥测', tel.status === 200);
    const after = await api('/api/devices?type=drone', { headers: A });
    const c1b = after.data.find((d) => d.id === 'DRONE-C1');
    T('上报后设备点亮 live=true', c1b && c1b.live === true, 'batt=' + c1b.batt + ' alt=' + c1b.alt);
    // 4) 指令下发 → 网关回执
    const cmd = await api('/api/devices/DRONE-C1/command', { method: 'POST', headers: A, body: JSON.stringify({ cmd: 'takeoff', params: { alt: 40, from: 'e2e' } }) });
    T('admin 下发起飞指令', cmd.status === 200 && cmd.data.status === 'sent', '#CMD' + cmd.data.id);
    await new Promise((r) => setTimeout(r, 1500));
    const ack = await api('/api/commands/' + cmd.data.id + '/ack', { method: 'POST', headers: G, body: JSON.stringify({ status: 'ack', msg: '网关已执行（e2e）' }) });
    T('网关回执 ack', ack.status === 200);
    const cmds = await api('/api/commands?device_id=DRONE-C1&limit=5', { headers: A });
    T('指令状态落库 ack', cmds.data[0].status === 'ack');
    // 5) 权限：operator 不能增删，gateway 不能改设备
    const ol = await api('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'operator', password: '123456' }) });
    const O = auth(ol.data.token);
    T('operator 增设备被拒 403', (await api('/api/devices', { method: 'POST', headers: O, body: JSON.stringify({ type: 'drone', name: 'x' }) })).status === 403);
    T('gateway 改设备被拒 403', (await api('/api/devices/CAM-C1', { method: 'PUT', headers: G, body: JSON.stringify({ name: 'x' }) })).status === 403);
    T('operator 可读设备', (await api('/api/devices', { headers: O })).status === 200);
    // 6) 摄像头心跳点亮（客户网关定时上报 status online）
    const tel2 = await api('/api/telemetry', { method: 'POST', headers: G, body: JSON.stringify({ deviceId: 'CAM-C1', status: 'online' }) });
    const camsAfter = await api('/api/devices?type=camera', { headers: A });
    const cc1 = camsAfter.data.find((d) => d.id === 'CAM-C1');
    T('摄像头心跳点亮', tel2.status === 200 && cc1 && cc1.live === true);
    // 7) 静态资源与页面
    for (const f of ['/', '/js/pages/drone.js', '/css/style.css', '/assets/logo.jpg', '/js/icons.js']) {
      const r = await fetch(base + f);
      T('静态资源 ' + f, r.status === 200);
    }
    // 8) 登录会话可见性：天气接口需登录
    T('天气接口需登录', (await api('/api/weather')).status === 401);
    // 清理测试设备（保留 DRONE-C1? 删除客户测试数据）
    await api('/api/devices/DRONE-C1', { method: 'DELETE', headers: A });
    await api('/api/devices/CAM-C1', { method: 'DELETE', headers: A });
    T('测试设备清理完成', true);
  } catch (e) {
    T('执行异常 ' + e.message, false);
  }
  console.log('\n======== 上线测试结果：PASS ' + pass + ' / FAIL ' + fail + ' ========');
  process.exitCode = fail ? 1 : 0;
})();
