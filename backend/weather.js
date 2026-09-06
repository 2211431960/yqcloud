/* ============================================================
 * 天气与卫星云图服务（后端代理，规避浏览器跨域与网络差异）
 * - 实时/预报天气：Open-Meteo（免费无 Key，全球网格，经纬度查询，
 *   current + daily(3日) + hourly(24h)，供“天气检测系统”使用）
 * - 天气预警规则引擎：evaluateWarnings() 按要素阈值/气象代码评估，
 *   由服务端定时巡检写入云端告警中心（/api/alarms），页面实时推送
 * - 卫星云图：中央气象台 风云四号B 中国区可见光（image.nmc.cn，
 *   帧时间序列从官方页实时解析，15 分钟一帧）
 * ============================================================ */
'use strict';
const cache = {};

function get(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 12000);
  return fetch(url, {
    signal: ctrl.signal,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) YQCloud/1.0', Referer: 'https://www.nmc.cn/' }
  }).finally(() => clearTimeout(timer));
}

/* ============ 天气预警规则（散养基地场景阈值，可按场区调整） ============
 * 单位约定：风速 km/h、降水 mm、温度 ℃。lv: crit 严重 / warn 警告。
 * ================================================================ */
const RULES = [
  { key: 'wind_gust', name: '阵风风速', unit: 'km/h', src: 'cur.gust', th: [55, 85], ico: 'wind',
    zh: ['大风预警（7级阵风，关注棚舍/围栏/无人机禁飞）', '强风预警（9级阵风，停止一切户外作业与飞行）'] },
  { key: 'wind_avg', name: '持续风速', unit: 'km/h', src: 'cur.wind', th: [40, 65], ico: 'wind',
    zh: ['持续大风（6级，减少户外作业）', '持续强风（8级，人员车辆远离大跨度棚舍）'] },
  { key: 'rain_1h', name: '1小时降水', unit: 'mm', src: 'cur.precip', th: [4, 10], ico: 'cloud-rain',
    zh: ['短时强降水（1h≥4mm，注意低洼鸡舍排水）', '暴雨（1h≥10mm，防范山洪/泥石流风险区）'] },
  { key: 'rain_6h', name: '未来6小时降水', unit: 'mm', src: 'hr.rain6', th: [12, 25], ico: 'cloud-rain',
    zh: ['未来6h累计降水偏大（提前疏通排水/收拢散养区）', '未来6h强降水（暂停放养与巡检，检查防灾）'] },
  { key: 'heat', name: '气温', unit: '℃', src: 'cur.temp', dir: 'high', th: [35, 38], ico: 'temperature',
    zh: ['高温（≥35℃，防中暑/保障饮水与通风）', '极端高温（≥38℃，启动降温预案并加强巡视）'] },
  { key: 'cold', name: '气温', unit: '℃', src: 'cur.temp', dir: 'low', th: [-8, -14], ico: 'snowflake',
    zh: ['低温（≤-8℃，育雏保温/防饮水结冰）', '严寒（≤-14℃，启动保温应急预案）'] },
  { key: 'heat_feels', name: '体感温度', unit: '℃', src: 'cur.feels', dir: 'high', th: [37, 40], ico: 'temperature',
    zh: ['闷热（体感≥37℃，加强通风降温）', '极闷热（体感≥40℃，高温停工）'] }
];
const CODE_ALERTS = [
  { lv: 'warn', codes: [95, 97, 99], type: '雷暴预警', ico: 'cloud-storm', zh: '监测到雷暴天气，请停止无人机作业并防范雷击' },
  { lv: 'crit', codes: [96, 99], type: '冰雹预警', ico: 'cloud-snow', zh: '监测到冰雹天气，注意棚舍/车辆与人员防护' },
  { lv: 'warn', codes: [71, 73, 75, 77, 85, 86], type: '降雪预警', ico: 'snowflake', zh: '监测到降雪天气，注意棚舍承重与道路通行' },
  { lv: 'warn', codes: [56, 57, 66, 67], type: '冻雨预警', ico: 'snowflake', zh: '监测到冻雨，谨防道路结冰与线路挂冰' },
  { lv: 'warn', codes: [80, 81, 82], type: '阵雨预警', ico: 'cloud-rain', zh: '监测到阵性强降水，注意散养区排水与防潮' }
];
const RULE_DEFS = RULES.map((r) => ({ key: r.key, name: r.name, unit: r.unit, thWarn: r.th[0], thCrit: r.th[1], dir: r.dir || 'high', ico: r.ico }));

function evaluateWarnings(w) {
  const out = { warnings: [], rules: [], codes: [] };
  const cur = (w && w.current) || {};
  const daily = (w && w.daily) || [];
  const hourly = (w && w.hourly) || [];
  // 未来 6h 累计降水（从 hourly 起 6 个时次，已有历史则从当前时次起）
  const next6 = hourly.filter((h) => h.future !== false).slice(0, 6);
  const rain6 = next6.reduce((s, h) => s + (h.precip || 0), 0);
  const srcOf = (def) => {
    if (def.src === 'cur.gust') return cur.gust;
    if (def.src === 'cur.wind') return cur.wind;
    if (def.src === 'cur.precip') return cur.precip;
    if (def.src === 'cur.temp') return cur.temp;
    if (def.src === 'cur.feels') return cur.feels;
    return null;
  };
  out.rules = RULES.map((def) => {
    const v = def.src === 'hr.rain6' ? rain6 : srcOf(def);
    const numeric = (v != null && Number.isFinite(+v)) ? +v : null;
    let level = 'none';
    if (numeric !== null) {
      if (def.dir === 'low') { if (numeric <= def.th[1]) level = 'crit'; else if (numeric <= def.th[0]) level = 'warn'; }
      else if (numeric >= def.th[1]) level = 'crit';
      else if (numeric >= def.th[0]) level = 'warn';
    }
    return { key: def.key, name: def.name, unit: def.unit, cur: numeric, thWarn: def.th[0], thCrit: def.th[1], dir: def.dir || 'high', level, ico: def.ico };
  });
  out.warnings = out.rules
    .filter((r) => r.level !== 'none')
    .map((r) => {
      const def = RULES.find((x) => x.key === r.key);
      const msg = (r.level === 'crit' ? '【严重】' : '【警告】') + def.zh[r.level === 'crit' ? 1 : 0] +
        '（当前 ' + (r.cur != null ? Math.round(r.cur * 10) / 10 : '—') + r.unit + '，' +
        (r.level === 'crit' ? '超过严重阈值 ' + r.thCrit : '达到警告阈值 ' + r.thWarn) + r.unit + '）';
      return { key: r.key, lv: r.level, type: def.zh[r.level === 'crit' ? 1 : 0].split('（')[0], ico: def.ico, msg };
    });
  // 气象代码即时预警（current 与未来 24h 各取一次，当前优先）
  const seen = {};
  const checkCode = (cd, when) => {
    CODE_ALERTS.forEach((ca) => {
      if (ca.codes.indexOf(cd.code) >= 0 && !seen[ca.type]) {
        seen[ca.type] = 1;
        out.warnings.push({ key: 'code:' + ca.type, lv: ca.lv, type: ca.type, ico: ca.ico, msg: ca.zh + (when ? '（' + when + '）' : '') });
      }
    });
  };
  if (cur.code != null) checkCode({ code: cur.code }, '当前实况');
  if (!out.warnings.some((x) => x.key.indexOf('code:') === 0)) {
    const fut = hourly.filter((h) => h.future !== false).slice(0, 24).find((h) => h.code != null && CODE_ALERTS.some((ca) => ca.codes.indexOf(h.code) >= 0));
    if (fut) checkCode({ code: fut.code }, '未来 ' + (fut.time ? fut.time.slice(11, 16) : '数小时'));
  }
  out.codes = CODE_ALERTS;
  return out;
}

/* ---------------- 实时天气 + 3 日 + 24 小时预报（Open-Meteo） ---------------- */
async function fetchWeather(lat, lon, siteName, force) {
  const key = 'wx:' + lat.toFixed(2) + ',' + lon.toFixed(2);
  if (!force && cache[key] && Date.now() - cache[key].t < 600000) return cache[key].data;  // 缓存 10 分钟

  const u = 'https://api.open-meteo.com/v1/forecast' +
    '?latitude=' + lat + '&longitude=' + lon +
    '&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m' +
    '&hourly=weather_code,temperature_2m,precipitation,precipitation_probability,wind_speed_10m,wind_gusts_10m' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max' +
    '&timezone=auto&forecast_days=3&past_hours=6';
  const r = await get(u, 15000);
  if (!r.ok) throw new Error('Open-Meteo HTTP ' + r.status);
  const d = await r.json();
  const c = d.current || {};
  const dl = d.daily || {};
  const hr = d.hourly || {};
  const hourNow = new Date();
  const hourIdx = (hr.time || []).findIndex((t) => new Date(t).getTime() >= hourNow.getTime() - 30 * 60000);
  const h0 = hourIdx < 0 ? 0 : hourIdx;
  const hourly0 = (hr.time || []).map((t, i) => ({
    time: t,
    future: i >= h0,
    code: (hr.weather_code || [])[i],
    temp: (hr.temperature_2m || [])[i],
    precip: (hr.precipitation || [])[i],
    rainProb: (hr.precipitation_probability || [])[i] ?? null,
    wind: (hr.wind_speed_10m || [])[i],
    gust: (hr.wind_gusts_10m || [])[i]
  }));
  // 只保留：过去 2 个时次 + 未来 48 小时（曲线与未来 6h 累计评估足够）
  const hourly = hourly0.slice(Math.max(0, h0 - 2), h0 + 48);
  const data = {
    ok: true,
    source: 'Open-Meteo（后端代理 · 免费无Key）',
    observedAt: new Date().toISOString(),
    location: { lat: +lat.toFixed(5), lon: +lon.toFixed(5), name: siteName || '' },
    current: {
      temp: c.temperature_2m, feels: c.apparent_temperature, humidity: c.relative_humidity_2m,
      code: c.weather_code, isDay: c.is_day, precip: c.precipitation, cloud: c.cloud_cover,
      pressure: c.pressure_msl, wind: c.wind_speed_10m, gust: c.wind_gusts_10m, windDir: c.wind_direction_10m
    },
    hourly,
    daily: (dl.time || []).map((t, i) => ({
      date: t,
      code: (dl.weather_code || [])[i],
      tMax: (dl.temperature_2m_max || [])[i],
      tMin: (dl.temperature_2m_min || [])[i],
      precip: (dl.precipitation_sum || [])[i],
      rainProb: (dl.precipitation_probability_max || [])[i] ?? null,
      windMax: (dl.wind_speed_10m_max || [])[i]
    }))
  };
  cache[key] = { t: Date.now(), data };
  return data;
}

/* ---------------- 中文地区→坐标（Photon/Komoot 免费无 Key；县级/镇级可搜） ----------------
 * 说明：为手机天气式“自定义地区”功能提供城市/县镇搜索；结果缓存 1 天。
 * 商用规模接入建议替换为高德/腾讯 Web 服务 Key（见 README 注意事项）。
 * ------------------------------------------------------------------------------------ */
async function fetchGeocode(q, limit) {
  const key = 'geo:' + q;
  if (cache[key] && Date.now() - cache[key].t < 86400000) return cache[key].data;
  const n = Math.min(parseInt(limit, 10) || 8, 12);
  const r = await get('https://photon.komoot.io/api/?q=' + encodeURIComponent(q) + '&limit=' + n, 10000);
  if (!r.ok) throw new Error('地理编码服务 HTTP ' + r.status);
  const j = await r.json();
  const items = (j.features || []).map((f) => {
    const p = f.properties || {};
    const c = f.geometry && f.geometry.coordinates;
    if (!c || !Number.isFinite(+c[0]) || !Number.isFinite(+c[1])) return null;
    return {
      name: p.name || '',
      region: [p.state, p.city].filter(Boolean).join('') || (p.country || ''),
      country: p.country || '',
      kind: p.type || '',
      lon: +c[0].toFixed(5), lat: +c[1].toFixed(5)
    };
  }).filter(Boolean);
  const data = { ok: true, provider: 'Photon/OSM（免费无 Key，城市/县镇可搜）', q, items };
  cache[key] = { t: Date.now(), data };
  return data;
}

/* ---------------- 风云四号 卫星云图帧（官方页实时解析） ---------------- */
async function fetchCloudsat() {
  const key = 'cloud';
  if (cache[key] && Date.now() - cache[key].t < 180000) return cache[key].data;  // 缓存 3 分钟

  const page = await get('https://www.nmc.cn/publish/satellite/fy4b-visible.htm', 15000);
  if (!page.ok) throw new Error('中央气象台云图页 HTTP ' + page.status);
  const html = await page.text();
  // data-img="https://image.nmc.cn/product/…/SEVP….JPG?v=…" data-time="09/06 16:15"
  const re = /data-img="([^"]+\.(?:JPG|jpg|png))[^"]*"\s+data-time="([^"]+)"/g;
  const frames = [];
  let m;
  while ((m = re.exec(html)) && frames.length < 20) {
    const url = m[1].replace(/\?v=\d+$/, '');
    const label = m[2].trim();
    if (!frames.some((f) => f.url === url)) frames.push({ label, url });
  }
  if (!frames.length) {
    const alt = html.match(/src="(https:\/\/image\.nmc\.cn\/product\/[^"]+\.JPG[^"]*)"[^>]*data-time="([^"]+)"/);
    if (alt) frames.push({ label: alt[2].trim(), url: alt[1].split('?')[0] });
  }
  if (!frames.length) throw new Error('未能从官方页面解析云图帧');
  const data = {
    ok: true,
    provider: 'FY4B 风云四号B · 中国区域可见光（中央气象台）',
    homepage: 'https://www.nmc.cn/publish/satellite/fy4b-visible.htm',
    latest: frames[0],
    frames: frames.map((f, i) => Object.assign({ i }, f)),
    note: '影像 15 分钟一帧；夜间可见光图像偏暗属正常，可前往中央气象台查看红外增强产品'
  };
  cache[key] = { t: Date.now(), data };
  return data;
}

/* ---------------- IP 地区识别（城市级初筛，生产建议换高德/腾讯定位Key） ---------------- */
async function fetchGeoIp() {
  const key = 'geoip';
  if (cache[key] && Date.now() - cache[key].t < 28800000) return cache[key].data; // 8h 缓存
  const r = await get('http://ip-api.com/json/?lang=zh-CN&fields=status,country,regionName,city,district,lat,lon,query', 8000);
  if (!r.ok) throw new Error('IP 定位服务 HTTP ' + r.status);
  const j = await r.json();
  const data = {
    ok: j.status === 'success',
    provider: 'ip-api.com（免费 · 城市级）',
    note: '结果来自网络出口 IP，精度为城市级；场地精确坐标请用浏览器定位或高德地图选点。',
    country: j.country, region: j.regionName, city: j.city, district: j.district || '',
    ip: j.query, lat: j.lat, lon: j.lon,
    queriedAt: new Date().toISOString()
  };
  cache[key] = { t: Date.now(), data };
  return data;
}

module.exports = { fetchWeather, fetchCloudsat, fetchGeoIp, fetchGeocode, evaluateWarnings, RULE_DEFS, CODE_ALERTS };
