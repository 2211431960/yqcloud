/* ============================================================
 * 智能补食面板（纯云端真实数据版）
 * - 点位列表   = GET /api/devices?type=feeder（连接只看行内 live）
 * - 单台料位   = GET /api/devices/:id/telemetry?limit=1（extra.level_pct/level_kg/frac；容量 device.config.cap）
 * - 今日补食   = GET /api/metrics（feed_kg_today，未上报显示 “—” + 上报引导）
 * - 补食流水   = GET /api/commands?cmd=feed_now&limit=50（queued/sent/ack/fail 配色）
 * - 手动补食   = POST /api/devices/:id/command {cmd:'feed_now', params:{from:'feed-panel'}}
 * - 自动策略   = KV 键 policy.feed_auto（GET /api/kv/...，PUT 仅 admin）
 * - 逐时趋势   = GET /api/samples?kind=intake_h&limit=24（meta.hour 为标签）
 * 契约：docs/API.md。禁止引用 js/data.js 仿真引擎；未接入一律真实空态/未连接。
 * ============================================================ */
(function (global) {
  'use strict';
  const UIx = global.UI, YQCx = global.YQC;
  const Q = UIx.Q, esc = UIx.esc, pad = UIx.pad, toast = UIx.toast;
  const api = UIx.api, apiEx = UIx.apiEx;

  const CMD_CLS = { queued: 'tag amber', sent: 'tag sky', ack: 'tag green', fail: 'tag red', timeout: 'tag gray' };
  const CMD_ZH = { queued: '排队中', sent: '待网关执行', ack: '网关已回执', fail: '执行失败', timeout: '超时' };

  const html = `
  <div class="content-scroll">
    <div id="fe-banner" class="hidden" style="display:none;padding:10px 14px;border-radius:10px;border:1px solid #fde68a;background:#fffbeb;color:#92400e;font-size:12.5px;margin-bottom:14px;align-items:center;gap:8px"></div>
    <div class="grid">
      <!-- KPI 行：全部来自云端真实数据 -->
      <div class="card span-3 kpi"><span class="k-ico ico-s">${I('package', 21)}</span><div class="k-body">
        <div class="k-label">补食机总数</div><div class="k-value" id="fe-k-total">–</div>
        <div class="k-sub" id="fe-k-total-sub">云端设备台账 type=feeder</div></div></div>
      <div class="card span-3 kpi"><span class="k-ico ico-g">${I('circle-check', 21)}</span><div class="k-body">
        <div class="k-label">已连接（90s 心跳内）</div><div class="k-value" id="fe-k-online">–</div>
        <div class="k-sub" id="fe-k-online-sub">未连接 <span class="down" id="fe-k-offline">–</span> 台</div></div></div>
      <div class="card span-3 kpi"><span class="k-ico ico-r">${I('alert-triangle', 21)}</span><div class="k-body">
        <div class="k-label">低余量点位（&lt;30%）</div><div class="k-value" id="fe-k-low">–</div>
        <div class="k-sub" id="fe-k-low-sub">仅按真实上报 level_pct 统计</div></div></div>
      <div class="card span-3 kpi"><span class="k-ico ico-a">${I('report-analytics', 21)}</span><div class="k-body">
        <div class="k-label">今日补食（指标）</div><div class="k-value" id="fe-k-today">–</div>
        <div class="k-sub" id="fe-k-today-sub">业务指标未接入</div></div></div>

      <!-- 补食中枢 · 自动模式 -->
      <div class="card span-4">
        <div class="card-h"><span class="h-ico">${I('adjustments', 15)}</span>补食中枢 · 自动模式
          <label class="switch" style="margin-left:auto" title="策略键 policy.feed_auto（仅 admin 可写；网关轮询该键执行）"><input type="checkbox" id="fe-auto"><span class="slider"></span></label>
        </div>
        <div class="h-divider"></div>
        <div class="card-b">
          <div class="field-row"><span class="fr-name">${I('settings', 14)} 自动补食策略</span>
            <span class="fr-val" id="fe-auto-txt"><span class="tag gray">读取策略中…</span></span></div>
          <div style="font-size:11px;color:var(--dim);line-height:1.8;margin-top:2px" id="fe-auto-desc">策略键 policy.feed_auto 由补食网关轮询（GET /api/kv/policy.feed_auto），取到 1 后按点位计划自动下发 feed_now。</div>
          <div style="display:flex;gap:16px;align-items:center;margin-top:14px">
            <div class="ring" style="--p:0;width:86px;height:86px;--c:#d1d5db" id="fe-ring">
              <b style="font-size:15px" id="fe-stock">—</b></div>
            <div style="flex:1;min-width:0">
              <div style="font-size:12.5px;color:#111827">全站料仓余量（真实上报）</div>
              <div style="font-size:20px;font-weight:700;margin:3px 0" id="fe-stock-kg">--</div>
              <div style="font-size:11px;color:var(--dim)" id="fe-stock-sub">等待补食机上报料位</div>
            </div>
          </div>
          <div style="display:flex;gap:8px;margin-top:14px">
            <button class="btn primary" style="flex:1" id="fe-feedall" disabled title="仅向已连接(90s 心跳内)补食机下发">${I('bolt', 14)} 全站补食（在线机）</button>
            <button class="btn" id="fe-sync" title="重新拉取设备/料位/流水/指标">${I('refresh', 14)} 刷新</button>
          </div>
        </div>
      </div>

      <!-- 补食点位实时料位 -->
      <div class="card span-8">
        <div class="card-h"><span class="h-ico">${I('gauge', 15)}</span>补食点位实时料位
          <span class="card-title-note" id="fe-tbl-note">连接=90s 心跳 · 料位=最近遥测</span></div>
        <div class="h-divider"></div>
        <div class="card-b" style="padding-top:4px;overflow-x:auto">
          <table class="table" style="min-width:760px"><thead><tr>
            <th>点位</th><th>区域/用途</th><th style="min-width:150px">料位</th><th>状态</th><th>电量</th><th>最近补食指令</th><th style="text-align:right">操作</th>
          </tr></thead><tbody id="fe-tbody"></tbody></table>
          <div id="fe-empty" class="empty-tip hidden"></div>
          <div id="fe-level-hint" class="hidden" style="font-size:11px;color:var(--dim);padding:8px 2px 2px"></div>
        </div>
      </div>

      <!-- 逐时采食（网关 samples 上报） -->
      <div class="card span-6">
        <div class="card-h"><span class="h-ico">${I('chart-bar', 15)}</span>逐时采食量（每 24 小时）<span class="card-title-note">kg · samples kind=intake_h</span></div>
        <div class="h-divider"></div>
        <div class="card-b">
          <div class="chart" data-chart id="fe-chart1" style="height:220px"></div>
          <div id="fe-c1-empty" class="empty-tip" style="padding:6px 10px">暂无逐时采食数据：由补食网关以 <code>POST /api/samples {kind:"intake_h", value:kg, meta:{hour:0..23}}</code> 上报后自动绘制。</div>
        </div>
      </div>

      <!-- 各点位余量对比 -->
      <div class="card span-6">
        <div class="card-h"><span class="h-ico">${I('scale', 15)}</span>各点位余量对比<span class="card-title-note">仅展示已上报料位的点位</span></div>
        <div class="h-divider"></div>
        <div class="card-b">
          <div class="chart" data-chart id="fe-chart2" style="height:220px"></div>
          <div id="fe-c2-empty" class="empty-tip" style="padding:6px 10px">暂无点位料位数据：料位由补食机遥测 <code>extra.level_pct</code>（或 level_kg + 设备 config.cap）上报后显示。</div>
        </div>
      </div>

      <!-- 补食指令流水 -->
      <div class="card span-6">
        <div class="card-h"><span class="h-ico">${I('send', 15)}</span>补食指令流水<span class="card-title-note">feed_now · 最近 50 条</span></div>
        <div class="h-divider"></div>
        <div class="card-b" style="padding-top:8px"><div class="event-stream" id="fe-flow" style="max-height:320px"></div></div>
      </div>

      <!-- 接入与策略 -->
      <div class="card span-6">
        <div class="card-h"><span class="h-ico">${I('bulb', 15)}</span>补食接入指引<span class="card-title-note">docs/API.md · README 速查</span></div>
        <div class="h-divider"></div>
        <div class="card-b" style="padding-top:6px;font-size:11.5px;line-height:2;color:var(--muted)">
          ① 登记：<b style="color:#374151">设备与网关</b>页新增 type=feeder 补食机（config 填 {"cap":容量kg}）。<br>
          ② 点亮：补食网关定时 <code>POST /api/telemetry</code>（≤90s 一次心跳），页面即显示已连接。<br>
          ③ 料位：遥测 extra 传 <code>level_pct</code>（或 level_kg/frac），页面显示余量百分比与趋势。<br>
          ④ 自动策略：上方开关写入 <code>policy.feed_auto</code>，网关轮询后自动安排 feed_now。<br>
          ⑤ 执行：网关取 <code>GET /api/commands?cmd=feed_now&status=sent</code> 执行，完成后 <code>POST /api/commands/:id/ack</code> → 流水变“网关已回执”。
        </div>
      </div>
    </div>
  </div>`;

  const state = {
    inited: false, tickSeq: 0,
    feeders: [],            // GET /api/devices?type=feeder 原始行
    flow: [],               // feed_now 指令流水
    metricKg: null,         // /api/metrics 中 feed_kg_today 行
    policy: null,           // '1' | '0' | null
    policyAt: 0,
    lvl: {},                // deviceId → 最近遥测 {pct, kg?, ts, extra}
    lvlAt: {},              // deviceId → 上次拉取时间
    flowAt: 0, metricAt: 0, devAt: 0, sampleAt: 0,
    busy: false,
    chHour: null, chPos: null,
    sampleRows: []          // 原始 intake_h 行（最新在前）
  };

  /* ---------- 小工具 ---------- */
  function tryJson(s, fb) {
    try { const v = JSON.parse(s || 'null'); return v == null ? fb : v; } catch (e) { return fb; }
  }
  function cfgOf(d) { return tryJson(d.config, {}); }
  function capOf(d) { const c = cfgOf(d).cap; return (c != null && Number.isFinite(+c) && +c > 0) ? +c : null; }
  function fmtTs(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function num(v) { return (v !== null && v !== undefined && Number.isFinite(+v)) ? +v : null; }
  /* 余量百分比：优先 level_pct，其次 level_kg/cap，其次 frac(0~1) */
  function pctOf(d, tel) {
    if (!tel) return null;
    const ex = tel.extra || {};
    const cap = capOf(d);
    if (ex.level_pct != null) return num(ex.level_pct);
    if (ex.level_kg != null && cap) { const kg = num(ex.level_kg); if (kg != null) return Math.min(100, kg / cap * 100); }
    if (ex.frac != null) { const f = num(ex.frac); return f == null ? null : (f <= 1 ? f * 100 : f); }
    return null;
  }
  function isLive(d) { return !!d && !!d.live; }

  /* ---------- 拉取（每次全量刷新；tick 节流调用 refreshLight） ---------- */
  async function fetchDevices() {
    state.devAt = Date.now();
    const list = await api('devices?type=feeder');
    if (!Array.isArray(list)) return null;   // 后端不可达/未登录：保留旧台账，交由调用方提示
    state.feeders = list;
    return list;
  }
  async function fetchLevel(dev, force) {
    const now = Date.now();
    if (!force && now - (state.lvlAt[dev.id] || 0) < 15000) return;
    state.lvlAt[dev.id] = now;
    const rows = await api('devices/' + encodeURIComponent(dev.id) + '/telemetry?limit=1');
    if (!Array.isArray(rows) || !rows.length) { state.lvl[dev.id] = null; return; }
    const rec = rows[0];
    state.lvl[dev.id] = {
      ts: rec.ts || null,
      batt: num(rec.batt),
      extra: tryJson(rec.extra, {})
    };
  }
  async function fetchLevels(force) {
    for (const d of state.feeders) { try { await fetchLevel(d, force); } catch (e) { /* 单台失败不阻断 */ } }
  }
  async function fetchFlow(force) {
    const now = Date.now();
    if (!force && now - state.flowAt < 8000) return;
    state.flowAt = now;
    const rows = await api('commands?cmd=feed_now&limit=50');
    if (Array.isArray(rows)) state.flow = rows;
  }
  async function fetchMetric(force) {
    const now = Date.now();
    if (!force && now - state.metricAt < 10000) return;
    state.metricAt = now;
    const rows = await api('metrics');
    if (Array.isArray(rows)) {
      state.metricKg = rows.find((m) => m.type === 'feed_kg_today') || null;
    }
  }
  async function fetchPolicy(force) {
    const now = Date.now();
    if (!force && now - state.policyAt < 15000) return;
    state.policyAt = now;
    const r = await api('kv/policy.feed_auto');
    if (r && r.v !== undefined) state.policy = String(r.v) === '1' ? '1' : '0';
  }
  async function fetchSamples(force) {
    const now = Date.now();
    if (!force && now - state.sampleAt < 60000) return;
    state.sampleAt = now;
    const rows = await api('samples?kind=intake_h&limit=24');
    state.sampleRows = Array.isArray(rows) ? rows : [];
  }

  async function refreshAll(force) {
    if (state.busy) return;
    state.busy = true;
    try {
      const off = (tip) => {
        const b = Q('fe-banner');
        if (!b) return;
        b.classList.remove('hidden'); b.style.display = 'flex';
        b.innerHTML = I('alert-triangle', 14) + '<span>' + esc(tip || '无法连接云端后端') +
          '：请运行 <code>node backend/server.js</code> 后刷新。</span>';
      };
      const devs = await fetchDevices();
      if (!devs) { off(); return; }
      const b = Q('fe-banner');
      if (b) { b.classList.add('hidden'); b.style.display = 'none'; }
      await Promise.all([fetchLevels(force), fetchFlow(force), fetchMetric(force), fetchPolicy(force), fetchSamples(force)]);
      renderAll();
    } catch (e) { /* 静默：下一次轮询重试 */ } finally {
      state.busy = false;
    }
  }
  function refreshLight() {
    if (state.busy) return;
    state.busy = true;
    (async () => {
      try {
        const devs = await fetchDevices();
        const b = Q('fe-banner');
        if (!devs) { if (b) { b.classList.remove('hidden'); b.style.display = 'flex'; } return; }
        if (b) { b.classList.add('hidden'); b.style.display = 'none'; }
        await fetchLevels(false);
        renderKpis(); renderTable(); renderHub();
        await Promise.all([fetchFlow(false), fetchMetric(false), fetchPolicy(false), fetchSamples(false)]);
        renderFlow(); renderCharts(); renderPolicy();
      } catch (e) { /* 忽略单次失败 */ } finally { state.busy = false; }
    })();
  }

  /* ---------- 渲染 ---------- */
  function known(d) {
    const tel = state.lvl[d.id];
    if (!tel) return null;
    return { pct: pctOf(d, tel), tel };
  }

  function renderKpis() {
    const list = state.feeders;
    const online = list.filter(isLive).length;
    const low = list.filter((d) => { const k = known(d); return k && k.pct != null && k.pct < 30; }).length;
    setKpi('fe-k-total', list.length);
    setKpi('fe-k-online', online);
    const off = Q('fe-k-offline');
    if (off) off.textContent = String(list.length - online);
    setKpi('fe-k-low', low);
    Q('fe-k-low-sub').textContent = low ? '低余量点位 ' + low + ' 台（真实 level_pct<30）' : '仅按真实上报 level_pct 统计';
    // 今日补食指标
    const m = state.metricKg;
    const kv = Q('fe-k-today');
    if (m && num(m.value) != null) {
      kv.innerHTML = num(m.value).toLocaleString('zh-Hans-CN', { maximumFractionDigits: 1 }) +
        (m.unit ? '<small>' + esc(m.unit) + '</small>' : '');
      Q('fe-k-today-sub').innerHTML = '云端指标 · ' + esc(m.source || '') + ' · ' + fmtTs(m.ts) +
        (m.note ? ' · ' + esc(m.note) : '');
    } else {
      kv.innerHTML = '—';
      Q('fe-k-today-sub').innerHTML = '未接入：由场区网关/ERP 以 <b>POST /api/metrics</b> type=feed_kg_today 上报';
    }
  }
  function setKpi(id, val) {
    const el = Q(id);
    if (el) el.textContent = String(val);
  }

  function renderHub() {
    // 全站余量（仅真实料位 × 配置容量）
    let sumKg = 0, sumCap = 0, reported = 0;
    const pcts = [];
    state.feeders.forEach((d) => {
      const k = known(d);
      if (!k || k.pct == null) return;
      reported++;
      pcts.push(k.pct);
      const cap = capOf(d);
      if (cap) { sumKg += Math.min(100, k.pct) / 100 * cap; sumCap += cap; }
    });
    const N = state.feeders.length;
    const ring = Q('fe-ring');
    if (!reported) {
      Q('fe-stock').textContent = '—';
      Q('fe-stock-kg').textContent = '—';
      Q('fe-stock-sub').innerHTML = '已上报料位 0/' + N + ' 台 · 由补食机遥测 <code>extra.level_pct</code> 上报后显示';
      if (ring) { ring.style.setProperty('--p', '0'); ring.style.setProperty('--c', '#d1d5db'); }
    } else {
      const avgPct = pcts.reduce((s, p) => s + p, 0) / pcts.length;
      const pctAll = sumCap ? sumKg / sumCap * 100 : avgPct;
      const p = Math.round(pctAll);
      Q('fe-stock').textContent = p + '%';
      Q('fe-stock-kg').textContent = (sumCap ? Math.round(sumKg).toLocaleString('zh-Hans-CN') : '—') + ' kg';
      Q('fe-stock-sub').innerHTML = '已上报料位 ' + reported + '/' + N + ' 台 · 低余量 <b style="color:#b91c1c">' +
        state.feeders.filter((d) => { const k = known(d); return k && k.pct != null && k.pct < 30; }).length + '</b> 台';
      if (ring) {
        ring.style.setProperty('--p', String(Math.min(100, p)));
        ring.style.setProperty('--c', p > 45 ? 'var(--green)' : (p > 25 ? 'var(--amber)' : 'var(--red)'));
      }
    }
    const on = state.feeders.filter(isLive).length;
    Q('fe-feedall').disabled = on === 0;
    const btn = Q('fe-feedall');
    if (btn) btn.title = on ? '向 ' + on + ' 台已连接补食机下发 feed_now' : '无已连接补食机（≤90s 心跳）时不可全站补食';
    Q('fe-tbl-note').textContent = '台账 ' + N + ' 台 · 已连接 ' + on + ' · 料位=最近遥测';
  }

  function renderTable() {
    const tbody = Q('fe-tbody');
    const list = state.feeders;
    if (!list.length) {
      tbody.innerHTML = '';
      const empty = Q('fe-empty');
      empty.classList.remove('hidden');
      empty.innerHTML = '<b style="color:#4b5563">暂无补食机设备</b><br>' +
        '请到「设备与网关」登记 type=feeder 补食机（或网关完成注册），即可在此查看料位与补食指令。';
      Q('fe-level-hint').classList.add('hidden');
      return;
    }
    Q('fe-empty').classList.add('hidden');
    const byDev = {};
    state.flow.forEach((c) => { if (!byDev[c.device_id]) byDev[c.device_id] = c; });
    tbody.innerHTML = list.map((d) => {
      const tel = state.lvl[d.id];
      const k = known(d);
      const pct = k ? k.pct : null;
      const live = isLive(d);
      const cap = capOf(d);
      const model = [d.vendor, d.model].filter(Boolean).join(' ');
      const last = byDev[d.id];
      const cfg = cfgOf(d);
      const metaTitle = ['cap=' + (cfg.cap != null ? cfg.cap : '未配置'), d.note].filter(Boolean).join(' · ');
      return `<tr>
        <td><b style="color:#111827">${esc(d.id)}</b><br>
          <span style="font-size:11px;color:var(--muted)">${esc(d.name)}</span>
          ${model ? '<div style="font-size:10.5px;color:var(--dim)">' + esc(model) + (d.sn ? ' · ' + esc(d.sn) : '') + '</div>' : ''}
          ${metaTitle ? '<div style="font-size:10px;color:var(--dim)">' + esc(metaTitle) + '</div>' : ''}</td>
        <td style="font-size:11.5px;color:var(--muted)">${esc(d.sub || '—')}</td>
        <td>${pct != null ? `<div style="display:flex;align-items:center;gap:8px">
            <div class="sr-bar" style="width:86px"><i class="${pct < 20 ? 'red' : (pct < 30 ? 'amber' : '')}" style="width:${Math.min(100, pct).toFixed(0)}%;${pct < 20 ? 'background:#ef4444' : (pct < 30 ? 'background:#f59e0b' : '')}"></i></div>
            <span style="width:44px;text-align:right;font-variant-numeric:tabular-nums">${pct.toFixed(0)}%</span></div>
            <div style="font-size:9.5px;color:var(--dim)">最近遥测 ${fmtTs(tel && tel.ts)}${cap ? ' · 余 ' + Math.round(Math.min(100, pct) / 100 * cap) + '/' + Math.round(cap) + 'kg' : ''}</div>`
          : `<span style="color:#9ca3af">— / 未上报</span><div style="font-size:9.5px;color:var(--dim)">由网关 extra.level_pct 上报后显示</div>`}</td>
        <td>${live ? '<span class="tag green">已连接</span>' : '<span class="tag red">未连接</span>'}</td>
        <td style="font-variant-numeric:tabular-nums;font-size:11px">${tel && tel.batt != null && tel.batt >= 0 ? Math.round(tel.batt) + '%' : '—'}</td>
        <td style="font-size:10.5px;color:var(--muted)">${last ? fmtTs(last.created_at) + ' · ' + (CMD_ZH[last.status] || last.status) : '—'}</td>
        <td style="text-align:right"><button class="btn" style="padding:3px 10px" data-feed="${esc(d.id)}" ${live ? '' : 'disabled'} title="${live ? '下发 feed_now（等待网关回执）' : '设备未连接，无法下发'}">${I('bolt', 12)} 立即补食</button></td>
      </tr>`;
    }).join('');
    const reportedN = list.filter((d) => { const k = known(d); return k && k.pct != null; }).length;
    const hint = Q('fe-level-hint');
    if (reportedN < list.length) {
      hint.classList.remove('hidden');
      hint.innerHTML = '仍有 <b>' + (list.length - reportedN) + '</b> 台未上报料位（当前 ' + reportedN + '/' + list.length + ' 台有真实 level）：' +
        '由补食网关在 <code>POST /api/telemetry</code> 的 extra 中携带 <code>level_pct</code>（或 level_kg + 设备 config.cap）后显示。';
    } else {
      hint.classList.add('hidden');
    }
  }

  function renderFlow() {
    const box = Q('fe-flow');
    const rows = state.flow;
    if (!rows.length) {
      box.innerHTML = '<div class="empty-tip"><b style="color:#4b5563">暂无补食指令</b><br>' +
        '点击上方任一“立即补食”，或在设备页/网关下发 feed_now 后，指令与回执将显示在此。</div>';
      return;
    }
    box.innerHTML = rows.slice(0, 50).map((c) => {
      const cls = CMD_CLS[c.status] || 'tag gray';
      const zh = CMD_ZH[c.status] || c.status;
      const dev = state.feeders.find((d) => d.id === c.device_id);
      return `<div class="ev-item" style="align-items:flex-start">
        <span class="ev-ico ico-s">${I('bolt', 13)}</span>
        <div style="min-width:0"><div style="font-size:12px;color:#111827;font-weight:500">${esc(c.device_id)} · feed_now
          <span class="${cls}" style="margin-left:5px">${zh}</span></div>
          <div style="font-size:10.5px;color:var(--dim)">${fmtTs(c.created_at)}${dev ? ' · ' + esc(dev.name) : ''}${c.ack_msg ? ' · ' + esc(c.ack_msg) : ''}</div></div>
      </div>`;
    }).join('');
  }

  function renderPolicy() {
    const on = state.policy === '1';
    const sw = Q('fe-auto');
    if (sw) sw.checked = on;
    const u = UIx.auth && UIx.auth.user;
    const isAdmin = !!(u && u.role === 'admin');
    const txt = Q('fe-auto-txt');
    if (!txt) return;
    if (state.policy == null) {
      txt.innerHTML = '<span class="tag gray">策略读取失败 · 按关闭处理</span>';
      Q('fe-auto-desc').innerHTML = '策略键读取失败（可能未配置）——网关按 policy.feed_auto=0 处理，仅手动补食生效。' +
        (isAdmin ? ' 拨动上方开关即可写入。' : ' 仅 admin 账号可配置。');
      return;
    }
    txt.innerHTML = on
      ? '<span class="tag green">已开启 · 网关将自动补食</span>'
      : '<span class="tag gray">已关闭 · 仅手动补食</span>';
    Q('fe-auto-desc').innerHTML = '策略键 <code>policy.feed_auto=' + (on ? '1' : '0') + '</code>' +
      (isAdmin ? ' · 拨动开关即可写入（网关轮询后生效）' : ' · 仅 admin 账号可修改该策略') +
      ' · 网关轮询：GET /api/kv/policy.feed_auto';
  }

  function renderCharts() {
    const rows = state.sampleRows.slice().reverse(); // 接口最新在前 → 翻转为时间正序
    const agg = {};
    rows.forEach((r) => {
      const vv = num(r.value);
      if (vv == null) return;
      const meta = tryJson(r.meta, {});
      let h = meta.hour != null ? meta.hour : null;
      if (h == null && r.ts) h = new Date(r.ts).getHours();
      if (h == null) return;
      const label = pad(+h) + ':00';
      agg[label] = (agg[label] || 0) + vv;
    });
    const hours = Object.keys(agg).sort();
    const values = hours.map((h) => +(agg[h].toFixed(1)));
    const box1 = Q('fe-chart1'), empty1 = Q('fe-c1-empty');
    if (hours.length) {
      if (empty1) empty1.classList.add('hidden');
      if (!state.chHour && box1 && YQCx) state.chHour = YQCx.make(box1, {
        tooltip: { trigger: 'axis' },
        grid: { left: 46, right: 16, top: 26, bottom: 24 },
        xAxis: { type: 'category', data: hours },
        yAxis: { type: 'value', name: 'kg' },
        series: [{ name: '采食量(kg)', type: 'bar', barWidth: '52%', itemStyle: { borderRadius: [3, 3, 0, 0] }, data: values }]
      });
      else if (state.chHour) state.chHour.setOption({ xAxis: { data: hours }, series: [{ data: values }] });
    } else {
      if (empty1) empty1.classList.remove('hidden');
      if (state.chHour) { try { state.chHour.dispose(); } catch (e) { /* 忽略 */ } state.chHour = null; if (box1) box1.innerHTML = ''; }
    }
    // 余量对比（只画有真实料位的点位）
    const knownRows = state.feeders.map((d) => ({ d, k: known(d) })).filter((x) => x.k && x.k.pct != null);
    const box2 = Q('fe-chart2'), empty2 = Q('fe-c2-empty');
    if (knownRows.length) {
      if (empty2) empty2.classList.add('hidden');
      const cats = knownRows.map((x) => x.d.id + ' · ' + x.d.name);
      const data = knownRows.map((x) => ({ value: Math.min(100, Math.round(x.k.pct)), name: x.d.id }));
      const opt = {
        tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
        grid: { left: 90, right: 48, top: 16, bottom: 22 },
        xAxis: { type: 'value', max: 100, name: '%' },
        yAxis: { type: 'category', inverse: true, data: cats },
        series: [{ name: '余量%', type: 'bar', barWidth: 13, label: { show: true, position: 'right', color: '#6b7280', fontSize: 10.5, formatter: (p) => p.value + '%' }, data }]
      };
      if (!state.chPos && box2 && YQCx) state.chPos = YQCx.make(box2, opt);
      else if (state.chPos) state.chPos.setOption(opt);
    } else {
      if (empty2) empty2.classList.remove('hidden');
      if (state.chPos) { try { state.chPos.dispose(); } catch (e) { /* 忽略 */ } state.chPos = null; if (box2) box2.innerHTML = ''; }
    }
  }

  function renderAll() {
    renderKpis();
    renderHub();
    renderTable();
    renderFlow();
    renderPolicy();
    renderCharts();
  }

  /* ---------- 动作 ---------- */
  async function sendFeedNow(dev) {
    const r = await apiEx('devices/' + encodeURIComponent(dev.id) + '/command', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'feed_now', params: { from: 'feed-panel' } })
    });
    if (r.status === 200 && r.data && r.data.id) {
      toast('指令已下发', dev.id + ' · feed_now 已入队（#CMD' + r.data.id + '），等待网关回执', 'ok');
      if (UIx.watchCmd) UIx.watchCmd(dev.id, r.data.id, 'feed_now');
      // 稍后刷新流水与点位状态（回执轮询由 watchCmd 完成）
      setTimeout(() => { fetchFlow(true).then(renderFlow); }, 2600);
    } else {
      const why = r.status === 403
        ? '当前账号无控制权限（需 admin/operator）'
        : (r.status === -1 ? '无法连接云端后端' : ((r.data && r.data.error) || 'HTTP ' + r.status));
      toast('指令下发失败', dev.id + '：' + why, 'err');
    }
  }

  async function feedAll() {
    const live = state.feeders.filter(isLive);
    if (!live.length) { toast('全站补食不可用', '当前无已连接补食机（需 ≤90s 心跳内），无法下发', 'warn'); return; }
    let okN = 0, badN = 0;
    for (const d of live) {
      const r = await apiEx('devices/' + encodeURIComponent(d.id) + '/command', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd: 'feed_now', params: { from: 'feed-panel', all: 1 } })
      });
      if (r.status === 200 && r.data && r.data.id) {
        okN++;
        if (UIx.watchCmd) UIx.watchCmd(d.id, r.data.id, 'feed_now');
      } else badN++;
    }
    if (okN) toast('指令已下发', '已向 ' + okN + ' 台已连接补食机下发 feed_now，等待网关回执' + (badN ? '（' + badN + ' 台失败）' : ''), okN ? 'ok' : 'err');
    else toast('指令下发失败', '全部下发失败：请确认账号为 admin/operator 且后端在线', 'err');
    setTimeout(() => { fetchFlow(true).then(renderFlow); }, 2600);
  }

  async function toggleAuto(e) {
    const want = e.target.checked;
    const u = UIx.auth && UIx.auth.user;
    if (!u || u.role !== 'admin') {
      e.target.checked = !want;
      toast('无权限', '仅 admin 账号可修改自动补食策略（policy.feed_auto）', 'warn');
      return;
    }
    const v = want ? '1' : '0';
    const r = await apiEx('kv/policy.feed_auto', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ v })
    });
    if (r.status === 200) {
      state.policy = v;
      renderPolicy();
      toast(want ? '自动补食已开启' : '自动补食已关闭',
        '已写入策略键 policy.feed_auto=' + v + ' · 网关轮询到后执行，回执见补食流水', want ? 'ok' : 'warn');
    } else {
      e.target.checked = !want;
      const why = r.status === 403 ? '仅 admin 可写策略键' : ((r.data && r.data.error) || 'HTTP ' + r.status);
      toast('策略保存失败', why, 'err');
    }
  }

  /* ---------- 生命周期 ---------- */
  function init() {
    if (state.inited) return;
    state.inited = true;
    const root = Q('page-feed');
    root.innerHTML = html;
    Q('fe-auto').addEventListener('change', toggleAuto);
    Q('fe-sync').addEventListener('click', () => refreshAll(true));
    Q('fe-feedall').addEventListener('click', feedAll);
    Q('fe-tbody').addEventListener('click', (e) => {
      const b = e.target.closest('[data-feed]');
      if (!b || b.disabled) return;
      const dev = state.feeders.find((d) => d.id === b.dataset.feed);
      if (dev) sendFeedNow(dev);
    });
    refreshAll(true);
  }

  function tick() {
    if (!state.inited) return;
    state.tickSeq++;
    if (state.tickSeq % 3 === 0) refreshLight();
  }

  function onShow() {
    if (!state.inited) return;
    refreshAll(true);
  }

  global.PAGES = global.PAGES || {};
  global.PAGES.feed = { name: '智能补食面板', init, tick, onShow };
})(window);
