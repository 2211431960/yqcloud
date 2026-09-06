/* ============================================================
 * 云禽智控 · 后台数据库（SQLite via node:sqlite，Node >= 22.5）
 * 表：sites / devices / telemetry / commands / alarms / waypoints / kv
 * ============================================================ */
'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const { hashPassword } = require('./security');

const DB_PATH = process.env.YQ_DB || path.join(__dirname, '..', 'data', 'yqcloud.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sites(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prov TEXT DEFAULT '', city TEXT DEFAULT '', county TEXT DEFAULT '',
  town TEXT DEFAULT '', village TEXT DEFAULT '',
  lat REAL NOT NULL, lon REAL NOT NULL, alt REAL DEFAULT 0,
  rtk_provider TEXT DEFAULT '', rtk_account TEXT DEFAULT '', rtk_secret TEXT DEFAULT '',
  note TEXT DEFAULT '',
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS devices(
  id TEXT PRIMARY KEY,
  site_id TEXT REFERENCES sites(id),
  type TEXT NOT NULL,                -- drone|camera|feeder|sensor|gateway|nest|rtk|weather
  sub TEXT DEFAULT '',
  name TEXT NOT NULL, model TEXT DEFAULT '', vendor TEXT DEFAULT '',
  sn TEXT DEFAULT '',
  protocol TEXT DEFAULT '',          -- MAVLink / RTSP / Modbus / MQTT...
  stream_url TEXT DEFAULT '',        -- RTSP / HLS / RTMP 推流地址
  lat REAL, lon REAL, alt REAL DEFAULT 0,
  batt REAL DEFAULT -1,
  status TEXT DEFAULT 'offline',     -- online|offline|standby|charging|flight|patrol
  config TEXT DEFAULT '{}',          -- JSON 扩展参数
  note TEXT DEFAULT '',
  created_at TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_dev_type ON devices(type);
CREATE INDEX IF NOT EXISTS idx_dev_site ON devices(site_id);

CREATE TABLE IF NOT EXISTS telemetry(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  lat REAL, lon REAL, alt REAL, batt REAL,
  extra TEXT DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_tel_dev ON telemetry(device_id, ts DESC);

CREATE TABLE IF NOT EXISTS commands(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  cmd TEXT NOT NULL,
  params TEXT DEFAULT '{}',
  src TEXT DEFAULT 'web',
  status TEXT DEFAULT 'queued',      -- queued|sent|ack|timeout|fail
  ack_msg TEXT DEFAULT '',
  created_at TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_cmd_dev ON commands(device_id, id DESC);

CREATE TABLE IF NOT EXISTS alarms(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT DEFAULT '',
  lv TEXT DEFAULT 'warn',            -- crit|warn|info
  type TEXT DEFAULT '', ico TEXT DEFAULT 'alert-triangle',
  msg TEXT NOT NULL,
  status TEXT DEFAULT 'open',        -- open|ack|misreport
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_alm_st ON alarms(status, id DESC);

CREATE TABLE IF NOT EXISTS waypoints(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  idx INTEGER DEFAULT 0,
  lat REAL NOT NULL, lon REAL NOT NULL, alt REAL DEFAULT 40,
  speed REAL DEFAULT 6, action TEXT DEFAULT '', name TEXT DEFAULT '',
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_wp_dev ON waypoints(device_id, idx);

CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);

CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  name TEXT DEFAULT '',
  role TEXT DEFAULT 'operator',     -- admin | operator | device
  salt TEXT NOT NULL, hash TEXT NOT NULL,
  created_at TEXT, updated_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  digest TEXT UNIQUE NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT,
  ip TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS metrics(
  type TEXT PRIMARY KEY,          -- birds / eggs_today / feed_kg_today / water_kg_today / health_index ...
  name TEXT DEFAULT '',
  value REAL NOT NULL,
  unit TEXT DEFAULT '',
  source TEXT DEFAULT '',
  note TEXT DEFAULT '',
  ts TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS samples(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT DEFAULT '',     -- 上报设备（网关/边缘盒/移动端）
  batch TEXT DEFAULT '',         -- 所属批次（溯源/健康按批次检索）
  kind TEXT NOT NULL,            -- avg_weight / weight / sick_rate / intake_h / eggs_h / isolate / ...
  value REAL NOT NULL,
  unit TEXT DEFAULT '',
  meta TEXT DEFAULT '{}',        -- 附加 JSON：{age_d, hour, note...}
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_samples_lookup ON samples(kind, batch, device_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_samples_ts ON samples(ts);
CREATE INDEX IF NOT EXISTS idx_telemetry_ts ON telemetry(ts);
CREATE INDEX IF NOT EXISTS idx_alarms_ts ON alarms(created_at);
CREATE INDEX IF NOT EXISTS idx_commands_ts ON commands(created_at);

CREATE TABLE IF NOT EXISTS batches(
  id TEXT PRIMARY KEY,           -- 批次号，如 P2024-0601A
  name TEXT NOT NULL,
  breed TEXT DEFAULT '',
  base TEXT DEFAULT '',
  in_count INTEGER DEFAULT 0,
  cur_count INTEGER DEFAULT 0,
  age_days INTEGER DEFAULT 0,
  target_age_d INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',  -- active / sold / archived
  note TEXT DEFAULT '',
  created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS batch_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch TEXT NOT NULL,
  ts TEXT NOT NULL,
  kind TEXT DEFAULT '',          -- enter / feed / vaccine / weight / health / transfer / sale / ...
  title TEXT NOT NULL,
  detail TEXT DEFAULT ''
);
`);

const now = () => new Date().toISOString();
const seq = (k) => {
  const row = db.prepare('SELECT v FROM kv WHERE k=?').get(k);
  const n = (row ? parseInt(row.v, 10) : 0) + 1;
  db.prepare('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(n));
  return n;
};

/* ---------- 种子：站点（仅空库执行一次） ---------- */
function seedSite() {
  if (db.prepare('SELECT COUNT(*) c FROM sites').get().c > 0) return;
  const t = now();
  const B = { lat: 34.96081, lon: 104.45189 };   // 步云村（菜子镇）机巢基点
  db.prepare('INSERT INTO sites VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    'SITE-1', '陇药步云 · 云顶山散养基地',
    '甘肃省', '定西市', '陇西县', '菜子镇', '步云村',
    B.lat, B.lon, 1980,
    '北斗/GNSS RTK（演示）', 'qianxun-demo-0001', '******',
    '无人机机巢坐标：东经104.45189° 北纬34.96081°，支持拖动卫星图精确定位后回写',
    t);
}
/* ---------- 种子：设备台账 + 航线（可重复执行，用于恢复默认模板） ---------- */
function seedDevices() {
  const t = now();
  const B = { lat: 34.96081, lon: 104.45189 };   // 步云村（菜子镇）机巢基点
  const site = 'SITE-1';
  const insDev = db.prepare(`INSERT OR IGNORE INTO devices
    (id,site_id,type,sub,name,model,vendor,sn,protocol,stream_url,lat,lon,alt,batt,status,config,note,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  const devices = [
    // ---- 无人机（可替换为大疆/御3E 等；MAVLink 接入，图传可改 stream_url）----
    ['DRONE-01', 'drone', '巡检/喊话', '猎鹰1号', 'Matrice 350 RTK', 'DJI 大疆', '0S3B5M6A111001',
      'MAVLink(UDP 14550)', 'rtmp://127.0.0.1:1935/live/drone01', 104.45342, 34.96235, 55, 78, 'patrol',
      '{"cam":"可见光+红外","gimbal":true,"speaker":true,"rtk":true}', '航线：基地外圈巡线，见航线表 WPT-DRONE-01'],
    ['DRONE-02', 'drone', '喊话/探照', '蓝隼2号', 'Matrice 350 RTK', 'DJI 大疆', '0S3B5M6A111002',
      'MAVLink(UDP 14551)', 'rtmp://127.0.0.1:1935/live/drone02', B.lon, B.lat, 0, 62, 'charging',
      '{"cam":"喊话器","gimbal":false,"speaker":true,"rtk":true}', '机巢充电位'],
    ['DRONE-03', 'drone', '热成像', '山雀3号', 'Mavic 3E', 'DJI 大疆', '1581F5BDA00137',
      'MAVLink(TCP 5760)', 'rtmp://127.0.0.1:1935/live/drone03', B.lon, B.lat, 0, 96, 'standby',
      '{"cam":"热成像+变焦","gimbal":true,"rtk":true}', '备用机，随时可调度'],
    // ---- 摄像头（RTSP 接入视频监控页）----
    ['CAM-01', 'camera', '育雏舍·东侧全景', '2XA8437 枪机', 'DS-2CD3T86FWDV2-I3', 'HIKVISION 海康', 'DS-2CD3T86FWD2021',
      'RTSP/ONVIF', 'rtsp://admin:******@192.168.1.21:554/Streaming/Channels/101', 104.45418, 34.96302, 8, -1, 'online',
      '{"ptz":false}', '示例 RTSP 地址，替换为真实摄像头后视频页即可播放'],
    ['CAM-02', 'camera', '散养区A·松林制高点', '2DC4223 球机', 'DS-2DC4223IW-DE', 'HIKVISION 海康', 'DS-2DC4223IWDE001',
      'RTSP/ONVIF', 'rtsp://admin:******@192.168.1.22:554/Streaming/Channels/201', 104.45036, 34.96286, 120, -1, 'online',
      '{"ptz":true,"gimbal":true}', '含云台，可在视频页下发云台指令'],
    ['CAM-03', 'camera', '散养区B·溪谷草坡', 'HFW2431 枪机', 'IPC-HFW2431TP', 'Dahua 大华', 'IPC-HFW2431TP001',
      'RTSP/ONVIF', 'rtsp://admin:******@192.168.1.23:554/cam/realmonitor?channel=1&subtype=0', 104.45327, 34.95928, 96, -1, 'online',
      '{"ptz":false}', ''],
    ['CAM-04', 'camera', '周界·西北角围栏', '2XA8437 枪机', 'DS-2CD3T86FWDV2-I3', 'HIKVISION 海康', 'DS-2CD3T86FWD2024',
      'RTSP/ONVIF', 'rtsp://admin:******@192.168.1.24:554/Streaming/Channels/101', 104.44878, 34.96215, 15, -1, 'online',
      '{"ptz":false,"ai":"电子围栏绊线"}', '配合边缘AI网关做周界入侵识别'],
    // ---- 智能补食机（Modbus 接入）----
    ['FEED-01', 'feeder', '1号山脊料塔', 'HG-6200A 称重补食机', '鸿谷智能', '鸿谷', 'HG6200A0001',
      'Modbus TCP 502', '', 104.45292, 34.96054, 0, -1, 'online', '{"cap":420}', ''],
    ['FEED-02', 'feeder', '2号松林料线', 'HG-6200A 称重补食机', '鸿谷智能', '鸿谷', 'HG6200A0002',
      'Modbus TCP 502', '', 104.45115, 34.96122, 0, -1, 'online', '{"cap":360}', ''],
    ['FEED-03', 'feeder', '3号草坡料塔', 'HG-6200A 称重补食机', '鸿谷智能', '鸿谷', 'HG6200A0003',
      'Modbus TCP 502', '', 104.45220, 34.95942, 0, -1, 'online', '{"cap":380}', ''],
    ['FEED-04', 'feeder', '4号溪谷料站', 'HG-6200A 称重补食机', '鸿谷智能', '鸿谷', 'HG6200A0004',
      'Modbus TCP 502', '', 104.45025, 34.95883, 0, -1, 'warn', '{"cap":300}', '余量偏低'],
    // ---- 传感器与气象 ----
    ['SEN-01', 'sensor', '育雏舍温湿度', 'TH12-WS 温湿度', '昆仑海岸', '昆仑', 'TH12WS-01', 'RS485/Modbus', '', null, null, null, -1, 'online', '{}', ''],
    ['SEN-02', 'sensor', '散养区A 氨气', 'JC-AM-NH3 氨气变送器', '精诚', '精诚', 'JCAMNH3-01', '4-20mA', '', null, null, null, -1, 'online', '{}', ''],
    ['SEN-03', 'sensor', '气象站(风/雨/辐照)', 'YT-QX-5 气象站', '雨田农业', '雨田', 'YTQX5-01', 'RS485/Modbus', '', B.lat, B.lon, 5, -1, 'online', '{}', ''],
    ['SEN-04', 'sensor', '散养区电子围栏', 'EP-Z1 围栏振动', '中电安科', '中电安科', 'EPZ1-001', 'LoRa', '', null, null, null, -1, 'online', '{}', '周界防入侵'],
    // ---- 网关 / 机巢 / RTK ----
    ['GW-01', 'gateway', '边缘AI识别盒', 'Jetson Orin Nano', 'NVIDIA', 'NVIDIA', 'JETSON-0001',
      'MQTT/MQTT 1883', '', B.lat, B.lon, 3, -1, 'online', '{"models":["行为识别","目标检测"]}', '摄像头视频流 AI 推理'],
    ['NEST-01', 'nest', '无人机智能机巢', 'Matrix 机巢', 'DJI Dock', 'DJI 大疆', 'DOCK-0001',
      'MQTT/WIFI', '', B.lat, B.lon, 0, -1, 'online', '{"chargingPorts":3}', '自动充换电，可远程起飞'],
    ['RTK-01', 'rtk', '北斗基准站', 'CORS-2000', '中海达', '中海达', 'CORS2000-01',
      'NTRIP', '', B.lat, B.lon, 2, -1, 'online', '{"provider":"qianxun"}', '为无人机/机巢提供厘米级差分']
  ];
  // 未接入真实设备前，全部台账设备显示“未连接”（status=offline）；
  // 只有网关心跳/遥测（/api/telemetry）到达后，设备才会点亮为已连接
  devices.forEach((d) => { d[13] = 'offline'; });

  devices.forEach((d) => insDev.run(d[0], site, d[1], d[2], d[3], d[4], d[5], d[6], d[7], d[8],
    d[9], d[10], d[11], d[12], d[13], d[14], d[15], t, t));

  // 航线（DRONE-01 外圈巡线，围绕基地 8 个航点）
  const insWp = db.prepare('INSERT OR IGNORE INTO waypoints(device_id,idx,lat,lon,alt,speed,action,name,updated_at) VALUES(?,?,?,?,?,?,?,?,?)');
  const ring = [
    [104.45189, 34.96081, 40, '起飞', '机巢'],
    [104.45342, 34.96235, 55, '', '散养区A 东南'],
    [104.45421, 34.96105, 50, '', '散养区A 东侧'],
    [104.45327, 34.95928, 55, '', '溪谷草坡'],
    [104.45115, 34.95866, 50, '', '散养区B 西南'],
    [104.44968, 34.95972, 55, '', '散养区B 西侧'],
    [104.44878, 34.96215, 50, '周界检查', '西北围栏'],
    [104.45036, 34.96286, 45, '返航', '机巢北']
  ];
  ring.forEach((w, i) => insWp.run('DRONE-01', i, w[0], w[1], w[2], 6, w[3], w[4], t));

  db.prepare('INSERT INTO kv VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run('cmd_seq', '0');
  console.log('[db] 设备台账种子已写入：' + devices.length + ' devices / ' + ring.length + ' waypoints');
}

seedSite();
/* 设备模板：仅首次启动（或管理员显式“恢复模板”）时写入一次。
 * 之后重启不再重灌 → 用户在设备页删除的默认设备不会被“复活”。 */
function templateSeeded() {
  const r = db.prepare('SELECT v FROM kv WHERE k=?').get('template_seeded');
  return !!(r && r.v === '1');
}
function markTemplateSeeded() {
  db.prepare('INSERT INTO kv VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run('template_seeded', '1');
}
function restoreDeviceTemplate() {
  seedDevices();
  markTemplateSeeded();
  return db.prepare('SELECT COUNT(*) c FROM devices').get().c;
}
if (!templateSeeded()) {
  seedDevices();
  markTemplateSeeded();
  console.log('[db] 默认设备模板已安装（删除设备后不会在重启时恢复；可在“设备与网关”页一键恢复模板）');
}
if (db.prepare('SELECT COUNT(*) c FROM sites').get().c > 0 &&
    db.prepare('SELECT COUNT(*) c FROM devices').get().c === 0) {
  console.warn('[db] 设备台账当前为空（您在设备页删除的默认设备不会被自动恢复；需要模板可调 POST /api/devices/restore-template）');
}

/* ---------- 初始账号（首次运行创建；上线后请立即修改默认密码） ---------- */
function seedUsers() {
  if (db.prepare('SELECT COUNT(*) c FROM users').get().c > 0) return;
  const t = now();
  const ins = db.prepare('INSERT INTO users(username,name,role,salt,hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?)');
  const a = hashPassword('123456');
  ins.run('admin', '基地管理员', 'admin', a.salt, a.hash, t, t);
  const o = hashPassword('123456');
  ins.run('operator', '值班操作员', 'operator', o.salt, o.hash, t, t);
  const d = hashPassword('gw-8600-secret');
  ins.run('gateway01', '设备网关服务账号', 'device', d.salt, d.hash, t, t);
  console.log('[db] seeded users: admin / operator / gateway01（默认密码见 docs/DEPLOY.md）');
}
seedUsers();

module.exports = { db, now, seq, restoreDeviceTemplate };
