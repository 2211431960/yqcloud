/* ============================================================
 * 应用主控：路由 / 全局心跳(1s) / 云端告警角标与Toast
 * 说明：无任何仿真引擎；角标与设备状态全部轮询真实 REST 接口。
 * ============================================================ */
(function (global) {
  'use strict';
  const UI = global.UI;
  const Q = UI.Q, $$ = UI.$$;

  let activeKey = 'overview';
  const inited = {};
  const raf = (fn) => (global.requestAnimationFrame || ((f) => setTimeout(f, 16)))(fn);

  /* 云端汇总状态（由 pollCloudMeta 维护，仅供顶栏/角标渲染） */
  const meta = { openAlarms: 0, lastAlarmId: 0, liveDev: 0, totalDev: 0 };

  /* ---------- 路由 ---------- */
  function go(key) {
    if (!global.PAGES[key]) return;
    if (!inited[key]) {
      try { global.PAGES[key].init(); } catch (e) { console.error('页面初始化失败：' + key, e); }
      inited[key] = true;
    }
    activeKey = key;
    UI.setPageTitle(key);
    $$('.page').forEach((el) => el.classList.remove('active'));
    const target = Q('page-' + key);
    if (target) target.classList.add('active');
    $$('.nav-item').forEach((el) => el.classList.toggle('active', el.dataset.page === key));
    // 页面激活钩子：进入页面时立即与云端台账/实况同步
    if (global.PAGES[key].onShow) {
      try { global.PAGES[key].onShow(); } catch (e) { console.error('onShow 失败', e); }
    }
    if (global.PAGES[key].tick) {
      try { global.PAGES[key].tick(); } catch (e) { console.error('页面刷新失败', e); }
    }
    raf(() => global.YQC && global.YQC.resizeAll());
  }

  /* ---------- 导航绑定 ---------- */
  function bindNav() {
    $$('.nav-item').forEach((el) => {
      el.onclick = () => {
        document.body.classList.remove('nav-open');
        go(el.dataset.page);
      };
    });
    const mb = Q('menu-btn');
    if (mb) mb.onclick = () => document.body.classList.toggle('nav-open');
  }

  /* ---------- 顶部铃铛：跳报警中心 ---------- */
  function bindBell() {
    Q('bell-btn').onclick = () => {
      if (meta.openAlarms > 0) {
        UI.toast('云端告警', '当前 ' + meta.openAlarms + ' 条未处理告警，点击下方列表逐条处置', 'warn');
      } else {
        UI.toast('暂无未处理告警', '真实设备告警上报后会实时出现在报警中心', 'info');
      }
      go('alarm');
    };
  }

  /* ---------- 云端汇总轮询（告警数/新告警提醒/设备在线） ---------- */
  let lastMetaPoll = 0;
  async function pollCloudMeta(force) {
    if (!force && Date.now() - lastMetaPoll < 6000) return;
    lastMetaPoll = Date.now();
    if (!UI.auth.token()) return;
    // 未处理告警（最近 200 条内）
    const alarms = await UI.api('alarms?status=open&limit=200');
    if (Array.isArray(alarms)) {
      const open = alarms.length;
      const maxId = alarms.reduce((m, a) => Math.max(m, a.id || 0), 0);
      // 新告警提醒（id 前进才提示，避免每次轮询重复）
      if (open > meta.openAlarms && meta.lastAlarmId > 0 && maxId > meta.lastAlarmId) {
        const news = alarms.filter((a) => (a.id || 0) > meta.lastAlarmId).slice(0, 3);
        news.forEach((a) => {
          const lvName = { crit: '严重告警', warn: '警告', info: '提示' }[a.lv] || '告警';
          UI.toast(lvName + '：' + (a.type || '设备告警'), (a.msg || '') + (a.device_id ? '（' + a.device_id + '）' : ''), lvName === '提示' ? 'info' : (lvName === '警告' ? 'warn' : 'err'));
        });
      }
      meta.openAlarms = open;
      meta.lastAlarmId = Math.max(meta.lastAlarmId, maxId);
      renderBadges();
    }
    // 设备在线概览（顶部/横幅用）
    const devs = await UI.api('devices');
    if (Array.isArray(devs)) {
      meta.totalDev = devs.length;
      meta.liveDev = devs.filter((d) => d.live).length;
      const devChip = Q('tp-dev');
      if (devChip) devChip.textContent = '设备 ' + meta.liveDev + '/' + meta.totalDev;
    }
  }
  function renderBadges() {
    const n = meta.openAlarms;
    const navBadge = Q('nav-alarm-badge');
    const bellBadge = Q('bell-badge');
    if (navBadge) { navBadge.textContent = n; navBadge.classList.toggle('hidden', n === 0); }
    if (bellBadge) { bellBadge.textContent = n; bellBadge.classList.toggle('hidden', n === 0); }
  }

  /* ---------- 全局心跳：只驱动活动页刷新（页面自带节流） ---------- */
  function heartbeat() {
    pollCloudMeta();
    const page = global.PAGES[activeKey];
    if (page && page.tick) {
      try { page.tick(); } catch (e) { console.error('页面刷新失败', e); }
    }
  }

  /* ---------- 加载骨架（未初始化页面显示，保证有加载态） ---------- */
  function skeletonHTML() {
    const kpiCard = '<div class="card" style="padding:16px;display:flex;flex-direction:column;gap:10px">' +
      '<div class="sk line" style="width:38%"></div><div class="sk big"></div><div class="sk line" style="width:70%"></div></div>';
    const panelCard = (span) => '<div class="card ' + span + '" style="padding:16px;display:flex;flex-direction:column;gap:12px">' +
      '<div class="sk card-h"></div><div class="sk chart"></div><div class="sk line" style="width:55%"></div></div>';
    return '<div class="skeleton-page">' +
      '<div class="sk-row">' + kpiCard.repeat(4) + '</div>' +
      '<div class="sk-panel">' + panelCard('span-8') + panelCard('span-4') + '</div>' +
      '<div class="sk-panel">' + panelCard('span-4') + panelCard('span-5') + panelCard('span-3') + '</div>' +
      '</div>';
  }

  /* ---------- 全局搜索（检索提示） ---------- */
  function bindSearch() {
    const input = Q('g-search');
    if (!input) return;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && input.value.trim()) {
        const kw = input.value.trim();
        UI.toast('全局搜索', '关键词「' + kw + '」：检索范围为批次号/设备ID/告警记录（见溯源中心与报警中心）', 'info');
        input.blur();
      }
      if (e.key === 'Escape') input.blur();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && document.activeElement !== input &&
        !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
        e.preventDefault();
        input.focus();
      }
    });
  }

  /* ---------- 全局接入状态条：未接入真实设备时醒目提示 ---------- */
  let bannerClosed = false;
  async function refreshCloudBanner() {
    const bn = Q('cloud-banner');
    if (!bn) return;
    if (bannerClosed || !UI.auth.token()) { bn.classList.add('hidden'); return; }
    // 复用最近一次 meta（6s 节流内不重复请求）
    if (Date.now() - lastMetaPoll < 5000) return applyBanner(bn);
    await pollCloudMeta(true);
    applyBanner(bn);
  }
  function applyBanner(bn) {
    const liveN = meta.liveDev, total = meta.totalDev;
    const txt = Q('cloud-banner-txt');
    const ico = Q('cloud-banner-ico');
    if (total === 0) {
      bn.classList.remove('hidden');
      bn.className = 'warn';
      bn.style.display = 'flex';
      if (ico) ico.innerHTML = I('alert-triangle', 14);
      txt.textContent = '设备台账为空：请在「设备与网关」登记您的设备（无人机/摄像头/补食机/传感器…），或由管理员恢复默认模板。';
    } else if (liveN === 0) {
      bn.classList.remove('hidden');
      bn.className = 'warn';
      bn.style.display = 'flex';
      if (ico) ico.innerHTML = I('alert-triangle', 14);
      txt.textContent = '尚未接入真实设备：当前全部 ' + total + ' 台设备显示“未连接”。接入步骤：①设备与网关页登记 ②运行网关上报心跳（POST /api/telemetry，docs/API.md）→ 自动点亮为“已连接”。';
    } else if (liveN < total) {
      bn.classList.remove('hidden');
      bn.className = 'part';
      bn.style.display = 'flex';
      if (ico) ico.innerHTML = I('info-circle', 14);
      txt.textContent = '已接入 ' + liveN + '/' + total + ' 台设备，其余 ' + (total - liveN) + ' 台未连接（未上报心跳）。';
    } else {
      bn.classList.add('hidden');
      bn.style.display = 'none';
    }
  }
  function bindBanner() {
    const cb = Q('cloud-banner-close');
    if (cb) cb.onclick = () => { bannerClosed = true; Q('cloud-banner').classList.add('hidden'); };
  }

  /* ---------- 启动动画期间的环境自检 ----------
   * 核心项失败（云端服务/数据库）→ 错误面板，仅可重试；
   * 外部依赖失败（天气/地区搜索/IP定位）→ 提示可“忽略并继续”，功能降级。 */
  const CHECKS = [
    { id: 'api', label: '云端服务' },
    { id: 'db', label: '数据库' },
    { id: 'weather', label: '天气服务' },
    { id: 'geo', label: '地区搜索' },
    { id: 'geoip', label: 'IP 定位' }
  ];
  function chkRender() {
    const box = Q('sp-checks');
    if (!box) return;
    box.innerHTML = CHECKS.map((c) =>
      `<span class="sp-chk run" data-chk="${c.id}"><span class="dot"></span>${c.label}</span>`).join('');
  }
  function chkSet(id, st) {
    const box = Q('sp-checks');
    if (!box) return;
    const el = box.querySelector('[data-chk="' + id + '"]');
    if (el) { el.classList.remove('run', 'ok', 'fail'); el.classList.add(st || 'ok'); }
  }
  function fetchHealth() {
    if (typeof fetch === 'undefined') return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 7000);
      Promise.resolve().then(() => fetch('/api/health', { cache: 'no-store' }))
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
        .then((v) => { clearTimeout(timer); resolve(v); });
    });
  }
  function showSplashError(opts) {
    UI.splashTip('环境自检发现问题');
    const p = Q('sp-error'), lst = Q('spe-list'), title = Q('spe-title');
    if (title) title.textContent = opts.critical ? '环境自检未通过 · 核心服务不可用' : '环境自检发现问题';
    if (p) p.classList.remove('hidden');
    const cont = Q('spe-continue');
    if (cont) cont.classList.toggle('hidden', !!opts.critical);
    const retry = Q('spe-retry');
    if (retry) retry.onclick = () => { try { location.reload(); } catch (e) { /* */ } };
    if (lst) {
      lst.innerHTML = '';
      (opts.items || []).forEach((it) => {
        const row = document.createElement('div');
        row.className = 'spe-item';
        const b = document.createElement('b');
        b.textContent = it.title;
        const s = document.createElement('span');
        s.textContent = it.detail || '';
        row.appendChild(b); row.appendChild(s);
        lst.appendChild(row);
      });
    }
  }
  function hideSplashError() {
    const p = Q('sp-error');
    if (p) p.classList.add('hidden');
  }

  /* ---------- 启动 ---------- */
  async function boot() {
    try {
      await bootInternal();
    } catch (e) {
      console.error('启动过程异常', e);
      try { UI.splashTip('启动异常'); } catch (e2) { /* */ }
      showSplashError({ critical: true, items: [{ title: '启动过程发生异常', detail: String((e && e.message) || e) }] });
    }
  }
  async function bootInternal() {
    window.__bootAt = Date.now();
    UI.splashTip('正在环境自检…');
    UI.bootChrome();
    UI.fillStaticIcons();
    UI.initAuthUI();
    bindBanner();
    chkRender();
    const health = await fetchHealth();
    chkSet('api', health ? 'ok' : 'fail');
    const depMeta = {
      weather: { title: '天气服务（Open-Meteo）', tip: '天气预报/预警引擎将不可用' },
      geo: { title: '地区搜索（Photon/OSM）', tip: '无法搜索切换城市' },
      geoip: { title: 'IP 定位（ip-api）', tip: 'IP 地区识别不可用' }
    };
    // 数据库
    if (health && health.db) chkSet('db', health.db.ok ? 'ok' : 'fail');
    else chkSet('db', 'fail');
    // 外部依赖
    const depFail = [];
    if (health && health.deps) {
      Object.keys(depMeta).forEach((k) => {
        const d = health.deps[k];
        if (!d) { chkSet(k, 'fail'); depFail.push(k); return; }
        chkSet(k, d.ok ? 'ok' : 'fail');
        if (!d.ok) depFail.push(k);
      });
    } else {
      Object.keys(depMeta).forEach((k) => { chkSet(k, 'fail'); depFail.push(k); });
    }
    const coreDown = !health || health.ok === false || !health.db || !health.db.ok;
    if (coreDown) {
      const items = [];
      if (!health) items.push({ title: '云端服务不可达', detail: '无法连接后端（node backend/server.js 未运行或网络异常），请启动后重试' });
      else if (!health.db || !health.db.ok) items.push({ title: '数据库异常', detail: (health.db && health.db.err) || 'SQLite 读写失败，请检查 data 目录权限' });
      showSplashError({ critical: true, items });
      return;
    }
    if (depFail.length) {
      const items = depFail.map((k) => {
        const d = health.deps[k];
        return { title: depMeta[k].title + ' 不可用', detail: (d && d.err ? '原因：' + d.err + '；' : '') + depMeta[k].tip + '（其余功能不受影响）' };
      });
      const cont = Q('spe-continue');
      if (cont) cont.onclick = () => { hideSplashError(); UI.splashTip('已忽略外部服务告警，继续启动…'); enterApp(true); };
      showSplashError({ critical: false, items });
      return;   // 等用户选择“忽略并继续”
    }
    UI.splashTip('环境自检通过 ✓');
    enterApp(false);
  }

  /* 自检通过/被忽略后：鉴权 → 骨架 → 绑定 → 进入主界面 */
  async function enterApp(depWarn) {
    // 登录门：有令牌则校验，无效/无令牌则锁定
    if (typeof fetch !== 'undefined' && UI.auth.token()) {
      UI.splashTip('正在验证登录状态…');
      const okA = await UI.auth.verify();
      if (okA) { UI.auth.hide(); UI.splashTip('验证通过，正在加载数据…'); pollCloudMeta(true); refreshCloudBanner(); }
      else { UI.auth.show('登录已过期，请重新登录'); UI.splashTip('请登录以继续'); }
    } else if (typeof fetch === 'undefined') {
      UI.splashTip('静态模式加载完成');
      UI.auth.hide();
    } else {
      UI.splashTip('请登录以继续');
      UI.auth.show();
    }
    // 未初始化页面先给加载骨架
    Object.keys(global.PAGES).forEach((key) => {
      if (key === 'overview') return;
      const sec = Q('page-' + key);
      if (sec && !sec.children.length) sec.innerHTML = skeletonHTML();
    });
    bindNav();
    bindBell();
    bindSearch();
    go('overview');
    setInterval(heartbeat, 1000);
    setInterval(refreshCloudBanner, 10000);
    setTimeout(refreshCloudBanner, 1300);
    // 窗口尺寸变化时重排图表
    let rzT;
    window.addEventListener('resize', () => {
      clearTimeout(rzT);
      rzT = setTimeout(() => global.YQC && global.YQC.resizeAll(), 200);
    });
    console.log('陇药步云已启动（纯云端数据模式，无仿真）');
    if (depWarn) {
      setTimeout(() => {
        if (UI.auth && UI.auth.user) UI.toast('部分外部服务不可用', '天气/城市搜索/IP 定位将降级，本地设备监控不受影响', 'warn');
      }, 2200);
    }
    // 启动动画收尾（拉长展示：约 3.2s + 600ms 淡出）
    setTimeout(() => UI.hideSplash(3200), 0);
  }

  global.APP = { go, boot };
  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', boot)
    : boot();
})(window);
