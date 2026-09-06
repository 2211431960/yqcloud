/* ============================================================
 * 基础 UI 组件：时钟 / Toast / 角标 / DOM 快捷方法
 * ============================================================ */
(function (global) {
  'use strict';
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const Q = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const pad = (n) => String(n).padStart(2, '0');
  function nowText(d) {
    d = d || new Date();
    return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${'星期' + '日一二三四五六'[d.getDay()]}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` };
  }

  /* ---------- Toast 通知 ---------- */
  function toast(title, msg, kind) {
    kind = kind || 'info';
    const meta = { info: ['info-circle', '提示'], ok: ['circle-check', '成功'], warn: ['alert-triangle', '注意'], err: ['alert-octagon', '异常'], drone: ['drone', '无人机'] };
    const m = meta[kind] || meta.info;
    const box = document.createElement('div');
    box.className = 'toast ' + kind;
    box.innerHTML = `<span class="t-ico">${I(m[0], 17)}</span><div><div class="t-title">${esc(m[1])} · ${esc(title)}</div><div class="t-msg">${esc(msg)}</div></div>`;
    Q('toast-root').appendChild(box);
    setTimeout(() => { box.classList.add('out'); setTimeout(() => box.remove(), 320); }, 4200);
  }

  /* ---------- 数值卡更新（带闪动） ---------- */
  function setNum(el, val, decimals) {
    if (!el) return;
    const fmt = (decimals === undefined || decimals === 0)
      ? Math.round(val).toLocaleString('zh-CN')
      : Number(val).toFixed(decimals);
    if (el.dataset.v !== fmt) {
      el.dataset.v = fmt;
      el.textContent = fmt;
      el.classList.remove('flash-up');
      void el.offsetWidth;
      el.classList.add('flash-up');
    }
  }

  /* ---------- 全局：时钟 / 天气（真实 API，后端代理） / 延迟 ---------- */
  /* WMO 天气码 → 中文 + 图标 */
  function wmo(code) {
    const c = Number(code);
    if (c === 0) return { text: '晴', icon: 'sun' };
    if (c === 1) return { text: '晴间多云', icon: 'sun' };
    if (c === 2) return { text: '少云', icon: 'cloud' };
    if (c === 3) return { text: '多云', icon: 'cloud' };
    if (c === 45 || c === 48) return { text: '雾', icon: 'wind' };
    if (c <= 57) return { text: '毛毛雨', icon: 'cloud-rain' };
    if (c <= 67) return { text: '雨', icon: 'cloud-rain' };
    if (c <= 77) return { text: '雪', icon: 'droplet' };
    if (c === 80 || c === 81 || c === 82) return { text: '阵雨', icon: 'cloud-rain' };
    if (c === 85 || c === 86) return { text: '阵雪', icon: 'droplet' };
    if (c >= 95) return { text: '雷暴', icon: 'bolt' };
    return { text: '多云', icon: 'cloud' };
  }
  /* 顶栏真实天气（后端代理 Open-Meteo；未登录/离线时占位）——可被页面主动刷新 */
  function refreshWeatherChip() {
    if (!UI.api) return;
    UI.api('weather').then((w) => {
      if (w && w.ok !== false && w.current && Number.isFinite(w.current.temp)) {
        const m = wmo(w.current.code);
        const wi = Q('weather-ico'); if (wi) wi.innerHTML = I(m.icon, 13);
        const wt = Q('weather-text'); if (wt) wt.textContent = Math.round(w.current.temp) + '℃ ' + m.text;
        const wtip = Q('weather-text'); if (wtip && w.location) wtip.title = (w.location.name || w.location.address || '') + ' · 天气按基地坐标计算';
      } else {
        const wi = Q('weather-ico'); if (wi) wi.innerHTML = I('cloud', 13);
        const wt = Q('weather-text'); if (wt) wt.textContent = '天气服务…';
      }
    });
  }
  function bootChrome() {
    const t1 = setInterval(() => {
      const t = nowText();
      const dc = Q('clock-date');
      if (dc) dc.textContent = t.date;
      Q('clock-time').textContent = t.time;
    }, 1000);
    // 云端在线状态（真实 RTT 探测，不模拟延迟）
    const t2 = setInterval(() => {
      const el = Q('cloud-latency');
      if (!el || !UI.api) return;
      const t0 = Date.now();
      UI.api('auth/me').then((me) => {
        el.textContent = me ? '云端在线 · 延迟 ' + (Date.now() - t0) + 'ms' : '云端离线';
      }).catch(() => { el.textContent = '云端离线'; });
    }, 15000);
    Q('clock-time').textContent = nowText().time;
    refreshWeatherChip();
    setInterval(refreshWeatherChip, 600000); // 10 分钟
    window.__bootT1 = t1; window.__bootT2 = t2;
  }

  /* ---------- 静态区域图标注入（导航/顶栏） ---------- */
  const NAV_ICONS = {
    overview: 'layout-dashboard', video: 'video', drone: 'drone', feed: 'package', weather: 'cloud',
    health: 'heartbeat', trace: 'qrcode', alarm: 'alert-triangle', devices: 'antenna'
  };
  function fillStaticIcons() {
    $$('.nav-item').forEach((el) => {
      const ico = el.querySelector('.ni-ico');
      const name = NAV_ICONS[el.dataset.page];
      if (ico && name) ico.innerHTML = I(name, 17);
    });
    const sico = Q('s-ico'); if (sico) sico.innerHTML = I('search', 13);
    const bico = Q('bell-ico'); if (bico) bico.innerHTML = I('bell', 15);
    const mbtn = Q('menu-btn'); if (mbtn) mbtn.innerHTML = I('menu-2', 18);
  }

  /* ---------- 页面切换（由 app.js 调用） ---------- */
  const CHROME_TITLE = {
    overview: ['总览监控面板', '基地运行态势 · 数据实时同步'],
    video: ['视频监控', '真实通道 · 云台联动 · 实时告警'],
    drone: ['无人机检测面板', '低空巡检 · 目标识别 · 威胁处置'],
    feed: ['智能补食面板', '料位监测 · 定时定量 · 智能策略'],
    health: ['鸡群健康分析', '健康指数 · 体重监测 · 防疫管理'],
    trace: ['云端溯源中心', '批次全生命周期 · 一鸡一码可追溯'],
    weather: ['天气检测系统', '天气预报 · 实时预警推送 · 监测阈值'],
    alarm: ['报警中心', '多源告警汇聚 · 分级处置闭环'],
    devices: ['设备与网关', '云端设备台账 · 增删改查 · 指令下发']
  };

  /* ============================================================
   * 登录鉴权（生产上线）
   * ============================================================ */
  const TOKEN_KEY = 'yq_web_token';
  const auth = {
    user: null,
    token() { try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; } },
    save(t) { try { localStorage.setItem(TOKEN_KEY, t); } catch (e) { /* 隐私模式忽略 */ } },
    clear() { try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* 忽略 */ } this.user = null; },

    /* 登录门显示/隐藏（带进出场动画） */
    show(msg) {
      const ov = Q('auth-overlay');
      if (!ov) return;
      ov.classList.remove('leave', 'hidden');
      document.body.classList.add('locked');
      const card = ov.querySelector('.auth-card');
      if (card) { card.classList.remove('anim'); void card.offsetWidth; card.classList.add('anim'); }
      // 默认回到“登录”面板（注册面板由 Tab 打开）
      const pl = Q('pane-login'), pr = Q('pane-register'), tl = Q('tab-login'), tr = Q('tab-register');
      if (pl && pr && pl.classList.contains('hidden')) {
        pl.classList.remove('hidden'); pr.classList.add('hidden');
        if (tl) tl.classList.add('on');
        if (tr) tr.classList.remove('on');
      }
      const err = Q('lg-err');
      if (msg) { err.textContent = msg; err.classList.remove('hidden'); }
      setTimeout(() => { const u = Q('lg-user'); if (u && u.focus) u.focus(); }, 160);
    },
    hide() {
      const ov = Q('auth-overlay');
      if (!ov || ov.classList.contains('hidden')) return;
      document.body.classList.remove('locked');
      ov.classList.add('leave');
      setTimeout(() => { ov.classList.add('hidden'); }, 320);
    },
    logged() { return !!(auth.token() && auth.user); },

    async login(username, password, remember) {
      if (typeof fetch === 'undefined') return { ok: false, net: true };
      try {
        const resp = await fetch('/api/auth/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password, remember })
        });
        if (resp.status === 200) {
          const r = await resp.json();
          auth.save(r.token);
          auth.user = r.user;
          toast('欢迎回来', r.user.name + '（' + r.user.role + '）已登录，正在进入平台', 'ok');
          auth.hide();   // 离场动画 320ms
          setTimeout(() => { try { location.reload(); } catch (e) { /* 刷新以加载云端数据 */ } }, 700);
          return { ok: true };
        }
        return { ok: false, net: false };   // 401/400 等：凭证错误
      } catch (e) {
        return { ok: false, net: true };    // 网络不可达
      }
    },
    async logout() {
      const t = auth.token();
      auth.clear();
      if (t) apiRaw('auth/logout', { method: 'POST' });
      auth.show('已退出登录，请重新登录');
      toast('已退出', '为安全起见请关闭浏览器窗口', 'info');
      setTimeout(() => { try { location.reload(); } catch (e) { /* */ } }, 400);
    },
    async verify() {
      const me = await apiRaw('auth/me');
      if (me && me.id) { auth.user = me; return true; }
      auth.clear();
      return false;
    },
    /* 会话过期（任何 API 401） */
    onUnauthorized() {
      if (!auth.token()) return;
      auth.clear();
      auth.show('登录已过期，请重新登录');
    }
  };

  /* 原始请求（自动携带 Token，401 不触发 onUnauthorized），供 auth 内部使用 */
  function apiRaw(path, opts) {
    if (typeof fetch === 'undefined') return Promise.resolve(null);
    opts = opts || {};
    const t = auth.token();
    if (t && !(opts.headers && opts.headers.Authorization)) {
      opts.headers = Object.assign({}, opts.headers || {}, { Authorization: 'Bearer ' + t });
    }
    return fetch('/api/' + path, opts)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  }

  /* 业务 API：自动携带 Bearer Token；401 时弹登录门 */
  function api(path, opts) {
    if (typeof fetch === 'undefined') return Promise.resolve(null);
    opts = opts || {};
    const t = auth.token();
    if (t) {
      opts.headers = Object.assign({}, opts.headers || {}, { Authorization: 'Bearer ' + t });
    }
    return fetch('/api/' + path, opts).then((r) => {
      if (r.status === 401) { auth.onUnauthorized(); return null; }
      return r.ok ? r.json() : null;
    }).catch(() => null);
  }
  /* 带错误码的请求（用于需要区分 403/404 等场景，data 为 JSON 或 null） */
  function apiEx(path, opts) {
    if (typeof fetch === 'undefined') return Promise.resolve({ status: -1, data: null });
    opts = opts || {};
    const t = auth.token();
    if (t) opts.headers = Object.assign({}, opts.headers || {}, { Authorization: 'Bearer ' + t });
    return fetch('/api/' + path, opts).then(async (r) => {
      if (r.status === 401) { auth.onUnauthorized(); return { status: 401, data: null }; }
      let data = null;
      try { data = await r.json(); } catch (e) { /* 无 JSON */ }
      return { status: r.status, data };
    }).catch(() => ({ status: -1, data: null }));
  }

  /* 云端指令回执跟踪：下发后轮询该设备最新指令状态，ack/fail 时 toast */
  function watchCmd(deviceId, cmdId, label) {
    if (!deviceId || !cmdId || typeof api !== 'function') return;
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      api('commands?device_id=' + deviceId + '&limit=20').then((rows) => {
        const mine = Array.isArray(rows) && rows.find((c) => c.id === cmdId);
        if (!mine) return;
        if (mine.status === 'ack') {
          clearInterval(timer);
          toast('网关已回执', deviceId + ' · ' + (label || mine.cmd) + ' 执行完成' + (mine.ack_msg ? '（' + mine.ack_msg + '）' : ''), 'ok');
        } else if (mine.status === 'fail') {
          clearInterval(timer);
          toast('指令执行失败', deviceId + ' · ' + (label || mine.cmd) + '：' + (mine.ack_msg || '网关执行异常'), 'err');
        }
      });
      if (tries >= 5) {
        clearInterval(timer);
        toast('回执查询超时', deviceId + ' 指令仍在网关队列中，请到「设备与网关」页查看流水', 'warn');
      }
    }, 1800);
  }

  /* ============================================================
   * 启动动画 Splash（index.html #boot-splash）
   * ============================================================ */
  function splashTip(text) {
    const el = Q('splash-tip');
    if (el) el.textContent = text;
  }
  function hideSplash(minMs) {
    const el = Q('boot-splash');
    if (!el) return;
    const start = window.__bootAt || Date.now();
    const wait = Math.max(0, (minMs || 900) - (Date.now() - start));
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 650);
    }, wait);
  }

  /* 登录门 / 账号菜单交互 */
  function initAuthUI() {
    const chip = Q('user-chip');
    const menu = Q('user-menu');
    const lgBtn = Q('lg-btn');
    const rgBtn = Q('rg-btn');
    const setErr = (box, msg) => { box.textContent = msg || ''; box.classList.toggle('hidden', !msg); };
    /* Tab：登录 / 注册 */
    function setPane(name) {
      const reg = name === 'register';
      const tl = Q('tab-login'), tr = Q('tab-register');
      if (tl) tl.classList.toggle('on', !reg);
      if (tr) tr.classList.toggle('on', reg);
      const pl = Q('pane-login'), pr = Q('pane-register');
      if (pl) pl.classList.toggle('hidden', reg);
      if (pr) pr.classList.toggle('hidden', !reg);
      setErr(Q('lg-err'), null); setErr(Q('rg-err'), null);
      setTimeout(() => {
        const f = reg ? Q('rg-name') : Q('lg-user');
        if (f && f.focus) f.focus();
      }, 120);
    }
    /* 提交按钮 loading 动画 */
    function busy(btn, on) {
      if (!btn) return;
      btn.disabled = on;
      const t = btn.querySelector('.btn-txt'), s = btn.querySelector('.btn-spin');
      if (t) t.style.opacity = on ? 0 : 1;
      if (s) s.classList.toggle('hidden', !on);
    }
    const doLogin = async () => {
      const user = (Q('lg-user').value || '').trim();
      const pass = Q('lg-pass').value;
      if (!user || !pass) { setErr(Q('lg-err'), '请输入用户名和密码'); return; }
      busy(lgBtn, true);
      splashTip('登录成功，正在进入平台…');
      const res = await auth.login(user, pass, Q('lg-remember').checked);
      if (!res || !res.ok) {
        busy(lgBtn, false);
        splashTip('请登录以继续');
        setErr(Q('lg-err'), (res && res.net)
          ? '无法连接云端服务器：请通过 http://127.0.0.1:8600 打开页面，并确认后端服务正在运行（已关闭的公网测试地址不可用）'
          : '用户名或密码错误');
      }
      // 成功路径由 auth.login 内部完成离场动画 + 刷新进入平台
    };
    const doRegister = async () => {
      const name = (Q('rg-name').value || '').trim();
      const user = (Q('rg-user').value || '').trim();
      const p1 = Q('rg-pass').value;
      const p2 = Q('rg-pass2').value;
      const box = Q('rg-err');
      if (!/^[A-Za-z0-9_\-]{3,20}$/.test(user)) { setErr(box, '用户名需为 3-20 位字母/数字/下划线'); return; }
      if (!p1 || p1.length < 6) { setErr(box, '密码至少 6 位'); return; }
      if (p1 !== p2) { setErr(box, '两次输入的密码不一致'); return; }
      busy(rgBtn, true);
      setErr(box, null);
      splashTip('正在创建账号…');
      try {
        const resp = await fetch('/api/auth/register', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: user, password: p1, password2: p2, name })
        });
        const data = await resp.json().catch(() => null);
        if (resp.status === 200 && data && data.ok) {
          splashTip('账号创建成功，正在登录…');
          // 自动切回登录并填入账号，随后自动登录进入
          Q('lg-user').value = user;
          Q('lg-pass').value = p1;
          setPane('login');
          await doLogin();
          return;
        }
        busy(rgBtn, false);
        splashTip('请登录或注册');
        setErr(box, (data && data.error) || ('注册失败（HTTP ' + resp.status + '）'));
      } catch (e) {
        busy(rgBtn, false);
        splashTip('请登录或注册');
        setErr(box, '无法连接云端服务器：请通过 http://127.0.0.1:8600 打开页面（已关闭的公网测试地址不可用），并确认后端服务正在运行');
      }
    };
    const tabL = Q('tab-login'), tabR = Q('tab-register');
    if (tabL) tabL.onclick = () => setPane('login');
    if (tabR) tabR.onclick = () => setPane('register');
    if (lgBtn) {
      lgBtn.onclick = doLogin;
      Q('lg-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
      Q('lg-user').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
      Q('lg-user').focus();
    }
    if (rgBtn) {
      rgBtn.onclick = doRegister;
      ['rg-user', 'rg-pass', 'rg-pass2'].forEach((id) => {
        const el = Q(id);
        if (el) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') doRegister(); });
      });
    }
    if (chip && menu) {
      chip.onclick = (e) => {
        e.stopPropagation();
        if (!auth.logged()) { auth.show(); return; }
        menu.classList.toggle('hidden');
        renderUserMenu();
      };
      document.addEventListener('click', (e) => {
        if (menu && !menu.classList.contains('hidden') && !e.target.closest('.user-wrap')) menu.classList.add('hidden');
      });
      Q('um-logout').onclick = () => auth.logout();
      Q('um-submit').onclick = async () => {
        if (!auth.user) return;
        const oldP = Q('um-old').value;
        const newP = Q('um-new').value;
        if (!newP || newP.length < 6) { toast('修改失败', '新密码至少 6 位', 'warn'); return; }
        const r = await apiRaw('users/' + auth.user.id + '/password', {
          method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + auth.token() },
          body: JSON.stringify({ oldPassword: oldP, newPassword: newP })
        });
        if (r && r.ok) { toast('密码已修改', '请使用新密码重新登录', 'ok'); setTimeout(() => auth.logout(), 800); }
        else toast('修改失败', '请检查原密码是否正确', 'err');
      };
    }
  }
  function renderUserMenu() {
    const u = auth.user;
    if (!u) return;
    Q('um-title').textContent = u.name + '（' + u.username + '）';
    Q('um-role').textContent = u.role;
    Q('user-name').textContent = u.username;
    Q('user-avatar').textContent = (u.name || u.username).slice(0, 1);
  }

  global.UI = {
    $, $$, Q, esc, pad, nowText, toast, setNum, api, apiEx, apiRaw, auth, wmo, refreshWeatherChip, watchCmd,
    initAuthUI, renderUserMenu, splashTip, hideSplash,
    bootChrome, fillStaticIcons,
    setPageTitle(key) { const t = CHROME_TITLE[key] || []; if (t[0]) Q('page-title').textContent = t[0]; if (t[1]) Q('page-sub').textContent = t[1]; }
  };
})(window);
