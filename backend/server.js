/* ============================================================
 * 云禽智控 · 云端后端（可上线形态）
 * - 鉴权：登录(admin/operator/device 角色) + Bearer Token 会话
 * - 资源：设备 / 遥测 / 指令 / 告警 / 航线 / 站点 / 用户
 * - 静态托管前端；指令回执模拟器（真实网关回执可替换）
 * - 环境配置：.env（PORT / HOST / YQ_DB / CORS_ORIGIN / LOG_LEVEL）
 * 运行：node backend/server.js   →  http://127.0.0.1:8600
 * 默认账号：admin / 123456（上线请立即修改，见 docs/DEPLOY.md）
 * ============================================================ */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { db, now, seq, restoreDeviceTemplate } = require('./db');
const { verifyPassword, hashPassword, newToken, tokenDigest } = require('./security');
const WX = require('./weather');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 8600;
const HOST = process.env.HOST || '0.0.0.0';
const IS_PROD = process.env.NODE_ENV === 'production';
const CORS_ORIGIN = (process.env.CORS_ORIGIN || '').trim();
const LOG_FILE = process.env.YQ_LOG || path.join(ROOT, 'data', 'logs', 'access.log');

/* ---------- 读取根目录 .env（若存在） ---------- */
try {
  const envFile = path.join(ROOT, '.env');
  if (fs.existsSync(envFile)) {
    fs.readFileSync(envFile, 'utf8').split('\n').forEach((ln) => {
      const m = ln.trim().match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    });
  }
} catch (e) { /* 忽略 */ }

fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
function log(level, msg) {
  const line = '[' + new Date().toISOString() + '] ' + level + ' ' + msg;
  if (level === 'ERROR' || !IS_PROD) console[level === 'ERROR' ? 'error' : 'log'](line.replace(/^\[[^\]]*\] /, ''));
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) { /* 日志失败不阻断 */ }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2'
};

/* ---------------- 基础工具 ---------------- */
const send = (res, code, obj) => {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
};
const ok = (res, obj) => { send(res, 200, obj); return true; };
const bad = (res, msg, code) => { send(res, code || 400, { error: msg }); return true; };
const bodyOf = (req) => new Promise((resolve) => {
  let s = '';
  req.on('data', (c) => { s += c; if (s.length > 1e6) req.destroy(); });
  req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { resolve({ __parseError: true }); } });
  req.on('error', () => resolve({ __parseError: true }));
});
const qs = (u) => Object.fromEntries(new URL(u, 'http://x').searchParams.entries());

/* ---------------- 鉴权 ---------------- */
const SESSION_DAYS = { normal: 1, remember: 30 };
/* 注册限流记录（进程内存，重启清零；生产可在前面加 Nginx 限流） */
const REG_GUARD = {};
/* 环境自检结果缓存（避免每次刷新都真实探测外服） */
const HEALTH_CACHE = { t: 0, data: null };
async function authOf(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!token) return null;
  const row = db.prepare(`SELECT s.id sid, s.expires_at, u.id uid, u.username, u.name, u.role
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.digest=?`).get(tokenDigest(token));
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id=?').run(row.sid);
    return null;
  }
  return { sid: row.sid, uid: row.uid, username: row.username, name: row.name, role: row.role };
}
function isAdmin(u) { return !!u && u.role === 'admin'; }
function canControl(u) { return !!u && (u.role === 'admin' || u.role === 'operator'); }

/* ---------------- 指令-状态联动 ---------------- */
const CMD_STATUS = {
  takeoff: 'patrol', start_patrol: 'patrol', rtl: 'standby', back: 'standby',
  land: 'standby', charge: 'charging', reboot: 'online', feed_now: null,
  gimbal: null, shot: null, record: null, speaker: null, stream_on: null, open_fan: null
};
const validDeviceTypes = ['drone', 'camera', 'feeder', 'sensor', 'gateway', 'nest', 'rtk', 'weather'];

/* ---------------- 连接状态：仅当最近有真实遥测/心跳（<90s）且未标记离线才算已连接 ---------------- */
function withLive(rows) {
  const nowMs = Date.now();
  const single = rows ? (Array.isArray(rows) ? rows : [rows]) : [];
  const out = single.map((d) => {
    const last = db.prepare('SELECT ts FROM telemetry WHERE device_id=? ORDER BY id DESC LIMIT 1').get(d.id);
    const lastSeen = last ? new Date(last.ts).getTime() : null;
    const live = !!(lastSeen && d.status !== 'offline' && (nowMs - lastSeen) < 90000);
    return Object.assign({}, d, { live, last_seen: last ? last.ts : null });
  });
  return Array.isArray(rows) ? out : out[0] || null;
}

/* ---------------- API 路由 ---------------- */
async function api(req, res, url) {
  const m = url.pathname.split('/').filter(Boolean);
  const method = req.method;
  if (m[0] !== 'api') return false;

  // CORS（默认同源；生产部署建议用 Nginx 同域反代或设置 CORS_ORIGIN）
  if (CORS_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  }
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }

  const u = await authOf(req);

  /* ============ 认证（公开） ============ */
  if (m[1] === 'auth' && m[2] === 'login' && method === 'POST') {
    const b = await bodyOf(req);
    if (b.__parseError || !b.username || !b.password) return bad(res, '请输入用户名和密码');
    const row = db.prepare('SELECT * FROM users WHERE username=?').get(b.username);
    if (!row || !verifyPassword(b.password, row.salt, row.hash)) {
      log('WARN', '登录失败：' + b.username + ' @ ' + req.socket.remoteAddress);
      return bad(res, '用户名或密码错误', 401);
    }
    const token = newToken();
    const exp = new Date(Date.now() + (b.remember ? SESSION_DAYS.remember : SESSION_DAYS.normal) * 864e5).toISOString();
    db.prepare('INSERT INTO sessions(user_id,digest,expires_at,created_at,ip) VALUES(?,?,?,?,?)')
      .run(row.id, tokenDigest(token), exp, now(), req.socket.remoteAddress || '');
    log('INFO', '登录：' + b.username + ' @ ' + req.socket.remoteAddress);
    return ok(res, { token, user: { id: row.id, username: row.username, name: row.name, role: row.role } });
  }
  if (m[1] === 'auth' && m[2] === 'register' && method === 'POST') {
    if ((process.env.ALLOW_REGISTER || '1') === '0') return bad(res, '当前未开放自助注册：请联系管理员在后台创建账号', 403);
    // 简易限流：同 IP 每小时最多 5 次注册尝试
    const ip = req.socket.remoteAddress || '?';
    REG_GUARD[ip] = (REG_GUARD[ip] || []).filter((t) => Date.now() - t < 3600000);
    if (REG_GUARD[ip].length >= 5) return bad(res, '注册过于频繁，请 1 小时后再试', 429);
    const b = await bodyOf(req);
    if (b.__parseError || !b.username || !b.password) return bad(res, '请完整填写用户名和密码');
    const username = String(b.username).trim();
    if (!/^[A-Za-z0-9_\-]{3,20}$/.test(username)) return bad(res, '用户名需为 3-20 位字母/数字/下划线');
    if (String(b.password).length < 6) return bad(res, '密码至少 6 位');
    if (String(b.password) !== String(b.password2 || '')) return bad(res, '两次输入的密码不一致');
    const name = String(b.name || '').trim().slice(0, 20) || username;
    REG_GUARD[ip].push(Date.now());
    try {
      const hp = hashPassword(String(b.password));
      const t = now();
      // 自助注册默认 operator：可查看与控制指令，但不能管理设备/用户（安全边界）
      db.prepare('INSERT INTO users(username,name,role,salt,hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
        .run(username, name, 'operator', hp.salt, hp.hash, t, t);
      log('INFO', '注册新账号：' + username + ' @ ' + ip);
      return ok(res, { ok: true, user: { username, name, role: 'operator' }, tip: '注册成功，请使用新账号登录' });
    } catch (e) {
      return bad(res, '用户名已存在，请换一个', 409);
    }
  }
  if (m[1] === 'auth' && m[2] === 'logout' && method === 'POST') {
    if (u) db.prepare('DELETE FROM sessions WHERE id=?').run(u.sid);
    return ok(res, { ok: true });
  }
  if (m[1] === 'auth' && m[2] === 'me' && method === 'GET') {
    if (!u) return bad(res, '未登录或登录已过期', 401);
    return ok(res, { id: u.uid, username: u.username, name: u.name, role: u.role });
  }

  /* ============ 环境自检（公开，供启动动画使用；结果缓存 2 分钟） ============ */
  if (m[1] === 'health' && method === 'GET') {
    if (HEALTH_CACHE.t && Date.now() - HEALTH_CACHE.t < 120000) return ok(res, HEALTH_CACHE.data);
    const probe = (fn, timeoutMs) => {
      const t0 = Date.now();
      return Promise.race([
        Promise.resolve().then(fn).then(() => ({ ok: true, ms: Date.now() - t0 })),
        new Promise((r) => setTimeout(() => r({ ok: false, ms: Date.now() - t0, err: '连接超时' }), timeoutMs || 6000))
      ]).catch((e) => ({ ok: false, ms: Date.now() - t0, err: String((e && e.message) || e).slice(0, 90) }));
    };
    const out = {
      ok: true, service: '陇药步云云监控平台', time: now(), node: process.version,
      db: { ok: true },
      deps: {}
    };
    try {
      const tbl = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name IN ('devices','sites','users','alarms','telemetry')").get();
      out.db = { ok: tbl.c === 5, tables: tbl.c };
      if (out.db.ok) out.db.devices = db.prepare('SELECT COUNT(*) c FROM devices').get().c;
    } catch (e) {
      out.db = { ok: false, err: String((e && e.message) || e).slice(0, 90) };
    }
    const site = db.prepare('SELECT * FROM sites LIMIT 1').get();
    const deps = await Promise.all([
      probe(async () => { await WX.fetchWeather(site ? site.lat : 34.96, site ? site.lon : 104.45, site ? site.name : 'probe'); }),
      probe(async () => { await WX.fetchGeocode('北京', 1); }),
      probe(async () => { await WX.fetchGeoIp(); })
    ]);
    out.deps = {
      weather: Object.assign(deps[0], { note: '天气预报 / 预警引擎（Open-Meteo）' }),
      geo: Object.assign(deps[1], { note: '地区搜索（Photon/OSM）' }),
      geoip: Object.assign(deps[2], { note: 'IP 定位（ip-api）' })
    };
    HEALTH_CACHE.t = Date.now();
    HEALTH_CACHE.data = out;
    return ok(res, out);
  }

  /* ============ 其余全部需要登录 ============ */
  if (!u) return bad(res, '未登录或登录已过期', 401);

  /* ---- 用户管理（仅 admin） ---- */
  if (m[1] === 'users' && method === 'GET') {
    if (!isAdmin(u)) return bad(res, '仅管理员可访问', 403);
    return ok(res, db.prepare('SELECT id,username,name,role,created_at FROM users ORDER BY id').all());
  }
  if (m[1] === 'users' && method === 'POST') {
    if (!isAdmin(u)) return bad(res, '仅管理员可操作', 403);
    const b = await bodyOf(req);
    if (!b.username || !b.password) return bad(res, '需要 username/password');
    if (!['admin', 'operator', 'device'].includes(b.role || 'operator')) return bad(res, '非法的角色');
    const hp = hashPassword(b.password);
    const t = now();
    try {
      db.prepare('INSERT INTO users(username,name,role,salt,hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
        .run(b.username, b.name || '', b.role || 'operator', hp.salt, hp.hash, t, t);
      return ok(res, { ok: true });
    } catch (e) { return bad(res, '用户名已存在', 409); }
  }
  if (m[1] === 'users' && m[2] && method === 'PUT') {
    const b = await bodyOf(req);
    const target = db.prepare('SELECT * FROM users WHERE id=?').get(m[2]);
    if (!target) return bad(res, '用户不存在', 404);
    const isSelf = u.uid === target.id;
    if (!isAdmin(u) && !isSelf) return bad(res, '无权操作其他账号', 403);
    if (m[3] === 'password') {
      const np = b.newPassword;
      if (!np || np.length < 6) return bad(res, '新密码至少 6 位');
      if (!isAdmin(u) && !verifyPassword(b.oldPassword || '', target.salt, target.hash)) return bad(res, '原密码错误', 403);
      const hp = hashPassword(np);
      db.prepare('UPDATE users SET salt=?, hash=?, updated_at=? WHERE id=?').run(hp.salt, hp.hash, now(), target.id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id); // 全端下线旧会话
      return ok(res, { ok: true });
    }
    if (isAdmin(u)) {
      const sets = ['updated_at=?']; const vals = [now()];
      if (b.name !== undefined) { sets.push('name=?'); vals.push(b.name); }
      if (b.role !== undefined) { if (!['admin', 'operator', 'device'].includes(b.role)) return bad(res, '非法的角色'); sets.push('role=?'); vals.push(b.role); }
      vals.push(target.id);
      db.prepare('UPDATE users SET ' + sets.join(',') + ' WHERE id=?').run(...vals);
      return ok(res, { ok: true });
    }
    return bad(res, '仅可修改自己的密码', 403);
  }
  if (m[1] === 'users' && m[2] && method === 'DELETE') {
    if (!isAdmin(u)) return bad(res, '仅管理员可操作', 403);
    if (String(u.uid) === String(m[2])) return bad(res, '不能删除当前登录账号');
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(m[2]);
    db.prepare('DELETE FROM users WHERE id=?').run(m[2]);
    return ok(res, { ok: true });
  }

  /* ---- 站点 ---- */
  if (m[1] === 'sites' && method === 'GET') return ok(res, db.prepare('SELECT * FROM sites').all());
  if (m[1] === 'sites' && m[2] && method === 'PUT') {
    if (!isAdmin(u)) return bad(res, '仅管理员可修改站点', 403);
    const s = db.prepare('SELECT * FROM sites WHERE id=?').get(m[2]);
    if (!s) return bad(res, '站点不存在', 404);
    const b = await bodyOf(req);
    const sets = ['updated_at=?']; const vals = [now()];
    ['name', 'prov', 'city', 'county', 'town', 'village', 'lat', 'lon', 'alt', 'rtk_provider', 'rtk_account', 'rtk_secret', 'note'].forEach((k) => {
      if (b[k] !== undefined) { sets.push(k + '=?'); vals.push(b[k]); }
    });
    vals.push(m[2]);
    db.prepare('UPDATE sites SET ' + sets.join(',') + ' WHERE id=?').run(...vals);
    return ok(res, db.prepare('SELECT * FROM sites WHERE id=?').get(m[2]));
  }

  /* ---- bootstrap ---- */
  if (m[1] === 'bootstrap' && method === 'GET') {
    return ok(res, {
      serverTime: now(),
      sites: db.prepare('SELECT * FROM sites').all(),
      devices: withLive(db.prepare('SELECT * FROM devices ORDER BY type, id').all()),
      kv: Object.fromEntries(db.prepare('SELECT k,v FROM kv').all().map((r) => [r.k, r.v]))
    });
  }

  /* ---- 设备 CRUD（写操作仅 admin） ---- */
  if (m[1] === 'devices' && !m[2] && method === 'GET') {
    const t = qs(url).type;
    const rows = t ? db.prepare('SELECT * FROM devices WHERE type=? ORDER BY id').all(t)
      : db.prepare('SELECT * FROM devices ORDER BY type, id').all();
    return ok(res, withLive(rows));
  }
  if (m[1] === 'devices' && m[2] && !m[3] && method === 'GET') {
    const dev = db.prepare('SELECT * FROM devices WHERE id=?').get(m[2]);
    if (!dev) return bad(res, '设备不存在', 404);
    return ok(res, withLive(dev));
  }
  if ((m[1] === 'devices' && !m[2] && method === 'POST')) {
    if (!isAdmin(u)) return bad(res, '仅管理员可新增设备', 403);
    const b = await bodyOf(req);
    if (b.__parseError) return bad(res, 'JSON 解析失败');
    if (!b.type || !validDeviceTypes.includes(b.type)) return bad(res, 'type 必须为 ' + validDeviceTypes.join('/'));
    if (!b.name) return bad(res, '缺少 name');
    const id = (b.id || '').trim() || (b.type.toUpperCase() + '-' + String(seq('dev_' + b.type)).padStart(2, '0'));
    const t = now();
    try {
      db.prepare(`INSERT INTO devices
        (id,site_id,type,sub,name,model,vendor,sn,protocol,stream_url,lat,lon,alt,batt,status,config,note,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, b.site_id || null, b.type, b.sub || '', b.name, b.model || '', b.vendor || '',
        b.sn || '', b.protocol || '', b.stream_url || '', b.lat ?? null, b.lon ?? null,
        b.alt ?? 0, b.batt ?? -1, b.status || 'offline', b.config || '{}', b.note || '', t, t);
      return ok(res, db.prepare('SELECT * FROM devices WHERE id=?').get(id));
    } catch (e) { return bad(res, '写入失败：' + e.message); }
  }
  if (m[1] === 'devices' && m[2] && method === 'PUT') {
    if (!isAdmin(u)) return bad(res, '仅管理员可修改设备', 403);
    const dev = db.prepare('SELECT * FROM devices WHERE id=?').get(m[2]);
    if (!dev) return bad(res, '设备不存在', 404);
    const b = await bodyOf(req);
    if (b.__parseError) return bad(res, 'JSON 解析失败');
    if (b.type !== undefined && !validDeviceTypes.includes(b.type)) return bad(res, '非法的 type');
    const cols = ['site_id', 'type', 'sub', 'name', 'model', 'vendor', 'sn', 'protocol',
      'stream_url', 'lat', 'lon', 'alt', 'batt', 'status', 'config', 'note'];
    const sets = [], vals = [];
    cols.forEach((c) => { if (b[c] !== undefined) { sets.push(c + '=?'); vals.push(b[c]); } });
    sets.push('updated_at=?'); vals.push(now()); vals.push(m[2]);
    db.prepare('UPDATE devices SET ' + sets.join(',') + ' WHERE id=?').run(...vals);
    return ok(res, db.prepare('SELECT * FROM devices WHERE id=?').get(m[2]));
  }
  if (m[1] === 'devices' && m[2] && method === 'DELETE') {
    if (!isAdmin(u)) return bad(res, '仅管理员可删除设备', 403);
    db.prepare('DELETE FROM devices WHERE id=?').run(m[2]);
    return ok(res, { ok: true });
  }
  /* 恢复默认设备模板（仅 admin；删除后不会自动复活，需要模板时手动调用） */
  if (m[1] === 'devices' && m[2] === 'restore-template' && method === 'POST') {
    if (!isAdmin(u)) return bad(res, '仅管理员可操作', 403);
    return ok(res, { ok: true, count: restoreDeviceTemplate() });
  }

  /* ---- 控制指令（admin/operator；device 角色仅可读回执） ---- */
  if (m[1] === 'devices' && m[2] && m[3] === 'command' && method === 'POST') {
    if (!canControl(u)) return bad(res, '当前账号无控制权限', 403);
    const dev = db.prepare('SELECT * FROM devices WHERE id=?').get(m[2]);
    if (!dev) return bad(res, '设备不存在', 404);
    const b = await bodyOf(req);
    if (b.__parseError) return bad(res, 'JSON 解析失败');
    if (!b.cmd) return bad(res, '缺少 cmd');
    const t = now();
    const info = db.prepare(`INSERT INTO commands(device_id,cmd,params,src,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?)`).run(dev.id, b.cmd, JSON.stringify(b.params || {}), b.src || ('web:' + u.username), 'queued', t, t);
    const id = Number(info.lastInsertRowid);
    db.prepare(`UPDATE commands SET status='sent', updated_at=? WHERE id=?`).run(t, id);
    log('INFO', '指令下发 ' + dev.id + ' ' + b.cmd + ' by ' + u.username);
    return ok(res, db.prepare('SELECT * FROM commands WHERE id=?').get(id));
  }
  if (m[1] === 'commands' && method === 'GET') {
    const q = qs(url);
    let sql = 'SELECT * FROM commands'; const where = []; const args = [];
    if (q.device_id) { where.push('device_id=?'); args.push(q.device_id); }
    if (q.status) { where.push('status=?'); args.push(q.status); }
    if (q.cmd) { where.push('cmd=?'); args.push(q.cmd); }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY id DESC LIMIT ' + Math.min(parseInt(q.limit, 10) || 30, 300);
    return ok(res, db.prepare(sql).all(...args));
  }
  /* 网关回执：POST /api/commands/:id/ack {status:'ack'|'fail', msg} */
  if (m[1] === 'commands' && m[2] && m[3] === 'ack' && method === 'POST') {
    if (!canControl(u) && u.role !== 'device') return bad(res, '无回执权限', 403);
    const cmd = db.prepare('SELECT * FROM commands WHERE id=?').get(m[2]);
    if (!cmd) return bad(res, '指令不存在', 404);
    const b = await bodyOf(req);
    const st = b.status === 'fail' ? 'fail' : 'ack';
    db.prepare("UPDATE commands SET status=?, ack_msg=?, updated_at=? WHERE id=?")
      .run(st, b.msg || (st === 'ack' ? '网关已回执' : '网关执行失败'), now(), cmd.id);
    if (st === 'ack') {
      const devSt = CMD_STATUS[cmd.cmd];
      if (devSt) db.prepare('UPDATE devices SET status=?, updated_at=? WHERE id=?').run(devSt, now(), cmd.device_id);
    }
    log('INFO', '指令回执 CMD' + cmd.id + ' → ' + st + ' by ' + u.username);
    return ok(res, { ok: true });
  }

  /* ---- 遥测（设备/网关服务账号上报；任意登录用户可写本设备? 仅 device/admin/operator） ---- */
  if (m[1] === 'telemetry' && method === 'POST') {
    if (!canControl(u) && u.role !== 'device') return bad(res, '无上报权限', 403);
    const b = await bodyOf(req);
    if (!b.deviceId) return bad(res, '缺少 deviceId');
    const t = now();
    db.prepare('INSERT INTO telemetry(device_id,ts,lat,lon,alt,batt,extra) VALUES(?,?,?,?,?,?,?)')
      .run(b.deviceId, t, b.lat ?? null, b.lon ?? null, b.alt ?? null, b.batt ?? null, JSON.stringify(b.extra || {}));
    const sets = ['updated_at=?']; const vals = [t];
    ['lat', 'lon', 'alt', 'batt', 'status'].forEach((k) => { if (b[k] !== undefined) { sets.push(k + '=?'); vals.push(b[k]); } });
    vals.push(b.deviceId);
    const r = db.prepare(`UPDATE devices SET ${sets.join(',')} WHERE id=?`).run(...vals);
    if (r.changes === 0) return bad(res, '设备不存在', 404);
    // 网关经 extra 上报的飞行细节（speed/mode/armed…）合并进设备 config，供前端实况展示
    try {
      if (b.extra && typeof b.extra === 'object') {
        const dev0 = db.prepare('SELECT config FROM devices WHERE id=?').get(b.deviceId);
        const cfg = JSON.parse(dev0.config || '{}');
        ['speed', 'mode', 'armed', 'heading'].forEach((k) => {
          if (b.extra[k] !== undefined) cfg['tel_' + k] = b.extra[k];
        });
        db.prepare('UPDATE devices SET config=? WHERE id=?').run(JSON.stringify(cfg), b.deviceId);
      }
    } catch (e) { /* 合并失败不影响遥测 */ }
    return ok(res, { ok: true });
  }
  if (m[1] === 'devices' && m[2] && m[3] === 'telemetry' && method === 'GET') {
    const q = qs(url);
    const metric = (q.metric || '').trim();
    const limit = Math.min(parseInt(q.limit, 10) || 60, 1000);
    if (!metric) {
      const rows = db.prepare('SELECT * FROM telemetry WHERE device_id=? ORDER BY id DESC LIMIT ?').all(m[2], limit);
      return ok(res, rows);
    }
    // ?metric=temp|hum|nh3|speed|alt|batt…：内置字段直接取，其余从 extra JSON 提取
    const builtin = { lat: 'lat', lon: 'lon', alt: 'alt', batt: 'batt' };
    const rows = db.prepare('SELECT ts,lat,lon,alt,batt,extra FROM telemetry WHERE device_id=? ORDER BY id DESC LIMIT ?').all(m[2], limit);
    const key = builtin[metric] || metric;
    const out = [];
    rows.forEach((r) => {
      let v = null;
      if (builtin[metric]) v = r[key];
      else {
        try {
          const ex = JSON.parse(r.extra || '{}');
          const hit = ex[metric] ?? (ex.weather && ex.weather[metric]);
          v = (hit !== undefined && hit !== null && Number.isFinite(+hit)) ? +hit : null;
        } catch (e) { v = null; }
      }
      if (v !== null) out.push({ ts: r.ts, v });
    });
    out.reverse();
    return ok(res, out);
  }

  /* ---- 采样/时序（健康体重、疫病率、逐时产量补食、批次均重…网关/ERP 上报） ---- */
  if (m[1] === 'samples' && method === 'GET') {
    const q = qs(url);
    let sql = 'SELECT * FROM samples'; const where = []; const args = [];
    if (q.kind) { where.push('kind=?'); args.push(q.kind); }
    if (q.batch) { where.push('batch=?'); args.push(q.batch); }
    if (q.device_id) { where.push('device_id=?'); args.push(q.device_id); }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY id DESC LIMIT ' + Math.min(parseInt(q.limit, 10) || 200, 2000);
    return ok(res, db.prepare(sql).all(...args));
  }
  if (m[1] === 'samples' && method === 'POST') {
    if (!canControl(u) && u.role !== 'device') return bad(res, '无上报权限', 403);
    const b = await bodyOf(req);
    if (!b.kind || b.value === undefined || !Number.isFinite(+b.value)) return bad(res, '需要 kind 与数值 value');
    const t = b.ts || now();
    const info = db.prepare('INSERT INTO samples(device_id,batch,kind,value,unit,meta,ts) VALUES(?,?,?,?,?,?,?)')
      .run(b.device_id || '', b.batch || '', String(b.kind), +b.value, String(b.unit || ''),
        JSON.stringify(b.meta || {}), t);
    return ok(res, { id: Number(info.lastInsertRowid), ts: t });
  }
  if (m[1] === 'samples' && m[2] && method === 'DELETE') {
    if (!isAdmin(u)) return bad(res, '仅管理员可删除采样', 403);
    db.prepare('DELETE FROM samples WHERE id=?').run(m[2]);
    return ok(res, { ok: true });
  }

  /* ---- 批次与溯源（批次主档 + 关键事件时间线；扫码接口复用 GET /api/batches/:id） ---- */
  if (m[1] === 'batches' && !m[2] && method === 'GET') {
    return ok(res, db.prepare('SELECT * FROM batches ORDER BY created_at DESC, id DESC').all());
  }
  if (m[1] === 'batches' && !m[2] && method === 'POST') {
    if (!canControl(u)) return bad(res, '无录入权限（需 admin/operator）', 403);
    const b = await bodyOf(req);
    if (!b.name) return bad(res, '缺少 name');
    const id = (b.id || '').trim() || 'P' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + String(seq('batch')).padStart(2, '0');
    const t = now();
    try {
      db.prepare('INSERT INTO batches(id,name,breed,base,in_count,cur_count,age_days,target_age_d,status,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, b.name, b.breed || '', b.base || '', +(b.in_count ?? 0), +(b.cur_count ?? b.in_count ?? 0),
          +(b.age_days ?? 0), +(b.target_age_d ?? 0), b.status || 'active', b.note || '', t, t);
      return ok(res, db.prepare('SELECT * FROM batches WHERE id=?').get(id));
    } catch (e) { return bad(res, '写入失败（批次号重复？）：' + e.message); }
  }
  if (m[1] === 'batches' && m[2] && !m[3] && method === 'GET') {
    const bat = db.prepare('SELECT * FROM batches WHERE id=?').get(m[2]);
    if (!bat) return bad(res, '批次不存在', 404);
    const evs = db.prepare('SELECT * FROM batch_events WHERE batch=? ORDER BY id DESC LIMIT 200').all(m[2]);
    const ws = db.prepare("SELECT * FROM samples WHERE batch=? AND kind IN('avg_weight','weight') ORDER BY id ASC LIMIT 500").all(m[2]);
    return ok(res, Object.assign({}, bat, { events: evs, weights: ws }));
  }
  if (m[1] === 'batches' && m[2] && method === 'PUT') {
    if (!canControl(u)) return bad(res, '无编辑权限（需 admin/operator）', 403);
    const bat = db.prepare('SELECT * FROM batches WHERE id=?').get(m[2]);
    if (!bat) return bad(res, '批次不存在', 404);
    const b = await bodyOf(req);
    const cols = ['name', 'breed', 'base', 'in_count', 'cur_count', 'age_days', 'target_age_d', 'status', 'note'];
    const sets = [], vals = [];
    cols.forEach((c) => { if (b[c] !== undefined) { sets.push(c + '=?'); vals.push(b[c]); } });
    sets.push('updated_at=?'); vals.push(now()); vals.push(m[2]);
    db.prepare('UPDATE batches SET ' + sets.join(',') + ' WHERE id=?').run(...vals);
    return ok(res, db.prepare('SELECT * FROM batches WHERE id=?').get(m[2]));
  }
  if (m[1] === 'batches' && m[2] && !m[3] && method === 'DELETE') {
    if (!isAdmin(u)) return bad(res, '仅管理员可删除批次', 403);
    db.prepare('DELETE FROM batches WHERE id=?').run(m[2]);
    db.prepare('DELETE FROM batch_events WHERE batch=?').run(m[2]);
    db.prepare("DELETE FROM samples WHERE batch=? AND kind IN('avg_weight','weight')").run(m[2]);
    return ok(res, { ok: true });
  }
  if (m[1] === 'batches' && m[2] && m[3] === 'events' && method === 'GET') {
    return ok(res, db.prepare('SELECT * FROM batch_events WHERE batch=? ORDER BY id DESC LIMIT 200').all(m[2]));
  }
  if (m[1] === 'batches' && m[2] && m[3] === 'events' && method === 'POST') {
    if (!canControl(u)) return bad(res, '无录入权限（需 admin/operator）', 403);
    const bat = db.prepare('SELECT * FROM batches WHERE id=?').get(m[2]);
    if (!bat) return bad(res, '批次不存在', 404);
    const b = await bodyOf(req);
    if (!b.title) return bad(res, '缺少 title');
    const info = db.prepare('INSERT INTO batch_events(batch,ts,kind,title,detail) VALUES(?,?,?,?,?)')
      .run(m[2], b.ts || now(), b.kind || '', b.title, b.detail || '');
    return ok(res, { id: Number(info.lastInsertRowid) });
  }
  if (m[1] === 'batches' && m[2] && m[3] === 'events' && m[4] && method === 'DELETE') {
    if (!isAdmin(u)) return bad(res, '仅管理员可删除事件', 403);
    db.prepare('DELETE FROM batch_events WHERE id=?').run(m[4]);
    return ok(res, { ok: true });
  }


  /* ---- 告警（device 账号可上报，管理员/操作员可处理） ---- */
  if (m[1] === 'alarms' && method === 'GET') {
    const q = qs(url);
    let sql = 'SELECT * FROM alarms'; const where = []; const args = [];
    if (q.status) { where.push('status=?'); args.push(q.status); }
    if (q.device_id) { where.push('device_id=?'); args.push(q.device_id); }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY id DESC LIMIT ' + Math.min(parseInt(q.limit, 10) || 100, 300);
    return ok(res, db.prepare(sql).all(...args));
  }
  if (m[1] === 'alarms' && !m[2] && method === 'POST') {
    if (u.role === 'operator' && !req.headers['x-gw']) return bad(res, '操作员账号不可上报告警', 403);
    const b = await bodyOf(req);
    if (!b.msg) return bad(res, '缺少 msg');
    const info = db.prepare('INSERT INTO alarms(device_id,lv,type,ico,msg,status,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(b.deviceId || '', b.lv || 'warn', b.type || '设备告警', b.ico || 'alert-triangle', b.msg, 'open', now());
    return ok(res, { id: Number(info.lastInsertRowid) });
  }
  if (m[1] === 'alarms' && m[2] && method === 'POST') {
    if (!canControl(u)) return bad(res, '无处理权限', 403);
    db.prepare('UPDATE alarms SET status=? WHERE id=?').run(m[3] === 'misreport' ? 'misreport' : 'ack', m[2]);
    return ok(res, { ok: true });
  }

  /* ---- 航线（写：admin；读：任意登录） ---- */
  if (m[1] === 'waypoints' && method === 'GET') {
    const did = qs(url).device_id;
    const rows = did
      ? db.prepare('SELECT * FROM waypoints WHERE device_id=? ORDER BY idx').all(did)
      : db.prepare('SELECT * FROM waypoints ORDER BY device_id, idx').all();
    return ok(res, rows);
  }
  if (m[1] === 'waypoints' && method === 'POST') {
    if (!isAdmin(u)) return bad(res, '仅管理员可编辑航线', 403);
    const b = await bodyOf(req);
    if (!b.device_id || b.lat === undefined || b.lon === undefined) return bad(res, '需要 device_id/lat/lon');
    const t = now();
    const info = db.prepare('INSERT INTO waypoints(device_id,idx,lat,lon,alt,speed,action,name,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(b.device_id, b.idx ?? 0, b.lat, b.lon, b.alt ?? 40, b.speed ?? 6, b.action || '', b.name || '', t);
    return ok(res, { id: Number(info.lastInsertRowid) });
  }
  if (m[1] === 'waypoints' && m[2] && method === 'DELETE') {
    if (!isAdmin(u)) return bad(res, '仅管理员可编辑航线', 403);
    db.prepare('DELETE FROM waypoints WHERE id=?').run(m[2]);
    return ok(res, { ok: true });
  }

  /* ---- KV ---- */
  if (m[1] === 'kv' && m[2] && method === 'GET') {
    const r = db.prepare('SELECT v FROM kv WHERE k=?').get(m[2]);
    return ok(res, { k: m[2], v: r ? r.v : null });
  }
  if (m[1] === 'kv' && m[2] && method === 'PUT') {
    if (!isAdmin(u)) return bad(res, '仅管理员可写配置', 403);
    const b = await bodyOf(req);
    db.prepare('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(m[2], JSON.stringify(b.v ?? ''));
    return ok(res, { ok: true });
  }

  /* ---- 数据导出（按月下载 CSV，admin/operator） ---- */
  if (m[1] === 'export' && method === 'GET') {
    if (!canControl(u)) return bad(res, '无下载权限（需 admin/operator）', 403);
    const q = qs(url);
    const kind = q.kind || 'telemetry';
    const def = EXPORT_DEFS[kind];
    if (!def) return bad(res, 'kind 需为 ' + Object.keys(EXPORT_DEFS).join('/'));
    const nowD = new Date();
    let y = nowD.getFullYear(), mo = nowD.getMonth() + 1;
    if (q.month) {
      const mm = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(q.month));
      if (!mm) return bad(res, '月份格式应为 YYYY-MM');
      y = +mm[1]; mo = +mm[2];
      if (y < 2000 || y > 2100) return bad(res, '月份超出范围');
    }
    const start = new Date(y, mo - 1, 1);
    const end = new Date(y, mo, 1);
    const startISO = start.toISOString(), endISO = end.toISOString();
    const file = 'yqcloud-' + kind + '-' + y + '-' + String(mo).padStart(2, '0') + '.csv';
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="' + file + '"',
      'Cache-Control': 'no-store'
    });
    res.write('\uFEFF');   // Excel 中文兼容 BOM
    res.write(def.cols.map((c) => csvEsc(c)).join(',') + '\r\n');
    const it = db.prepare(def.sql).iterate(startISO, endISO);
    for (const row of it) {
      res.write(def.cols.map((c) => csvEsc(row[c] == null ? '' : row[c])).join(',') + '\r\n');
    }
    res.end();
    log('INFO', '数据导出 ' + kind + ' ' + y + '-' + mo + ' by ' + u.username);
    return true;
  }
  /* 立即清理过期数据（仅 admin；日常由保留策略定时自动执行） */
  if (m[1] === 'system' && m[2] === 'purge' && method === 'POST') {
    if (!isAdmin(u)) return bad(res, '仅管理员可清理', 403);
    return ok(res, { ok: true, keepDays: DATA_KEEP_DAYS, removed: purgeExpiredData(true) });
  }

  /* ---- 业务指标（总览 KPI 的真实数据源：集蛋线/地磅/计数网关/ERP 上报） ---- */  if (m[1] === 'metrics' && method === 'GET') {
    return ok(res, db.prepare('SELECT * FROM metrics ORDER BY type').all());
  }
  if (m[1] === 'metrics' && method === 'POST') {
    const b = await bodyOf(req);
    if (b.type == null || b.value === undefined || !Number.isFinite(+b.value)) return bad(res, '需要 type 与数值 value');
    const t = now();
    db.prepare(`INSERT INTO metrics(type,name,value,unit,source,note,ts) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(type) DO UPDATE SET value=excluded.value, name=excluded.name, unit=excluded.unit,
      source=excluded.source, note=excluded.note, ts=excluded.ts`)
      .run(String(b.type), String(b.name || ''), +b.value, String(b.unit || ''),
        (b.source || 'user:' + u.username), String(b.note || ''), t);
    return ok(res, { ok: true, type: String(b.type), ts: t });
  }
  if (m[1] === 'metrics' && m[2] && method === 'DELETE') {
    if (!isAdmin(u)) return bad(res, '仅管理员可删除指标', 403);
    db.prepare('DELETE FROM metrics WHERE type=?').run(m[2]);
    return ok(res, { ok: true });
  }

  /* ---- 天气 / 卫星云图（任意登录角色；后端代理外部服务） ---- */
  if (m[1] === 'weather' && !m[2] && method === 'GET') {
    const q = qs(url);
    const site = db.prepare('SELECT * FROM sites LIMIT 1').get();
    // 支持自定义地区（手机天气式）：?lat=&lon=&label=（不传则用基地 SITE-1）
    const lat = q.lat != null ? parseFloat(q.lat) : null;
    const lon = q.lon != null ? parseFloat(q.lon) : null;
    const custom = (lat != null && lon != null && Number.isFinite(lat) && Number.isFinite(lon) &&
      lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180);
    if (!site && !custom) return bad(res, '站点未配置');
    try {
      const label = custom ? decodeURIComponent((q.label || '自定义地区').trim()) : null;
      const data = await WX.fetchWeather(
        custom ? lat : site.lat, custom ? lon : site.lon,
        custom ? label : site.name);
      if (data && data.location) {
        if (custom) {
          data.location.siteId = null;
          data.location.name = label;
          data.location.address = label;
        } else {
          data.location.siteId = site.id;
          data.location.name = site.name;
          data.location.address = [site.prov, site.city, site.county, site.town, site.village].filter(Boolean).join('');
        }
      }
      // 天气预警规则评估（阈值引擎，页面实时推送依据）
      if (data && data.ok !== false) {
        const ev = WX.evaluateWarnings(data);
        data.warnings = ev.warnings;
        data.rules = ev.rules;
        data.codes = ev.codes;
        data.checkedAt = now();
        // “查看即报”：任何查看地区（含基地/自定义）命中即写入云端告警中心；
        // 同地区同类预警 open 不重复、10 分钟冷却，防反复刷屏
        if (ev.warnings.length) {
          const devId = custom ? 'WX-' + Math.abs(+lat).toFixed(4) + '_' + Math.abs(+lon).toFixed(4) : 'SEN-03';
          const lab = custom ? label : siteBaseLabel(site);
          pushWeatherAlarms(ev.warnings, devId, lab, now());
        }
      }
      // 基地实况同步写入“气象站”设备遥测（SEN-03）；自定义地区不污染设备数据
      if (!custom) {
        try {
          if (data && data.current && Number.isFinite(data.current.temp)) {
            db.prepare('INSERT INTO telemetry(device_id,ts,lat,lon,alt,batt,extra) VALUES(?,?,?,?,?,?,?)')
              .run('SEN-03', now(), site.lat, site.lon, site.alt || 0, -1,
                JSON.stringify({ weather: data.current, source: data.source, observedAt: data.observedAt }));
          }
        } catch (e) { /* 遥测写入失败不影响响应 */ }
      }
      return ok(res, data);
    } catch (e) {
      return ok(res, { ok: false, error: String((e && e.message) || e) });
    }
  }
  /* 地区搜索（城市/县镇 → 坐标）：GET /api/geocode?q=成都 */
  if (m[1] === 'geocode' && method === 'GET') {
    const q = (qs(url).q || '').trim();
    if (q.length < 1) return bad(res, '缺少查询词 q');
    try {
      return ok(res, await WX.fetchGeocode(q, qs(url).limit));
    } catch (e) {
      return ok(res, { ok: false, error: String((e && e.message) || e) });
    }
  }
  /* 手动立即检测：基地=自动上报；自定义地区=若该点已设为“监测点”则上报，否则仅本地评估 */
  if (m[1] === 'weather' && m[2] === 'check' && method === 'POST') {
    if (!canControl(u)) return bad(res, '无检测权限（需 admin/operator）', 403);
    const body = await bodyOf(req);
    const lat = body.lat != null ? parseFloat(body.lat) : null;
    const lon = body.lon != null ? parseFloat(body.lon) : null;
    const custom = (lat != null && lon != null && Number.isFinite(lat) && Number.isFinite(lon) &&
      lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180);
    const site = db.prepare('SELECT * FROM sites LIMIT 1').get();
    if (!site && !custom) return bad(res, '站点未配置');
    try {
      // 任何地区立即检测命中都上报（base→SEN-03；其他→WX-坐标），同地区去重
      let deviceId = 'SEN-03';
      let label = siteBaseLabel(site);
      let fetchName = site ? site.name : label;
      if (custom) {
        deviceId = 'WX-' + Math.abs(+lat).toFixed(4) + '_' + Math.abs(+lon).toFixed(4);
        label = String(body.label || '自定义地区');
        fetchName = label;
      }
      const data = await WX.fetchWeather(custom ? lat : site.lat, custom ? lon : site.lon, fetchName, true);
      const ev = WX.evaluateWarnings(data);
      const pushed = pushWeatherAlarms(ev.warnings, deviceId, label, now());
      return ok(res, {
        ok: true, base: !custom, report: true, label, checkedAt: now(), source: data.source,
        current: data.current, daily: data.daily, hourly: data.hourly,
        warnings: ev.warnings, rules: ev.rules, pushed
      });
    } catch (e) {
      return ok(res, { ok: false, error: String((e && e.message) || e) });
    }
  }
  /* 监测点管理（基地恒为监测点；其余点命中同样写入云端告警中心） */
  if (m[1] === 'weather' && m[2] === 'stations' && method === 'GET') {
    const site = db.prepare('SELECT * FROM sites LIMIT 1').get();
    return ok(res, {
      stations: readStations(),
      base: site ? { id: 'SEN-03', name: site.name, label: siteBaseLabel(site), lat: site.lat, lon: site.lon } : null
    });
  }
  if (m[1] === 'weather' && m[2] === 'stations' && method === 'PUT') {
    if (!canControl(u)) return bad(res, '无管理权限（需 admin/operator）', 403);
    const body = await bodyOf(req);
    const arr = Array.isArray(body.stations) ? body.stations : [];
    const okList = arr.filter((s) => s && s.name && Number.isFinite(+s.lat) && Number.isFinite(+s.lon) &&
      +s.lat >= -90 && +s.lat <= 90 && +s.lon >= -180 && +s.lon <= 180)
      .map((s) => ({ name: String(s.name).slice(0, 30), region: String(s.region || '').slice(0, 40), lat: +(+s.lat).toFixed(5), lon: +(+s.lon).toFixed(5) }));
    if (okList.length > 10) return bad(res, '监测点最多 10 个');
    saveStations(okList);
    return ok(res, { ok: true, stations: readStations() });
  }
  /* 最近天气预警：?device=SEN-03(默认) | WX-*（监测点） | all（基地+监测点） */
  if (m[1] === 'weather' && m[2] === 'alerts' && method === 'GET') {
    const dev = (qs(url).device || 'SEN-03').trim();
    if (dev === 'all') {
      return ok(res, db.prepare("SELECT * FROM alarms WHERE device_id='SEN-03' OR device_id LIKE 'WX-%' ORDER BY id DESC LIMIT 40").all());
    }
    return ok(res, db.prepare('SELECT * FROM alarms WHERE device_id=? ORDER BY id DESC LIMIT 30').all(dev));
  }
  if (m[1] === 'geoip' && method === 'GET') {
    try {
      return ok(res, await WX.fetchGeoIp());
    } catch (e) {
      return ok(res, { ok: false, error: String((e && e.message) || e) });
    }
  }
  if (m[1] === 'cloudsat' && method === 'GET') {
    try {
      return ok(res, await WX.fetchCloudsat());
    } catch (e) {
      return ok(res, { ok: false, error: String((e && e.message) || e) });
    }
  }

  return bad(res, '接口不存在：' + method + ' /api/' + m.slice(1).join('/'), 404);
}

/* ---------------- 数据保留策略：时序数据默认保留 30 天，超期自动删除 ----------------
 * 适用：telemetry 遥测 / alarms 告警 / commands 指令流水 / samples 采样（逐时、均重等高频数据）。
 * 档案数据长期保留：设备台账、用户、站点、批次与溯源事件、业务指标快照。
 * 保留天数可用 DATA_KEEP_DAYS 环境变量调整；启动后 30s + 每 6 小时自动清理一次。 */
const DATA_KEEP_DAYS = Math.max(1, parseInt(process.env.DATA_KEEP_DAYS || '30', 10));
function purgeExpiredData(verbose) {
  const cut = new Date(Date.now() - DATA_KEEP_DAYS * 86400000).toISOString();
  const removed = {};
  removed.telemetry = db.prepare('DELETE FROM telemetry WHERE ts < ?').run(cut).changes;
  removed.alarms = db.prepare('DELETE FROM alarms WHERE created_at < ?').run(cut).changes;
  removed.commands = db.prepare('DELETE FROM commands WHERE created_at < ?').run(cut).changes;
  removed.samples = db.prepare('DELETE FROM samples WHERE ts < ?').run(cut).changes;
  if (verbose) log('INFO', '数据保留清理（保留 ' + DATA_KEEP_DAYS + ' 天）：' + JSON.stringify(removed));
  return removed;
}
setTimeout(() => { try { purgeExpiredData(true); } catch (e) { log('WARN', '数据清理失败：' + String((e && e.message) || e)); } }, 30000);
setInterval(() => { try { purgeExpiredData(false); } catch (e) { /* 静默 */ } }, 6 * 3600000);
console.log('[db] 数据保留策略：时序数据 ' + DATA_KEEP_DAYS + ' 天，超期自动删除（DATA_KEEP_DAYS 可调）');

/* 导出表定义（CSV） */
const EXPORT_DEFS = {
  telemetry: { cols: ['id', 'device_id', 'ts', 'lat', 'lon', 'alt', 'batt', 'extra'], sql: 'SELECT * FROM telemetry WHERE ts>=? AND ts<? ORDER BY id' },
  alarms: { cols: ['id', 'device_id', 'lv', 'type', 'ico', 'msg', 'status', 'created_at'], sql: 'SELECT * FROM alarms WHERE created_at>=? AND created_at<? ORDER BY id' },
  commands: { cols: ['id', 'device_id', 'cmd', 'params', 'src', 'status', 'ack_msg', 'created_at', 'updated_at'], sql: 'SELECT * FROM commands WHERE created_at>=? AND created_at<? ORDER BY id' },
  samples: { cols: ['id', 'device_id', 'batch', 'kind', 'value', 'unit', 'meta', 'ts'], sql: 'SELECT * FROM samples WHERE ts>=? AND ts<? ORDER BY id' }
};
function csvEsc(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/* ---------------- 指令回执模拟器 ----------------
 * 仅演示模式（未设置 NODE_ENV=production 且 DEMO_ACK 未关闭）自动回执；
 * 生产环境由 gateway/drone_bridge.py 等真实网关执行后经
 * POST /api/commands/:id/ack 回执，模拟器不会抢占。 */
const DEMO_ACK = !IS_PROD && process.env.DEMO_ACK !== '0';
if (DEMO_ACK) {
  setInterval(() => {
    const t = now();
    const sent = db.prepare("SELECT * FROM commands WHERE status='sent'").all();
    sent.forEach((c) => {
      const dev = db.prepare('SELECT * FROM devices WHERE id=?').get(c.device_id);
      if (dev && dev.status === 'offline') {
        db.prepare("UPDATE commands SET status='fail', ack_msg='设备离线，指令失败', updated_at=? WHERE id=?").run(t, c.id);
      } else {
        db.prepare("UPDATE commands SET status='ack', ack_msg='网关已回执（演示模拟，生产由真实网关回执）', updated_at=? WHERE id=?").run(t, c.id);
        const st = CMD_STATUS[c.cmd];
        if (st && dev) db.prepare('UPDATE devices SET status=?, updated_at=? WHERE id=?').run(st, t, dev.id);
      }
    });
    db.prepare("UPDATE commands SET status='sent', updated_at=? WHERE status='queued'").run(t);
  }, 4000);
  console.log('[demo] 指令回执模拟器已启用（DEMO_ACK；生产 NODE_ENV=production 自动关闭）');
}

/* ---------------- 天气预警：写告警 + 自动巡检 ----------------
 * 规则引擎在 backend/weather.js（阈值/RULES/CODE_ALERTS）。
 * 上报对象 = 基地（device_id=SEN-03）+ 用户设置的“监测点”（device_id=WX-<坐标>），
 * 命中写入 alarms → 报警中心/天气页/铃铛角标联动。
 * 去重：同类预警同 device 已 open 不重复报；10 分钟冷却防风暴刷屏。
 * ============================================================ */
function readStations() {
  try {
    const r = db.prepare('SELECT v FROM kv WHERE k=?').get('weather.stations');
    if (!r) return [];
    const a = JSON.parse(r.v);
    return Array.isArray(a)
      ? a.filter((s) => s && s.name && Number.isFinite(+s.lat) && Number.isFinite(+s.lon) && +s.lat >= -90 && +s.lat <= 90 && +s.lon >= -180 && +s.lon <= 180).slice(0, 10)
      : [];
  } catch (e) { return []; }
}
function saveStations(arr) {
  db.prepare("INSERT INTO kv(k,v) VALUES('weather.stations',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
    .run(JSON.stringify(arr.slice(0, 10)));
}
function devOfStation(s) {
  return 'WX-' + Math.abs(+s.lat).toFixed(4) + '_' + Math.abs(+s.lon).toFixed(4);
}
function siteBaseLabel(site) {
  return [site.county, site.village].filter(Boolean).join('') || site.name || '基地';
}
function pushWeatherAlarms(warnings, deviceId, label, t0) {
  const t = t0 || now();
  const ids = [];
  (warnings || []).forEach((wa) => {
    const open = db.prepare("SELECT COUNT(*) c FROM alarms WHERE type=? AND device_id=? AND status='open'").get(wa.type, deviceId).c;
    if (open > 0) return;
    const recent = db.prepare('SELECT COUNT(*) c FROM alarms WHERE type=? AND device_id=? AND created_at > ?')
      .get(wa.type, deviceId, new Date(new Date(t).getTime() - 600000).toISOString()).c;
    if (recent > 0) return;
    const msg = '【' + label + '】' + wa.msg;
    const info = db.prepare('INSERT INTO alarms(device_id,lv,type,ico,msg,status,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(deviceId, wa.lv === 'crit' ? 'crit' : 'warn', wa.type, wa.ico || 'alert-triangle', msg, 'open', t);
    ids.push(Number(info.lastInsertRowid));
  });
  return ids;
}
const WEATHER_POLL_MIN = Math.max(2, Number(process.env.WEATHER_POLL_MIN) || 10); // 分钟
async function weatherPatrol() {
  const site = db.prepare('SELECT * FROM sites LIMIT 1').get();
  if (!site) return;
  const points = [{ lat: site.lat, lon: site.lon, label: siteBaseLabel(site), dev: 'SEN-03', name: site.name }];
  readStations().forEach((s) => {
    points.push({ lat: +s.lat, lon: +s.lon, label: s.name + (s.region ? ' ' + s.region : ''), dev: devOfStation(s), name: s.name });
  });
  for (const p of points) {
    try {
      const data = await WX.fetchWeather(p.lat, p.lon, p.name);   // 复用 10min 缓存
      const ev = WX.evaluateWarnings(data);
      const ids = pushWeatherAlarms(ev.warnings, p.dev, p.label, now());
      if (ids.length) log('INFO', '天气预警自动巡检：' + p.label + ' 命中 ' + ev.warnings.length + ' 条，已上报告警中心 ' + ids.join(','));
    } catch (e) { log('WARN', '天气巡检失败（' + p.label + '）：' + String((e && e.message) || e)); }
  }
}
setTimeout(() => { weatherPatrol(); }, 20000);
setInterval(weatherPatrol, WEATHER_POLL_MIN * 60000);
console.log('[wx] 天气预警自动巡检已启用：每 ' + WEATHER_POLL_MIN + ' 分钟（基地 + 监测点，规则见 backend/weather.js）');

/* ---------------- 静态文件 ---------------- */
function staticFile(req, res, pathname) {
  let p = decodeURIComponent(pathname || '/');
  if (p === '/' || p === '/index.html') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('404 Not Found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
}

/* ---------------- 入口 ---------------- */
const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const handled = await api(req, res, url);
    if (!handled) staticFile(req, res, url.pathname);
  } catch (e) {
    log('ERROR', e.stack || e.message);
    send(res, 500, { error: '服务器内部错误' });
  } finally {
    if (url.pathname.startsWith('/api/')) log('INFO', req.method + ' ' + url.pathname + ' ' + res.statusCode + ' ' + (Date.now() - t0) + 'ms');
  }
});
server.listen(PORT, HOST, () => {
  console.log('陇药步云 · 云端后端已启动（' + (IS_PROD ? 'production' : 'development') + '）');
  console.log('  后台/API: http://' + (HOST === '0.0.0.0' ? '127.0.0.1' : HOST) + ':' + PORT);
  console.log('  默认账号: admin / 123456（上线请修改，见 docs/DEPLOY.md）');
});
