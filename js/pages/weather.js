/* ============================================================
 * 天气检测系统 v7（多地区 · 任何地区命中即上报告警中心）
 * - 地区：基地 SITE-1（自动巡检）或任意搜索的城市/县/镇（Photon/OSM → Open-Meteo）
 * - 上报语义：任何查看/立即检测的地区，引擎命中即自动写入云端告警中心
 *   （device_id：基地 SEN-03，其他 WX-坐标；同地区同类 open/10 分钟去重防刷屏）
 * - 监测点 = 后台自动巡检名单：每 10 分钟持续盯防（不打开页面也上报）
 * ============================================================ */
(function (global) {
  'use strict';
  const UIx = global.UI;
  const Q = UIx.Q, $ = UIx.$, $$ = UIx.$$, esc = UIx.esc, toast = UIx.toast, pad = UIx.pad;

  const state = {
    wx: null, hit: null, al: [], lastAlarmId: 0,
    wxAt: 0, alAt: 0, busy: false,
    loc: null,          // {base:true} 基地 | {base:false, name, region, lat, lon} 自定义地区
    history: [],        // 最近查看地区 [{name, region, lat, lon}]
    stations: [],       // 云端监测点（命中自动上报告警）：[{name, region, lat, lon}]
    geoBusy: false, searchT: null
  };
  const BASE_KEY = 'wx_loc_v1', HIST_KEY = 'wx_history_v1';
  function readLoc() {
    try {
      const o = JSON.parse(localStorage.getItem(BASE_KEY) || 'null');
      if (o && o.base === true) return { base: true };
      if (o && !o.base && Number.isFinite(+o.lat) && Number.isFinite(+o.lon)) {
        return { base: false, name: String(o.name || '自定义地区'), region: String(o.region || ''), lat: +o.lat, lon: +o.lon };
      }
    } catch (e) { /* 忽略损坏数据 */ }
    return { base: true };
  }
  function saveLoc() { try { localStorage.setItem(BASE_KEY, JSON.stringify(state.loc)); } catch (e) { /* */ } }
  function readHistory() {
    try {
      const h = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
      return Array.isArray(h) ? h.filter((x) => x && x.name && Number.isFinite(+x.lat)) : [];
    } catch (e) { return []; }
  }
  function saveHistory() { try { localStorage.setItem(HIST_KEY, JSON.stringify(state.history.slice(0, 6))); } catch (e) { /* */ } }
  const isBase = () => !state.loc || state.loc.base === true;
  /* 当前视图对应的告警上报设备：基地 SEN-03；其余任何地区 WX-坐标（查看即报） */
  function stationOf(lat, lon) {
    return (state.stations || []).find((s) => Math.abs(+s.lat - lat) < 0.001 && Math.abs(+s.lon - lon) < 0.001) || null;
  }
  function devOfLoc() {
    if (isBase()) return 'SEN-03';
    return 'WX-' + Math.abs(state.loc.lat).toFixed(4) + '_' + Math.abs(state.loc.lon).toFixed(4);
  }
  /* 该地区是否在“后台自动巡检名单”（监测点） */
  const isStn = () => !isBase() && !!stationOf(state.loc.lat, state.loc.lon);
  const LV_ZH = { crit: '严重', warn: '警告', info: '提示' };
  const ST_ZH = { open: '未处理', ack: '已处理', misreport: '误报' };
  const RULE_DIR = { low: '≤', high: '≥' };

  const html = `
  <div class="content-scroll">
    <div class="grid">

      <!-- 地区切换面板（搜索城市/县镇 · 历史记录 · 一键回基地） -->
      <div class="card span-12 hidden" id="wx-loc-panel" style="display:none">
        <div class="card-h"><span class="h-ico">${I('map', 15)}</span>切换天气地区
          <span class="card-title-note">搜索任意城市/县/镇查看当地天气；任何地区命中预警都会自动写入云端告警中心（同地区去重）</span>
          <span class="more" id="wx-loc-close">收起 ✕</span></div>
        <div class="h-divider"></div>
        <div class="card-b" style="padding-top:8px">
          <input class="dv-in" id="wx-loc-q" placeholder="输入地区名，例如：陇西县 / 定西 / 成都 / 兰州…" style="width:100%;padding:9px 12px">
          <div id="wx-loc-res" style="display:flex;flex-direction:column;gap:4px;margin-top:8px"></div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;align-items:center">
            <span style="font-size:11px;color:var(--dim)">常用/最近：</span>
            <button class="btn" id="wx-loc-base" style="padding:3px 10px">${I('home-2', 12)} 基地（SITE-1）</button>
            <span id="wx-loc-hist" style="display:inline-flex;flex-wrap:wrap;gap:6px"></span>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;align-items:center;border-top:1px dashed #e5e7eb;padding-top:10px">
            <span style="font-size:11px;color:var(--dim)">后台自动巡检名单（监测点）：</span>
            <span id="wx-stn-list" style="display:inline-flex;flex-wrap:wrap;gap:6px"></span>
            <span style="font-size:10.5px;color:var(--dim)">监测点由后台每 10 分钟自动巡检（不打开页面也盯防）；未设点的地区在查看/立即检测时命中同样上报</span>
          </div>
          <div style="font-size:10.5px;color:var(--dim);margin-top:8px" id="wx-loc-tip">搜索服务：Photon/OSM（免费无 Key）。任何地区命中预警都会自动写入云端告警中心（同地区 open/10 分钟去重）；「设为监测点」（需 admin/operator）表示后台每 10 分钟自动巡检该地区。</div>
        </div>
      </div>

      <!-- 天气预警 · 实时推送面板 -->
      <div class="card span-12" style="border-color:#fca5a5">
        <div class="card-h"><span class="h-ico">${I('radar', 16)}</span>实时天气预警
          <span class="tag sky" id="wx-cur-loc" title="当前天气地区" style="cursor:pointer">基地 · 步云村</span>
          <span class="card-title-note" id="wx-warn-state">检测状态：待启动…</span>
          <span style="margin-left:auto;display:flex;gap:8px;align-items:center">
            <button class="btn" id="wx-city-btn" title="搜索/切换天气地区（手机天气式）">${I('map', 13)} 切换地区</button>
            <span class="tag gray" id="wx-open-num">未处理 0</span>
            <button class="btn primary" id="wx-check-now">${I('radar', 13)} 立即检测</button>
            <span class="more" data-nav="alarm" style="margin-left:0">报警中心 ›</span>
          </span></div>
        <div class="h-divider"></div>
        <div class="card-b" style="padding-top:8px">
          <div id="wx-hit" class="hidden" style="display:none"></div>
          <div id="wx-warn-list" style="display:flex;flex-direction:column"></div>
          <div class="empty-tip hidden" id="wx-warn-empty">暂无天气预警：基地与已设监测点每 10 分钟自动巡检，其他地区查看/立即检测命中同样自动上报（同地区去重）。</div>
          <div style="font-size:10.5px;color:var(--dim);margin-top:8px" id="wx-alert-note"></div>
        </div>
      </div>

      <!-- 实时监测 KPI -->
      <div class="card span-3 kpi"><span class="k-ico ico-a">${I('temperature', 21)}</span><div class="k-body">
        <div class="k-label">当前气温</div><div class="k-value" id="wx-temp">–<small>℃</small></div>
        <div class="k-sub" id="wx-temp-sub">体感 –℃</div></div></div>
      <div class="card span-3 kpi"><span class="k-ico ico-s">${I('droplet', 21)}</span><div class="k-body">
        <div class="k-label">湿度 / 降水</div><div class="k-value" id="wx-hum">–<small>%</small></div>
        <div class="k-sub" id="wx-precip">降水 –mm</div></div></div>
      <div class="card span-3 kpi"><span class="k-ico ico-c">${I('wind', 21)}</span><div class="k-body">
        <div class="k-label">风</div><div class="k-value" id="wx-wind">–<small>km/h</small></div>
        <div class="k-sub" id="wx-gust">阵风 – · 气压 –hPa</div></div></div>
      <div class="card span-3 kpi"><span class="k-ico ico-g">${I('cloud', 21)}</span><div class="k-body">
        <div class="k-label">云量 / 现象</div><div class="k-value" id="wx-cloud">–<small>%</small></div>
        <div class="k-sub" id="wx-src">更新时间 –</div></div></div>

      <!-- 监测要素与预警阈值 -->
      <div class="card span-7">
        <div class="card-h"><span class="h-ico">${I('gauge', 15)}</span>监测要素与预警阈值
          <span class="card-title-note">规则引擎按基地实时/预报值评估 · 命中自动上报告警中心</span></div>
        <div class="h-divider"></div>
        <div class="card-b" style="padding-top:6px">
          <div id="wx-rules"></div>
        </div>
      </div>

      <!-- 24h 气象趋势 -->
      <div class="card span-5">
        <div class="card-h"><span class="h-ico">${I('chart-line', 15)}</span>24 小时气象趋势
          <span class="card-title-note">温度 / 降水概率（未来 24h 预报）</span></div>
        <div class="h-divider"></div>
        <div class="card-b" style="padding-top:8px">
          <div id="wx-chart1" style="width:100%;height:230px;display:none"></div>
          <div class="empty-tip hidden" id="wx-chart1-empty" style="padding:80px 12px">逐时预报加载失败</div>
        </div>
      </div>

      <!-- 3 日预报 -->
      <div class="card span-12">
        <div class="card-h"><span class="h-ico">${I('calendar', 15)}</span>3 日天气预报
          <span class="card-title-note" id="wx-daily-sub">Open-Meteo 预报 · 按基地坐标计算</span>
          <span class="more" id="wx-refresh">刷新 ▸</span></div>
        <div class="h-divider"></div>
        <div class="card-b" style="padding-top:6px" id="wx-daily"></div>
      </div>
    </div>
  </div>`;

  /* ================= 监测点管理（后台自动巡检名单；查看任意地区命中也会上报） ================= */
  function renderStnList() {
    const box = Q('wx-stn-list');
    if (!box) return;
    const all = (state.stations || []).map((s, i) => ({
      name: s.name, region: s.region || '', lat: +s.lat, lon: +s.lon, i
    }));
    box.innerHTML = '<span class="tag green" style="display:inline-flex;align-items:center;gap:4px">' + I('home-2', 12) + ' 基地（SITE-1）</span>' +
      (all.length ? all.map((s) =>
        `<span class="btn" style="padding:2px 8px;display:inline-flex;gap:4px;align-items:center" data-stn="${s.i}" title="点击移除（移除后仅在查看时上报）">${esc(s.name)}${s.region ? '<small style="color:var(--dim)">' + esc(s.region) + '</small>' : ''}
          <b data-stn-del="${s.i}" style="color:#9ca3af;cursor:pointer">×</b></span>`).join('')
        : '<span style="font-size:10.5px;color:var(--dim)">暂无，可在上方搜索结果点「设为监测点」</span>');
    $$('#wx-stn-list [data-stn]').forEach((el) => {
      el.onclick = (e) => {
        if (e.target.closest('[data-stn-del]')) { removeStation(+e.target.closest('[data-stn-del]').dataset.stnDel); return; }
        const s = state.stations[+el.dataset.stn];
        if (s) setCity({ base: false, name: s.name, region: s.region, lat: +s.lat, lon: +s.lon });
      };
    });
  }
  async function loadStations() {
    const r = await UIx.api('weather/stations');
    if (r && Array.isArray(r.stations)) {
      state.stations = r.stations;
      renderStnList();
      refreshMode();
      // 非基地视图：补拉当前地区自身的云端告警
      if (!isBase()) loadAlerts(true);
    }
  }
  async function putStations(tipOk) {
    const r = await UIx.apiEx('weather/stations', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stations: (state.stations || []).map((s) => ({ name: s.name, region: s.region || '', lat: +s.lat, lon: +s.lon })) })
    });
    if (r.status === 200 && r.data) {
      state.stations = r.data.stations || [];
      renderStnList();
      if (tipOk) toast('监测点已更新', tipOk, 'ok');
      return true;
    }
    toast('操作失败', r.status === 403 ? '监测点管理需 admin/operator 权限' : ((r.data && r.data.error) || 'HTTP ' + r.status), 'err');
    return false;
  }
  function toggleStation(item) {
    if (!item || !item.lat || !item.lon) return;
    const dup = stationOf(item.lat, item.lon);
    if (dup) { toast('已在自动巡检名单', dup.name + ' 后台每 10 分钟自动巡检中', 'info'); return; }
    state.stations.push({ name: String(item.name || '监测点').slice(0, 30), region: String(item.region || '').slice(0, 40), lat: +item.lat, lon: +item.lon });
    putStations('已加入后台自动巡检：' + item.name + '（每 10 分钟；其他地区在查看时命中同样上报）').then((ok) => {
      if (ok) {
        const q = Q('wx-loc-q');
        if (q && q.value.trim().length >= 2) geoSearch(q.value);
        refreshMode();
      } else { state.stations.pop(); renderStnList(); }
    });
  }
  function removeStation(i) {
    const s = state.stations[i];
    if (!s) return;
    state.stations.splice(i, 1);
    putStations('已移出后台自动巡检：' + s.name + '（查看该地区时命中仍会上报）').then((ok) => { if (!ok) loadStations(); else refreshMode(); });
  }

  /* ================= 地区切换（手机天气式） ================= */
  function togglePanel(show) {
    const p = Q('wx-loc-panel');
    if (!p) return;
    const want = (show === undefined) ? p.classList.contains('hidden') : !!show;
    if (want) {
      p.classList.remove('hidden'); p.style.display = '';
      renderHistory();
      renderStnList();
      const q = Q('wx-loc-q');
      if (q) setTimeout(() => q.focus(), 60);
    } else {
      p.classList.add('hidden'); p.style.display = 'none';
    }
  }
  function renderHistory() {
    const box = Q('wx-loc-hist');
    if (!box) return;
    box.innerHTML = state.history.map((c, i) =>
      `<span class="btn" style="padding:3px 10px;display:inline-flex;gap:4px;align-items:center" data-hist="${i}">
        ${esc(c.name)}${c.region ? '<small style="color:var(--dim)">' + esc(c.region) + '</small>' : ''}
        <b data-hist-del="${i}" style="color:#9ca3af;cursor:pointer">×</b></span>`).join('');
    $$('#wx-loc-hist [data-hist]').forEach((el) => {
      el.onclick = (e) => {
        const del = e.target.closest('[data-hist-del]');
        if (del) { state.history.splice(+del.dataset.histDel, 1); saveHistory(); renderHistory(); return; }
        const c = state.history[+el.dataset.hist];
        if (c) setCity({ base: false, name: c.name, region: c.region, lat: c.lat, lon: c.lon });
      };
    });
  }
  function setCity(loc) {
    state.loc = (loc && loc.base === false && Number.isFinite(+loc.lat)) ? { base: false, name: loc.name, region: loc.region || '', lat: +loc.lat, lon: +loc.lon } : { base: true };
    saveLoc();
    state.wxAt = 0; state.hit = null; state.wx = null;
    if (!isBase()) {
      const dup = state.history.findIndex((h) => Math.abs(+h.lat - state.loc.lat) < 0.001 && Math.abs(+h.lon - state.loc.lon) < 0.001);
      const item = { name: state.loc.name, region: state.loc.region, lat: state.loc.lat, lon: state.loc.lon };
      if (dup >= 0) state.history.splice(dup, 1);
      state.history.unshift(item);
      saveHistory();
    }
    togglePanel(false);
    refreshMode();
    renderHistory();
    renderStnList();
    loadWx(true);
    loadAlerts(true);
    toast('已切换地区', isBase() ? '基地（SITE-1）实时天气与预警' : '「' + state.loc.name + '」天气' + (isStn() ? '（监测点 · 后台自动巡检）' : '（命中自动上报云端告警）'), 'info');
  }
  function geoSearch(q) {
    const box = Q('wx-loc-res');
    if (!box) return;
    const qs = String(q || '').trim();
    if (qs.length < 2) { box.innerHTML = ''; return; }
    if (state.geoBusy) return;
    state.geoBusy = true;
    box.innerHTML = '<div class="empty-tip" style="padding:12px">搜索中…</div>';
    UIx.api('geocode?q=' + encodeURIComponent(qs)).then((g) => {
      state.geoBusy = false;
      if (!g || g.ok === false) { box.innerHTML = '<div class="empty-tip" style="padding:12px">搜索服务不可用：' + esc((g && g.error) || '网络错误') + '</div>'; return; }
      const items = (g.items || []).slice(0, 6);
      if (!items.length) { box.innerHTML = '<div class="empty-tip" style="padding:12px">未找到「' + esc(qs) + '」，试试更常见写法（如 成都 / 兰州 / 陇西县）</div>'; return; }
      box.innerHTML = items.map((it, i) => {
        const done = !!stationOf(it.lat, it.lon);
        return `<button class="wx-geo-item" data-geo="${i}" type="button">
          <span style="font-weight:600;color:#111827">${esc(it.name)}</span>
          <span style="color:var(--muted);font-size:11.5px">${esc(it.region || '')}${it.kind ? ' · ' + esc(it.kind) : ''}</span>
          <span style="color:var(--dim);font-size:10.5px;font-variant-numeric:tabular-nums;margin-left:auto">${it.lat}, ${it.lon}</span>
          <span class="btn wx-stn-toggle ${done ? 'tag green' : ''}" data-addgeo="${i}" style="padding:2px 10px;margin-left:8px;flex:none;pointer-events:auto">${done ? '✓ 已设监测点' : '＋ 设为监测点'}</span>
        </button>`;
      }).join('');
      $$('#wx-loc-res [data-geo]').forEach((el) => el.onclick = (e) => {
        if (e.target.closest('[data-addgeo]')) return;   // 交给“设为监测点”按钮
        const it = items[+el.dataset.geo];
        if (it) setCity({ base: false, name: it.name, region: it.region, lat: it.lat, lon: it.lon });
      });
      $$('#wx-loc-res [data-addgeo]').forEach((el) => el.onclick = (e) => {
        e.stopPropagation();
        const it = items[+el.dataset.addgeo];
        if (it) toggleStation(it);
      });
    });
  }
  /* 预警面板：基地与其他任何地区命中都会写入云端告警（同地区去重） */
  function refreshMode() {
    const num = Q('wx-open-num');
    const list = Q('wx-warn-list');
    const empty = Q('wx-warn-empty');
    const open = (state.al || []).filter((a) => a.status === 'open').length;
    if (num) num.textContent = '未处理 ' + open;
    const has = (state.al || []).length;
    if (list && !has) list.innerHTML = '';
    if (empty) {
      empty.classList.toggle('hidden', has > 0);
      empty.style.display = has ? 'none' : '';
      if (!has) {
        empty.innerHTML = isBase()
          ? '暂无天气预警：基地每 10 分钟自动巡检（大风/暴雨/高温/低温/雷暴/降雪…），命中即写入报警中心；也可点「立即检测」。'
          : '该地区暂无天气预警：打开页面或点「立即检测」命中将自动写入云端告警中心（同地区去重）。' +
            (isStn() ? ' 该点已加入后台自动巡检（每 10 分钟）。' : ' 设为「监测点」可让后台每 10 分钟自动巡检，不打开页面也在盯防。');
      }
    }
  }

  /* ================= 天气预警（实时推送） ================= */
  function fmtTS(t) {
    if (!t) return '--';
    const d = new Date(t);
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function lvCls(lv) { return lv === 'crit' ? 'tag red' : (lv === 'warn' ? 'tag amber' : 'tag sky'); }
  function renderWarnEmpty() {
    const has = (state.al || []).length;
    Q('wx-warn-empty').classList.toggle('hidden', has > 0);
    Q('wx-warn-empty').style.display = has ? 'none' : '';
  }
  function renderAlerts() {
    const box = Q('wx-warn-list');
    const list = (state.al || []).slice(0, 12);
    const dev = devOfLoc();
    const devName = dev === 'SEN-03' ? '气象站 SEN-03' : '地区监测点 ' + dev;
    if (!list.length) { box.innerHTML = ''; renderWarnEmpty(); return; }
    box.innerHTML = list.map((a) => `
      <div class="alert-line" data-alarm="${a.id}" style="${a.status === 'open' ? '' : 'opacity:.72'}">
        <span class="al-ico ${a.lv === 'crit' ? 'ico-r' : (a.lv === 'warn' ? 'ico-a' : 'ico-s')}">${I(a.ico || 'alert-triangle', 15)}</span>
        <div class="al-body" style="min-width:0">
          <div class="al-title">${esc(a.type || '天气预警')} <span class="${lvCls(a.lv)}" style="margin-left:4px">${LV_ZH[a.lv] || a.lv}</span>
            <span class="tag ${a.status === 'open' ? 'red' : (a.status === 'ack' ? 'green' : 'gray')}" style="margin-left:4px">${ST_ZH[a.status] || a.status}</span></div>
          <div class="al-desc">${esc(a.msg || '')}</div>
          <div style="font-size:10.5px;color:var(--dim);margin-top:2px">${devName} · ${fmtTS(a.created_at)}${a.status === 'open' ? ' · 可到报警中心处置' : ''}</div>
        </div>
        <div style="text-align:right;flex:none;display:flex;align-items:center;gap:6px">
          ${a.status === 'open' ? '<button class="btn" style="padding:3px 10px" data-alarm-go="' + a.id + '">处置 ▸</button>' : ''}
        </div>
      </div>`).join('');
    renderWarnEmpty();
    const open = state.al.filter((a) => a.status === 'open').length;
    Q('wx-open-num').textContent = '未处理 ' + open;
  }
  async function loadAlerts(force) {
    const dev = devOfLoc();   // 基地 SEN-03；其他任何地区 WX-坐标
    if (state.busy && !force) return;
    if (!force && Date.now() - state.alAt < 8000) return;
    state.alAt = Date.now();
    const rows = await UIx.api('weather/alerts?device=' + encodeURIComponent(dev));
    if (!Array.isArray(rows)) return;
    const prevLast = state.lastAlarmId;
    const newOpen = rows.filter((a) => a.status === 'open' && (a.id || 0) > prevLast);
    state.al = rows;
    state.lastAlarmId = rows.reduce((m, a) => Math.max(m, a.id || 0), prevLast);
    renderAlerts();
    if (newOpen.length && prevLast > 0) {
      // 页内高亮提示（全局铃铛/角标/toast 由 app.js 统一推送一次）
      Q('wx-warn-state').textContent = '新增预警 ' + newOpen.length + ' 条 · 已推送报警中心';
      setTimeout(() => { if (Q('wx-warn-state')) Q('wx-warn-state').textContent = state.detectState || '实时监测中 · 每 10 分钟自动巡检'; }, 6000);
    }
  }
  function renderHit() {
    const hit = state.hit;
    const box = Q('wx-hit');
    if (!hit) { box.classList.add('hidden'); box.style.display = 'none'; return; }
    const warn = (hit.warnings || []).map((x) =>
      `<span class="${lvCls(x.lv)}" style="margin:0 6px 4px 0">${LV_ZH[x.lv] || ''} · ${esc(x.type)}</span>`).join('');
    const pushedN = (hit.pushed || []).length;
    const timeTxt = hit.checkedAt ? fmtTS(hit.checkedAt) : '';
    box.classList.remove('hidden');
    box.style.display = 'flex';
    box.style.flexWrap = 'wrap';
    box.style.alignItems = 'center';
    box.style.gap = '2px 6px';
    box.style.padding = '8px 12px';
    box.style.borderRadius = '10px';
    box.style.border = '1px solid ' + (hit.warnings && hit.warnings.length ? '#fca5a5' : '#bbf7d0');
    box.style.background = (hit.warnings && hit.warnings.length) ? '#fff7ed' : '#f0fdf4';
    box.style.marginBottom = '8px';
    box.style.fontSize = '12px';
    box.innerHTML = (hit.warnings && hit.warnings.length)
      ? '<b style="color:#b45309">检测命中 ' + hit.warnings.length + ' 项预警：</b>' + warn +
        '<span style="color:#92400e">' + (pushedN ? ' · 已上报告警中心 ' + pushedN + ' 条' : ' · 同地区同类预警已存在（自动去重，未重复上报）') + '</span>' +
        '<span style="margin-left:auto;color:var(--dim)">' + timeTxt + ' 检测</span>'
      : '<b style="color:#047857">检测正常</b><span style="color:#047857"> · 当前各要素均未触发预警阈值</span>' +
        '<span style="margin-left:auto;color:var(--dim)">' + timeTxt + ' 检测</span>';
  }
  async function checkNow() {
    if (state.busy) return;
    state.busy = true;
    const b = Q('wx-check-now');
    if (b) { b.disabled = true; b.innerHTML = I('radar', 13) + ' 检测中…'; }
    const r = await UIx.apiEx('weather/check', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(isBase() ? {} : { lat: state.loc.lat, lon: state.loc.lon, label: state.loc.name })
    });
    state.busy = false;
    if (b) { b.disabled = false; b.innerHTML = I('radar', 13) + ' 立即检测'; }
    if (r.status !== 200 || !r.data || r.data.ok === false) {
      toast('检测失败', r.status === 403 ? '当前账号无检测权限（需 admin/operator）' : ((r.data && r.data.error) || 'HTTP ' + r.status), 'err');
      return;
    }
    state.hit = r.data;
    renderHit();
    if (!state.detectState) state.detectState = (isBase() || isStn()) ? '监测中 · 每 10 分钟自动巡检' : '查看即报 · 命中自动上报云端告警';
    Q('wx-warn-state').textContent = (r.data.warnings || []).length
      ? '命中 ' + r.data.warnings.length + ' 项 · 已按去重规则上报告警中心'
      : '检测正常 · 未触发阈值';
    loadAlerts(true);
    toast('天气巡检完成', isBase()
      ? ((r.data.warnings || []).length
        ? '命中 ' + r.data.warnings.length + ' 项预警，' + (r.data.pushed || []).length + ' 条已上报告警中心'
        : '各要素均正常，无预警触发')
      : ((r.data.warnings || []).length
        ? '「' + state.loc.name + '」命中 ' + r.data.warnings.length + ' 项预警，' + ((r.data.pushed || []).length ? '已上报 ' + r.data.pushed.length + ' 条到云端告警中心' : '同地区同类预警已存在（自动去重）')
        : '「' + state.loc.name + '」各要素正常'), (r.data.warnings || []).length ? 'warn' : 'ok');
  }

  /* ================= 阈值监测表 + 趋势图 ================= */
  function dirTxt(rule) {
    const u = rule.unit || '';
    if (rule.dir === 'low') return '≤' + rule.thWarn + u + ' 警告 / ≤' + rule.thCrit + u + ' 严重';
    return '≥' + rule.thWarn + u + ' 警告 / ≥' + rule.thCrit + u + ' 严重';
  }
  function renderRules() {
    const rules = (state.wx && state.wx.rules) || [];
    const box = Q('wx-rules');
    if (!rules.length) { box.innerHTML = '<div class="empty-tip">监测数据读取失败（天气服务不可用）</div>'; return; }
    box.innerHTML = '<table class="table" style="min-width:560px"><thead><tr>' +
      '<th>要素</th><th>当前值</th><th>预警阈值</th><th>状态</th></tr></thead><tbody>' +
      rules.map((r) => {
        const st = r.level === 'crit' ? '<span class="tag red">严重</span>' : (r.level === 'warn' ? '<span class="tag amber">警告</span>' : '<span class="tag green">正常</span>');
        const v = r.cur == null ? '—' : (Math.round(r.cur * 10) / 10) + (r.unit || '');
        return `<tr>
          <td><span style="display:inline-flex;align-items:center;gap:5px">${I(r.ico || 'activity', 13)} ${esc(r.name)}</span></td>
          <td><b style="color:${r.level === 'crit' ? '#b91c1c' : (r.level === 'warn' ? '#b45309' : '#111827')}">${v}</b></td>
          <td style="font-size:11px;color:var(--muted)">${dirTxt(r)}</td>
          <td>${st}</td></tr>`;
      }).join('') + '</tbody></table>' +
      '<div style="font-size:10.5px;color:var(--dim);margin-top:6px">阈值按散养鸡场场景预设（backend/weather.js RULES 可调）；警告/严重级别会写入云端告警中心。</div>';
  }
  function renderTrend() {
    const el = Q('wx-chart1');
    const empty = Q('wx-chart1-empty');
    if (!el) return;
    const hr = ((state.wx && state.wx.hourly) || []).filter((h) => h.future !== false).slice(0, 24);
    if (!hr.length || !global.YQC || !global.YQC.make) { el.style.display = 'none'; empty.classList.remove('hidden'); return; }
    empty.classList.add('hidden');
    el.style.display = '';
    const labels = hr.map((h) => (h.time || '').slice(11, 16));
    global.YQC.make(el, {
      tooltip: { trigger: 'axis' },
      legend: { data: ['气温℃', '降水概率%'] },
      grid: { left: 42, right: 42, top: 38, bottom: 22 },
      xAxis: { type: 'category', data: labels },
      yAxis: [
        { type: 'value', name: '℃', nameTextStyle: { color: '#6b7280', fontSize: 10 }, scale: true },
        { type: 'value', name: '%', nameTextStyle: { color: '#6b7280', fontSize: 10 }, max: 100 }
      ],
      series: [
        { name: '气温℃', type: 'line', smooth: true, showSymbol: false, data: hr.map((h) => h.temp), lineStyle: { width: 2 } },
        { name: '降水概率%', type: 'bar', yAxisIndex: 1, barMaxWidth: 10, itemStyle: { color: 'rgba(99,102,241,.35)' }, data: hr.map((h) => h.rainProb) }
      ]
    });
  }

  /* ================= 天气/预报 ================= */
  const WD = ['日', '一', '二', '三', '四', '五', '六'];
  function renderDaily() {
    const d = (state.wx && state.wx.daily) || [];
    Q('wx-daily').innerHTML = d.map((x) => {
      const m = UIx.wmo(x.code);
      const dt = new Date(x.date + 'T00:00:00');
      const tag = d.indexOf(x) === 0 ? '今天' : (dt.getMonth() + 1) + '/' + dt.getDate() + ' ' + WD[dt.getDay()];
      return `<div class="sensor-row">
        <div class="sr-name" style="min-width:80px"><b style="color:#111827">${tag}</b>
          <span class="tag sky">${I(m.icon, 13)} ${esc(m.text)}</span></div>
        <div style="display:flex;gap:10px;align-items:center;font-size:12.5px">
          <span><b style="color:#dc2626">${Math.round(x.tMax)}°</b>/<b style="color:#2563eb">${Math.round(x.tMin)}°</b></span>
          <span style="color:var(--muted)">${I('droplet', 11)} ${x.rainProb == null ? '—' : x.rainProb + '%'}</span>
          ${x.windMax != null ? '<span style="color:var(--muted)">' + I('wind', 11) + ' ' + Math.round(x.windMax) + 'km/h</span>' : ''}
        </div></div>`;
    }).join('') || '<div class="empty-tip">预报数据加载失败</div>';
  }
  async function loadWx(force) {
    if (!force && Date.now() - state.wxAt < 60000) return;
    state.wxAt = Date.now();
    const url = isBase()
      ? 'weather'
      : 'weather?lat=' + state.loc.lat + '&lon=' + state.loc.lon + '&label=' + encodeURIComponent(state.loc.name + (state.loc.region ? ' ' + state.loc.region : ''));
    const w = await UIx.api(url);
    if (!w || w.ok === false) { Q('wx-src').textContent = '天气服务不可用'; return; }
    state.wx = w;
    fillAreaInfo();
    const c = w.current || {};
    UIx.setNum(Q('wx-temp'), c.temp, 1);
    Q('wx-temp-sub').textContent = '体感 ' + (c.feels != null ? Math.round(c.feels) + '℃' : '–') + ' · ' + UIx.wmo(c.code).text;
    UIx.setNum(Q('wx-hum'), c.humidity, 0);
    Q('wx-precip').textContent = '降水 ' + (c.precip != null ? c.precip : 0) + 'mm';
    UIx.setNum(Q('wx-wind'), c.wind != null ? Math.round(c.wind) : 0, 0);
    Q('wx-gust').textContent = '阵风 ' + (c.gust != null ? Math.round(c.gust) : '–') + ' · 气压 ' + (c.pressure != null ? Math.round(c.pressure) : '–') + 'hPa';
    UIx.setNum(Q('wx-cloud'), c.cloud, 0);
    const t = new Date();
    Q('wx-src').textContent = '更新 ' + pad(t.getHours()) + ':' + pad(t.getMinutes()) + ' · ' + (c.code != null ? UIx.wmo(c.code).text : '');
    renderDaily();
    renderRules();
    renderTrend();
    // 服务地区信息条（任何地区命中即自动上报告警中心；监测点额外获得后台自动巡检）
    if (!state.detectState) state.detectState = (isBase() || isStn()) ? '监测中 · 每 10 分钟自动巡检' : '查看即报 · 命中自动上报云端告警';
    if (Q('wx-warn-state')) Q('wx-warn-state').textContent = state.detectState;
    // 引擎实时命中（GET 已附带评估结果）
    const warnings = (w.warnings || []).length;
    const noteEl = Q('wx-alert-note');
    if (noteEl) {
      if (isBase()) {
        const locName = (w.location && (w.location.address || w.location.name)) || '';
        noteEl.textContent = '计算点：基地站点 SITE-1' + (locName ? '（' + locName + '）' : '') +
          ' · 自动巡检每 10 分钟一次（阈值见上表）· 命中即写入报警中心并实时推送。当前引擎命中：' +
          (warnings ? (w.warnings || []).map((x) => esc(x.type)).join('、') : '无');
        noteEl.style.color = warnings ? '#b45309' : 'var(--dim)';
      } else {
        noteEl.textContent = '当前查看：' + state.loc.name + (state.loc.region ? '（' + state.loc.region + '）' : '') +
          ' · ' + (isStn()
            ? '该点已设为【监测点】：后台每 10 分钟自动巡检，命中写入云端告警中心'
            : '命中将自动上报云端告警中心（查看即报，同地区去重）；设为「监测点」可让后台每 10 分钟自动巡检，不打开页面也在盯防') +
          '。当前评估命中：' + (warnings ? (w.warnings || []).map((x) => esc(x.type)).join('、') : '无');
        noteEl.style.color = warnings ? '#b45309' : 'var(--dim)';
      }
    }
    // 引擎命中且尚未手动检测时给出引导行
    if (!state.hit && (w.warnings || []).length) renderHitLive(w.warnings);
  }
  /* 当前地区标签（预警面板标题处）+ 3日预报地区标注 */
  function fillAreaInfo() {
    const w = state.wx || {};
    const loc = w.location || {};
    const addr = (loc.address || loc.name || '').trim();
    const curEl = Q('wx-cur-loc');
    if (curEl) {
      if (isBase()) curEl.textContent = '基地 · 步云村';
      else if (isStn()) curEl.textContent = state.loc.name + '（监测点）';
      else curEl.textContent = state.loc.name + (state.loc.region ? ' · ' + state.loc.region : '');
    }
    const dailySub = Q('wx-daily-sub');
    if (dailySub) dailySub.textContent = 'Open-Meteo 预报 · ' + (isBase() ? '真实地区：' + addr : '地区：' + (state.loc.name + (state.loc.region ? ' ' + state.loc.region : ''))) + '（' + (isBase() ? '基地坐标 · 自动巡检' : (isStn() ? '监测点 · 后台自动巡检' : '命中自动上报 · 同地区去重')) + '）';
  }
  function renderHitLive(warnings) {
    const box = Q('wx-hit');
    if (!box) return;
    box.classList.remove('hidden');
    box.style.display = 'flex';
    box.style.flexWrap = 'wrap';
    box.style.alignItems = 'center';
    box.style.gap = '2px 6px';
    box.style.padding = '8px 12px';
    box.style.borderRadius = '10px';
    box.style.border = '1px solid #fca5a5';
    box.style.background = '#fff7ed';
    box.style.marginBottom = '8px';
    box.style.fontSize = '12px';
    box.innerHTML = '<b style="color:#b45309">当前实况命中：</b>' +
      warnings.map((x) => `<span class="${lvCls(x.lv)}" style="margin:0 6px 4px 0">${LV_ZH[x.lv]} · ${esc(x.type)}</span>`).join('') +
      '<span style="color:#92400e">将写入云端告警中心（同地区自动去重' + (isStn() ? '；后台每 10 分钟自动巡检' : '；也可设为「监测点」开启后台自动巡检') + '）</span>';
  }

  /* ================= 生命周期 ================= */
  function init() {
    const root = Q('page-weather');
    if (!root) return;
    state.loc = readLoc();
    state.history = readHistory();
    root.innerHTML = html;
    Q('wx-refresh').onclick = () => { state.wxAt = 0; loadWx(true); loadAlerts(true); toast('已刷新', isBase() ? '天气与预警已重新获取' : '「' + state.loc.name + '」天气已重新获取', 'ok'); };
    Q('wx-check-now').onclick = () => checkNow();
    // 地区切换
    Q('wx-city-btn').onclick = () => togglePanel();
    if (Q('wx-cur-loc')) Q('wx-cur-loc').onclick = () => togglePanel();
    Q('wx-loc-close').onclick = () => togglePanel(false);
    Q('wx-loc-base').onclick = () => setCity({ base: true });
    const qIn = Q('wx-loc-q');
    qIn.addEventListener('input', () => {
      clearTimeout(state.searchT);
      state.searchT = setTimeout(() => geoSearch(qIn.value), 650);
    });
    qIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(state.searchT); geoSearch(qIn.value); } });
    $$('[data-nav="alarm"]', root).forEach((el) => {
      el.onclick = () => { if (global.APP && global.APP.go) global.APP.go('alarm'); };
    });
    Q('wx-warn-list').addEventListener('click', (e) => {
      const b = e.target.closest('[data-alarm-go]');
      if (b && global.APP && global.APP.go) global.APP.go('alarm');
    });
    refreshMode();
    loadWx(true);
    loadAlerts(true);
    loadStations();
  }

  function tick() {
    if (!Q('wx-temp')) return;
    loadAlerts(false);
    loadWx(false);
  }

  global.PAGES = global.PAGES || {};
  global.PAGES.weather = { name: '天气检测系统', init, tick, onShow() { loadAlerts(true); loadWx(false); } };
})(window);
