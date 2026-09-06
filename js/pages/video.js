/* ============================================================
 * 视频监控（纯云端真实数据版）
 * - 通道 = GET /api/devices?type=camera（每台设备动态生成一个通道，无固定假通道）
 * - 连接状态 = 后端 live（最近 90s 有遥测上报），画面一律由真实流承载
 * - 画面规则：live 且配置 stream_url → window.StreamBox 真实播放（HLS/HTTP-FLV/MP4，
 *   RTSP/RTMP 提示转流，见 docs/STREAMING.md）；其余情况只绘制静态灰底占位，
 *   不随时间变化、不产生数据感
 * - 云台/抓拍/录像/喊话 → POST /api/devices/:id/command（gimbal_home|gimbal_*|shot|record|speaker）
 *   + UI.watchCmd 跟踪网关回执
 * - 右侧原“识别卡片”区域已改为“最新设备告警”：GET /api/alarms（真实告警流）
 * 数据契约：docs/API.md（页面只消费真实接口）
 * ============================================================ */
(function (global) {
  'use strict';
  const UIx = global.UI;
  const Q = UIx.Q, $ = UIx.$, $$ = UIx.$$, esc = UIx.esc, toast = UIx.toast, pad = UIx.pad;
  const YQC = global.YQC || {};

  /* 页面状态：仅云端台账数据 */
  const state = {
    cams: [],        // GET /api/devices?type=camera 返回行（原样保存）
    sig: '',         // 台账指纹（名称/流地址/live/状态 变化时重建通道）
    main: 0,         // 主画面索引
    alarms: [],      // GET /api/alarms?limit=20
    aSig: '',
    ready: false,    // 首次加载完成
    online: false,   // 后端可达
    lastPoll: 0      // tick 轮询节流时间戳
  };
  const POLL_MS = 5000;
  const LV_ZH = { crit: '严重', warn: '警告', info: '提示' };
  const CMD_ZH = { gimbal_home: '云台归中', gimbal_up: '云台上仰', gimbal_down: '云台下俯', gimbal_left: '云台左转', gimbal_right: '云台右转', shot: '抓拍', record: '录像', speaker: '喊话' };

  /* ---------- 展示辅助 ---------- */
  const capName = (d) => esc(d.name || d.id) + (d.sub ? ' · ' + esc(d.sub) : '');
  const devMeta = (d) => {
    const m = [d.vendor, d.model].filter(Boolean).join(' ');
    return (m ? esc(m) : esc(d.protocol || d.id || ''));
  };
  const ts2 = (t) => {
    const d = t ? new Date(t) : null;
    return d && !isNaN(d) ? pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) : '—';
  };
  const lvCls = (lv) => (YQC.lvTag ? YQC.lvTag(lv) : 'tag gray');
  const lvBox = (lv) => (YQC.lvIcoBox ? YQC.lvIcoBox(lv) : 'ico-s');
  const aIco = (a) => (a.ico && global.I && global.I.has(a.ico) ? a.ico : 'alert-triangle');
  const camSigOf = (list) => list.map((d) => [d.id, d.name || '', d.sub || '', d.stream_url || '', d.live ? 1 : 0, d.status || ''].join('|')).join('#');

  /* ============================================================
   * 静态占位画面（纯静态：灰底 + 网格 + 文字；不随时间变化）
   * ============================================================ */
  const CW = 640, CH = 360;
  function paintStatic(cv, p) {
    if (!cv || !cv.getContext) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, CW, CH);
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, CW, CH);
    // 静态网格纹理（非动画）
    ctx.strokeStyle = 'rgba(255,255,255,.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= CW; x += 40) { ctx.moveTo(x, 0); ctx.lineTo(x, CH); }
    for (let y = 0; y <= CH; y += 40) { ctx.moveTo(0, y); ctx.lineTo(CW, y); }
    ctx.stroke();
    // 静态取景边框
    ctx.strokeStyle = 'rgba(99,102,241,.3)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(14, 14, CW - 28, CH - 28);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (p.title) {
      ctx.fillStyle = '#b9c6dc';
      ctx.font = 'bold 21px "Microsoft YaHei",sans-serif';
      ctx.fillText(p.title, CW / 2, CH / 2 - 26);
    }
    let yy = CH / 2 + 6;
    (p.body || []).forEach((line) => {
      ctx.fillStyle = '#7e90ad';
      ctx.font = '12.5px "Microsoft YaHei",sans-serif';
      ctx.fillText(line, CW / 2, yy);
      yy += 20;
    });
    if (p.guide) {
      ctx.fillStyle = '#5b6c8c';
      ctx.font = '11.5px "Microsoft YaHei",sans-serif';
      ctx.fillText(p.guide, CW / 2, CH - 40);
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  /* 每类画面的静态文案（诚实：不播放=不画画面） */
  const capNameRaw = (d) => (d.name || d.id) + (d.sub ? ' · ' + d.sub : '');

  /* ============================================================
   * 布局（整体重建；通道数量 = 台账 camera 设备数量）
   * ============================================================ */
  function layoutLoading() {
    return '<div class="content-scroll"><div class="grid"><div class="card span-12"><div class="empty-tip">正在读取云端摄像头台账（GET /api/devices?type=camera）…</div></div></div></div>';
  }
  function layoutOffline() {
    return '<div class="content-scroll"><div class="grid"><div class="card span-12"><div class="empty-tip">' +
      '<b>无法连接云端后端</b><br>请确认已运行 <code>node backend/server.js</code> 并已登录（token 过期请重新登录）。</div></div></div></div>';
  }
  function layoutEmpty() {
    return `<div class="content-scroll"><div class="grid">
      <div class="card span-8">
        <div class="card-h"><span class="h-ico">${I('device-cctv', 15)}</span>视频监控<span class="card-title-note">云端真实画面 · 台账驱动</span></div>
        <div class="h-divider"></div>
        <div class="card-b" style="padding:18px 16px">
          <div style="text-align:center;padding:6px 0 2px">
            <div style="width:52px;height:52px;border-radius:14px;background:#eef2ff;display:inline-flex;align-items:center;justify-content:center;color:#6366f1;margin-bottom:10px">${I('device-cctv', 30)}</div>
            <div style="font-size:14.5px;font-weight:600;color:#111827;line-height:1.8">
              暂无摄像头设备：请先在「设备与网关」登记并配置流地址（docs/API.md）</div>
            <div style="color:#6b7280;font-size:12px;line-height:1.9;margin-top:8px">登记后本页将按云端台账自动生成通道，不再显示任何固定占位通道。</div>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px;margin-top:18px;font-size:12px;line-height:1.8;color:#374151">
            <div style="background:#f9fafb;border:1px solid #f3f4f6;border-radius:10px;padding:10px 12px">
              <b style="color:#4f46e5">① 登记摄像头</b><br>「设备与网关」→ 添加设备（type=camera，填名称/型号/SN/协议）</div>
            <div style="background:#f9fafb;border:1px solid #f3f4f6;border-radius:10px;padding:10px 12px">
              <b style="color:#059669">② 上报心跳</b><br>摄像头网关定时 <code>POST /api/telemetry</code>，最近 90s 内上报 → 显示“已连接”</div>
            <div style="background:#f9fafb;border:1px solid #f3f4f6;border-radius:10px;padding:10px 12px">
              <b style="color:#d97706">③ 配置画面</b><br>设备填可直连播放的 <code>stream_url</code>（HLS/HTTP-FLV/MP4；RTSP/RTMP 需转流，见 docs/STREAMING.md）</div>
          </div>
          <div style="font-size:11px;color:#9ca3af;margin-top:14px;text-align:center">画面与指令全部走真实接口：devices?type=camera · devices/:id/command · alarms</div>
        </div>
      </div>
      <div class="span-4" style="display:flex;flex-direction:column;gap:12px">
        ${alarmCardHtml()}
        <div class="card">
          <div class="card-h"><span class="h-ico">${I('camera', 15)}</span>通道生成规则</div>
          <div class="h-divider"></div>
          <div class="card-b" style="padding-top:8px;font-size:11.5px;line-height:1.9;color:var(--muted)">
            每台 <code>type=camera</code> 的设备生成一个通道卡片；设备被删除后通道随之消失。<br><br>
            控制按钮（云台/抓拍/录像/喊话）仅在设备“已连接（live）”时可用，指令写入 commands 表由网关执行并回执。
          </div>
        </div>
      </div>
    </div></div>`;
  }
  function layoutCams(cams) {
    const m = cams[state.main] || cams[0];
    const liveN = cams.filter((d) => d.live).length;
    const thumbs = cams.map((d, i) => `
      <div class="card span-3">
        <div class="card-b" style="padding:8px">
          <div class="feed-box ${i === state.main ? 'chosen' : ''}" style="aspect-ratio:16/9;cursor:pointer" data-feed-i="${i}">
            <canvas id="vd-cv-${i}" width="640" height="360"></canvas>
            <div class="feed-badge">${d.live ? '已连接' : '未连接'}</div>
            <div class="feed-time" id="vd-time-${i}">--:--:--</div>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;margin-top:6px;font-size:11.5px">
            <span style="color:#111827;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${capName(d)}">${capName(d)}</span>
            <span class="tag ${d.live ? 'green' : 'red'}" style="flex:none">${d.live ? '已连接' : '未连接'}</span>
          </div>
          <div style="font-size:10.5px;color:#9ca3af;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.id)} · ${devMeta(d)}</div>
        </div>
      </div>`).join('');
    return `<div class="content-scroll"><div class="grid">
      <div class="span-9" style="display:flex;flex-direction:column;gap:12px">
        <div class="card">
          <div class="card-h"><span class="h-ico">${I('device-cctv', 15)}</span><span id="vd-main-name">${m ? capName(m) : ''}</span>
            <span class="card-title-note" id="vd-main-tip">实况转播 · 已连接 ${liveN}/${cams.length} 路</span>
            <span class="more" id="vd-refresh">${I('refresh', 13)} 刷新</span>
          </div>
          <div class="h-divider"></div>
          <div class="card-b">
            <div class="feed-box chosen" style="aspect-ratio:16/9" data-feed="main">
              <canvas id="vd-main-cv" width="640" height="360"></canvas>
              <div class="feed-badge">${m && m.live ? '已连接' : '未连接'}</div>
              <div class="feed-time" id="vd-main-time">--:--:--</div>
              <div class="feed-name" id="vd-main-nm">${m ? esc(m.id) + ' · ' + capName(m) : ''}</div>
              <div class="feed-stats" style="display:none"></div>
            </div>
          </div>
        </div>
        <div class="grid">${thumbs}</div>
      </div>
      <div class="span-3" style="display:flex;flex-direction:column;gap:12px">
        <div class="card" id="vd-ctrl">
          <div class="card-h"><span class="h-ico">${I('focus-2', 15)}</span>云台与操作<span class="card-title-note" id="vd-ctrl-tip"></span></div>
          <div class="h-divider"></div>
          <div class="card-b">
            <div class="ptz-pad" style="grid-template-columns:repeat(3,1fr)">
              <span></span><button data-ptz="up" title="上仰">${I('arrow-up', 13)}</button><span></span>
              <button data-ptz="left" title="左转">${I('arrow-left', 13)}</button><button data-ptz="home" title="云台归中">${I('focus-2', 13)}</button><button data-ptz="right" title="右转">${I('arrow-right', 13)}</button>
              <span></span><button data-ptz="down" title="下俯">${I('arrow-down', 13)}</button><span></span>
            </div>
            <div style="display:flex;gap:8px;margin-top:12px">
              <button class="btn" style="flex:1" data-vd="shot" title="下发抓拍指令">${I('photo', 14)} 抓拍</button>
              <button class="btn danger" style="flex:1" data-vd="rec" title="下发录像指令">${I('disc', 14)} 录像</button>
              <button class="btn" style="flex:1" data-vd="talk" title="下发喊话指令">${I('volume', 14)} 喊话</button>
            </div>
            <div style="font-size:10.5px;color:var(--dim);margin-top:10px;line-height:1.7">
              指令经 <code>POST /api/devices/:id/command</code> 下发至云端，由摄像头网关执行并通过 /ack 回执（见 docs/API.md）。</div>
          </div>
        </div>
        ${alarmCardHtml()}
        <div class="card">
          <div class="card-h"><span class="h-ico">${I('camera', 15)}</span>画面通道<span class="more" id="vd-refresh2">刷新</span></div>
          <div class="h-divider"></div>
          <div class="card-b" style="padding-top:4px" id="vd-list">
            ${cams.map((d, i) => `
            <div class="alert-line" data-cam-i="${i}" style="cursor:pointer;padding:7px 4px">
              <span class="dot ${d.live ? 'green' : 'red'}" style="margin-top:5px;flex:none"></span>
              <div class="al-body"><div class="al-title" style="font-size:12px">${capName(d)}</div>
                <div class="al-desc">${esc(d.id)} · ${d.live ? '已连接' : '未连接 · 待接入'}${d.live && !d.stream_url ? ' · 未配置流地址' : ''}</div></div>
              <span class="al-time">${i === state.main ? '主画面' : 'CH' + String(i + 1).padStart(2, '0')}</span>
            </div>`).join('')}
          </div>
        </div>
      </div>
    </div></div>`;
  }
  function alarmCardHtml() {
    return `<div class="card">
      <div class="card-h"><span class="h-ico">${I('bell-ringing', 15)}</span>最新设备告警<span class="card-title-note" id="vd-alarm-note">GET /api/alarms</span></div>
      <div class="h-divider"></div>
      <div class="card-b" style="padding-top:6px"><div class="event-stream" style="max-height:300px" id="vd-alarms"></div></div>
    </div>`;
  }

  /* ---------- 渲染 ---------- */
  function teardownBoxes() {
    // 重建前先停掉旧的真实流（释放 hls/flv 播放器），避免重建后残留
    const root = Q('page-video');
    if (!root || !window.StreamBox) return;
    $$('.feed-box', root).forEach((b) => { try { window.StreamBox.stop(b); } catch (e) { /* 忽略 */ } });
  }
  function renderAll() {
    const root = Q('page-video');
    if (!root) return;
    state.ready = true;
    if (!state.online) { root.innerHTML = layoutOffline(); return; }
    teardownBoxes();
    root.innerHTML = state.cams.length ? layoutCams(state.cams) : layoutEmpty();
    refreshAllBoxes();
    fillAlarms(state.alarms);
    updateCtrl();
  }
  function refreshAllBoxes() {
    const root = Q('page-video');
    if (!root) return;
    $$('.feed-box', root).forEach((box) => refreshBox(box));
  }
  /* 单通道刷新：先画静态占位（如需），再尝试真实播放 */
  function refreshBox(box) {
    const cv = box.querySelector('canvas');
    const i = box.dataset.feed === 'main' ? state.main : parseInt(box.dataset.feedI, 10);
    const d = state.cams[i];
    if (!d) { if (cv) paintStatic(cv, { title: '通道已失效', body: [], guide: '台账刷新中…' }); return; }
    const live = !!d.live;
    const url = d.stream_url || '';
    const bd = box.querySelector('.feed-badge');
    const tEl = box.querySelector('.feed-time');
    const stEl = box.querySelector('.feed-stats');
    const nmEl = box.querySelector('.feed-name');
    const setBadge = (t, bg) => { if (bd) { bd.innerHTML = t; if (bg) bd.style.background = bg; } };
    const setTime = (t) => { if (tEl) tEl.textContent = t; };
    const setStats = (show, t) => { if (stEl) { if (show) { stEl.style.display = 'flex'; stEl.textContent = t || ''; } else stEl.style.display = 'none'; } };
    if (nmEl && box.dataset.feed === 'main') nmEl.textContent = esc(d.id) + ' · ' + capNameRaw(d);

    setStats(false);
    if (!live) {
      if (cv) paintStatic(cv, { title: '设备未连接', body: [capNameRaw(d), '未上报心跳（POST /api/telemetry）'], guide: '接入网关上报心跳并配置 stream_url 后显示实况' });
      setBadge('未连接');
      setTime('待接入');
      return;
    }
    if (!url || !/^https?:\/\//i.test(url)) {
      if (cv) paintStatic(cv, { title: '无视频流', body: [capNameRaw(d), '已连接 · 未配置可播放流地址'], guide: '请在「设备与网关」填写 stream_url（HLS/HTTP-FLV/MP4）' });
      setBadge('无视频流');
      setTime('--:--:--');
      return;
    }
    // live 且有 HTTP 流地址 → 真实播放尝试
    if (cv) paintStatic(cv, { title: '连接实况中…', body: [capNameRaw(d)], guide: '播放器正在加载 ' + url.replace(/^https?:\/\//, '') });
    if (!window.StreamBox) {
      if (cv) paintStatic(cv, { title: '播放器组件未加载', body: [capNameRaw(d)], guide: '页面脚本未完整加载（js/stream.js），请刷新重试' });
      setBadge('播放器未加载');
      return;
    }
    let st = 'na';
    try {
      st = window.StreamBox.play(box, url, { muted: true, controls: box.dataset.feed === 'main' });
    } catch (e) { st = 'error'; }
    if (st === 'playing') {
      setTime(UIx.nowText().time);
      setStats(true, '实况播放中');
      ensureWatch(); // 有真实 <video> 播放时才维持 rAF（无真实流时自动停）
      return; // 真实 <video> 已覆盖画布（StreamBox 已替换徽标 LIVE·HLS/FLV）
    }
    if (st === 'relay') {
      if (cv) paintStatic(cv, { title: 'RTSP/RTMP 待转流', body: [capNameRaw(d), '浏览器无法直连 ' + String(url.split(':')[0]).toUpperCase() + ' 源'], guide: '请用 mediamtx/ZLMediaKit 转 HLS/HTTP-FLV 后填入 stream_url（docs/STREAMING.md）' });
      setTime('待转流');
      return;
    }
    // 播放失败 / 不可播
    if (cv) paintStatic(cv, { title: '视频流播放失败', body: [capNameRaw(d), '无法播放：' + url], guide: 'stream_url 需为浏览器可直连的 HTTP 流（RTSP/RTMP 请先转流）' });
    setBadge('播放失败');
    setTime('失败');
  }

  /* ---------- 右侧：主通道操作卡（live 才可点） ---------- */
  function updateCtrl() {
    const root = Q('page-video');
    if (!root) return;
    const ctrl = Q('vd-ctrl');
    if (!ctrl) return;
    const d = state.cams[state.main];
    const tip = Q('vd-ctrl-tip');
    if (tip) tip.textContent = d ? (d.live ? '目标：' + capNameRaw(d) + '（已连接）' : '目标：' + capNameRaw(d) + '（未连接）') : '无可用通道';
    const en = !!(d && d.live);
    $$('[data-ptz]', ctrl).forEach((b) => { b.disabled = !en; });
    $$('[data-vd]', ctrl).forEach((b) => { b.disabled = !en; });
  }
  function setMain(i) {
    if (!state.cams[i] || i === state.main) return;
    state.main = i;
    const root = Q('page-video');
    if (!root) return;
    const d = state.cams[i];
    const nm = Q('vd-main-name'); if (nm) nm.textContent = capName(d);
    const nm2 = Q('vd-main-nm'); if (nm2) nm2.textContent = esc(d.id) + ' · ' + capName(d);
    const tip = Q('vd-main-tip');
    if (tip) tip.textContent = '实况转播 · 已连接 ' + state.cams.filter((x) => x.live).length + '/' + state.cams.length + ' 路';
    $$('.feed-box', root).forEach((b) => {
      const idx = b.dataset.feed === 'main' ? state.main : parseInt(b.dataset.feedI, 10);
      b.classList.toggle('chosen', idx === state.main);
    });
    const mainBox = $('.feed-box[data-feed="main"]', root);
    if (mainBox) refreshBox(mainBox);
    updateCtrl();
    toast('已切换通道', capNameRaw(d) + '（' + d.id + '）已切换至主画面', 'ok');
  }

  /* ---------- 数据轮询（全部真实接口） ---------- */
  async function pollCams(force) {
    if (!UIx.api) return;
    const nowT = Date.now();
    if (!force && nowT - state.lastPoll < POLL_MS) return;
    state.lastPoll = nowT;
    const list = await UIx.api('devices?type=camera');
    if (!list) {
      // 后端不可达：保留当前界面；首屏则给出明确提示
      state.online = false;
      if (!state.ready) { const root = Q('page-video'); if (root) root.innerHTML = layoutOffline(); }
      return;
    }
    const wasOnline = state.online;
    state.online = true;
    const sig = camSigOf(list);
    if (sig !== state.sig || !state.ready || !wasOnline) {
      state.sig = sig;
      state.cams = list;
      if (state.main >= list.length) state.main = 0;
      renderAll();
    }
  }
  async function pollAlarms() {
    if (!UIx.api || !Q('vd-alarms')) return;
    const rows = await UIx.api('alarms?limit=20');
    if (!rows) return;
    const sig = rows.map((a) => a.id + ':' + a.status + ':' + a.created_at + ':' + (a.lv || '')).join('#');
    if (sig !== state.aSig) {
      state.aSig = sig;
      state.alarms = rows;
      fillAlarms(rows);
    }
  }
  function fillAlarms(rows) {
    const box = Q('vd-alarms');
    if (!box) return;
    box.innerHTML = (!rows || !rows.length)
      ? '<div class="empty-tip">设备告警实时同步：真实告警由网关 POST /api/alarms 上报</div>'
      : rows.map((a) => `
        <div class="ev-item" style="align-items:flex-start">
          <span class="ev-ico ${lvBox(a.lv)}">${I(aIco(a), 14)}</span>
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:6px;min-width:0">
              <b style="font-size:12px;color:#111827;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.type || '设备告警')}</b>
              <span class="${lvCls(a.lv)}" style="flex:none">${esc(LV_ZH[a.lv] || a.lv)}</span>
              <span class="al-time" style="flex:none;padding-top:0">${ts2(a.created_at)}</span>
            </div>
            <div class="al-desc" style="white-space:normal;margin-top:2px">${esc(a.msg)}</div>
            <div style="font-size:10.5px;color:var(--dim)">设备 ${esc(a.device_id || '—')} · ${a.status === 'open' ? '待处理' : esc(a.status)}</div>
          </div>
        </div>`).join('');
    const note = Q('vd-alarm-note');
    if (note) note.textContent = rows && rows.length ? 'GET /api/alarms · ' + rows.length + ' 条' : 'GET /api/alarms';
  }
  async function refreshAll() {
    state.lastPoll = 0;
    await pollCams(true);
    pollAlarms();
  }

  /* ---------- 事件（委托一次） ---------- */
  function sendCamCmd(cmd, params) {
    const d = state.cams[state.main];
    if (!d) { toast('无可控通道', '请先在「设备与网关」登记摄像头', 'warn'); return; }
    if (!d.live) { toast('设备未连接', d.id + ' 未上报心跳，指令已拦截（控制按钮未启用时不可下发）', 'warn'); return; }
    UIx.api('devices/' + d.id + '/command', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd, params: Object.assign({ from: 'video-panel' }, params || {}) })
    }).then((r) => {
      if (r && r.id) {
        toast('云端指令已入队', d.id + ' · ' + (CMD_ZH[cmd] || cmd) + '（#CMD' + r.id + '）等待网关执行并回执', 'ok');
        if (UIx.watchCmd) UIx.watchCmd(d.id, r.id, CMD_ZH[cmd] || cmd);
      } else {
        toast('指令下发失败', d.id + '：云端未返回指令（请确认已登录且有控制权限）', 'err');
      }
    });
  }
  function onClick(e) {
    const vd = e.target.closest('[data-vd]');
    if (vd) { sendCamCmd({ shot: 'shot', rec: 'record', talk: 'speaker' }[vd.dataset.vd] || 'shot', {}); return; }
    const pz = e.target.closest('[data-ptz]');
    if (pz) {
      const dir = pz.dataset.ptz;
      sendCamCmd(dir === 'home' ? 'gimbal_home' : 'gimbal_' + dir, dir === 'home' ? {} : { dir });
      return;
    }
    const fi = e.target.closest('[data-feed-i]');
    if (fi) { const i = parseInt(fi.dataset.feedI, 10); if (state.cams[i]) setMain(i); return; }
    const ci = e.target.closest('[data-cam-i]');
    if (ci) { const i = parseInt(ci.dataset.camI, 10); if (state.cams[i]) setMain(i); return; }
    if (e.target.closest('#vd-refresh') || e.target.closest('#vd-refresh2')) { refreshAll(); return; }
  }

  /* ============================================================
   * 生命周期
   * ============================================================ */
  /* 真实视频播放观察循环：仅当页面激活且确有 video.real-vid 在播时维持；
   * 无真实流 / 页面未激活 → 立即停止，不做任何画面绘制 */
  let watchOn = false, watchLast = 0;
  function ensureWatch() {
    if (watchOn || !global.requestAnimationFrame) return;
    watchOn = true;
    global.requestAnimationFrame(watchFrame);
  }
  function watchFrame(ts) {
    const page = Q('page-video');
    const any = page && page.classList.contains('active') && page.querySelector('.feed-box video.real-vid');
    if (!any) { watchOn = false; return; } // 无真实视频 → 不再请求下一帧
    if (ts - watchLast >= 1000) {
      watchLast = ts;
      page.querySelectorAll('.feed-box').forEach((box) => {
        const v = box.querySelector('video.real-vid');
        const tEl = box.querySelector('.feed-time');
        if (v && tEl && !v.paused) tEl.textContent = UIx.nowText().time;
      });
    }
    global.requestAnimationFrame(watchFrame);
  }

  function init() {
    const root = Q('page-video');
    if (!root) return;
    if (!root.__vdBound) { root.__vdBound = 1; root.addEventListener('click', onClick); }
    teardownBoxes(); // 重建前释放旧的真实流
    state.sig = ''; state.aSig = ''; state.cams = []; state.alarms = []; state.ready = false; state.online = false;
    state.main = 0; state.lastPoll = 0;
    watchOn = false;
    root.innerHTML = layoutLoading();
    refreshAll();
  }
  /* tick：每秒被 app 调用，内部节流 ≥5s 才轮询；未激活页面直接返回 */
  function tick() {
    const page = Q('page-video');
    if (!page || !page.classList.contains('active')) return;
    // 真实播放中的通道更新时间角标（仅时间文本，无任何画面绘制）
    page.querySelectorAll('.feed-box').forEach((box) => {
      const v = box.querySelector('video.real-vid');
      const tEl = box.querySelector('.feed-time');
      if (v && tEl && !v.paused) tEl.textContent = UIx.nowText().time;
    });
    if (Date.now() - state.lastPoll >= POLL_MS) refreshAll();
  }
  function onShow() {
    // 进入页面立即全量刷新（台账增删/连接状态即时生效）
    refreshAll();
  }

  global.PAGES = global.PAGES || {};
  global.PAGES.video = { name: '视频监控', init, tick, onShow };
})(window);
