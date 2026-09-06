/* ============================================================
 * 无人机检测面板（纯云端真实数据版）
 * ============================================================
 * 契约：docs/API.md（只消费后端接口，禁止仿真/YQ/data.js 依赖）
 * - 机队卡片：GET /api/devices?type=drone（live 语义：90s 内遥测点亮）
 * - 任务/指令流水：GET /api/commands?limit=30（cmd 中文 + 状态 + ack_msg）
 * - 设备告警流：GET /api/alarms?limit=30（只读展示）
 * - 航线：GET /api/waypoints（仅取“机队中已连接”的设备的航点连线到态势图）
 * - 联动策略开关：GET/PUT /api/kv/policy.drone.*（网关轮询执行，真实持久化）
 * - FPV：仅已连接且配置 HTTP 流地址时经 StreamBox 播放；其余为静态占位一帧
 * 说明：
 * - UI.Q = document.getElementById（不接受 CSS 选择器），需要子查询时先
 *   取容器元素再 container.querySelector，严禁 Q('#a b') 写法。
 * - 态势图为“几何示意 + 云端航点投影”，无任何 YQ/演示/随机内容。
 * ============================================================ */
(function (global) {
  'use strict';
  const UIx = global.UI, YQCx = global.YQC;
  const Q = UIx.Q, $$ = UIx.$$, esc = UIx.esc, toast = UIx.toast, pad = UIx.pad;

  /* ---------- 态势图几何常量（本地示意，viewBox 640x430） ---------- */
  const MB = { w: 640, h: 430 };
  const ZONES = [
    { name: '散养区A · 松林', poly: '70,215 90,150 200,105 330,118 352,178 300,262 150,268 78,252', color: '#10b981', label: [150, 150] },
    { name: '散养区B · 草坡', poly: '390,112 545,122 600,215 525,300 375,268 352,180', color: '#0ea5e9', label: [452, 165] },
    { name: '舍区(育雏/育成)', poly: '300,300 470,306 492,340 300,344', color: '#8b5cf6', label: [392, 332] }
  ];
  const NEST = { label: '智能机巢', x: 296, y: 386, w: 60, h: 30, cx: 326, cy: 400 };
  /* 航点经纬度 → 本地坐标的近似投影：以机巢基点(站点经纬度)为锚，示意比例，非精确测绘 */
  const BASE_FALLBACK = { lon: 104.45189, lat: 34.96081 };   // 步云村（菜子镇）机巢
  const PX_PER_M = 0.45;                                     // 0.45 px/m（约 500m 半径落在画布内）
  const M_PER_DEG_LAT = 111132, M_PER_DEG_LON = 91245;       // 34.96°N 处经度米距

  /* ---------- 状态/指令文案（页面自备常量，全部来自 devices/commands 行） ---------- */
  const ST_ZH = { offline: '离线', online: '在线', standby: '待命', patrol: '巡线中', flight: '飞行中', charging: '充电中', warn: '预警' };
  const ST_CLS = { offline: 'tag red', online: 'tag sky', standby: 'tag green', patrol: 'tag sky', flight: 'tag sky', charging: 'tag amber', warn: 'tag amber' };
  const S_FLY = { patrol: 1, flight: 1 };                     // “飞行中”指令语义（返航按钮）
  const CMD_ZH = {
    takeoff: '起飞', rtl: '返航', land: '降落', charge: '充电', start_patrol: '开始巡线',
    stream_on: '开启图传', reboot: '重启', feed_now: '立即补食', gimbal_home: '云台归中',
    shot: '抓拍', record: '录像', speaker: '喊话', relay: '开关控制', gimbal: '云台'
  };
  const CMD_ST_CLS = { queued: 'tag amber', sent: 'tag sky', ack: 'tag green', fail: 'tag red', timeout: 'tag gray' };
  const CMD_ST_ZH = { queued: '排队中', sent: '待网关回执', ack: '已回执', fail: '失败', timeout: '超时' };
  const ALM_ST_ZH = { open: '待处理', ack: '已确认', misreport: '误报' };
  const LV_ZH = { crit: '严重', warn: '警告', info: '提示' };

  /* ---------- 页面状态 ---------- */
  const state = {
    inited: false, tickSeq: 0,
    fleet: undefined,      // undefined=未加载；null=后端不可达；[]=空台账
    cmds: [], alarms: [], wps: [], site: null, kv: {},
    names: {}, namesAt: 0, kvAt: 0,
    lastPoll: 0, fpvSig: '', routeSig: ''
  };

  /* ---------- 小工具 ---------- */
  const t2 = (iso) => { if (!iso) return ''; const d = new Date(iso); if (isNaN(d.getTime())) return ''; return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); };
  const cfgOf = (cd) => { try { return JSON.parse(cd && cd.config ? cd.config : '{}') || {}; } catch (e) { return {}; } };
  const battOf = (cd) => (cd && cd.batt != null && cd.batt >= 0) ? cd.batt : null;
  const num = (v, dec) => { const n = Number(v); return Number.isFinite(n) ? n.toFixed(dec === undefined ? 0 : dec) : '—'; };
  const liveOf = (cd) => !!(cd && cd.live);
  const zhOf = (cd) => (cd && ST_ZH[cd.status]) || '未知';
  const flyOf = (cd) => liveOf(cd) && !!S_FLY[cd.status];
  const devFullOf = (id) => { const n = state.names[id]; return n ? (n.name + (n.sub ? ' · ' + n.sub : '')) : (id || ''); };

  function firstLive() { return (state.fleet || []).find((cd) => cd.live) || null; }

  /* ---------- 布局 ---------- */
  const html = `
  <div class="content-scroll">
    <div class="grid">

      <!-- 无人机机队（云端台账） -->
      <div class="card span-4">
        <div class="card-h"><span class="h-ico">${I('drone', 15)}</span>无人机机队
          <span class="card-title-note" id="dr-cloud-state" style="margin-left:auto;text-align:right;line-height:1.5">数据源检测中…</span>
          <span class="more" id="dr-fleet-refresh" title="立即从云端刷新">刷新</span></div>
        <div class="h-divider"></div>
        <div class="card-b" id="dr-fleet" style="padding-top:10px"></div>
      </div>

      <!-- 任务 / 指令流水 -->
      <div class="card span-8">
        <div class="card-h"><span class="h-ico">${I('send', 15)}</span>任务 / 指令流水
          <span class="card-title-note" id="dr-cmd-state" style="line-height:1.5">网关轮询执行并回执后闭环</span>
          <span class="more" id="dr-cmd-refresh">刷新</span></div>
        <div class="h-divider"></div>
        <div class="card-b" style="padding-top:6px"><div class="event-stream" id="dr-cmds" style="max-height:400px"></div></div>
      </div>

      <!-- 低空巡检态势图（几何示意 + 云端航点航线） -->
      <div class="card span-6">
        <div class="card-h"><span class="h-ico">${I('map-2', 15)}</span>低空巡检态势图
          <span class="card-title-note" id="dr-map-state" style="line-height:1.5">等待云端数据…</span></div>
        <div class="h-divider"></div>
        <div class="card-b">
          <div class="map-wrap" id="dr-map" style="width:100%"></div>
        </div>
        <div style="display:flex;gap:14px;padding:0 14px 12px;font-size:11px;color:var(--dim);flex-wrap:wrap">
          <span><span class="dot" style="background:#10b981;margin-right:4px"></span>散养区A</span>
          <span><span class="dot" style="background:#0ea5e9;margin-right:4px"></span>散养区B</span>
          <span><span class="dot" style="background:#8b5cf6;margin-right:4px"></span>舍区</span>
          <span><span class="dot" style="background:#6366f1;margin-right:4px"></span>航点航线(云端)</span>
          <span><span class="dot" style="background:#cbd5e1;margin-right:4px"></span>机巢</span>
          <span style="margin-left:auto" id="dr-fresh">—</span>
        </div>
      </div>

      <!-- 实时图传监控 · FPV（仅真实流 / 静态占位） -->
      <div class="card span-6">
        <div class="card-h"><span class="h-ico">${I('video', 15)}</span>实时图传监控 · FPV
          <span class="card-title-note" id="dr-fpv-tip">设备未连接 · 无图传画面</span>
          <span class="more" id="dr-fpv-full">全屏观看</span></div>
        <div class="h-divider"></div>
        <div class="card-b">
          <div class="feed-box" id="dr-fpv-box" style="aspect-ratio:16/9">
            <canvas id="dr-fpv-cv" width="640" height="360"></canvas>
            <div class="feed-badge"><span class="rec-dot" style="background:#94a3b8;animation:none"></span>未连接</div>
            <div class="feed-time" id="dr-fpv-time">--:--:--</div>
            <div class="feed-name" id="dr-fpv-name">— 暂无图传源 —</div>
            <div class="feed-stats" id="dr-fpv-hud"><span>ALT —</span><span>SPD —</span><span>电量 —</span></div>
          </div>
        </div>
      </div>

      <!-- 设备告警 / 识别事件流 -->
      <div class="card span-4">
        <div class="card-h"><span class="h-ico">${I('alert-triangle', 15)}</span>设备告警 / 识别事件
          <span class="card-title-note" id="dr-alarm-state">—</span>
          <span class="more" data-nav="alarm">报警中心 ›</span></div>
        <div class="h-divider"></div>
        <div class="card-b" style="padding-top:8px"><div class="event-stream" id="dr-detect" style="max-height:360px"></div></div>
      </div>

      <!-- 联动策略（KV 持久化 · 网关轮询执行） -->
      <div class="card span-8">
        <div class="card-h"><span class="h-ico">${I('settings', 15)}</span>联动策略
          <span class="card-title-note">开关写入 KV（policy.drone.*），由网关轮询执行；默认关闭</span>
          <span class="more" id="dr-policy-refresh">同步策略</span></div>
        <div class="h-divider"></div>
        <div class="card-b" style="padding-top:6px">
          <div class="dr-plan-grid" id="dr-policy" style="grid-template-columns:1fr">
            <div class="field-row"><span class="fr-name">${I('cloud-rain', 14)}
              <span><b style="font-weight:500">恶劣天气自动返航</b><small style="display:block;font-size:10.5px;color:var(--dim)">大风/暴雨触发时向巡检无人机下发返航指令</small></span></span>
              <label class="switch" title="KV: policy.drone.auto_rtl"><input type="checkbox" data-kv="auto_rtl" data-key="policy.drone.auto_rtl"><span class="slider"></span></label></div>
            <div class="field-row"><span class="fr-name">${I('moon', 14)}
              <span><b style="font-weight:500">夜间红外巡视</b><small style="display:block;font-size:10.5px;color:var(--dim)">夜间时段向机队派发开始巡线指令</small></span></span>
              <label class="switch" title="KV: policy.drone.night_scan"><input type="checkbox" data-kv="night_scan" data-key="policy.drone.night_scan"><span class="slider"></span></label></div>
            <div class="field-row"><span class="fr-name">${I('bell-plus', 14)}
              <span><b style="font-weight:500">告警推送手机端</b><small style="display:block;font-size:10.5px;color:var(--dim)">设备告警生成时推送场区手机端</small></span></span>
              <label class="switch" title="KV: policy.drone.push_alarm"><input type="checkbox" data-kv="push_alarm" data-key="policy.drone.push_alarm"><span class="slider"></span></label></div>
          </div>
          <div style="font-size:10.5px;color:var(--dim);margin-top:6px" id="dr-policy-tip">策略值为云端 KV 持久化状态 · 网关轮询（GET /api/kv）执行后回执</div>
        </div>
      </div>
    </div>
  </div>`;

  /* ================= 无人机机队卡片（台账行 → 卡片） ================= */
  function droneCard(d) {
    const live = liveOf(d);
    const cfg = cfgOf(d);
    const batt = battOf(d);
    const flying = flyOf(d);
    const mountParts = [cfg.cam && ('相机 ' + cfg.cam), cfg.gimbal && '云台', cfg.speaker && '喊话', cfg.rtk && 'RTK'].filter(Boolean);
    const mainBtn = flying
      ? { cmd: 'rtl', ico: 'home-2', t: '召回返航' }
      : { cmd: 'takeoff', ico: 'plane', t: '起飞' };
    // 实况明细行：全部来自真实行/遥测字段，缺失即省略，不填假值
    let detail = '';
    if (!live) {
      detail = '<div style="margin-top:7px;font-size:10.5px;color:var(--dim);line-height:1.7">' +
        '未连接：网关定时上报遥测（POST /api/telemetry）后 90 秒内自动点亮 · 接入见 gateway/drone_bridge.py</div>';
    } else {
      const parts = [];
      if (d.last_seen) parts.push('心跳 ' + t2(d.last_seen));
      if (d.lat != null && d.lon != null) parts.push(d.lat.toFixed(6) + 'N, ' + d.lon.toFixed(6) + 'E');
      if (cfg.tel_armed !== undefined) parts.push(cfg.tel_armed ? '已解锁' : '未解锁');
      if (cfg.tel_mode) parts.push('模式 ' + esc(cfg.tel_mode));
      if (cfg.tel_heading !== undefined) parts.push('航向 ' + num(cfg.tel_heading) + '°');
      if (mountParts.length) parts.push('挂载 ' + esc(mountParts.join(' / ')));
      detail = '<div style="margin-top:7px;font-size:10.5px;color:var(--dim);line-height:1.7">云端实况：' +
        (parts.length ? parts.join(' · ') : '（无更多实况字段）') + '</div>';
    }
    const statusChip = live
      ? `<span class="${ST_CLS[d.status] || 'tag gray'}">${zhOf(d)}</span>`
      : '<span class="tag red">未连接</span>';
    return `<div class="uav-card ${flying ? 'flight' : ''}">
      <div class="uav-head">
        <div class="ring" style="--p:${batt != null ? Math.round(batt) : 0};--c:${batt != null ? (batt > 55 ? '#10b981' : (batt > 25 ? '#f59e0b' : '#ef4444')) : '#d1d5db'}">
          <b>${batt != null ? Math.round(batt) + '%' : '—'}</b></div>
        <div style="min-width:0">
          <div class="u-name" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">${esc(d.id)}
            ${live ? '<span class="tag green">已连接</span>' : '<span class="tag red">未连接</span>'}</div>
          <div class="u-mod">${esc((((d.vendor || '') + ' ' + (d.model || '')).trim() || '未登记型号') + (d.sub ? ' · ' + d.sub : ''))}</div>
          <div style="margin-top:3px;display:flex;gap:4px;flex-wrap:wrap">${statusChip}
            ${mountParts.length ? `<span class="tag gray">${esc(mountParts.join(' / '))}</span>` : ''}</div>
        </div>
      </div>
      <div class="uav-metrics" style="margin-top:9px">
        <div class="um"><b>${live && d.alt != null ? Math.round(d.alt) : '—'}</b><span>高度m</span></div>
        <div class="um"><b>${live && cfg.tel_speed != null ? num(cfg.tel_speed, 1) : '—'}</b><span>速度m/s</span></div>
        <div class="um"><b>${live && cfg.tel_mode ? esc(cfg.tel_mode) : '—'}</b><span>飞行模式</span></div>
        <div class="um"><b>${live && cfg.tel_armed !== undefined ? (cfg.tel_armed ? '已解锁' : '未解锁') : '—'}</b><span>解锁</span></div>
      </div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn primary" style="flex:1" data-uav="${esc(d.id)}" data-cmd="${mainBtn.cmd}"
          ${live ? '' : 'disabled title="接入网关后点亮"'}>${I(mainBtn.ico, 14)} ${mainBtn.t}</button>
        <button class="btn" data-uav="${esc(d.id)}" data-cmd="charge" ${live ? '' : 'disabled title="接入网关后点亮"'}>${I('bolt', 14)} 充电</button>
        <button class="btn" data-uav="${esc(d.id)}" data-cmd="stream_on" ${live ? '' : 'disabled title="接入网关后点亮"'}>${I('video', 14)} 图传</button>
      </div>
      ${detail}
    </div>`;
  }

  function renderFleet() {
    const box = Q('dr-fleet');
    const note = Q('dr-cloud-state');
    if (!box) return;
    const f = state.fleet;
    if (f === null) {
      box.innerHTML = '<div class="empty-tip"><b style="color:#4b5563">无法连接云端后端</b><br>请运行 node backend/server.js 并确认已登录后重试。</div>';
      if (note) { note.textContent = '云端后端不可用'; note.style.color = '#b91c1c'; }
      return;
    }
    if (f === undefined) {
      box.innerHTML = '<div class="empty-tip">正在读取云端无人机台账…</div>';
      if (note) { note.textContent = '数据源检测中…'; note.style.color = ''; }
      return;
    }
    const liveN = f.filter((cd) => cd.live).length;
    if (f.length === 0) {
      box.innerHTML = '<div class="empty-tip"><b style="color:#4b5563">暂无无人机设备</b><br>' +
        '请到「设备与网关」登记您的无人机（或接入网关后自动登记），即可在此管理。</div>';
      if (note) { note.textContent = '0 台（台账为空）'; note.style.color = '#d97706'; }
      return;
    }
    box.innerHTML = f.map(droneCard).join('');
    if (note) {
      note.textContent = liveN
        ? f.length + ' 台 · ' + liveN + ' 台已连接（90s 遥测内）'
        : f.length + ' 台 · 全部未连接（接入网关上报遥测后点亮）';
      note.style.color = liveN ? '#047857' : '#d97706';
    }
  }

  /* ================= 任务 / 指令流水 ================= */
  function cmdRow(c) {
    const zh = CMD_ZH[c.cmd] || c.cmd;
    const stC = CMD_ST_CLS[c.status] || 'tag gray';
    const stZ = CMD_ST_ZH[c.status] || c.status;
    const nm = c.device_id ? devFullOf(c.device_id) : '';
    const who = nm && nm !== c.device_id ? (esc(c.device_id) + ' · ' + esc(nm)) : esc(c.device_id || '—');
    return `<div class="ev-item" style="align-items:flex-start">
      <span class="ev-ico ico-s">${I('send', 13)}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;color:#111827;font-weight:500">${who} · ${esc(zh)}
          <span class="${stC}" style="margin-left:5px">${stZ}</span></div>
        <div style="font-size:10.5px;color:var(--dim);margin-top:1px">${t2(c.created_at)}${c.ack_msg ? ' · ' + esc(String(c.ack_msg)) : ''}</div>
      </div>
    </div>`;
  }

  function renderCmds() {
    const box = Q('dr-cmds');
    if (!box) return;
    const list = state.cmds;
    const note = Q('dr-cmd-state');
    if (note) {
      if (list.length) {
        const ackN = list.filter((c) => c.status === 'ack').length;
        note.textContent = '最近 ' + list.length + ' 条 · ' + ackN + ' 条已回执';
      } else if (state.fleet === null) note.textContent = '云端后端不可用';
      else note.textContent = '暂无指令 · 下发后在此查看回执';
    }
    box.innerHTML = list.length
      ? list.slice(0, 30).map(cmdRow).join('')
      : '<div class="empty-tip"><b style="color:#4b5563">暂无任务 / 指令</b><br>' +
        '登记并接入无人机后，在本页下发起飞 / 返航等指令；网关（gateway/drone_bridge.py）轮询执行并回执后，流水自动出现在这里（docs/API.md）。</div>';
  }

  /* ================= 设备告警 / 识别事件流 ================= */
  function alarmRow(a) {
    const lv = a.lv || 'info';
    const fn = a.device_id ? devFullOf(a.device_id) : '';
    const nm = fn !== a.device_id ? (fn + (a.device_id ? ' · ' + a.device_id : '')) : (a.device_id || '设备');
    const stC = a.status === 'open' ? 'tag amber' : (a.status === 'misreport' ? 'tag gray' : 'tag green');
    const stZ = ALM_ST_ZH[a.status] || a.status;
    return `<div class="ev-item" style="align-items:flex-start">
      <span class="ev-ico ${YQCx.lvIcoBox(lv)}">${I(a.ico || 'alert-triangle', 14)}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;color:#111827;font-weight:500">${esc(a.type || '设备告警')}
          <span class="${YQCx.lvTag(lv)}" style="margin-left:5px">${LV_ZH[lv] || lv}</span>
          <span class="${stC}" style="margin-left:4px">${stZ}</span></div>
        <div style="font-size:11px;color:var(--dim);margin-top:1px">${esc(a.msg || '')}</div>
        <div style="font-size:10.5px;color:#9ca3af;margin-top:1px">${esc(nm)}</div>
      </div>
      <span class="ev-time">${t2(a.created_at)}</span>
    </div>`;
  }

  function renderAlarms() {
    const box = Q('dr-detect');
    if (!box) return;
    const list = state.alarms;
    const note = Q('dr-alarm-state');
    if (note) note.textContent = list.length ? list.length + ' 条' : '—';
    box.innerHTML = list.length
      ? list.slice(0, 30).map(alarmRow).join('')
      : '<div class="empty-tip"><b style="color:#4b5563">暂无设备告警</b><br>' +
        '设备（网关/无人机/摄像头等）上报的事件会出现在这里；接入与上报见 docs/API.md。</div>';
  }

  /* ================= 态势图：静态几何 + 云端航点航线 ================= */
  function svgStatic() {
    const zoneSvg = ZONES.map((z) =>
      `<polygon points="${z.poly}" fill="${z.color}14" stroke="${z.color}" stroke-opacity=".65" stroke-width="1.4"/>
       <text x="${z.label[0]}" y="${z.label[1]}" class="map-label">${z.name}</text>`).join('');
    return `<svg class="map-svg" viewBox="0 0 ${MB.w} ${MB.h}" preserveAspectRatio="xMidYMid meet">
      <rect width="${MB.w}" height="${MB.h}" fill="#eef2f7" rx="10"/>
      <rect width="${MB.w}" height="${MB.h}" fill="url(#mg)" rx="10"/>
      <defs>
        <linearGradient id="mg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="rgba(255,255,255,.9)"/><stop offset="1" stop-color="rgba(255,255,255,0)"/>
        </linearGradient>
      </defs>
      ${zoneSvg}
      <!-- 机巢（几何示意） -->
      <g id="nest-g">
        <rect x="${NEST.x}" y="${NEST.y}" width="${NEST.w}" height="${NEST.h}" rx="5" fill="#ffffff" stroke="#cbd5e1"/>
        <text x="${NEST.x + 4}" y="${NEST.y + 18}" fill="#475569" style="font-size:10px;font-weight:600">${NEST.label}</text>
      </g>
      <!-- 云端航点航线层（每次按真实 waypoints 重建，无数据则为空） -->
      <g id="wp-layer"></g>
    </svg>`;
  }

  /* 站点锚点：优先云端站点表，失败回退步云村机巢坐标 */
  function baseCoord() {
    const s = state.site;
    return s && s.lon != null && s.lat != null ? { lon: s.lon, lat: s.lat } : BASE_FALLBACK;
  }
  function proj(lon, lat, base) {
    return {
      x: NEST.cx + (lon - base.lon) * M_PER_DEG_LON * PX_PER_M,
      y: NEST.cy - (lat - base.lat) * M_PER_DEG_LAT * PX_PER_M
    };
  }
  const F = (v) => (Math.round(v * 10) / 10).toFixed(1);

  function routeGroups() {
    const liveIds = new Set((state.fleet || []).filter((cd) => cd.live).map((cd) => cd.id));
    const byDev = {};
    (state.wps || []).forEach((w) => { if (liveIds.has(w.device_id)) { (byDev[w.device_id] = byDev[w.device_id] || []).push(w); } });
    const out = [];
    Object.keys(byDev).forEach((did) => {
      const dev = (state.fleet || []).find((cd) => cd.id === did);
      const pts = byDev[did].slice().sort((a, b) => (a.idx || 0) - (b.idx || 0));
      out.push({ device: dev, pts });
    });
    return out;
  }

  function renderMap() {
    const mapEl = Q('dr-map');
    const layer = mapEl ? mapEl.querySelector('#wp-layer') : null;
    const note = Q('dr-map-state');
    if (!layer) return;
    const base = baseCoord();
    const groups = routeGroups();
    const sig = JSON.stringify([Math.round(base.lon * 1e4), Math.round(base.lat * 1e4),
      groups.map((g) => [g.device && g.device.id, g.pts.map((p) => [p.lat, p.lon])])]);
    let svg = '';
    if (sig !== state.routeSig) {
      state.routeSig = sig;
      groups.forEach((g) => {
        const dev = g.device;
        const pts = g.pts.map((p) => proj(p.lon, p.lat, base));
        const title = esc((dev ? (dev.id + ' · ' + dev.name + (dev.sub ? ' · ' + dev.sub : '')) : g.device) + ' 航点航线');
        if (pts.length >= 2) {
          const line = pts.map((p) => F(p.x) + ',' + F(p.y)).join(' ');
          svg += `<polyline points="${line}" fill="none" stroke="#6366f1" stroke-width="2" stroke-dasharray="8 6" opacity=".8">
            <title>${title}</title></polyline>`;
        }
        pts.forEach((p) => {
          svg += `<circle cx="${F(p.x)}" cy="${F(p.y)}" r="2.4" fill="#6366f1" opacity=".9"><title>${title}</title></circle>`;
        });
      });
      layer.innerHTML = svg;
    }
    const liveWpN = groups.length;
    if (note) {
      if (state.fleet === null) note.textContent = '云端后端不可用';
      else if ((state.fleet || []).length === 0) note.textContent = '无实时航线 · 登记无人机后显示航点';
      else if (!liveWpN) note.textContent = '无已连接无人机航点（接入网关并上传 waypoints 后自动连线）';
      else note.textContent = liveWpN + ' 架已连接无人机 · 云端航点连线';
      note.style.color = liveWpN ? '#047857' : (state.fleet === null ? '#b91c1c' : '#d97706');
    }
    const fresh = Q('dr-fresh');
    if (fresh) fresh.textContent = '云端 ' + (state.lastPoll ? Math.max(0, Math.round((Date.now() - state.lastPoll) / 1000)) + 's 前刷新' : '…');
  }

  /* ================= FPV：仅真实流（无动态模拟，占位为静态一帧） ================= */
  const FPV_W = 640, FPV_H = 360;

  function fpvPlaceholderText() {
    const f = state.fleet;
    const live = firstLive();
    if (f === null) return ['无法连接云端后端', '请运行 node backend/server.js 并确认登录后刷新'];
    if (f === undefined) return ['正在读取云端数据…', ''];
    if (!f.length) return ['暂无无人机设备', '登记无人机后，图传画面将在此显示（见「设备与网关」）'];
    if (!live) return ['全部无人机未连接', '接入网关并定时上报遥测（POST /api/telemetry）后自动点亮'];
    return null; // 有已连接无人机 → 按流地址决定（StreamBox）
  }

  function drawFpvStatic(title, sub, extra) {
    const cv = Q('dr-fpv-cv');
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#0d1626'; ctx.fillRect(0, 0, FPV_W, FPV_H);
    ctx.strokeStyle = 'rgba(255,255,255,.05)'; ctx.lineWidth = 1;
    for (let x = 0; x <= FPV_W; x += 32) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, FPV_H); ctx.stroke(); }
    for (let y = 0; y <= FPV_H; y += 32) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(FPV_W, y); ctx.stroke(); }
    ctx.textAlign = 'center';
    ctx.fillStyle = '#9fb2d8';
    ctx.font = 'bold 17px "Microsoft YaHei",sans-serif';
    ctx.fillText(title || '设备未连接', FPV_W / 2, 176);
    ctx.font = '12px "Microsoft YaHei",sans-serif';
    if (sub) { ctx.fillStyle = '#8fa3c8'; ctx.fillText(sub, FPV_W / 2, 205); }
    if (extra) { ctx.fillStyle = '#5d7294'; ctx.font = '11px "Microsoft YaHei",sans-serif'; ctx.fillText(extra, FPV_W / 2, 232); }
    ctx.textAlign = 'left';
  }

  function syncFpvBox() {
    const box = Q('dr-fpv-box');
    const cv = Q('dr-fpv-cv');
    if (!box || !cv) return;
    const f = state.fleet;
    const live = firstLive();
    const ph = fpvPlaceholderText();
    const url = (live && live.stream_url) ? live.stream_url.trim() : '';
    let playSt = 'na';
    const oldSig = state.fpvSig;
    // 先驱动播放器状态（幂等：StreamBox 同源不重建）
    if (ph === null) {
      if (window.StreamBox) playSt = window.StreamBox.play(box, url, { muted: true });
    } else if (window.StreamBox) {
      window.StreamBox.stop(box);
    }
    // 顶部小字：状态说明
    const tip = Q('dr-fpv-tip');
    const nm = Q('dr-fpv-name');
    const hud = Q('dr-fpv-hud');
    if (nm) {
      nm.textContent = live
        ? live.id + ' · ' + (live.name || '') + (live.sub ? ' · ' + live.sub : '') + ((live.vendor || live.model) ? ' · ' + (((live.vendor || '') + ' ' + (live.model || '')).trim()) : '')
        : '— 暂无图传源 —';
    }
    if (tip) {
      if (ph !== null) tip.textContent = ph[0] + (ph[1] ? ' · ' + ph[1] : '');
      else if (playSt === 'playing') tip.textContent = '真实图传播放中 · ' + live.id + ' · ' + esc(url.split('?')[0].slice(0, 60));
      else if (playSt === 'relay') tip.textContent = '已连接 · 图传为 RTSP/RTMP，需转流为 HLS/FLV 后填入 HTTP 地址（docs/STREAMING.md）';
      else if (url) tip.textContent = '已连接 · 图传地址无法直接播放（' + esc(url.split('?')[0].slice(0, 50)) + '）';
      else tip.textContent = '已连接 · 未配置图传流地址（「设备与网关」页填写 stream_url）';
    }
    if (hud) {
      if (ph === null && live) {
        const cfg = cfgOf(live);
        const batt = battOf(live);
        const altT = live.alt != null ? Math.round(live.alt) : '—';
        const spdT = cfg.tel_speed != null ? num(cfg.tel_speed, 1) : '—';
        const batT = batt != null ? Math.round(batt) + '%' : '—';
        const posT = (live.lat != null && live.lon != null) ? live.lat.toFixed(5) + ',' + live.lon.toFixed(5) : '—';
        hud.innerHTML = '<span>ALT ' + altT + 'm</span><span>SPD ' + spdT + 'm/s</span><span>电量 ' + batT + '</span><span>' + esc(posT) + '</span>';
      } else {
        hud.innerHTML = '<span>ALT —</span><span>SPD —</span><span>电量 —</span>';
      }
    }
    // 静态占位一帧：仅在状态变化时重绘（无动态画面）
    const sig = [ph ? ph[0] : 'live', url, playSt, state.fleet === null ? 'off' : ''].join('|');
    if (sig !== oldSig) {
      state.fpvSig = sig;
      if (playSt !== 'playing') {
        const cfg = live ? cfgOf(live) : {};
        if (ph !== null) drawFpvStatic(ph[0], ph[1], ph[2] || '');
        else if (playSt === 'relay') drawFpvStatic('已连接 · 图传需转流', 'RTSP/RTMP 浏览器无法直连：经 mediamtx / ZLMediaKit 转 HLS/FLV 后填入 HTTP 地址', 'docs/STREAMING.md · ' + url);
        else if (url) drawFpvStatic('已连接 · 图传地址暂不可播放', '请检查地址是否为浏览器可播的 HLS/FLV/MP4 HTTP 流', url.split('?')[0]);
        else drawFpvStatic('已连接 · 未配置图传流地址', '请到「设备与网关」为该机填写 HTTP 流地址（stream_url）', cfg.tel_mode ? '模式 ' + esc(cfg.tel_mode) : '');
      } else {
        // 真实流接管：隐藏画布由 video 覆盖（StreamBox 已完成），此处只兜底
        cv.style.display = 'none';
      }
    }
  }

  /* ================= KV 联动策略开关 ================= */
  function refreshKv(force) {
    if (!force && Date.now() - state.kvAt < 10000) return;
    state.kvAt = Date.now();
    ['auto_rtl', 'night_scan', 'push_alarm'].forEach((k) => {
      UIx.api('kv/policy.drone.' + k).then((r) => {
        // 后端 KV 值以 JSON 字符串存储（GET 返回原文），兼容非 JSON 旧值
        let raw = (r && r.v) != null ? r.v : null;
        if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch (e) { /* 保留原文 */ } }
        state.kv[k] = (raw === '1' || raw === 1 || raw === true) ? true : false;
        const inp = Q('dr-policy') && Q('dr-policy').querySelector('[data-kv="' + k + '"]');
        if (inp) inp.checked = !!state.kv[k];
      });
    });
  }

  function bindPolicy() {
    const box = Q('dr-policy');
    const isAdmin = UIx.auth && UIx.auth.user && UIx.auth.user.role === 'admin';
    if (!isAdmin) {
      const tip = Q('dr-policy-tip');
      if (tip) tip.textContent = '策略值为云端 KV 持久化状态 · 当前账号仅可查看（写入需 admin）';
      $$('input[data-key]', box).forEach((inp) => { inp.disabled = true; });
    }
    box.addEventListener('change', (e) => {
      const inp = e.target.closest('input[data-key]');
      if (!inp || inp.disabled) return;
      const key = inp.dataset.key;
      const on = inp.checked;
      const val = on ? '1' : '0';
      UIx.api('kv/' + key, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ v: val })
      }).then((r) => {
        if (r) { state.kv[inp.dataset.kv] = on; toast('策略已保存', key + ' = ' + val + '（网关轮询后生效）', 'ok'); }
        else { inp.checked = !on; toast('保存失败', '写入 KV 失败：无管理员权限或后端不可用', 'err'); }
      });
    });
  }

  /* ================= 云端刷新（节流 ≥3s：机队/指令/告警/航点并行拉取） ================= */
  function refreshAll(force) {
    if (!state.inited || !UIx.api) return;
    const now = Date.now();
    if (!force && now - state.lastPoll < 3000) return;
    state.lastPoll = now;
    Promise.all([
      UIx.api('devices?type=drone'),
      UIx.api('commands?limit=30'),
      UIx.api('alarms?limit=30'),
      UIx.api('waypoints')
    ]).then(([fleet, cmds, alarms, wps]) => {
      state.fleet = Array.isArray(fleet) ? fleet : null;
      if (Array.isArray(cmds)) state.cmds = cmds;
      if (Array.isArray(alarms)) state.alarms = alarms;
      if (Array.isArray(wps)) state.wps = wps;
      renderFleet();
      // 指令/告警中出现的非机队设备名，需全量台账补充（60s 缓存）
      const need = {};
      state.cmds.forEach((c) => { if (c.device_id && state.names[c.device_id] === undefined) need[c.device_id] = 1; });
      state.alarms.forEach((a) => { if (a.device_id && state.names[a.device_id] === undefined) need[a.device_id] = 1; });
      const needN = Object.keys(need);
      if (needN.length && (!state.namesAt || now - state.namesAt > 60000)) {
        UIx.api('devices').then((all) => {
          if (Array.isArray(all)) {
            all.forEach((d) => { state.names[d.id] = { name: d.name, sub: d.sub }; });
            state.namesAt = now;
          }
          renderCmds();
          renderAlarms();
        });
      } else {
        renderCmds();
        renderAlarms();
      }
      renderMap();
      syncFpvBox();
    });
  }

  /* ================= 生命周期 ================= */
  function init() {
    const root = Q('page-drone');
    if (!root) return;
    state.inited = true;
    root.innerHTML = html;
    // 态势图：静态几何（本地常量）+ 空航点层
    Q('dr-map').innerHTML = svgStatic();
    // 机队：指令按钮（事件委托）
    Q('dr-fleet').addEventListener('click', (e) => {
      const b = e.target.closest('[data-uav]');
      if (!b || b.disabled) return;
      sendCmd(b.dataset.uav, b.dataset.cmd);
    });
    Q('dr-fleet-refresh').onclick = () => refreshAll(true);
    Q('dr-cmd-refresh').onclick = () => { refreshAll(true); toast('已同步', '重新拉取云端设备与指令流水', 'info'); };
    Q('dr-policy-refresh').onclick = () => refreshKv(true);
    // 报警中心跳转
    $$('[data-nav="alarm"]', root).forEach((el) => {
      el.onclick = () => { if (global.APP && global.APP.go) global.APP.go('alarm'); };
    });
    // FPV 全屏（仅真实流/有视频元素时可用）
    Q('dr-fpv-full').onclick = () => {
      const box = Q('dr-fpv-box');
      const v = box && box.querySelector('video.real-vid');
      if (!v) { toast('暂无真实画面', '设备连接并播放图传后可用全屏', 'info'); return; }
      try { const fn = box.requestFullscreen || box.webkitRequestFullscreen; if (fn) fn.call(box); } catch (err) { /* 浏览器限制忽略 */ }
    };
    bindPolicy();
    refreshKv(true);
    // 站点（机巢坐标）：作为态势图航点投影锚点（不依赖外部地图）
    UIx.api('sites').then((list) => {
      if (list && list.length) {
        state.site = list[0];
        renderMap();
      }
    });
    refreshAll(true);
  }

  function tick() {
    if (!state.inited || !Q('dr-fleet')) return;
    state.tickSeq++;
    const ft = Q('dr-fpv-time');
    if (ft && UIx.nowText) ft.textContent = UIx.nowText().time;
    refreshAll(false);            // 节流 ≥3s
    if (state.tickSeq % 5 === 0) refreshKv(false);
    // 顶部“刷新间隔”与态势图注记联动（renderMap 内已更新；轻量兜底）
    const fresh = Q('dr-fresh');
    if (fresh) fresh.textContent = '云端 ' + (state.lastPoll ? Math.max(0, Math.round((Date.now() - state.lastPoll) / 1000)) + 's 前刷新' : '…');
  }

  /* ================= 指令下发（云端入队 → 网关回执闭环） ================= */
  function sendCmd(id, cmd) {
    const cd = (state.fleet || []).find((x) => x.id === id);
    if (!cd) return;
    const zh = CMD_ZH[cmd] || cmd;
    if (!liveOf(cd)) { toast('设备未连接', id + ' 未上报遥测，无法下发；接入网关后点亮（docs/API.md）', 'warn'); return; }
    toast('指令下发', id + ' ← ' + zh + '，等待网关回执…', 'info');
    UIx.apiEx('devices/' + id + '/command', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd, params: { from: 'drone-panel' } })
    }).then((r) => {
      if (r.status === 200 && r.data) {
        toast('指令已入队', id + ' · ' + zh + '（#CMD' + r.data.id + '），网关执行并回执后在此闭环', 'ok');
        if (typeof UIx.watchCmd === 'function') UIx.watchCmd(id, r.data.id, zh);
        setTimeout(() => { if (state.inited) { state.lastPoll = 0; refreshAll(false); } }, 2500);
      } else {
        const why = r.status === 403
          ? '当前账号无控制权限（admin / operator）'
          : (r.status === -1 ? '无法连接云端后端' : ((r.data && r.data.error) || ('HTTP ' + r.status)));
        toast('指令下发失败', id + '：' + why, 'err');
      }
    });
  }

  global.PAGES = global.PAGES || {};
  global.PAGES.drone = {
    name: '无人机检测面板',
    init,
    tick,
    onShow() { if (!state.inited) return; refreshAll(true); refreshKv(true); }
  };
})(window);
