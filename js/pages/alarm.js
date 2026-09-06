/* ============================================================
 * 报警中心（纯云端真实数据）
 * - 数据源：GET /api/alarms?limit=200（后端 SQLite；网关/边缘设备用
 *   device 账号 POST /api/alarms 上报；总览/无人机页展示同一数据源）
 * - 处置：确认 POST /api/alarms/:id ；误报 POST /api/alarms/:id/misreport
 *   （仅 admin/operator；非管理员只读并给出提示）
 * - 本页不引用 js/data.js 仿真引擎：库为空时渲染真实空态引导。
 * 契约：docs/API.md §5
 * ============================================================ */
(function (global) {
  'use strict';
  const UIx = global.UI, YQCx = global.YQC;
  const Q = UIx.Q, esc = UIx.esc, toast = UIx.toast;
  const I = global.I;

  /* 级别/状态中文映射（页面自带常量，不依赖 data.js） */
  const LV_ZH = { crit: '严重', warn: '警告', info: '提示' };
  const ST_ZH = { open: '未处理', ack: '已处理', misreport: '误报' };
  const ST_TAG = { open: 'tag red', ack: 'tag green', misreport: 'tag gray' };

  const html = `
  <div class="content-scroll">
    <div class="grid">
      <div class="card span-3 kpi"><span class="k-ico ico-a">${I('alert-octagon', 21)}</span><div class="k-body">
        <div class="k-label">告警总数</div><div class="k-value" id="al-total">–</div>
        <div class="k-sub" id="al-total-sub">云端台账 · 窗口 200 条 · 5s 轮询</div></div></div>
      <div class="card span-3 kpi"><span class="k-ico ico-r">${I('alert-triangle', 21)}</span><div class="k-body">
        <div class="k-label">未处理</div><div class="k-value" id="al-open">–</div>
        <div class="k-sub" id="al-open-sub">点击行内「确认 / 误报」处置（admin/operator）</div></div></div>
      <div class="card span-3 kpi"><span class="k-ico ico-g">${I('circle-check', 21)}</span><div class="k-body">
        <div class="k-label">已处理</div><div class="k-value" id="al-ack">–</div>
        <div class="k-sub">确认后归档为「已处理」，仅真实上报可再开</div></div></div>
      <div class="card span-3 kpi"><span class="k-ico ico-s">${I('x', 21)}</span><div class="k-body">
        <div class="k-label">误报</div><div class="k-value" id="al-mis">–</div>
        <div class="k-sub">误报样本留存，可追溯复核</div></div></div>

      <!-- 告警列表 -->
      <div class="card span-8">
        <div class="card-h"><span class="h-ico">${I('bell-ringing', 15)}</span>告警列表
          <span class="card-title-note" id="al-note">读取云端告警…</span>
          <span style="margin-left:auto;display:flex;gap:8px;align-items:center">
            <select class="btn" id="al-f-lv" style="padding:4px 8px"><option value="">全部级别</option><option value="crit">严重</option><option value="warn">警告</option><option value="info">提示</option></select>
            <select class="btn" id="al-f-type" style="padding:4px 8px;max-width:150px"><option value="">全部类型</option></select>
            <button class="btn" id="al-batch" disabled title="仅 admin/operator 可批量确认未处理告警">${I('check', 13)} 批量确认 <b id="al-batch-n">0</b></button>
            <button class="btn" id="al-refresh" style="padding:4px 9px">${I('refresh', 13)} 刷新</button>
          </span>
        </div>
        <div class="h-divider"></div>
        <div class="card-b" style="padding-top:4px">
          <div id="al-chips" style="display:flex;gap:6px;flex-wrap:wrap;margin:2px 0 8px"></div>
          <div style="max-height:440px;overflow-y:auto">
            <table class="table" style="min-width:880px"><thead id="al-thead"></thead><tbody id="al-tbody"></tbody></table>
          </div>
          <div id="al-empty" class="empty-tip hidden"></div>
        </div>
      </div>

      <!-- 右侧：上报 / 处置说明（真实语义，无演示数据） -->
      <div class="span-4" style="display:flex;flex-direction:column;gap:12px">
        <div class="card">
          <div class="card-h"><span class="h-ico">${I('send', 15)}</span>告警从哪里来</div>
          <div class="h-divider"></div>
          <div class="card-b" style="padding-top:6px;font-size:11.5px;line-height:1.9;color:var(--muted)">
            无人机/摄像头/传感器/边缘AI 等真实设备（或场区网关）用 <b style="color:#374151">device 账号</b>上报：
            <code style="background:#f3f4f6;padding:1px 5px;border-radius:4px">POST /api/alarms</code>
            <code style="background:#f3f4f6;padding:1px 5px;border-radius:4px">{deviceId,lv,type,ico,msg}</code><br>
            lv：<b style="color:#374151">crit</b> 严重 / <b style="color:#374151">warn</b> 警告 / <b style="color:#374151">info</b> 提示。<br>
            上报即写入云端 SQLite，本页与总览/无人机页同源展示。示例见 <b style="color:#374151">docs/API.md §5</b>。
          </div>
        </div>
        <div class="card">
          <div class="card-h"><span class="h-ico">${I('shield', 15)}</span>处置闭环</div>
          <div class="h-divider"></div>
          <div class="card-b" style="padding-top:6px;font-size:11.5px;line-height:1.9;color:var(--muted)">
            <div class="sensor-row"><span class="sr-name"><span class="dot red"></span>未处理</span><span style="font-size:11px">新上报告警，等待处置</span></div>
            <div class="sensor-row"><span class="sr-name"><span class="dot green"></span>确认</span><span style="font-size:11px">POST /api/alarms/:id 归档</span></div>
            <div class="sensor-row"><span class="sr-name"><span class="dot gray"></span>误报</span><span style="font-size:11px">/api/alarms/:id/misreport</span></div>
            <div style="margin-top:8px;color:var(--dim)">确认/误报仅 <b>admin / operator</b> 可执行；
              device 角色账号只读（行内已隐藏操作按钮）。处置后本页与角标实时同步刷新。</div>
          </div>
        </div>
        <div class="card">
          <div class="card-h"><span class="h-ico">${I('adjustments', 15)}</span>快捷过滤</div>
          <div class="h-divider"></div>
          <div class="card-b" style="padding-top:8px" id="al-lv-mini">
            <div class="sensor-row"><span class="sr-name">级别分布</span><span id="al-lv-text" style="font-size:11px">–</span></div>
            <div class="sensor-row"><span class="sr-name">未处理严重级</span><span id="al-crit-open" style="font-size:11px">–</span></div>
          </div>
        </div>
      </div>
    </div>
  </div>`;

  /* ---------- 本地状态（全部来自云端接口） ---------- */
  const f = {
    rows: [],      // GET /api/alarms?limit=200 全量窗口（服务端已按 id 倒序）
    devs: {},      // GET /api/devices 台账名称缓存 { device_id → 名称 }
    lv: '', type: '', st: '',   // 客户端过滤：级别 / 类型 / 状态 chips
    sel: new Set(),             // 勾选的未处理告警 id（批量确认）
    lastPoll: 0, lastDev: 0,
    online: false, inited: false, busy: false
  };

  const canAck = () => !!UIx.auth && !!UIx.auth.user &&
    (UIx.auth.user.role === 'admin' || UIx.auth.user.role === 'operator');

  /* ---------- 工具 ---------- */
  const fmtTs = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso), p = UIx.pad;
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  };
  const lvZh = (lv) => LV_ZH[lv] || esc(String(lv == null ? '' : lv));
  const stZh = (s) => ST_ZH[s] || esc(String(s == null ? '' : s));

  /* ---------- 拉取（真值；401 由 UI.api 弹登录门并返回 null） ---------- */
  function refresh(force) {
    if (!force && Date.now() - f.lastPoll < 2000) return;  // 双节流：外层 tick ≥5s
    f.lastPoll = Date.now();
    UIx.api('alarms?limit=200').then((rows) => {
      if (!rows) {
        f.online = false;
        renderNote('云端连接失败，正在自动重试…');
        renderEmpty();
        return;
      }
      f.online = true;
      f.rows = rows;
      // 清理已失效的勾选（不再 open / 已不在窗口内）
      const open = new Set(f.rows.filter((a) => a.status === 'open').map((a) => String(a.id)));
      f.sel.forEach((id) => { if (!open.has(id)) f.sel.delete(id); });
      renderChips();
      renderTypeOpts();
      renderKpi();
      renderTable();
      if (Date.now() - f.lastDev > 30000) loadDevNames();   // 台账名缓存 30s 级刷新
      if (!Object.keys(f.devs).length) loadDevNames();      // 首次进入立即取一次名称映射
      renderNote('云端 SQLite · 5s 轮询 · 最近同步 ' + UIx.nowText().time + ' · ' + f.rows.length + ' 条');
    });
  }
  /* 设备台账名称映射缓存（30s 级刷新；查不到就只显示 device_id） */
  function loadDevNames() {
    f.lastDev = Date.now();
    UIx.api('devices').then((list) => {
      if (!Array.isArray(list)) return;
      f.devs = {};
      list.forEach((d) => { if (d && d.id) f.devs[d.id] = (d.name || d.id) + (d.sub ? ' · ' + d.sub : ''); });
      renderTable();
    });
  }

  /* ---------- 渲染 ---------- */
  function visible() {
    return f.rows.filter((a) =>
      (!f.lv || a.lv === f.lv) &&
      (!f.type || a.type === f.type) &&
      (!f.st || a.status === f.st));
  }
  function cnt(st) { return f.rows.filter((a) => a.status === st).length; }

  function renderKpi() {
    if (!f.online) {
      ['al-total', 'al-open', 'al-ack', 'al-mis'].forEach((id) => { const el = Q(id); if (el) el.textContent = '–'; });
      Q('al-open-sub') && (Q('al-open-sub').textContent = '后端不可达：请确认已运行 node backend/server.js');
      Q('al-lv-text') && (Q('al-lv-text').textContent = '–');
      Q('al-crit-open') && (Q('al-crit-open').textContent = '–');
      return;
    }
    const opens = f.rows.filter((a) => a.status === 'open');
    UIx.setNum(Q('al-total'), f.rows.length, 0);
    UIx.setNum(Q('al-open'), cnt('open'), 0);
    UIx.setNum(Q('al-ack'), cnt('ack'), 0);
    UIx.setNum(Q('al-mis'), cnt('misreport'), 0);
    Q('al-open-sub').textContent = canAck()
      ? '严重 ' + opens.filter((a) => a.lv === 'crit').length + ' 条 · 行内确认/误报'
      : '当前账号只读（处置需 admin/operator）';
    const lvTxt = ['crit', 'warn', 'info'].map((lv) => {
      const n = f.rows.filter((a) => a.lv === lv).length;
      return '<span class="tag ' + YQCx.lvTag(lv) + '" style="margin:0 3px">' + LV_ZH[lv] + ' ' + n + '</span>';
    }).join('');
    Q('al-lv-text').innerHTML = lvTxt || '—';
    Q('al-crit-open').innerHTML = '<b style="color:#dc2626">' + opens.filter((a) => a.lv === 'crit').length + '</b> 条';
  }

  function renderChips() {
    const chips = [
      ['', '全部', f.rows.length],
      ['open', '未处理', cnt('open')],
      ['ack', '已处理', cnt('ack')],
      ['misreport', '误报', cnt('misreport')]
    ];
    Q('al-chips').innerHTML = chips.map(([v, lb, n]) => {
      const on = f.st === v;
      return `<button class="btn" data-chip="${v}" style="padding:3px 11px;font-size:12px${on ? ';background:#6366f1;border-color:#6366f1;color:#fff' : ''}">
        ${lb}<b style="margin-left:5px;${on ? 'color:#fff' : 'color:#9ca3af'}">${n}</b></button>`;
    }).join('');
  }

  function renderTypeOpts() {
    const sel = Q('al-f-type');
    const types = Array.from(new Set(f.rows.map((a) => a.type).filter((t) => t))).sort();
    const cur = sel.value;
    sel.innerHTML = '<option value="">全部类型</option>' +
      types.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
    if (cur && types.indexOf(cur) >= 0) sel.value = cur;
  }

  function theadHtml() {
    const cb = canAck()
      ? '<th style="width:34px;text-align:center" title="全选未处理"><input type="checkbox" id="al-selall"></th>'
      : '';
    return `<tr>${cb}<th>时间</th><th>级别</th><th>设备</th><th style="min-width:240px">类型 / 内容</th><th>状态</th><th style="text-align:right">操作</th></tr>`;
  }

  function rowHtml(a) {
    const open = a.status === 'open';
    const id = String(a.id);
    const right = canAck();
    const name = f.devs[a.device_id];
    const ico = a.ico && I.has(a.ico) ? a.ico : 'alert-triangle';
    const ops = open
      ? (right
        ? `<button class="btn" style="padding:2px 9px" data-act="${id}" data-kind="ack" title="POST /api/alarms/${id}">确认</button>
           <button class="btn danger" style="padding:2px 9px;margin-left:4px" data-act="${id}" data-kind="misreport" title="POST /api/alarms/${id}/misreport">误报</button>`
        : '<span style="color:#9ca3af;font-size:10.5px">只读：仅 admin/operator 可处置</span>')
      : '<span style="color:#9ca3af;font-size:11px">已归档</span>';
    return `<tr>
      ${right ? `<td style="text-align:center"><input type="checkbox" data-sel="${id}" ${open ? '' : 'disabled'} ${open && f.sel.has(id) ? 'checked' : ''} title="${open ? '勾选后批量确认' : '非未处理不可选'}"></td>` : ''}
      <td style="color:var(--dim);font-variant-numeric:tabular-nums;white-space:nowrap">${fmtTs(a.created_at)}</td>
      <td><span class="${YQCx.lvTag(a.lv)}">${lvZh(a.lv)}</span></td>
      <td><b style="color:#111827">${esc(a.device_id || '—')}</b>
        ${name ? '<div style="font-size:10.5px;color:var(--dim)">' + esc(name) + '</div>' : ''}</td>
      <td style="white-space:normal;color:#374151">
        <div style="display:flex;align-items:center;gap:4px">${I(ico, 12)}<b style="color:#111827">${esc(a.type || '告警')}</b></div>
        <div style="font-size:11.5px;color:var(--muted);word-break:break-word">${esc(a.msg || '')}</div></td>
      <td><span class="${ST_TAG[a.status] || 'tag gray'}">${stZh(a.status)}</span></td>
      <td style="text-align:right;white-space:nowrap">${ops}</td>
    </tr>`;
  }

  function renderTable() {
    const rows = visible();
    Q('al-thead').innerHTML = theadHtml();
    Q('al-tbody').innerHTML = rows.map(rowHtml).join('');
    renderEmpty(rows.length === 0);
    updateBatchUI();
  }

  function renderEmpty(none) {
    const box = Q('al-empty');
    if (!box) return;
    if (!f.online) {
      box.classList.remove('hidden');
      box.innerHTML = '<b style="color:#4b5563">无法连接云端后端</b><br>请确认已运行 node backend/server.js 并登录，页面将自动重试。';
      return;
    }
    if (f.rows.length === 0) {
      box.classList.remove('hidden');
      box.innerHTML = '<b style="color:#4b5563">暂无告警</b><br>真实设备告警上报 POST /api/alarms 后出现（网关示例见 docs/API.md）';
    } else if (none) {
      box.classList.remove('hidden');
      box.innerHTML = '没有符合筛选条件的告警';
    } else {
      box.classList.add('hidden');
    }
  }

  function renderNote(txt) {
    const el = Q('al-note');
    if (el) el.textContent = txt;
  }

  /* 全选/批量按钮联动（以当前筛选视图内的未处理行为范围） */
  function updateBatchUI() {
    const btn = Q('al-batch');
    if (!btn) return;
    const selAll = Q('al-selall');
    const visOpen = visible().filter((a) => a.status === 'open');
    const n = visOpen.filter((a) => f.sel.has(String(a.id))).length;
    if (btn) {
      btn.disabled = !canAck() || visOpen.length === 0 || n === 0 || f.busy;
      Q('al-batch-n').textContent = canAck() ? n : 0;
    }
    if (selAll) {
      selAll.disabled = visOpen.length === 0;
      selAll.checked = visOpen.length > 0 && n === visOpen.length;
    }
  }

  /* ---------- 处置动作（云端写回） ---------- */
  function act(a, kind) {
    if (!canAck()) {
      toast('无处置权限', '确认/误报仅 admin/operator 可执行，当前角色 ' + (UIx.auth.user ? UIx.auth.user.role : '未登录'), 'warn');
      return;
    }
    const path = 'alarms/' + a.id + (kind === 'misreport' ? '/misreport' : '');
    UIx.apiEx(path, { method: 'POST' }).then((r) => {
      if (r.status === 200) {
        f.sel.delete(String(a.id));
        if (kind === 'misreport') toast('已标记误报', a.type + ' 已写入云端（misreport），列表将刷新', 'warn');
        else toast('告警已确认并写入云端', a.type + '：' + (a.msg || '').slice(0, 24) + (a.msg && a.msg.length > 24 ? '…' : ''), 'ok');
        refresh(true);
      } else if (r.status === 403) {
        toast('处置失败：无权限', '确认/误报仅 admin/operator 可执行', 'err');
      } else if (r.status === 404) {
        toast('处置失败', '该告警不存在（可能已被删除），列表将刷新', 'err');
        refresh(true);
      } else if (r.status === -1) {
        toast('处置失败', '无法连接云端后端', 'err');
      } else {
        toast('处置失败', (r.data && r.data.error) || ('HTTP ' + r.status), 'err');
      }
    });
  }

  async function batchAck() {
    if (!canAck() || f.busy) return;
    const ids = visible().filter((a) => a.status === 'open' && f.sel.has(String(a.id))).map((a) => a.id);
    if (!ids.length) { toast('未选择告警', '请先勾选未处理告警再批量确认', 'warn'); return; }
    f.busy = true;
    updateBatchUI();
    let okN = 0, failN = 0;
    for (const id of ids) {
      const r = await UIx.apiEx('alarms/' + id, { method: 'POST' });
      if (r.status === 200) okN++; else failN++;
    }
    f.busy = false;
    f.sel.clear();
    if (okN) toast('批量确认成功', okN + ' 条已确认并写入云端' + (failN ? '，' + failN + ' 条失败已忽略' : ''), okN > failN ? 'ok' : 'warn');
    else toast('批量确认失败', '云端无响应或权限不足，请稍后重试', 'err');
    refresh(true);
  }

  /* ---------- 事件绑定（init 一次；委托在常驻容器上，渲染刷新不丢监听） ---------- */
  function init() {
    const root = Q('page-alarm');
    root.innerHTML = html;
    Q('al-f-lv').onchange = (e) => { f.lv = e.target.value; renderTable(); };
    Q('al-f-type').onchange = (e) => { f.type = e.target.value; renderTable(); };
    Q('al-chips').addEventListener('click', (e) => {
      const c = e.target.closest('[data-chip]');
      if (!c) return;
      f.st = c.dataset.chip;
      renderChips();
      renderTable();
    });
    Q('al-tbody').addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const row = f.rows.find((a) => String(a.id) === b.dataset.act);
      if (row) act(row, b.dataset.kind);
    });
    Q('al-tbody').addEventListener('change', (e) => {
      const cb = e.target.closest('[data-sel]');
      if (!cb) return;
      const id = cb.dataset.sel;
      if (cb.checked) f.sel.add(id); else f.sel.delete(id);
      updateBatchUI();
    });
    Q('al-batch').onclick = () => batchAck();
    Q('al-refresh').onclick = () => refresh(true);
    // 头部全选（范围 = 当前筛选视图内的未处理；thead 会被重建，故用 document 委托）
    document.addEventListener('change', (e) => {
      if (e.target && e.target.id === 'al-selall') {
        const visOpen = visible().filter((a) => a.status === 'open');
        visOpen.forEach((a) => { const id = String(a.id); e.target.checked ? f.sel.add(id) : f.sel.delete(id); });
        renderTable();
      }
    });
    f.inited = true;
    refresh(true);
  }

  /* tick：每秒被 app 调用，自带 ≥5s 节流；未 init 直接返回 */
  function tick() {
    if (!f.inited || !Q('al-tbody')) return;
    if (Date.now() - f.lastPoll >= 5000) refresh(false);
  }

  /* 进入页面：全量刷新 */
  function onShow() {
    if (!f.inited) return;
    refresh(true);
  }

  global.PAGES = global.PAGES || {};
  global.PAGES.alarm = { name: '报警中心', init, tick, onShow };
})(window);
