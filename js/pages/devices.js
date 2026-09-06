/* ============================================================
 * 设备与网关管理（云端后台 DB → 现实设备台账）
 * - 无人机 / 摄像头 / 补食机 / 传感器 / 网关 / 机巢 / RTK
 * - 增删改查、状态、经纬度、RTSP/MAVLink 接入参数
 * - 云端指令下发（起飞/返航/充电/云台/补食…）与回执流水
 * 依赖后端：node backend/server.js（离线时页面给出引导）
 * ============================================================ */
(function (global) {
  'use strict';
  const UI = global.UI;
  const Q = UI.Q, $$ = UI.$$, esc = UI.esc, toast = UI.toast;

  const TYPES = [
    ['drone', '无人机'], ['camera', '摄像头'], ['feeder', '补食机'], ['sensor', '传感器'],
    ['gateway', 'AI网关'], ['nest', '机巢'], ['rtk', 'RTK站'], ['weather', '气象站']
  ];
  const TYPE_ICON = { drone: 'drone', camera: 'camera', feeder: 'package', sensor: 'activity', gateway: 'cpu', nest: 'home-2', rtk: 'satellite', weather: 'cloud' };
  const CTRL = {
    drone: [['takeoff', 'player-play', '起飞'], ['rtl', 'home-2', '返航'], ['charge', 'bolt', '充电']],
    camera: [['gimbal_home', 'focus-2', '云台归中'], ['reboot', 'refresh', '重启']],
    feeder: [['feed_now', 'bolt', '立即补食']],
    sensor: [['reboot', 'refresh', '重启']],
    gateway: [['reboot', 'refresh', '重启']],
    nest: [['reboot', 'refresh', '重启']],
    rtk: [['reboot', 'refresh', '重启']],
    weather: [['reboot', 'refresh', '重启']]
  };
  const ST_CLS = { online: 'green', standby: 'sky', patrol: 'sky', flight: 'sky', charging: 'amber', warn: 'amber', offline: 'red' };
  const ST_ZH = { online: '在线', standby: '待命', patrol: '巡线中', flight: '飞行中', charging: '充电中', warn: '预警', offline: '离线' };

  const state = { list: [], cmds: [], alarmsOpen: 0, filter: '', type: '', editId: null, adding: false, online: false };

  const html = `
  <div class="content-scroll">
    <div id="dv-banner" class="hidden" style="display:none;padding:10px 14px;border-radius:10px;border:1px solid #fde68a;background:#fffbeb;color:#92400e;font-size:12.5px;margin-bottom:14px;align-items:center;gap:8px"></div>
    <div class="grid">
      <div class="card span-3 kpi"><span class="k-ico ico-s">${I('antenna', 21)}</span><div class="k-body">
        <div class="k-label">云端设备总数</div><div class="k-value" id="dv-total">–</div>
        <div class="k-sub" id="dv-total-sub">SQLite 台账 · 实时同步</div></div></div>
      <div class="card span-3 kpi"><span class="k-ico ico-g">${I('circle-check', 21)}</span><div class="k-body">
        <div class="k-label">在线设备</div><div class="k-value" id="dv-online">–</div>
        <div class="k-sub">离线 <span class="down" id="dv-offline">–</span> 台</div></div></div>
      <div class="card span-3 kpi"><span class="k-ico ico-a">${I('clock', 21)}</span><div class="k-body">
        <div class="k-label">今日云端指令</div><div class="k-value" id="dv-cmd">–</div>
        <div class="k-sub" id="dv-cmd-sub">已回执 <span class="up" id="dv-ack">–</span></div></div></div>
      <div class="card span-3 kpi"><span class="k-ico ico-r">${I('alert-triangle', 21)}</span><div class="k-body">
        <div class="k-label">未处理设备告警</div><div class="k-value" id="dv-alarm">–</div>
        <div class="k-sub">真实设备告警上报入口已开放</div></div></div>

      <!-- 新增/编辑 表单 -->
      <div class="card span-12 hidden" id="dv-form-card">
        <div class="card-h"><span class="h-ico" id="dv-form-ico">${I('plus', 15)}</span><span id="dv-form-title">新增设备</span>
          <span class="more" id="dv-form-cancel">取消 ✕</span></div>
        <div class="h-divider"></div>
        <div class="card-b">
          <div id="dv-form" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px 14px">
            <div><label class="dv-lb">设备ID（留空自动生成）</label><input class="dv-in" id="f-id" placeholder="如 DRONE-09"></div>
            <div><label class="dv-lb">类型 *</label>
              <select class="dv-in" id="f-type">${TYPES.map((t) => `<option value="${t[0]}">${t[1]}</option>`).join('')}</select></div>
            <div><label class="dv-lb">名称 *</label><input class="dv-in" id="f-name" placeholder="如 山雀4号 / 东门枪机"></div>
            <div><label class="dv-lb">用途/位置描述</label><input class="dv-in" id="f-sub" placeholder="如 散养区A·松林"></div>
            <div><label class="dv-lb">品牌厂商</label><input class="dv-in" id="f-vendor" placeholder="如 DJI / 海康威视"></div>
            <div><label class="dv-lb">型号</label><input class="dv-in" id="f-model" placeholder="如 Matrice 350 RTK"></div>
            <div><label class="dv-lb">序列号 SN</label><input class="dv-in" id="f-sn" placeholder="机身序列号"></div>
            <div><label class="dv-lb">接入协议</label><input class="dv-in" id="f-protocol" placeholder="MAVLink / RTSP / Modbus / MQTT"></div>
            <div style="grid-column:1/-1"><label class="dv-lb">视频流地址（RTSP/RTMP/HLS）</label>
              <input class="dv-in" id="f-stream" style="width:100%" placeholder="rtsp://user:pass@ip:554/Streaming/Channels/101"></div>
            <div><label class="dv-lb">经度 lon</label><input class="dv-in" id="f-lon" placeholder="104.45189"></div>
            <div><label class="dv-lb">纬度 lat</label><input class="dv-in" id="f-lat" placeholder="34.96081"></div>
            <div><label class="dv-lb">高度 alt(m)</label><input class="dv-in" id="f-alt" placeholder="0"></div>
            <div><label class="dv-lb">状态</label>
              <select class="dv-in" id="f-status"><option>online</option><option>standby</option><option>patrol</option><option>flight</option><option>charging</option><option>offline</option></select></div>
            <div style="grid-column:1/-1"><label class="dv-lb">备注（接入指引/说明）</label>
              <input class="dv-in" id="f-note" style="width:100%" placeholder="设备安装位置、接入注意事项…"></div>
          </div>
          <div style="display:flex;gap:10px;margin-top:14px">
            <button class="btn primary" id="dv-save">${I('circle-check', 14)} 保存到云端数据库</button>
            <button class="btn" id="dv-form-cancel2">取消</button>
          </div>
        </div>
      </div>

      <!-- 设备表 -->
      <div class="card span-8">
        <div class="card-h"><span class="h-ico">${I('antenna', 15)}</span>设备台账<span class="card-title-note" id="dv-sub">云端 SQLite 数据库</span>
          <span style="margin-left:auto;display:flex;gap:8px">
            <select class="btn" id="dv-type" style="padding:4px 8px"><option value="">全部类型</option>
              ${TYPES.map((t) => `<option value="${t[0]}">${t[1]}</option>`).join('')}</select>
            <input class="dv-in" id="dv-q" placeholder="搜索名称/ID/SN…" style="width:150px">
            <button class="btn" id="dv-restore-tpl" style="padding:4px 10px;display:none" title="恢复内置默认设备模板（仅管理员；您删除的设备不会再自动回来）">${I('refresh', 13)} 恢复默认模板</button>
            <button class="btn primary" id="dv-add">${I('plus', 13)} 添加设备</button>
          </span>
        </div>
        <div class="h-divider"></div>
        <div class="card-b" style="padding-top:4px;overflow-x:auto">
          <table class="table" style="min-width:860px"><thead><tr>
            <th>设备</th><th>类型</th><th>接入（协议 / 流）</th><th>经纬度</th><th>状态</th><th>控制</th><th style="text-align:right">操作</th>
          </tr></thead><tbody id="dv-tbody"></tbody></table>
          <div id="dv-empty" class="empty-tip hidden">没有匹配的设备</div>
        </div>
      </div>

      <!-- 右侧：指令流水 / 站点 / 接入说明 -->
      <div class="span-4" style="display:flex;flex-direction:column;gap:12px">
        <div class="card">
          <div class="card-h"><span class="h-ico">${I('send', 15)}</span>云端指令流水<span class="more" id="dv-refresh">刷新</span></div>
          <div class="h-divider"></div>
          <div class="card-b" style="padding-top:6px"><div class="event-stream" id="dv-cmds" style="max-height:252px"></div></div>
        </div>
        <div class="card">
          <div class="card-h"><span class="h-ico">${I('current-location', 15)}</span>机巢站点 · 步云村</div>
          <div class="h-divider"></div>
          <div class="card-b" style="padding-top:6px" id="dv-site">
            <div class="sensor-row"><span class="sr-name">站点坐标</span><span style="font-size:12px;font-variant-numeric:tabular-nums" id="dv-site-xy">--</span></div>
            <div class="sensor-row"><span class="sr-name">RTK 服务</span><span id="dv-site-rtk">--</span></div>
            <div class="sensor-row"><span class="sr-name">备注</span><span id="dv-site-note" style="font-size:11px;color:var(--dim);white-space:normal;text-align:right;max-width:210px">--</span></div>
            <div style="font-size:10.5px;color:var(--dim);margin-top:8px">站点（SITE-1）坐标即无人机机巢/天气预警的计算点，由云端站点表维护；各设备经纬度可在本页「编辑」中单独填写。</div>
          </div>
        </div>
        <div class="card">
          <div class="card-h"><span class="h-ico">${I('route', 15)}</span>设备接入指引</div>
          <div class="h-divider"></div>
          <div class="card-b" style="padding-top:6px;font-size:11.5px;line-height:1.9;color:var(--muted)">
            ① 无人机：<b style="color:#374151">MAVLink</b> 接入（云 SDK/数传→网关），
            ② 摄像头：把上面 <b style="color:#374151">RTSP 地址</b> 换成真实内网地址，
            ③ 遥测上报：<code style="background:#f3f4f6;padding:1px 5px;border-radius:4px">POST /api/telemetry</code>，
            ④ 指令：本页按钮写入 commands 表，网关轮询 <code style="background:#f3f4f6;padding:1px 5px;border-radius:4px">GET /api/commands</code> 后执行并回执。
          </div>
        </div>
      </div>

      <!-- 数据下载窗口（按月份一键导出 CSV） -->
      <div class="card span-12">
        <div class="card-h"><span class="h-ico">${I('download', 15)}</span>数据下载窗口
          <span class="card-title-note">按月导出时序数据 CSV · 云端默认保留 30 天（DATA_KEEP_DAYS 可调），超期自动清理</span>
          <span class="more" style="cursor:default" id="dv-keep-tag">默认保留 30 天</span>
        </div>
        <div class="h-divider"></div>
        <div class="card-b" style="padding-top:8px">
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#6b7280">
              选择月份 <input type="month" id="dl-month" style="padding:6px 8px;border:1px solid #e5e7eb;border-radius:8px;font-size:12.5px;color:#111827"></label>
            <button class="btn primary" data-dl="telemetry">${I('download', 13)} 遥测数据</button>
            <button class="btn" data-dl="alarms">${I('download', 13)} 告警记录</button>
            <button class="btn" data-dl="commands">${I('download', 13)} 指令流水</button>
            <button class="btn" data-dl="samples">${I('download', 13)} 采样记录</button>
            <button class="btn danger" id="dv-purge" title="仅管理员：立即删除超过保留期的数据">清理过期数据</button>
          </div>
          <div style="font-size:11px;color:var(--dim);margin-top:10px;line-height:1.8">
            ① <b>自动保留策略</b>：遥测 / 告警 / 指令流水 / 采样（逐时、均重等时序数据）保存最近 30 天，服务启动后及每 6 小时自动删除过期记录；
            ② <b>长期档案</b>：设备台账、用户、站点、批次与溯源事件、业务指标快照不受影响，可永久追溯；
            ③ 导出文件为 CSV（UTF-8，Excel 可直接打开），选择月份后点对应按钮即可下载；被策略清理的历史月份可能为空属正常；
            ④ 保留天数可在后端环境变量 DATA_KEEP_DAYS 调整（如 90），接口见 docs/API.md。
          </div>
        </div>
      </div>
    </div>
  </div>`;

  /* ---------- 工具 ---------- */
  function cloudOff(tip) {
    const b = Q('dv-banner');
    state.online = false;
    b.classList.remove('hidden'); b.style.display = 'flex';
    b.innerHTML = I('alert-triangle', 14) + '<span>' + esc(tip || '无法连接云端后端') +
      '：请运行 <code>node backend/server.js</code> 后刷新。当前展示引导信息，页面功能不可用。</span>';
  }
  function gv(id) { return Q(id); }
  const n = (v) => (v === null || v === undefined || v === '') ? '—' : v;
  const t2s = (t) => { const d = new Date(t); const p = UI.pad; return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); };
  function typeMeta(t) { return TYPES.find((x) => x[0] === t) || [t, t]; }

  /* ---------- 渲染 ---------- */
  function rowHtml(d) {
    const [tv, tn] = typeMeta(d.type);
    const st = d.live ? '已连接' : '未连接';
    const stc = d.live ? 'green' : 'red';
    const pos = (d.lat != null && d.lon != null) ? d.lat.toFixed(5) + ', ' + d.lon.toFixed(5) : '—';
    const ctrl = (CTRL[d.type] || []).map(([cmd, ic, lb]) =>
      `<button class="btn" style="padding:2.5px 8px;margin-right:4px;margin-top:3px" data-ctl="${d.id}" data-cmd="${cmd}" title="下发指令：${lb}" ${d.live ? '' : 'disabled'}>${I(ic, 12)} ${lb}</button>`).join('');
    const last = d.last_seen ? ' · 心跳 ' + t2s(d.last_seen) : '';
    return `<tr>
      <td><b style="color:#111827;cursor:pointer" data-edit-name="${d.id}" title="点击编辑：名称/用途/型号/SN/流地址均可自定义">${esc(d.id)} ✎</b><br>
        <span style="font-size:11px;color:var(--muted)">${esc(d.name)}${d.sub ? ' · ' + esc(d.sub) : ''}</span>
        ${d.vendor ? '<div style="font-size:10.5px;color:var(--dim)">' + esc(d.vendor) + (d.model ? ' ' + esc(d.model) : '') + (d.sn ? ' · ' + esc(d.sn) : '') + '</div>' : ''}</td>
      <td><span class="tag ${d.type === 'drone' ? 'purple' : (d.type === 'camera' ? 'sky' : 'gray')}">${I(TYPE_ICON[d.type] || 'antenna', 11)} ${tn}</span></td>
      <td style="max-width:190px"><div style="font-size:11px;color:var(--muted)">${esc(d.protocol || '—')}</div>
        <div style="font-size:10.5px;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(d.stream_url || '')}">${esc(d.stream_url || '无视频流')}</div></td>
      <td style="font-size:11px;font-variant-numeric:tabular-nums;color:var(--muted)">${pos}</td>
      <td><span class="tag ${stc}">${st}</span><div style="font-size:9.5px;color:var(--dim);margin-top:2px">${d.live ? '' : '待接入'}${last}</div></td>
      <td>${ctrl || '<span style="color:#d1d5db;font-size:11px">—</span>'}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn" style="padding:2.5px 8px" data-edit="${d.id}">编辑</button>
        <button class="btn danger" style="padding:2.5px 8px" data-del="${d.id}">删除</button></td>
    </tr>`;
  }

  function renderList() {
    const tbody = Q('dv-tbody');
    const rows = state.list.filter((d) => {
      if (state.type && d.type !== state.type) return false;
      if (state.filter) {
        const s = (d.id + ' ' + d.name + ' ' + d.model + ' ' + d.sn + ' ' + d.vendor).toLowerCase();
        if (s.indexOf(state.filter.toLowerCase()) < 0) return false;
      }
      return true;
    });
    tbody.innerHTML = rows.map(rowHtml).join('');
    // 台账真正为空（用户删光了）与“筛选无结果”分开提示
    const empty = Q('dv-empty');
    if (state.list.length === 0) {
      empty.classList.remove('hidden');
      empty.innerHTML = '台账为空：您已删除全部设备。删除结果会永久保留（重启后端也不会恢复），' +
        '需要默认模板时点右上角「恢复默认模板」（仅管理员）。<br>' +
        '也可以点「添加设备」登记您的真实设备，网关/遥测到达后自动点亮为已连接。';
      const tpl = Q('dv-restore-tpl');
      if (tpl) tpl.style.display = (UI.auth.user && UI.auth.user.role === 'admin') ? '' : 'none';
    } else {
      empty.classList.toggle('hidden', rows.length > 0);
      empty.innerHTML = '没有匹配的设备';
      const tpl = Q('dv-restore-tpl');
      if (tpl) tpl.style.display = 'none';
    }
    // KPI：以“真实连接(live)”为准
    const liveN = state.list.filter((d) => d.live).length;
    UI.setNum(Q('dv-total'), state.list.length, 0);
    UI.setNum(Q('dv-online'), liveN, 0);
    UI.setNum(Q('dv-offline'), state.list.length - liveN, 0);
    UI.setNum(Q('dv-alarm'), state.alarmsOpen, 0);
    Q('dv-total-sub').textContent = '站点：' + (state.site ? state.site.name : '—') + ' · ' + liveN + ' 台已连接';
  }

  function renderCmds() {
    const box = Q('dv-cmds');
    const cls = { queued: 'tag amber', sent: 'tag sky', ack: 'tag green', fail: 'tag red', timeout: 'tag gray' };
    box.innerHTML = state.cmds.slice(0, 12).map((c) => `
      <div class="ev-item" style="align-items:flex-start">
        <span class="ev-ico ico-s">${I('send', 13)}</span>
        <div style="min-width:0"><div style="font-size:12px;color:#111827;font-weight:500">${esc(c.device_id)} · ${esc(c.cmd)}
          <span class="${cls[c.status] || 'tag gray'}" style="margin-left:5px">${c.status}</span></div>
          <div style="font-size:10.5px;color:var(--dim)">${t2s(c.created_at)} ${c.ack_msg ? '· ' + esc(c.ack_msg) : ''}</div></div>
      </div>`).join('') || '<div class="empty-tip">暂无指令，可在设备表中下发</div>';
    const total = state.cmds.length;
    UI.setNum(Q('dv-cmd'), total, 0);
    UI.setNum(Q('dv-ack'), state.cmds.filter((c) => c.status === 'ack').length, 0);
    Q('dv-cmd-sub').textContent = total ? '最近 ' + Math.min(total, 12) + ' 条' : '下发指令后在此查看回执';
  }

  function renderSite() {
    const s = state.site;
    if (!s) return;
    Q('dv-site-xy').textContent = s.lon.toFixed(6) + '°E, ' + s.lat.toFixed(6) + '°N';
    Q('dv-site-rtk').textContent = (s.rtk_provider || '—') + (s.rtk_account ? ' · ' + s.rtk_account : '');
    Q('dv-site-note').textContent = s.note || '';
  }

  /* ---------- 数据轮询 ---------- */
  let lastPoll = 0;
  async function poll(force) {
    if (!force && Date.now() - lastPoll < 2500) return;
    lastPoll = Date.now();
    const dev = await UI.api('devices');
    if (!dev) { cloudOff(); return; }
    state.online = true;
    Q('dv-banner').classList.add('hidden');
    Q('dv-banner').style.display = 'none';
    state.list = dev;
    const cmds = await UI.api('commands?limit=30');
    if (cmds) state.cmds = cmds;
    const alarms = await UI.api('alarms?status=open&limit=100');
    if (alarms) state.alarmsOpen = alarms.length;
    const sites = await UI.api('sites');
    if (sites && sites.length) state.site = sites[0];
    renderList();
    renderCmds();
    renderSite();
    Q('dv-sub').textContent = '云端 SQLite · ' + state.list.length + ' 台 · ' + t2s(new Date());
  }

  /* ---------- 表单 ---------- */
  function openForm(d) {
    state.editId = d ? d.id : null;
    const card = Q('dv-form-card');
    card.classList.remove('hidden');
    Q('dv-form-title').textContent = d ? '编辑设备 ' + d.id : '新增设备（写入云端数据库）';
    Q('dv-form-ico').innerHTML = I(d ? 'pencil' : 'plus', 15);
    const set = (id, v) => { const el = gv(id); if (el) el.value = v == null ? '' : v; };
    set('f-id', d ? d.id : '');
    set('f-type', d ? d.type : 'drone');
    set('f-name', d ? d.name : '');
    set('f-sub', d ? d.sub : '');
    set('f-vendor', d ? d.vendor : '');
    set('f-model', d ? d.model : '');
    set('f-sn', d ? d.sn : '');
    set('f-protocol', d ? d.protocol : '');
    set('f-stream', d ? d.stream_url : '');
    set('f-lon', d ? d.lon : '');
    set('f-lat', d ? d.lat : '');
    set('f-alt', d ? d.alt : '');
    set('f-status', d ? d.status : 'online');
    set('f-note', d ? d.note : '');
    if (!d) gv('f-id').readOnly = false; else gv('f-id').readOnly = true;
    if (card.scrollIntoView) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  function closeForm() { Q('dv-form-card').classList.add('hidden'); state.editId = null; }

  function collect() {
    const v = (id) => gv(id).value.trim();
    const num = (id) => { const x = parseFloat(v(id)); return Number.isFinite(x) ? x : null; };
    return {
      name: v('f-name'), type: v('f-type'), sub: v('f-sub'), vendor: v('f-vendor'), model: v('f-model'),
      sn: v('f-sn'), protocol: v('f-protocol'), stream_url: v('f-stream'), note: v('f-note'),
      lon: num('f-lon'), lat: num('f-lat'), alt: num('f-alt'), status: v('f-status')
    };
  }

  async function save() {
    const b = collect();
    if (!b.name) { toast('保存失败', '请填写设备名称', 'warn'); return; }
    const body = JSON.stringify(b);
    let rs;
    if (state.editId) {
      rs = await UI.apiEx('devices/' + state.editId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
      if (rs.status === 200) toast('已更新', state.editId + ' 配置已写入云端数据库', 'ok');
    } else {
      rs = await UI.apiEx('devices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      if (rs.status === 200 && rs.data) toast('已新增', rs.data.id + ' 已写入云端数据库', 'ok');
    }
    if (rs.status !== 200) {
      const why = rs.status === 403 ? '当前账号无写权限（需管理员）' :
        (rs.status === -1 ? '无法连接云端后端' : ((rs.data && rs.data.error) || ('HTTP ' + rs.status)));
      toast('保存失败', why, 'err');
      return;
    }
    closeForm();
    poll(true);
  }

  async function sendCmd(id, cmd) {
    toast('云端指令下发', id + ' ← ' + cmd + '，等待网关回执…', 'drone');
    const r = await UI.apiEx('devices/' + id + '/command', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd, params: { src: 'web' } })
    });
    if (r.status === 200 && r.data) {
      toast('指令已入队', id + ' · ' + cmd + '（#CMD' + r.data.id + '），回执约 4s', 'ok');
      setTimeout(() => poll(true), 2500);
    } else {
      const why = r.status === 403 ? '当前账号无控制权限（需 admin/operator）' :
        (r.status === -1 ? '无法连接云端后端' : ((r.data && r.data.error) || ('HTTP ' + r.status)));
      toast('指令下发失败', id + '：' + why, 'err');
    }
  }

  /* ---------- 数据下载窗口（按月导出 CSV） ---------- */
  const DL_LABEL = { telemetry: '遥测', alarms: '告警', commands: '指令', samples: '采样' };
  function doDownload(kind) {
    const month = Q('dl-month') ? Q('dl-month').value : '';
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) { toast('请选择月份', '点击月份选择器选择要导出的月份', 'warn'); return; }
    if (!UI.auth.token()) { toast('下载失败', '登录状态已失效，请重新登录', 'err'); return; }
    toast('正在生成下载…', (DL_LABEL[kind] || kind) + ' ' + month + '（CSV），文件较大时请稍候', 'info');
    fetch('/api/export?month=' + month + '&kind=' + kind, {
      headers: { Authorization: 'Bearer ' + UI.auth.token() }
    }).then(async (r) => {
      if (!r.ok) {
        const d = await r.json().catch(() => null);
        toast('下载失败', (d && d.error) || ('HTTP ' + r.status), 'err');
        return null;
      }
      return r.blob();
    }).then((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      const url = URL.createObjectURL(blob);
      a.href = url;
      a.download = 'yqcloud-' + kind + '-' + month + '.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 6000);
      toast('下载已开始', 'yqcloud-' + kind + '-' + month + '.csv', 'ok');
    }).catch(() => { toast('下载失败', '网络异常，请重试', 'err'); });
  }
  async function doPurge() {
    if (!confirm('立即删除超过保留期（默认 30 天）的遥测/告警/指令/采样数据？此操作不可撤销。')) return;
    const r = await UI.apiEx('system/purge', { method: 'POST' });
    if (r.status === 200 && r.data) {
      const rm = r.data.removed || {};
      toast('清理完成', '已删除 遥测 ' + rm.telemetry + ' / 告警 ' + rm.alarms + ' / 指令 ' + rm.commands + ' / 采样 ' + rm.samples + '（保留 ' + r.data.keepDays + ' 天）', 'ok');
    } else {
      toast('清理失败', r.status === 403 ? '仅管理员可清理' : ((r.data && r.data.error) || 'HTTP ' + r.status), 'err');
    }
  }

  /* ---------- 生命周期 ---------- */
  function init() {
    const root = Q('page-devices');
    root.innerHTML = html;
    // 数据下载窗口：默认本月 + 按钮
    const dm = Q('dl-month');
    if (dm) {
      const nd = new Date();
      dm.value = nd.getFullYear() + '-' + String(nd.getMonth() + 1).padStart(2, '0');
    }
    $$('#page-devices [data-dl]').forEach((el) => { el.onclick = () => doDownload(el.dataset.dl); });
    const purgeBtn = Q('dv-purge');
    if (purgeBtn) {
      const isAdmin = !!(UI.auth.user && UI.auth.user.role === 'admin');
      purgeBtn.style.display = isAdmin ? '' : 'none';
      purgeBtn.onclick = doPurge;
    }
    // 事件
    Q('dv-add').onclick = () => openForm(null);
    Q('dv-form-cancel').onclick = closeForm;
    Q('dv-form-cancel2').onclick = closeForm;
    Q('dv-save').onclick = save;
    Q('dv-type').onchange = (e) => { state.type = e.target.value; renderList(); };
    Q('dv-q').oninput = (e) => { state.filter = e.target.value; renderList(); };
    Q('dv-refresh').onclick = () => poll(true);
    Q('dv-restore-tpl').onclick = () => {
      if (!confirm('恢复内置默认设备模板（无人机/摄像头/补食机/传感器等共 18 台，状态为未连接）？')) return;
      UI.apiEx('devices/restore-template', { method: 'POST' }).then((r) => {
        if (r.status === 200 && r.data) toast('模板已恢复', '共 ' + r.data.count + ' 台设备已重建（未连接状态，接入真实网关后点亮）', 'ok');
        else toast('恢复失败', r.status === 403 ? '仅管理员可恢复模板' : ((r.data && r.data.error) || 'HTTP ' + r.status), 'err');
        poll(true);
      });
    };
    Q('dv-tbody').addEventListener('click', (e) => {
      const ctl = e.target.closest('[data-ctl]');
      if (ctl) { sendCmd(ctl.dataset.ctl, ctl.dataset.cmd); return; }
      const ed = e.target.closest('[data-edit]');
      if (ed) { const d = state.list.find((x) => x.id === ed.dataset.edit); if (d) openForm(d); return; }
      const edN = e.target.closest('[data-edit-name]');
      if (edN) { const d = state.list.find((x) => x.id === edN.dataset.editName); if (d) openForm(d); return; }
      const del = e.target.closest('[data-del]');
      if (del) {
        const id = del.dataset.del;
        if (confirm('确认从云端数据库删除设备 ' + id + ' ？')) {
          del.disabled = true;
          UI.apiEx('devices/' + id, { method: 'DELETE' }).then((r) => {
            if (r.status === 200) {
              toast('已删除', id + ' 已从云端台账移除，监控页将不再显示该设备', 'ok');
            } else if (r.status === 403) {
              toast('删除失败：无权限', '当前账号（' + (UI.auth.user ? UI.auth.user.role : '?') + '）仅管理员可删除设备，请切换 admin 账号', 'err');
            } else if (r.status === -1) {
              toast('删除失败', '无法连接云端后端', 'err');
            } else {
              toast('删除失败', id + '：' + ((r.data && r.data.error) || ('HTTP ' + r.status)), 'err');
            }
            poll(true);
          });
        }
        return;
      }
    });
    poll(true);
  }

  function tick() { if (Q('dv-total')) poll(false); }

  global.PAGES = global.PAGES || {};
  global.PAGES.devices = {
    name: '设备与网关', init, tick,
    onShow() { poll(true); }
  };
})(window);
