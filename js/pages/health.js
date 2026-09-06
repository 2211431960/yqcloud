/* ============================================================
 * 鸡群健康分析（纯云端真实数据版）
 * - KPI：GET /api/metrics（health_index / sick_rate / isolate / mortality）
 * - 批次：GET/POST/PUT/DELETE /api/batches（/api/batches/:id）
 * - 事件：GET/POST /api/batches/:id/events
 * - 采样：GET/POST /api/samples（avg_weight / isolate_event / sick_rate）
 * 无合成数据：无上报时只显示「未接入」引导与空态，绝不合成曲线。
 * 契约见 docs/API.md。
 * ============================================================ */
(function (global) {
  'use strict';
  const UIx = global.UI;
  const Q = UIx.Q, $$ = UIx.$$, esc = UIx.esc, toast = UIx.toast;
  const setNum = UIx.setNum, pad = UIx.pad;
  const YQCx = global.YQC;
  const I = global.I;
  const api = UIx.api, apiEx = UIx.apiEx;

  /* ---------- 模块状态（仅云端数据） ---------- */
  let inited = false;
  let lastTickMs = 0, tickSeq = 0;
  let metrics = [];             // GET /api/metrics 快照
  let batches = undefined;      // undefined=未加载 / 数组=加载成功
  let batchFail = false;        // 后端不可达
  let selId = '';               // 当前选中批次
  let detail = null;            // GET /api/batches/:id
  let isoRows = [];             // 隔离记录（新→旧）
  let sickRows = [];            // 发病率采样（接口新→旧，绘图前反转为旧→新）
  let charts = { w: null, sr: null };
  let formMode = '';            // '' 隐藏 / 'create' / 'edit'
  let editId = '';

  /* ---------- 展示字典 ---------- */
  const METRIC_META = {
    health_index: { el: 'he-idx', dec: 1 },
    sick_rate: { el: 'he-sick', dec: 2 },
    isolate: { el: 'he-iso', dec: 0 },
    mortality: { el: 'he-mort', dec: 2 }
  };
  const KIND_ZH = {
    enter: '进栏', feed: '转料', vaccine: '免疫', weight: '称重',
    health: '检疫', transfer: '转群', sale: '出栏'
  };
  const KIND_TAG = {
    enter: 'tag green', feed: 'tag amber', vaccine: 'tag sky',
    weight: 'tag purple', health: 'tag green', transfer: 'tag amber', sale: 'tag red'
  };
  const ST_ZH = {
    active: '在养中', selling: '出栏中', done: '已结束',
    quarantine: '隔离观察', sick: '病群', paused: '暂停'
  };
  const ST_TAG = {
    active: 'green', selling: 'amber', done: 'gray',
    quarantine: 'amber', sick: 'red', paused: 'gray'
  };
  const EV_KINDS = [
    ['enter', 'enter 进栏'], ['feed', 'feed 转料'], ['vaccine', 'vaccine 免疫'],
    ['weight', 'weight 称重'], ['health', 'health 检疫'], ['transfer', 'transfer 转群'], ['sale', 'sale 出栏']
  ];

  const role = () => (UIx.auth.user ? UIx.auth.user.role : '');
  const isAdmin = () => role() === 'admin';
  const canWrite = () => { const r = role(); return r === 'admin' || r === 'operator'; };
  const fmtT = (ts) => {
    if (!ts) return '—';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '—';
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  };
  const metaOf = (row) => { try { return JSON.parse(row.meta || '{}') || {}; } catch (e) { return {}; } };
  const intOf = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
  const numOf = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  const fmtInt = (v) => (v === null || v === undefined || v === '' ? '—' : Number(v).toLocaleString('zh-CN'));
  const KV = (k) => { const m = {}; (metrics || []).forEach((x) => { m[x.type] = x; }); return m[k]; };

  /* ============================================================
   * 布局（无数据占位；批次/事件/隔离容器由 JS 渲染）
   * ============================================================ */
  const html = `
  <div class="content-scroll">
    <div class="grid">

      <!-- KPI：业务指标来自云端 metrics，未上报则“未接入”引导 -->
      <div class="card span-3 kpi"><span class="k-ico ico-g">${I('heartbeat', 21)}</span><div class="k-body">
        <div class="k-label">健康指数</div><div class="k-value" id="he-idx">–</div>
        <div class="k-sub" id="he-sub-health_index">未接入：请由场区网关/管理端上报 metrics（见 docs/API.md 第 7 节）</div></div></div>
      <div class="card span-3 kpi"><span class="k-ico ico-r">${I('activity', 21)}</span><div class="k-body">
        <div class="k-label">发病率</div><div class="k-value" id="he-sick">–</div>
        <div class="k-sub" id="he-sub-sick_rate">未接入：请由场区网关/管理端上报 metrics（见 docs/API.md 第 7 节）</div></div></div>
      <div class="card span-3 kpi"><span class="k-ico ico-a">${I('building-hospital', 21)}</span><div class="k-body">
        <div class="k-label">在隔离数</div><div class="k-value" id="he-iso">–</div>
        <div class="k-sub" id="he-sub-isolate">未接入：请由场区网关/管理端上报 metrics（见 docs/API.md 第 7 节）</div></div></div>
      <div class="card span-3 kpi"><span class="k-ico ico-s">${I('report-medical', 21)}</span><div class="k-body">
        <div class="k-label">死亡率</div><div class="k-value" id="he-mort">–</div>
        <div class="k-sub" id="he-sub-mortality">未接入：请由场区网关/管理端上报 metrics（见 docs/API.md 第 7 节）</div></div></div>

      <!-- 批次健康明细 -->
      <div class="card span-12">
        <div class="card-h"><span class="h-ico">${I('clipboard', 15)}</span>批次健康明细
          <span class="card-title-note" id="he-bat-note">云端批次（batches）· 实时同步</span>
          <span style="margin-left:auto;display:flex;gap:10px;align-items:center">
            <button class="btn primary hidden" id="he-add-batch" title="新建批次（写入云端数据库）">${I('plus', 13)} 新建批次</button>
            <span class="more" id="he-refresh">刷新</span>
          </span>
        </div>
        <div class="h-divider"></div>
        <div class="card-b" style="padding-top:6px">
          <!-- 新建/编辑 表单（复用同一份字段） -->
          <div id="he-batch-form" class="hidden" style="border:1px dashed #e5e7eb;border-radius:10px;padding:12px 14px;margin-bottom:12px">
            <div style="display:flex;gap:10px;align-items:center;margin-bottom:10px;font-size:13px;font-weight:600;color:#111827">
              <span id="he-form-title">新建批次</span>
              <span class="card-title-note" id="he-form-id"></span>
              <span class="more" style="margin-left:auto" id="he-form-cancel">取消 ✕</span>
            </div>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px 12px">
              <div><label class="dv-lb">批次名称 *</label><input class="dv-in" id="f-b-name" placeholder="如 秋一栏散养鸡"></div>
              <div><label class="dv-lb">品种</label><input class="dv-in" id="f-b-breed" placeholder="如 青脚麻鸡"></div>
              <div><label class="dv-lb">基地/场地</label><input class="dv-in" id="f-b-base" placeholder="如 云顶山基地"></div>
              <div><label class="dv-lb">进栏数量</label><input class="dv-in" id="f-b-in" type="number" min="0" placeholder="如 2000"></div>
              <div><label class="dv-lb">当前存栏</label><input class="dv-in" id="f-b-cur" type="number" min="0" placeholder="如 1986"></div>
              <div><label class="dv-lb">日龄 age_days</label><input class="dv-in" id="f-b-age" type="number" min="0" placeholder="如 42"></div>
              <div><label class="dv-lb">目标日龄 target_age_d</label><input class="dv-in" id="f-b-tage" type="number" min="0" placeholder="如 110"></div>
              <div style="grid-column:1/-1"><label class="dv-lb">备注</label><input class="dv-in" id="f-b-note" style="width:100%" placeholder="批次说明…"></div>
            </div>
            <div style="display:flex;gap:10px;margin-top:12px">
              <button class="btn primary" id="he-save-batch">${I('circle-check', 14)} 保存到云端数据库</button>
              <button class="btn" id="he-form-cancel2">取消</button>
            </div>
          </div>
          <!-- 批次列表（行点击=查看详情） -->
          <div id="he-batch-list"></div>
        </div>
      </div>

      <!-- 均重趋势 / 发病率趋势（真实采样才绘制） -->
      <div class="card span-6">
        <div class="card-h"><span class="h-ico">${I('scale', 15)}</span>批次均重趋势
          <span class="card-title-note" id="he-w-note">未选择批次</span></div>
        <div class="h-divider"></div>
        <div class="card-b" style="padding-top:6px">
          <div class="chart-sm" data-chart id="he-wchart"></div>
          <div id="he-wtip"></div>
        </div>
      </div>
      <div class="card span-6">
        <div class="card-h"><span class="h-ico">${I('chart-line', 15)}</span>发病率趋势（近 90 采样）
          <span class="card-title-note">samples kind=sick_rate</span></div>
        <div class="h-divider"></div>
        <div class="card-b" style="padding-top:6px">
          <div class="chart-sm" data-chart id="he-schart"></div>
          <div id="he-stip"></div>
        </div>
      </div>

      <!-- 健康事件时间线（选中批次） -->
      <div class="card span-7">
        <div class="card-h"><span class="h-ico">${I('clipboard-check', 15)}</span>健康事件时间线
          <span class="card-title-note" id="he-ev-note">未选择批次</span></div>
        <div class="h-divider"></div>
        <div class="card-b" style="padding-top:6px">
          <div id="he-events" style="max-height:330px;overflow-y:auto"></div>
          <div style="margin-top:10px;padding-top:10px;border-top:1px dashed #f3f4f6" id="he-evform-box">
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <span style="font-size:11.5px;color:var(--muted)">登记事件：</span>
              <select class="dv-in" id="he-ev-kind" style="padding:5px 8px">
                ${EV_KINDS.map((k) => `<option value="${k[0]}">${k[1]}</option>`).join('')}
              </select>
              <input class="dv-in" id="he-ev-title" placeholder="标题 *（如 全群晨检）" style="flex:1;min-width:150px">
              <input class="dv-in" id="he-ev-detail" placeholder="详情（可选）" style="flex:1.2;min-width:160px">
              <button class="btn primary" id="he-ev-save">${I('plus', 13)} 登记</button>
            </div>
          </div>
        </div>
      </div>

      <!-- 隔离记录（选中批次；快速登记写入 samples kind=isolate_event） -->
      <div class="card span-5">
        <div class="card-h"><span class="h-ico">${I('users', 15)}</span>隔离记录
          <span class="card-title-note" id="he-iso-note">samples kind=isolate_event</span></div>
        <div class="h-divider"></div>
        <div class="card-b" style="padding-top:6px">
          <div class="event-stream" id="he-iso-list" style="max-height:256px"></div>
          <div style="margin-top:10px;padding-top:10px;border-top:1px dashed #f3f4f6" id="he-isoform-box">
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <input class="dv-in" id="he-iso-zone" placeholder="区域（如 散养区A）" style="width:120px">
              <input class="dv-in" id="he-iso-note" placeholder="原因/症状（可选）" style="flex:1;min-width:140px">
              <button class="btn primary" id="he-iso-save">${I('plus', 13)} 登记隔离</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>`;

  /* ============================================================
   * KPI：metrics 快照 → 值 + 单位 + 「云端上报 source · 时间」副标
   * ============================================================ */
  function renderKpi() {
    const M = {};
    (metrics || []).forEach((m) => { M[m.type] = m; });
    Object.keys(METRIC_META).forEach((type) => {
      const meta = METRIC_META[type];
      const el = Q(meta.el), sub = Q('he-sub-' + type);
      const row = M[type];
      if (!el) return;
      if (!row || row.value === null || row.value === undefined || !Number.isFinite(+row.value)) {
        el.innerHTML = '–';
        if (sub) sub.innerHTML = '未接入：请由场区网关/管理端上报 <b>metrics</b>（见 docs/API.md 第 7 节）';
        return;
      }
      const v = +row.value;
      const numStr = String(Number(v.toFixed(meta.dec)));
      el.innerHTML = numStr + (row.unit ? '<small>' + esc(row.unit) + '</small>' : '');
      if (sub) {
        const t = new Date(row.ts);
        const tm = !Number.isNaN(t.getTime()) ? pad(t.getMonth() + 1) + '-' + pad(t.getDate()) + ' ' + pad(t.getHours()) + ':' + pad(t.getMinutes()) : '—';
        sub.innerHTML = '云端上报 · ' + esc(row.source || '—') + ' · ' + tm + (row.note ? ' · ' + esc(row.note) : '');
      }
    });
  }
  function loadMetrics() {
    if (!api) return;
    api('metrics').then((rows) => {
      if (Array.isArray(rows)) { metrics = rows; renderKpi(); }
    });
  }

  /* ============================================================
   * 批次明细
   * ============================================================ */
  function batchListHtml() {
    if (batchFail) {
      return '<div class="empty-tip"><b style="color:#4b5563">无法连接云端后端</b><br>' +
        '请确认已运行 node backend/server.js 并刷新页面；恢复后本页自动读取真实批次数据。</div>';
    }
    if (batches === undefined) {
      return '<div class="empty-tip"><b style="color:#4b5563">正在读取云端批次…</b><br>若长时间无响应，请检查后端与登录状态。</div>';
    }
    if (!batches.length) {
      return '<div class="empty-tip"><b style="color:#4b5563">暂无批次</b><br>' +
        '批次由「新建批次」或管理端写入（POST /api/batches）后在此显示；' +
        '选择批次后可查看其均重趋势 / 健康事件 / 隔离记录。</div>';
    }
    return `<table class="table" style="min-width:760px"><thead><tr>
        <th>批次</th><th>品种 / 基地</th><th>日龄(天)</th><th>存栏 cur/in</th><th>状态</th><th style="text-align:right">操作</th>
      </tr></thead><tbody>` + batches.map((b) => {
      const stRaw = b.status || '';
      const stZh = ST_ZH[stRaw] || (stRaw || '—');
      const sel = selId === b.id;
      return `<tr data-sel="${esc(b.id)}" style="cursor:pointer;${sel ? 'background:#f5f3ff' : ''}">
        <td><b style="color:#111827">${esc(b.id)}</b>${sel ? ' <span class="tag purple">当前</span>' : ''}<br>
          <span style="font-size:11px;color:var(--muted)">${esc(b.name || '')}${b.note ? ' · ' + esc(b.note) : ''}</span></td>
        <td style="font-size:12px;color:var(--muted)">${esc(b.breed || '—')}${b.base ? '<br><span style="font-size:10.5px;color:var(--dim)">' + esc(b.base) + '</span>' : ''}</td>
        <td style="font-variant-numeric:tabular-nums">${b.age_days == null ? '—' : b.age_days}${b.target_age_d ? '<span style="color:#9ca3af">/' + b.target_age_d + '</span>' : ''}</td>
        <td style="font-variant-numeric:tabular-nums">${fmtInt(b.cur_count)}<span style="color:#9ca3af"> / ${fmtInt(b.in_count)}</span></td>
        <td><span class="tag ${ST_TAG[stRaw] || 'tag gray'}">${esc(stZh)}</span></td>
        <td style="text-align:right;white-space:nowrap">
          ${canWrite() ? `<button class="btn" style="padding:2.5px 8px" data-edit-b="${esc(b.id)}">${I('pencil', 12)} 编辑</button>` : ''}
          ${isAdmin() ? `<button class="btn danger" style="padding:2.5px 8px" data-del-b="${esc(b.id)}">删除</button>` : ''}
        </td>
      </tr>`;
    }).join('') + '</tbody></table>';
  }

  function renderBatchList() {
    const box = Q('he-batch-list');
    if (!box) return;
    box.innerHTML = batchListHtml();
    if (Q('he-bat-note')) {
      Q('he-bat-note').textContent = batches === undefined || batchFail
        ? '云端批次（batches）· 读取中/不可达'
        : '云端批次（batches）· ' + batches.length + ' 批 · ' + fmtT(new Date().toISOString());
    }
    const add = Q('he-add-batch');
    if (add) { add.classList.toggle('hidden', !canWrite()); }
  }

  function loadBatches() {
    if (!api) return;
    api('batches').then((rows) => {
      if (!Array.isArray(rows)) { batchFail = true; batches = []; renderBatchList(); updateCtl(); return; }
      batchFail = false;
      batches = rows;
      if (selId && !batches.some((b) => b.id === selId)) { selId = ''; detail = null; }
      if (!selId && batches.length) selId = batches[0].id;
      renderBatchList();
      if (selId) refreshDetail();
      else { renderChartsEmpty(); renderEvents(); renderIso(); updateCtl(); }
    });
  }

  /* ---------- 新建/编辑表单 ---------- */
  function openBatchForm(b) {
    formMode = b ? 'edit' : 'create';
    editId = b ? b.id : '';
    Q('he-batch-form').classList.remove('hidden');
    Q('he-form-title').textContent = b ? '编辑批次 ' + b.id : '新建批次';
    Q('he-form-id').textContent = b ? '' : '批次 ID 留空由云端自动生成';
    const set = (id, v) => { const el = Q(id); if (el) el.value = v == null ? '' : String(v); };
    set('f-b-name', b ? b.name : '');
    set('f-b-breed', b ? b.breed : '');
    set('f-b-base', b ? b.base : '');
    set('f-b-in', b ? b.in_count : '');
    set('f-b-cur', b ? b.cur_count : '');
    set('f-b-age', b ? b.age_days : '');
    set('f-b-tage', b ? b.target_age_d : '');
    set('f-b-note', b ? b.note : '');
  }
  function closeBatchForm() {
    formMode = '';
    editId = '';
    const f = Q('he-batch-form');
    if (f) f.classList.add('hidden');
  }
  function collectBatchForm() {
    const g = (id) => { const el = Q(id); return el ? el.value.trim() : ''; };
    return {
      name: g('f-b-name'), breed: g('f-b-breed'), base: g('f-b-base'),
      in_count: intOf(g('f-b-in')), cur_count: intOf(g('f-b-cur')),
      age_days: intOf(g('f-b-age')), target_age_d: intOf(g('f-b-tage')),
      note: g('f-b-note')
    };
  }
  async function saveBatch() {
    if (!canWrite()) { toast('无权限', '仅管理员/操作员可写入批次', 'err'); return; }
    const b = collectBatchForm();
    if (!b.name) { toast('保存失败', '请填写批次名称', 'warn'); return; }
    const body = {};
    Object.keys(b).forEach((k) => { if (b[k] !== null && b[k] !== '') body[k] = b[k]; });
    const path = formMode === 'edit' ? 'batches/' + editId : 'batches';
    const r = await apiEx(path, { method: formMode === 'edit' ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status === 200 && r.data && r.data.id) {
      toast('已保存', r.data.id + ' 已写入云端数据库', 'ok');
      closeBatchForm();
      await loadBatches();
      selId = r.data.id;                 // 新建后直接查看新批次
      renderBatchList();
      refreshDetail();
    } else {
      toast('保存失败', r.status === 403 ? '当前账号无写入权限（需 admin/operator）' : ((r.data && r.data.error) || ('HTTP ' + r.status)), 'err');
    }
  }
  async function delBatch(id) {
    if (!isAdmin()) { toast('无权限', '仅管理员可删除批次', 'err'); return; }
    if (!confirm('确认删除批次 ' + id + ' ？（其事件与均重采样将一并删除）')) return;
    const r = await apiEx('batches/' + encodeURIComponent(id), { method: 'DELETE' });
    if (r.status === 200) {
      toast('已删除', id + ' 已从云端移除', 'ok');
      if (selId === id) { selId = ''; detail = null; }
      loadBatches();
    } else {
      toast('删除失败', r.status === 403 ? '仅管理员可删除' : ((r.data && r.data.error) || ('HTTP ' + r.status)), 'err');
    }
  }

  /* ============================================================
   * 选中批次 → 详情（均重 / 事件 / 隔离 / 发病率）
   * ============================================================ */
  function selectBatch(id) {
    selId = id;
    renderBatchList();
    refreshDetail();
  }
  async function refreshDetail() {
    if (!selId || !api) return;
    const tipW = Q('he-wtip'), tipS = Q('he-stip');
    const d = await api('batches/' + encodeURIComponent(selId));
    if (!d || d.error) {
      if (tipW) tipW.innerHTML = '<div class="empty-tip">无法读取批次详情：云端后端不可达或会话过期，请刷新重试。</div>';
      if (tipS) tipS.innerHTML = '';
      return;
    }
    detail = d;
    const head = d.name ? esc(d.name) : esc(d.id);
    const note = esc(d.id) + ' · ' + head + ' · ' + fmtInt(d.cur_count) + '/' + fmtInt(d.in_count) + ' 只' +
      (d.age_days != null ? ' · ' + d.age_days + '日龄' : '') +
      (d.target_age_d ? '/' + d.target_age_d : '');
    const wn = Q('he-w-note'); if (wn) wn.textContent = note;
    const en = Q('he-ev-note'); if (en) en.textContent = d.name ? d.name + ' · ' + d.id : d.id;
    renderWeightChart(d.weights || []);
    renderEvents(d.events || []);
    loadIso(d.id);
    loadSick();
    updateCtl();
  }
  function renderWeightChart(rows) {
    const el = Q('he-wchart'), tip = Q('he-wtip');
    if (!el) return;
    if (!rows.length) {
      if (charts.w) { try { charts.w.dispose(); } catch (e) { /* 忽略 */ } charts.w = null; }
      el.innerHTML = '';
      if (tip) tip.innerHTML = '<div class="empty-tip"><b style="color:#4b5563">暂无均重采样</b><br>' +
        '批次均重由网关/称重站以 <code>samples kind=avg_weight</code>（meta.age_d 日龄）上报后绘制。</div>';
      return;
    }
    if (tip) tip.innerHTML = '';
    const xs = rows.map((r, i) => {
      const m = metaOf(r);
      return m.age_d != null ? String(m.age_d) : String(i + 1);
    });
    const vs = rows.map((r) => numOf(r.value));
    const unit = rows.find((r) => r.unit) ? rows.find((r) => r.unit).unit : 'g';
    if (!charts.w) charts.w = YQCx.make(el, {
      tooltip: { trigger: 'axis' },
      grid: { left: 52, right: 18, top: 30, bottom: 26 },
      xAxis: { type: 'category', name: '日龄(天)', data: xs },
      yAxis: { type: 'value', name: unit },
      series: [{ name: '均重', type: 'line', smooth: true, showSymbol: false, data: vs,
        lineStyle: { width: 2 }, areaStyle: { opacity: .12 } }]
    });
    if (charts.w) {
      charts.w.setOption({ xAxis: { data: xs }, yAxis: { name: unit }, series: [{ data: vs }] });
    }
  }
  function renderSickChart() {
    const el = Q('he-schart'), tip = Q('he-stip');
    if (!el) return;
    const rows = sickRows.slice().reverse(); // 接口新→旧；图表按时间升序
    if (!rows.length) {
      if (charts.sr) { try { charts.sr.dispose(); } catch (e) { /* 忽略 */ } charts.sr = null; }
      el.innerHTML = '';
      if (tip) tip.innerHTML = '<div class="empty-tip"><b style="color:#4b5563">暂无发病率采样</b><br>' +
        '由场区网关每日以 <code>samples kind=sick_rate</code>（value 为 %）上报后绘制。</div>';
      return;
    }
    if (tip) tip.innerHTML = '';
    const xs = rows.map((r, i) => fmtT(r.ts) === '—' ? String(i + 1) : fmtT(r.ts));
    const vs = rows.map((r) => numOf(r.value));
    const unit = rows.find((r) => r.unit) ? rows.find((r) => r.unit).unit : '%';
    if (!charts.sr) charts.sr = YQCx.make(el, {
      tooltip: { trigger: 'axis' },
      grid: { left: 52, right: 18, top: 30, bottom: 26 },
      xAxis: { type: 'category', data: xs },
      yAxis: { type: 'value', name: unit },
      series: [{ name: '发病率', type: 'line', smooth: true, showSymbol: false, data: vs,
        lineStyle: { width: 2, color: '#dc2626' }, areaStyle: { opacity: .12 } }]
    });
    if (charts.sr) charts.sr.setOption({ xAxis: { data: xs }, series: [{ data: vs }] });
  }
  function renderChartsEmpty() {
    const w = Q('he-wchart'), t1 = Q('he-wtip'), s = Q('he-schart'), t2 = Q('he-stip');
    if (charts.w) { try { charts.w.clear(); } catch (e) { /* 忽略 */ } charts.w = null; }
    if (charts.sr) { try { charts.sr.clear(); } catch (e) { /* 忽略 */ } charts.sr = null; }
    if (w) w.innerHTML = '';
    if (s) s.innerHTML = '';
    if (t1) t1.innerHTML = '<div class="empty-tip"><b style="color:#4b5563">未选择批次</b><br>请在上方「批次健康明细」选择或新建一个批次后查看均重趋势。</div>';
    if (t2) t2.innerHTML = '';
    if (Q('he-w-note')) Q('he-w-note').textContent = '未选择批次';
  }

  /* ---------- 事件时间线 ---------- */
  function renderEvents(evs) {
    const box = Q('he-events');
    if (!box) return;
    if (!selId) {
      box.innerHTML = '<div class="empty-tip"><b style="color:#4b5563">未选择批次</b><br>请先在「批次健康明细」中选择一个批次查看其健康事件。</div>';
      return;
    }
    if (!evs.length) {
      box.innerHTML = '<div class="empty-tip"><b style="color:#4b5563">暂无事件</b><br>' +
        '可在下方「登记事件」记录 enter进栏 / feed转料 / vaccine免疫 / weight称重 / health检疫 / transfer转群 / sale出栏。</div>';
      return;
    }
    box.innerHTML = evs.map((e) => `
      <div class="tl-item" style="padding:7px 2px">
        <div class="tl-date">${fmtT(e.ts)} <span class="tag ${KIND_TAG[e.kind] || 'tag gray'}" style="margin-left:4px">${esc(KIND_ZH[e.kind] || e.kind || '事件')}</span></div>
        <div class="tl-title">${esc(e.title || '')}</div>
        ${e.detail ? `<div class="tl-desc">${esc(e.detail)}</div>` : ''}
      </div>`).join('');
  }
  async function saveEvent() {
    if (!selId) { toast('请先选择批次', '在上方批次明细中点击一个批次', 'warn'); return; }
    if (!canWrite()) { toast('无权限', '仅管理员/操作员可登记事件', 'err'); return; }
    const title = Q('he-ev-title').value.trim();
    if (!title) { toast('登记失败', '请填写事件标题', 'warn'); return; }
    const kind = Q('he-ev-kind').value;
    const detailTxt = Q('he-ev-detail').value.trim();
    const r = await apiEx('batches/' + encodeURIComponent(selId) + '/events', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, title, detail: detailTxt || undefined })
    });
    if (r.status === 200 && r.data && r.data.id != null) {
      toast('已登记', selId + ' · ' + title + ' 已写入云端事件流', 'ok');
      Q('he-ev-title').value = '';
      Q('he-ev-detail').value = '';
      refreshDetail();
    } else {
      toast('登记失败', r.status === 403 ? '当前账号无写入权限' : ((r.data && r.data.error) || ('HTTP ' + r.status)), 'err');
    }
  }

  /* ---------- 隔离记录（samples kind=isolate_event） ---------- */
  function renderIso() {
    const box = Q('he-iso-list');
    if (!box) return;
    if (!selId) {
      box.innerHTML = '<div class="empty-tip"><b style="color:#4b5563">未选择批次</b><br>选择批次后显示该批隔离记录与快速登记入口。</div>';
      return;
    }
    if (!isoRows.length) {
      box.innerHTML = '<div class="empty-tip"><b style="color:#4b5563">暂无隔离记录</b><br>' +
        '人工登记或隔离网关以 <code>samples kind=isolate_event</code>（meta.zone/meta.note）上报后显示。</div>';
      return;
    }
    box.innerHTML = isoRows.map((r) => {
      const m = metaOf(r);
      return `<div class="ev-item" style="align-items:flex-start">
        <span class="ev-ico ico-a">${I('building-hospital', 13)}</span>
        <div style="min-width:0"><div style="font-size:12px;color:#111827;font-weight:500">${esc(m.zone || '—')}
          <span class="tag amber" style="margin-left:5px">隔离</span></div>
          <div style="font-size:10.5px;color:var(--dim)">${fmtT(r.ts)}</div>
          ${m.note ? `<div style="font-size:11px;color:var(--muted)">${esc(m.note)}</div>` : ''}</div>
      </div>`;
    }).join('');
  }
  function loadIso(batchId) {
    if (!api) return;
    api('samples?kind=isolate_event&batch=' + encodeURIComponent(batchId) + '&limit=200').then((rows) => {
      if (Array.isArray(rows)) { isoRows = rows; renderIso(); }
    });
  }
  function loadSick() {
    if (!api) return;
    api('samples?kind=sick_rate&limit=90').then((rows) => {
      if (Array.isArray(rows)) { sickRows = rows; renderSickChart(); }
    });
  }
  async function saveIso() {
    if (!selId) { toast('请先选择批次', '在上方批次明细中点击一个批次', 'warn'); return; }
    if (!canWrite()) { toast('无权限', '仅管理员/操作员可登记隔离', 'err'); return; }
    const zone = Q('he-iso-zone').value.trim();
    const note = Q('he-iso-note').value.trim();
    const r = await apiEx('samples', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'isolate_event', value: 1, batch: selId, meta: { zone: zone || '', note: note || '' } })
    });
    if (r.status === 200 && r.data && r.data.id != null) {
      toast('已登记', selId + ' 隔离记录已写入云端（value=1 · meta.zone=' + (zone || '—') + '）', 'ok');
      Q('he-iso-zone').value = '';
      Q('he-iso-note').value = '';
      loadIso(selId);
      loadMetrics(); // isolate KPI 由 metrics 上报；此处保持列表最新即可
    } else {
      toast('登记失败', r.status === 403 ? '当前账号无写入权限' : ((r.data && r.data.error) || ('HTTP ' + r.status)), 'err');
    }
  }

  /* ---------- 控件可用性（角色 + 选择状态） ---------- */
  function updateCtl() {
    const w = canWrite();
    const hasSel = !!selId;
    const evSave = Q('he-ev-save'), isoSave = Q('he-iso-save');
    const evTitle = Q('he-ev-title'), evKind = Q('he-ev-kind'), evDetail = Q('he-ev-detail');
    const iz = Q('he-iso-zone'), in_ = Q('he-iso-note');
    [evSave, isoSave, evTitle, evKind, evDetail, iz, in_].forEach((el) => { if (el) el.disabled = !(w && hasSel); });
    const add = Q('he-add-batch');
    if (add) add.classList.toggle('hidden', !w);
  }

  /* ---------- 生命周期 ---------- */
  function bindEvents() {
    const root = Q('page-health');
    if (!root) return;

    root.addEventListener('click', (e) => {
      // 优先级：行内按钮（编辑/删除/工具栏）→ 行点击选中
      const eb = e.target.closest('[data-edit-b]');
      if (eb) { const b = (batches || []).find((x) => x.id === eb.dataset.editB); if (b) openBatchForm(b); return; }
      const db2 = e.target.closest('[data-del-b]');
      if (db2) { delBatch(db2.dataset.delB); return; }
      if (e.target.closest('#he-add-batch')) { openBatchForm(null); return; }
      if (e.target.closest('#he-refresh')) { refreshAll(); return; }
      if (e.target.closest('#he-save-batch')) { saveBatch(); return; }
      if (e.target.closest('#he-form-cancel') || e.target.closest('#he-form-cancel2')) { closeBatchForm(); return; }
      if (e.target.closest('#he-ev-save')) { saveEvent(); return; }
      if (e.target.closest('#he-iso-save')) { saveIso(); return; }
      const row = e.target.closest('[data-sel]');
      if (row && !e.target.closest('button')) { selectBatch(row.dataset.sel); return; }
    });
  }

  function refreshAll() {
    loadMetrics();
    loadBatches();
    if (!selId && !batches) renderChartsEmpty();
  }

  function init() {
    if (inited) { refreshAll(); return; }
    inited = true;
    const root = Q('page-health');
    if (!root) return;
    root.innerHTML = html;
    bindEvents();
    refreshAll();
  }

  function tick() {
    const now = Date.now();
    if (!inited || now - lastTickMs < 3000) return;
    lastTickMs = now;
    tickSeq++;
    if (!Q('he-idx')) return;
    loadMetrics();
    // 批次与详情全量刷新：每 10 tick（≈30s）一次，避免写表单期间被打断
    if (tickSeq % 10 === 1 && !formMode) refreshDetail();
  }

  function onShow() {
    if (!inited) { init(); return; }
    refreshAll();
  }

  global.PAGES = global.PAGES || {};
  global.PAGES.health = { name: '鸡群健康分析', init, tick, onShow };
})(window);
