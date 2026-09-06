/* ============================================================
 * 总览监控面板（纯云端真实数据版）
 * 数据源全部来自 REST API（docs/API.md）：
 *   /api/metrics      业务指标（KPI + 其他业务指标卡）
 *   /api/devices      + /api/devices/:id/telemetry  环境/设备实时清单、趋势图
 *   /api/samples      逐时采食/产蛋
 *   /api/alarms       报警分类 donut + 最新告警
 *   /api/commands     最新云端指令
 * 无仿真引擎引用；未接入一律显示空态/未接入引导。
 * ============================================================ */
(function (global) {
  'use strict';
  const UIx = global.UI, YQCx = global.YQC;   // YQC = js/charts.js（仅图表工具，非仿真）
  const Q = UIx.Q, $$ = UIx.$$, esc = UIx.esc, pad = UIx.pad, toast = UIx.toast;

  /* ---------- 展示映射 ---------- */
  const LV_ZH = { crit: '严重', warn: '警告', info: '提示' };
  const ALM_ST = {
    open: ['未处理', '#d97706'], ack: ['已确认', '#059669'], misreport: ['误报', '#9ca3af']
  };
  const CMD_ZH = {
    takeoff: '起飞', rtl: '返航', land: '降落', charge: '充电', start_patrol: '开始巡检',
    stream_on: '开启图传', gimbal_home: '云台归中', gimbal: '云台转动', reboot: '重启',
    shot: '抓拍', record: '录像', speaker: '喊话', feed_now: '补食', relay: '环境开关'
  };
  const CMD_ST = {
    queued: ['tag amber', '排队中'], sent: ['tag sky', '已下发'],
    ack: ['tag green', '已回执'], fail: ['tag red', '失败'], timeout: ['tag gray', '超时']
  };
  /* extra/weather 数值键 → [中文名, 单位]（不认识的键原样显示） */
  const KEY_ZH = {
    temp: ['温度', '℃'], hum: ['湿度', '%'], nh3: ['氨气', 'ppm'], co2: ['二氧化碳', 'ppm'],
    pm25: ['PM2.5', 'µg/m³'], rain: ['雨量', 'mm'], ws: ['风速', 'm/s'],
    wind_speed: ['风速', 'm/s'], wind_dir: ['风向', '°'], pressure: ['气压', 'hPa'],
    light: ['光照', 'lx'], level_pct: ['料位', '%'], noise: ['噪声', 'dB']
  };
  const TEL_PRI = ['temp', 'hum', 'nh3', 'co2', 'pm25', 'wind_speed', 'ws', 'rain', 'pressure', 'light', 'level_pct'];
  /* KPI 之外的可选业务指标（其余 type 原样显示） */
  const METRIC_X = {
    water_kg_today: ['今日饮水', 'kg'], mortality: ['死亡率', '%'], sick_rate: ['发病率', '%']
  };

  const html = `
  <div class="content-scroll">
    <div class="grid">
      <!-- KPI 行：业务指标来自云端上报（POST /api/metrics） -->
      <div class="card span-3 kpi"><span class="k-ico ico-g">${I('users', 21)}</span><div class="k-body">
        <div class="k-label">存栏总数</div><div class="k-value" id="ov-birds">–</div>
        <div class="k-sub"><span id="ov-sub-birds">业务指标未接入</span></div>
      </div></div>
      <div class="card span-3 kpi"><span class="k-ico ico-c">${I('heartbeat', 21)}</span><div class="k-body">
        <div class="k-label">鸡群健康指数</div><div class="k-value" id="ov-health">–</div>
        <div class="k-sub"><span id="ov-sub-health">业务指标未接入</span></div>
      </div></div>
      <div class="card span-3 kpi"><span class="k-ico ico-a">${I('egg', 21)}</span><div class="k-body">
        <div class="k-label">今日产蛋（枚）</div><div class="k-value" id="ov-egg">–</div>
        <div class="k-sub"><span id="ov-sub-egg">业务指标未接入</span></div>
      </div></div>
      <div class="card span-3 kpi"><span class="k-ico ico-s">${I('package', 21)}</span><div class="k-body">
        <div class="k-label">今日补食量</div><div class="k-value" id="ov-feed">–<small>kg</small></div>
        <div class="k-sub"><span id="ov-sub-feed">业务指标未接入</span></div>
      </div></div>
      <div class="card span-12" style="padding:0;background:transparent;border:none;box-shadow:none">
        <div style="font-size:11.5px;color:var(--dim);line-height:1.8">
          本页数据全部来自云端接口（docs/API.md）：存栏/产蛋/补食/健康指数等 KPI 由场区计数、称重、养殖系统经
          <code style="background:#f3f4f6;padding:1px 5px;border-radius:4px">POST /api/metrics</code> 上报；
          趋势/告警/指令/设备清单分别为 samples / alarms / commands / devices + telemetry 接口。
          未上报的数据一律显示「未接入」，绝不显示编造数值。
        </div>
      </div>

      <!-- 环境实时趋势（真实传感器遥测） -->
      <div class="card span-8">
        <div class="card-h"><span class="h-ico">${I('temperature', 15)}</span>环境实时趋势<span class="card-title-note">至多 3 台实时传感器 · 按遥测键自适应 · 30s 刷新</span></div>
        <div class="h-divider"></div>
        <div class="card-b">
          <div class="chart-lg" data-chart id="ov-chart1" style="display:none"></div>
          <div class="empty-tip" id="ov-env-empty" style="padding:120px 14px">正在读取传感器遥测…</div>
        </div>
      </div>

      <!-- 报警分类（真实告警） -->
      <div class="card span-4">
        <div class="card-h"><span class="h-ico">${I('alert-triangle', 15)}</span>报警分类统计<span class="more" data-nav="alarm">报警中心 ›</span></div>
        <div class="h-divider"></div>
        <div class="card-b">
          <div class="chart" data-chart id="ov-chart2" style="display:none"></div>
          <div class="empty-tip" id="ov-alm-empty" style="padding:96px 14px">正在读取告警…</div>
        </div>
        <div style="padding:2px 16px 14px;display:flex;justify-content:space-between;font-size:11.5px;color:var(--dim)">
          <span>未处理 <b id="ov-untreated" style="color:var(--red)">0</b> 条</span>
          <span>处理率 <b id="ov-rate">0%</b></span>
          <span data-nav="alarm" style="cursor:pointer;color:var(--sky)">查看全部</span>
        </div>
      </div>

      <!-- 环境/设备实时清单（传感器 + 气象站，点击行看最近实况） -->
      <div class="card span-4">
        <div class="card-h"><span class="h-ico">${I('activity', 15)}</span>环境 / 设备实时清单<span class="more" data-nav="devices">设备管理 ›</span></div>
        <div class="h-divider"></div>
        <div class="card-b" style="padding-top:6px" id="ov-sensors"></div>
      </div>

      <!-- 逐时采食 / 产蛋（真实 samples） -->
      <div class="card span-5">
        <div class="card-h"><span class="h-ico">${I('chart-line', 15)}</span>逐时采食 / 产蛋<span class="card-title-note">网关 samples(intake_h / eggs_h) 上报后绘制</span></div>
        <div class="h-divider"></div>
        <div class="card-b">
          <div class="chart" data-chart id="ov-chart3" style="display:none"></div>
          <div class="empty-tip" id="ov-hour-empty" style="padding:110px 14px">正在读取逐时采样…</div>
        </div>
      </div>

      <!-- 最新云端指令 -->
      <div class="card span-3">
        <div class="card-h"><span class="h-ico">${I('send', 15)}</span>最新云端指令</div>
        <div class="h-divider"></div>
        <div class="card-b" style="padding-top:6px"><div class="event-stream" id="ov-logs"></div></div>
      </div>

      <!-- 其他业务指标（今日饮水等） -->
      <div class="card span-7">
        <div class="card-h"><span class="h-ico">${I('droplet', 15)}</span>今日饮水 / 其他业务指标<span class="card-title-note">场区网关经 metrics 上报（water_kg_today / mortality …）</span></div>
        <div class="h-divider"></div>
        <div class="card-b" style="padding-top:4px" id="ov-extra"></div>
      </div>

      <!-- 最新告警 -->
      <div class="card span-5">
        <div class="card-h"><span class="h-ico">${I('bell-ringing', 15)}</span>最新告警<span class="more" data-nav="alarm">全部 ›</span></div>
        <div class="h-divider"></div>
        <div class="card-b" style="padding-top:8px" id="ov-alerts"></div>
      </div>

      <!-- 环境控制面板（指令经云端下发，网关回执） -->
      <div class="card span-12">
        <div class="card-h"><span class="h-ico">${I('settings', 15)}</span>环境控制面板
          <span class="card-title-note">每路先绑定一台执行设备，拨动开关即下发 relay 指令 → 网关执行并回执；设备未连接时指令排队等待</span>
          <span class="more" id="ov-ctrl-refresh">同步设备 ▸</span>
        </div>
        <div class="h-divider"></div>
        <div class="card-b" id="ov-ctrl"></div>
      </div>
    </div>
  </div>`;

  /* ================= 工具 ================= */
  let charts = null;   // { env, donut, hourly }
  function fmtDT(iso, withSec) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    let s = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    if (withSec) s += ':' + pad(d.getSeconds());
    return s;
  }
  const hhmm = (iso) => { const d = new Date(iso); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  const fmtNum = (v) => (Math.abs(v) >= 100 || Number.isInteger(v)) ? String(Math.round(v)) : (+v).toFixed(1);
  function safeParse(s) { try { return JSON.parse(s || '{}'); } catch (e) { return null; } }
  /* 展开 extra（weather 子对象拍平）里的数值键 → [[key, value]]，按 TEL_PRI 排序 */
  function numericPairs(ex) {
    const out = [];
    const walk = (obj) => {
      if (!obj || typeof obj !== 'object') return;
      Object.keys(obj).forEach((k) => {
        const v = obj[k];
        if (v === null || v === undefined || typeof v === 'boolean') return;
        if (typeof v === 'object') { walk(v); return; }
        const n = +v;
        if (!Number.isFinite(n)) return;
        if (out.some((o) => o[0] === k)) return;
        out.push([k, n]);
      });
    };
    walk(ex);
    out.sort((a, b) => {
      const ia = TEL_PRI.indexOf(a[0]), ib = TEL_PRI.indexOf(b[0]);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a[0].localeCompare(b[0]);
    });
    return out;
  }
  function goPage(key) {
    if (global.APP && global.APP.go) global.APP.go(key);
  }
  function bindNav() {
    const root = Q('page-overview');
    $$('[data-nav]', root).forEach((el) => { el.onclick = () => goPage(el.dataset.nav); });
  }
  /* 图表区域占位/空态切换：showTip('id','html') 显示空态，hideTip('id') 隐藏 */
  function showTip(id, t) { const el = Q(id); if (el) { el.style.display = ''; el.innerHTML = t; } }
  function hideTip(id) { const el = Q(id); if (el) el.style.display = 'none'; }

  /* ================= 业务指标（KPI / 其他指标，/api/metrics） ================= */
  const METRIC_META = {
    birds: { el: 'ov-birds', dec: 0, unit: '只', label: '存栏', sub: 'ov-sub-birds' },
    eggs_today: { el: 'ov-egg', dec: 0, unit: '枚', label: '今日产蛋', sub: 'ov-sub-egg' },
    feed_kg_today: { el: 'ov-feed', dec: 0, unit: 'kg', label: '今日补食', sub: 'ov-sub-feed' },
    health_index: { el: 'ov-health', dec: 1, unit: '', label: '健康指数', sub: 'ov-sub-health' }
  };
  const KPI_TYPES = Object.keys(METRIC_META);
  let metricsBusy = false;
  function loadMetrics() {
    if (!UIx.api || metricsBusy) return;
    metricsBusy = true;
    UIx.api('metrics').then((rows) => {
      metricsBusy = false;
      const M = {};
      (rows || []).forEach((m) => { M[m.type] = m; });
      Object.keys(METRIC_META).forEach((type) => {
        const meta = METRIC_META[type];
        const el = Q(meta.el), sub = Q(meta.sub);
        if (!el) return;
        const m = M[type];
        if (!m) {
          el.textContent = '–';
          if (sub) sub.innerHTML = '未接入：场区网关经 <b>POST /api/metrics</b> 上报 ' + type + ' 后显示';
          return;
        }
        const num = +m.value;
        el.innerHTML = Number(num).toFixed(meta.dec || 0) + (meta.unit ? '<small>' + meta.unit + '</small>' : '');
        if (sub) sub.innerHTML = '云端上报 · ' + esc(m.source || '') + ' · ' + fmtDT(m.ts) +
          (m.note ? ' · ' + esc(m.note) : '');
      });
      renderExtraMetrics(M);
    }).catch(() => { metricsBusy = false; });
  }
  /* 其他业务指标卡（KPI 之外的 metrics 行；water_kg_today/mortality/sick_rate 中文化，未知原样） */
  function renderExtraMetrics(M) {
    const box = Q('ov-extra');
    if (!box) return;
    const list = Object.keys(M)
      .filter((t) => KPI_TYPES.indexOf(t) < 0)
      .map((t) => M[t]);
    if (!list.length) {
      box.innerHTML = '<div class="empty-tip"><b>暂无其他业务指标</b><br>' +
        '场区网关/ERP 经 <code>POST /api/metrics</code> 上报后显示，例如 ' +
        '<code>water_kg_today</code>（今日饮水kg）、<code>mortality</code>（死亡率%）。</div>';
      return;
    }
    box.innerHTML = list.map((m) => {
      const meta = METRIC_X[m.type] || [m.type, ''];
      const unit = meta[1] || m.unit || '';
      return `<div class="sensor-row">
        <div class="sr-name"><span class="k-ico ico-s" style="width:30px;height:30px;border-radius:8px">${I('droplet', 15)}</span>
          <div><div style="font-size:12.5px">${esc(meta[0])}</div>
          <div style="font-size:10.5px;color:var(--dim)">${esc(m.type)}${m.source ? ' · ' + esc(m.source) : ''}</div></div>
        </div>
        <div style="text-align:right">
          <div class="sr-val">${fmtNum(m.value)}${unit ? '<small style="font-size:11px;color:#9ca3af;font-weight:400"> ' + esc(unit) + '</small>' : ''}</div>
          <div style="font-size:10px;color:var(--dim)">${fmtDT(m.ts)}</div>
        </div>
      </div>`;
    }).join('');
  }

  /* ================= 环境/设备实时清单（sensor + weather） ================= */
  const envState = { list: null, open: {}, html: {}, busy: false };
  function loadEnvList() {
    if (!UIx.api || envState.busy) return;
    envState.busy = true;
    Promise.all([
      UIx.api('devices?type=sensor'),
      UIx.api('devices?type=weather')
    ]).then(([a, b]) => {
      envState.busy = false;
      if (a === null && b === null) { envState.list = null; renderEnvList(); return; }
      envState.list = (a || []).concat(b || []);
      renderEnvList();
    }).catch(() => { envState.busy = false; envState.list = null; renderEnvList(); });
  }
  function typeLabel(d) { return d.type === 'weather' ? '气象站' : '传感器'; }
  function detInner(id) { return envState.html[id] || DET_LOADING; }
  function renderEnvList() {
    const box = Q('ov-sensors');
    if (!box) return;
    if (envState.list === null) {
      box.innerHTML = '<div class="empty-tip"><b>云端后端未连接</b><br>请运行 <code>node backend/server.js</code> 并登录后查看设备清单。</div>';
      return;
    }
    if (!envState.list.length) {
      box.innerHTML = '<div class="empty-tip"><b>暂无环境/气象设备</b><br>请先到「设备与网关」登记传感器与气象站；网关心跳上报后自动点亮为已连接。</div>';
      return;
    }
    box.innerHTML = envState.list.map((d) => {
      const w = d.type === 'weather';
      return `<div class="sensor-row" data-det="${esc(d.id)}" style="cursor:pointer" title="点击查看最近上报实况">
        <div class="sr-name"><span class="k-ico ${w ? 'ico-a' : 'ico-s'}" style="width:30px;height:30px;border-radius:8px">${I(w ? 'cloud' : 'activity', 15)}</span>
          <div><div style="font-size:12.5px;color:#111827">${esc(d.id)} · ${esc(d.name)}<span class="tag ${d.live ? 'green' : 'red'}" style="margin-left:6px">${d.live ? '已连接' : '未连接'}</span></div>
          <div style="font-size:10.5px;color:var(--dim)">${esc(d.sub || typeLabel(d))}${d.protocol ? ' · ' + esc(d.protocol) : ''}</div></div>
        </div>
        <div style="text-align:right;flex:none">
          <div style="font-size:12px;color:${d.live ? '#047857' : '#d1d5db'}">${d.live ? '实况上报中' : '未接入'}</div>
          <div style="font-size:10px;color:var(--dim)">${d.live ? '点击展开实况' : '接入并上报遥测后点亮'}</div>
        </div>
      </div>
      <div id="ov-detail-${esc(d.id)}" class="hidden">${detInner(d.id)}</div>`;
    }).join('');
    // 展开中行恢复（数据来自缓存；open 状态保留）
    Object.keys(envState.open).forEach((id) => {
      const dd = Q('ov-detail-' + id);
      if (dd && envState.open[id]) dd.classList.remove('hidden');
    });
  }
  const DET_LOADING = '<div style="padding:6px 4px 12px 42px;font-size:11.5px;color:#9ca3af">正在读取最近上报…</div>';
  const DET_ERR = '<div style="padding:6px 4px 12px 42px;font-size:11.5px;color:#9ca3af">无法连接云端后端，请稍后重试</div>';
  const DET_NONE = '<div style="padding:6px 4px 12px 42px;font-size:11.5px;color:#9ca3af">— 尚无上报：该设备遥测为空，网关经 <code>POST /api/telemetry</code> 上报后此处显示实况</div>';
  async function openDet(id, dd) {
    envState.open[id] = true;
    if (dd.classList.contains('hidden')) dd.classList.remove('hidden');
    dd.innerHTML = DET_LOADING;                       // 每次点开展开都重新拉取最近实况
    const rows = await UIx.api('devices/' + id + '/telemetry?limit=1');
    if (rows === null) {
      if (envState.html[id]) dd.innerHTML = envState.html[id];  // 拉取失败时保留上一次缓存
      else dd.innerHTML = DET_ERR;
      return;
    }
    envState.html[id] = rows.length ? detHtml(rows[0]) : DET_NONE;
    dd.innerHTML = envState.html[id];
  }
  function detHtml(tel) {
    const ex = safeParse(tel.extra);
    const pairs = numericPairs(ex || {});
    const bits = pairs.length
      ? pairs.map((p) => {
        const m = KEY_ZH[p[0]] || [p[0], ''];
        return `<span style="display:inline-flex;align-items:baseline;gap:3px;background:#f8fafc;border:1px solid #eef2f7;border-radius:7px;padding:3px 8px;font-size:11px;color:#6b7280">${esc(m[0])} <b style="color:#111827;font-size:12px">${fmtNum(p[1])}</b>${m[1] ? '<small style="color:#9ca3af">' + esc(m[1]) + '</small>' : ''}</span>`;
      }).join('')
      : '<span style="font-size:11.5px;color:#9ca3af">遥测 extra 无数值键（可上报 temp/hum/nh3/co2…）</span>';
    return `<div style="padding:2px 2px 12px 42px">
      <div style="display:flex;justify-content:space-between;font-size:10.5px;color:var(--dim)">
        <span>最近遥测实况</span><span>上报时间 ${fmtDT(tel.ts, true)}</span></div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:7px">${bits}</div>
    </div>`;
  }
  function bindEnvList() {
    const box = Q('ov-sensors');
    if (!box) return;
    box.addEventListener('click', (e) => {
      const row = e.target.closest('[data-det]');
      if (!row) return;
      const id = row.dataset.det;
      const dd = Q('ov-detail-' + id);
      if (!dd) return;
      if (dd.classList.contains('hidden')) openDet(id, dd);
      else { dd.classList.add('hidden'); envState.open[id] = false; }
    });
  }

  /* ================= 环境实时趋势（真实传感器遥测，至多 3 台） ================= */
  let envTrendBusy = false;
  function loadEnvTrend() {
    if (!UIx.api || envTrendBusy) return;
    envTrendBusy = true;
    UIx.api('devices').then(async (list) => {
      envTrendBusy = false;
      if (!list) {
        showTip('ov-env-empty', '<b>云端后端未连接</b><br>请运行 <code>node backend/server.js</code> 并登录。');
        showChart('ov-chart1', false);
        return;
      }
      const live = list.filter((d) => (d.type === 'sensor' || d.type === 'weather') && d.live).slice(0, 3);
      if (!live.length) {
        showTip('ov-env-empty', '环境趋势由传感器遥测上报后绘制（docs/API.md 第 1 节）。<br>当前无「已连接」传感器：<b>登记设备 → 网关 POST /api/telemetry → 点亮后自动出线</b>。');
        showChart('ov-chart1', false);
        return;
      }
      // 逐台探测：用最近一条遥测的 extra 键自适应选 metric（temp→hum→nh3…）
      const series = [];
      for (const d of live) {
        const one = await UIx.api('devices/' + d.id + '/telemetry?limit=1');
        if (!one || !one.length) continue;
        const keys = numericPairs(safeParse(one[0].extra) || {}).map((p) => p[0]);
        const key = TEL_PRI.find((k) => keys.indexOf(k) >= 0) || (keys[0] || null);
        if (!key) continue;
        const pts = await UIx.api('devices/' + d.id + '/telemetry?metric=' + encodeURIComponent(key) + '&limit=120');
        if (!pts || pts.length < 2) continue;
        const m = KEY_ZH[key] || [key, ''];
        series.push({ name: d.name + '·' + m[0], unit: m[1], data: pts.map((p) => ({ t: p.ts, v: +p.v })) });
        if (series.length >= 3) break;
      }
      if (!series.length) {
        showTip('ov-env-empty', '已连接传感器尚无有效数值遥测：请让网关在 <code>extra</code> 中上报 temp/hum/nh3 等键（POST /api/telemetry）。');
        showChart('ov-chart1', false);
        return;
      }
      // x 轴 = 各序列时间并集
      const seen = [], idx = {};
      series.forEach((s) => s.data.forEach((p) => { if (idx[p.t] === undefined) { idx[p.t] = seen.length; seen.push(p.t); } }));
      const cats = seen.map(hhmm);
      const build = (s) => {
        const arr = new Array(seen.length).fill(null);
        s.data.forEach((p) => { arr[idx[p.t]] = p.v; });
        return arr;
      };
      const sOpt = series.map((s) => ({
        name: s.name + (s.unit ? '(' + s.unit + ')' : ''),
        type: 'line', smooth: true, showSymbol: false, connectNulls: false,
        lineStyle: { width: 2 },
        data: build(s)
      }));
      const mount = (!charts || !charts.env);
      if (mount) {
        if (!(YQCx && YQCx.make)) {
          showTip('ov-env-empty', '图表组件不可用（echarts 未加载），无法绘制趋势。');
          showChart('ov-chart1', false);
          return;
        }
        charts = charts || {};
        charts.env = YQCx.make(Q('ov-chart1'), {
          legend: { data: sOpt.map((s) => s.name), type: 'scroll' },
          tooltip: { trigger: 'axis' },
          grid: { left: 48, right: 18, top: 36, bottom: 26 },
          xAxis: { type: 'category', boundaryGap: false, data: cats },
          yAxis: { type: 'value', name: '遥测值' },
          series: sOpt
        });
        if (!charts.env) {
          showTip('ov-env-empty', '图表组件加载失败，无法绘制趋势。');
          showChart('ov-chart1', false);
          return;
        }
      } else if (charts.env) {
        charts.env.setOption({ xAxis: { data: cats }, series: sOpt });
      }
      hideTip('ov-env-empty');
      showChart('ov-chart1', true);
    }).catch(() => {
      envTrendBusy = false;
      showTip('ov-env-empty', '读取遥测失败：请检查云端后端与登录状态（docs/API.md 第 1 节）。');
    });
  }
  function showChart(id, on) {
    const el = Q(id);
    if (el) el.style.display = on ? '' : 'none';
  }

  /* ================= 逐时采食/产蛋（/api/samples） ================= */
  let hourlyBusy = false;
  function loadHourly() {
    if (!UIx.api || hourlyBusy) return;
    hourlyBusy = true;
    Promise.all([
      UIx.api('samples?kind=intake_h&limit=24'),
      UIx.api('samples?kind=eggs_h&limit=24')
    ]).then(([feed, eggs]) => {
      hourlyBusy = false;
      const ok = feed !== null || eggs !== null;
      if (!ok) { showTip('ov-hour-empty', '<b>云端后端未连接</b><br>请运行 <code>node backend/server.js</code> 并登录。'); showChart('ov-chart3', false); return; }
      const hourOf = (r) => {
        const meta = safeParse(r.meta) || {};
        const h = +meta.hour;
        if (Number.isFinite(h) && h >= 0 && h < 24) return h;
        const d = new Date(r.ts);
        return isNaN(d.getTime()) ? null : d.getHours();
      };
      const fold = (rows) => {
        const m = {};
        (rows || []).forEach((r) => { const h = hourOf(r); if (h !== null) m[h] = { v: +r.value, ts: r.ts }; });
        return m;
      };
      const F = fold(feed), E = fold(eggs);
      if (!Object.keys(F).length && !Object.keys(E).length) {
        showTip('ov-hour-empty', '逐时采食/产蛋由网关 <code>samples</code>（kind=intake_h / eggs_h，meta.hour=0..23）上报后绘制（docs/API.md 第 3 节）。<br>当前无任何采样记录。');
        showChart('ov-chart3', false);
        return;
      }
      const hours = Array.from(new Set(Object.keys(F).concat(Object.keys(E)).map(Number))).sort((a, b) => a - b);
      const cats = hours.map((h) => pad(h) + ':00');
      const val = (m) => hours.map((h) => (m[h] !== undefined ? m[h].v : null));
      const sOpt = [
        { name: '采食 kg/h', type: 'bar', barWidth: '38%', itemStyle: { color: '#6366f1', borderRadius: [3, 3, 0, 0] }, data: val(F) },
        { name: '产蛋 枚/h', type: 'bar', barWidth: '38%', itemStyle: { color: '#d97706', borderRadius: [3, 3, 0, 0] }, data: val(E) }
      ];
      const mount = (!charts || !charts.hourly);
      if (mount) {
        if (!(YQCx && YQCx.make)) {
          showTip('ov-hour-empty', '图表组件不可用（echarts 未加载），无法绘制。');
          showChart('ov-chart3', false);
          return;
        }
        charts = charts || {};
        charts.hourly = YQCx.make(Q('ov-chart3'), {
          legend: { data: ['采食 kg/h', '产蛋 枚/h'] },
          tooltip: { trigger: 'axis' },
          grid: { left: 48, right: 18, top: 34, bottom: 26 },
          xAxis: { type: 'category', data: cats },
          yAxis: { type: 'value', name: '数量' },
          series: sOpt
        });
        if (!charts.hourly) {
          showTip('ov-hour-empty', '图表组件加载失败，无法绘制。');
          showChart('ov-chart3', false);
          return;
        }
      } else if (charts.hourly) {
        charts.hourly.setOption({ xAxis: { data: cats }, series: sOpt });
      }
      hideTip('ov-hour-empty');
      showChart('ov-chart3', true);
    }).catch(() => { hourlyBusy = false; showTip('ov-hour-empty', '读取采样失败：请检查云端后端与登录状态。'); });
  }

  /* ================= 告警：donut 统计 + 最新列表（/api/alarms） ================= */
  let almBusy = false;
  function loadAlarms() {
    if (!UIx.api || almBusy) return;
    almBusy = true;
    UIx.api('alarms?limit=300').then((rows) => {
      almBusy = false;
      const R = rows || [];
      // donut：按 type 计数
      const cnt = {};
      let open = 0, done = 0;
      R.forEach((a) => {
        const t = a.type || '未分类';
        cnt[t] = (cnt[t] || 0) + 1;
        if (a.status === 'open') open++;
        else if (a.status === 'ack' || a.status === 'misreport') done++;
      });
      Q('ov-untreated').textContent = open;
      Q('ov-rate').textContent = R.length ? Math.round(done / R.length * 100) + '%' : '0%';
      if (!R.length) {
        showTip('ov-alm-empty', '暂无告警数据：设备/网关告警经 <code>POST /api/alarms</code> 上报后此处统计分类。<br>接入真实设备后自动出现。');
        showChart('ov-chart2', false);
        renderAlertsList([]);
        return;
      }
      const data = Object.keys(cnt).map((k) => ({ name: k, value: cnt[k] }));
      const mount = (!charts || !charts.donut);
      if (mount) {
        if (!(YQCx && YQCx.make)) {
          showTip('ov-alm-empty', '图表组件不可用（echarts 未加载），无法绘制。');
          showChart('ov-chart2', false);
          return;
        }
        charts = charts || {};
        charts.donut = YQCx.make(Q('ov-chart2'), {
          tooltip: { trigger: 'item', formatter: '{b}: {c} 条 ({d}%)' },
          legend: { bottom: 0, type: 'scroll', textStyle: { fontSize: 10 } },
          series: [{
            type: 'pie', radius: ['44%', '68%'], center: ['50%', '44%'],
            label: { show: false },
            itemStyle: { borderColor: '#ffffff', borderWidth: 2 },
            data
          }]
        });
        if (!charts.donut) {
          showTip('ov-alm-empty', '图表组件加载失败，无法绘制。');
          showChart('ov-chart2', false);
          return;
        }
      } else if (charts.donut) {
        charts.donut.setOption({ series: [{ data }] });
      }
      hideTip('ov-alm-empty');
      showChart('ov-chart2', true);
      renderAlertsList(R);
    }).catch(() => {
      almBusy = false;
      showTip('ov-alm-empty', '读取告警失败：请检查云端后端与登录状态。');
    });
  }
  function renderAlertsList(rows) {
    const box = Q('ov-alerts');
    if (!box) return;
    if (!rows.length) {
      box.innerHTML = '<div class="empty-tip">暂无告警，状态良好<br><span style="font-size:10.5px">设备告警经 POST /api/alarms 上报后在此实时展示</span></div>';
      return;
    }
    box.innerHTML = rows.slice(0, 5).map((a) => {
      const st = ALM_ST[a.status] || [a.status, '#9ca3af'];
      const tag = YQCx && YQCx.lvTag ? YQCx.lvTag(a.lv) : 'tag gray';
      const icobox = YQCx && YQCx.lvIcoBox ? YQCx.lvIcoBox(a.lv) : 'ico-s';
      return `<div class="alert-line" data-goalarm style="cursor:pointer">
        <span class="al-ico ${icobox}">${I(a.ico || 'alert-triangle', 15)}</span>
        <div class="al-body">
          <div class="al-title">${esc(a.type || '设备告警')}<span class="${tag}" style="margin-left:6px">${LV_ZH[a.lv] || a.lv}</span></div>
          <div class="al-desc">${esc(a.msg || '')}${a.device_id ? ' · ' + esc(a.device_id) : ''}</div>
        </div>
        <div style="text-align:right;flex:none">
          <div class="al-time" style="padding-top:0">${fmtDT(a.created_at)}</div>
          <div style="font-size:10.5px;color:${st[1]}">${st[0]}</div>
        </div>
      </div>`;
    }).join('');
  }
  function bindAlertsGo() {
    const box = Q('ov-alerts');
    if (!box) return;
    box.addEventListener('click', (e) => {
      if (e.target.closest('[data-goalarm]')) goPage('alarm');
    });
  }

  /* ================= 最新云端指令（/api/commands） ================= */
  let cmdsBusy = false;
  function loadCmds() {
    if (!UIx.api || cmdsBusy) return;
    cmdsBusy = true;
    UIx.api('commands?limit=10').then((rows) => {
      cmdsBusy = false;
      const box = Q('ov-logs');
      if (!box) return;
      const R = rows || [];
      if (!R.length) {
        box.innerHTML = '<div class="empty-tip">暂无云端指令<br><span style="font-size:10.5px">在「设备与网关」/控制面板下发指令、网关回执后在此展示流水</span></div>';
        return;
      }
      box.innerHTML = R.slice(0, 6).map((c) => {
        const st = CMD_ST[c.status] || ['tag gray', c.status];
        return `<div class="ev-item" style="align-items:flex-start">
          <span class="ev-ico ico-s">${I('send', 13)}</span>
          <div style="min-width:0;flex:1">
            <div style="font-size:12px;color:#111827;font-weight:500">${esc(c.device_id)} · ${esc(CMD_ZH[c.cmd] || c.cmd)}<span class="${st[0]}" style="margin-left:5px">${st[1]}</span></div>
            <div style="font-size:10.5px;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.ack_msg || '')}</div>
          </div>
          <div class="ev-time" style="padding-top:2px">${fmtDT(c.created_at)}</div>
        </div>`;
      }).join('');
    }).catch(() => { cmdsBusy = false; });
  }

  /* ================= 环境控制面板（保留云端化逻辑，仅补空台账引导） ================= */
  const RELAYS = [
    { id: 'fan_main', name: '主风机', zone: '育雏舍', icon: 'wind' },
    { id: 'fan_aux', name: '负压风机', zone: '育成舍', icon: 'wind' },
    { id: 'pad_pump', name: '湿帘泵', zone: '育成舍', icon: 'droplet' },
    { id: 'spray', name: '林下喷雾降温', zone: '散养区A', icon: 'droplet' },
    { id: 'feed_line', name: '料线电机', zone: '散养区', icon: 'bolt' },
    { id: 'light', name: '舍内补光', zone: '育雏舍', icon: 'sun' },
    { id: 'door', name: '散放门', zone: '场区', icon: 'door-exit' }
  ];
  const ctrlState = { devices: [], bind: {}, states: {}, busy: false };
  function bindPersist() {
    try { ctrlState.bind = JSON.parse(localStorage.getItem('ovCtrlBind') || '{}'); } catch (e) { ctrlState.bind = {}; }
  }
  function loadCtrlDevices() {
    if (!UIx.api || ctrlState.busy) return;
    ctrlState.busy = true;
    UIx.api('devices').then((list) => {
      ctrlState.busy = false;
      if (!list) return;
      ctrlState.devices = list;
      renderCtrl();
    }).catch(() => { ctrlState.busy = false; });
  }
  function ctrlOpts() {
    const live = ctrlState.devices.filter((d) => d.live);
    const rest = ctrlState.devices.filter((d) => !d.live);
    const ordered = live.concat(rest);
    return '<option value="">— 选择执行设备 —</option>' + ordered.map((d) =>
      `<option value="${esc(d.id)}">${esc(d.id)} · ${esc(d.name)}${d.live ? '（已连接）' : '（未连接）'}</option>`).join('');
  }
  function renderCtrl() {
    const box = Q('ov-ctrl');
    if (!box) return;
    bindPersist();
    if (!ctrlState.devices.length) {
      box.innerHTML = '<div class="empty-tip"><b>暂无执行设备可绑定</b><br>请先到「设备与网关」登记网关/补食机/机巢等设备，再回来为各开关绑定执行设备。</div>';
      return;
    }
    box.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:8px 14px">` +
      RELAYS.map((r) => {
        const bindId = ctrlState.bind[r.id] || '';
        const bound = ctrlState.devices.find((d) => d.id === bindId) || null;
        const stTxt = !bindId ? '未绑定执行设备' : (bound && bound.live ? '执行设备已连接' : '执行设备未连接（指令将排队）');
        const stCls = !bindId ? 'dim' : (bound && bound.live ? 'ok' : 'warn');
        return `<div class="ctrl-row">
          <span class="cr-ico ico-s">${I(r.icon, 16)}</span>
          <div class="cr-name">${r.name}<small>${r.zone}</small></div>
          <select class="dv-in" data-relay="${r.id}" title="选择执行设备（网关桥支持后即能控制）">${ctrlOpts()}</select>
          <span class="cr-st ${stCls}" id="cr-st-${r.id}" data-st="${stTxt}">${stTxt}</span>
          <label class="switch" title="下发开/关指令"><input type="checkbox" data-sw="${r.id}"><span class="slider"></span></label>
        </div>`;
      }).join('') + '</div>';
    RELAYS.forEach((r) => {
      const sel = box.querySelector('[data-relay="' + r.id + '"]');
      if (sel && ctrlState.bind[r.id]) sel.value = ctrlState.bind[r.id];
      const sw = box.querySelector('[data-sw="' + r.id + '"]');
      if (sw && ctrlState.states[r.id]) sw.checked = !!ctrlState.states[r.id];
    });
  }
  function bindCtrl() {
    const box = Q('ov-ctrl');
    if (!box) return;
    box.addEventListener('change', (e) => {
      const sel = e.target.closest('[data-relay]');
      if (sel) {
        ctrlState.bind[sel.dataset.relay] = sel.value;
        try { localStorage.setItem('ovCtrlBind', JSON.stringify(ctrlState.bind)); } catch (err) { /* */ }
        renderCtrl();
        return;
      }
      const sw = e.target.closest('[data-sw]');
      if (sw) sendRelay(sw.dataset.sw, sw.checked);
    });
    Q('ov-ctrl-refresh').onclick = () => loadCtrlDevices();
  }
  function sendRelay(relayId, on) {
    const bindId = ctrlState.bind[relayId];
    const st = Q('cr-st-' + relayId);
    const ctrlEl = Q('ov-ctrl');
    const sw = ctrlEl ? ctrlEl.querySelector('[data-sw="' + relayId + '"]') : null;
    if (!bindId) {
      if (sw) sw.checked = false;
      toast('请先选择执行设备', '每行下拉框选择承担该开关的网关/设备', 'warn');
      return;
    }
    const dev = ctrlState.devices.find((d) => d.id === bindId);
    if (dev && !dev.live) toast('执行设备未连接', bindId + ' 指令将进入云端队列，网关接入并轮询后执行', 'warn');
    ctrlState.states[relayId] = !!on;
    UIx.apiEx('devices/' + bindId + '/command', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'relay', params: { relay: relayId, state: on ? 1 : 0, from: 'overview' } })
    }).then((r) => {
      if (r.status === 200 && r.data) {
        if (st) { st.textContent = '已下发 #CMD' + r.data.id + ' · 等待网关回执'; st.className = 'cr-st ok'; }
        if (UIx.watchCmd) UIx.watchCmd(bindId, r.data.id, 'relay:' + relayId);
      } else {
        if (sw) sw.checked = !on;
        ctrlState.states[relayId] = !on;
        const why = r.status === 403 ? '当前账号无控制权限' : ((r.data && r.data.error) || 'HTTP ' + r.status);
        toast('指令下发失败', bindId + '：' + why, 'err');
      }
    });
  }

  /* ================= 生命周期 ================= */
  const last = { metrics: 0, ctrl: 0, envList: 0, envTrend: 0, hourly: 0, cmds: 0, alm: 0 };

  function init() {
    const root = Q('page-overview');
    root.innerHTML = html;
    charts = null;   // 页面重绘后旧实例已脱离 DOM，重新按需创建
    bindNav();
    bindEnvList();
    bindAlertsGo();
    bindCtrl();
    // 立即填充（含空态渲染），随后 tick 节流刷新
    loadMetrics();
    loadCtrlDevices();
    loadEnvList();
    loadEnvTrend();
    loadHourly();
    loadCmds();
    loadAlarms();
    tick();
  }

  /* 每秒被 app 调用；自带节流：metrics 5s / 控制设备 15s / 其余 30s；未 init 直接返回 */
  function tick() {
    if (!Q('ov-ctrl')) return;
    const now = Date.now();
    if (now - last.metrics >= 5000) { last.metrics = now; loadMetrics(); }
    if (now - last.ctrl >= 15000) { last.ctrl = now; loadCtrlDevices(); }
    if (now - last.envList >= 30000) { last.envList = now; loadEnvList(); }
    if (now - last.envTrend >= 30000) { last.envTrend = now; loadEnvTrend(); }
    if (now - last.hourly >= 30000) { last.hourly = now; loadHourly(); }
    if (now - last.cmds >= 30000) { last.cmds = now; loadCmds(); }
    if (now - last.alm >= 30000) { last.alm = now; loadAlarms(); }
  }

  /* 页面激活钩子：立即同步一次（busy 标志防重入） */
  function onShow() {
    if (!Q('ov-ctrl')) return;
    loadMetrics();
    loadCtrlDevices();
    loadEnvList();
    loadAlarms();
    loadCmds();
  }

  global.PAGES = global.PAGES || {};
  global.PAGES.overview = { name: '总览监控面板', init, tick, onShow };
})(window);
