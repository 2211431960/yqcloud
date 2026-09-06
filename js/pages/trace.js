/* ============================================================
 * 云端溯源中心（纯云端真实数据版）
 * - 数据全部来自后端：GET/POST/PUT/DELETE /api/batches[/(:id)[/events...]]
 * - 不引用 js/data.js 仿真引擎（YQ/YQx/TRACE_STEPS/GROWTH），无随机数、无伪二维码
 * - 空库/空数据时显示真实空态引导；无批次绝不渲染模拟批次/曲线
 * 依赖：node backend/server.js（http://127.0.0.1:8600）
 * ============================================================ */
(function (global) {
  'use strict';
  const UIx = global.UI, YQC = global.YQC;
  const Q = UIx.Q, esc = UIx.esc, toast = UIx.toast, pad = UIx.pad;

  /* ---------- 常量（页面自带映射，非仿真数据） ---------- */
  const KIND = [
    ['enter', '进栏', 'green', 'egg'],
    ['feed', '转料', 'amber', 'bolt'],
    ['vaccine', '免疫', 'sky', 'shield-check'],
    ['weight', '称重', 'purple', 'chart-bar'],
    ['health', '检疫', 'green', 'activity'],
    ['transfer', '转群', 'sky', 'arrow-right'],
    ['sale', '出栏', 'amber', 'truck']
  ];
  const KIND_MAP = {};
  KIND.forEach((k) => { KIND_MAP[k[0]] = { zh: k[1], cls: k[2], ico: k[3] }; });
  const kindMeta = (k) => KIND_MAP[k] || { zh: k || '其他', cls: 'gray', ico: 'clipboard' };
  const ST = {
    active: ['在栏养殖', 'green'], sold: ['已出栏', 'sky'], archived: ['已归档', 'gray']
  };
  const stMeta = (s) => ST[s] || [s || '—', 'gray'];

  /* ---------- 状态 ---------- */
  const state = {
    loaded: false, list: [], selId: null, detail: null,
    editor: '',            // '' | 'new' | 'batch'（新建/编辑展开态）
    chart: null,           // echarts 实例（避免重复 init）
    chartEl: null,
    polled: 0, lastSnap: '', err: false
  };

  const me = () => (UIx.auth && UIx.auth.user) || null;
  const canWrite = () => { const u = me(); return !!(u && (u.role === 'admin' || u.role === 'operator')); };
  const isAdmin = () => { const u = me(); return !!(u && u.role === 'admin'); };
  const num = (v) => (v === null || v === undefined || v === '') ? null : Number(v);
  const hasDetail = () => !!(state.selId && state.detail && state.detail.id);

  /* ---------- 格式化 ---------- */
  const fmtDT = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso).replace('T', ' ').slice(0, 16);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes());
  };
  const fmtShort = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso).slice(0, 10);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  };
  const fmtNo = (v) => (v === null || v === undefined || v === '') ? '—' : Number(v).toLocaleString('zh-CN');
  const localDT = () => {
    const d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' +
      pad(d.getHours()) + ':' + pad(d.getMinutes());
  };
  const metaAge = (s) => {
    try {
      const m = JSON.parse(s.meta || '{}');
      return (m.age_d === undefined || m.age_d === null) ? null : Number(m.age_d);
    } catch (e) { return null; }
  };

  /* ---------- 组件 ---------- */
  const cardHead = (ico, title, note, right) =>
    `<div class="card-h"><span class="h-ico">${I(ico, 15)}</span>${title}` +
    (note ? `<span class="card-title-note">${note}</span>` : '') +
    (right || '') + '</div><div class="h-divider"></div>';
  const codeTag = (t) => `<code style="background:#f3f4f6;padding:1px 5px;border-radius:4px">${t}</code>`;

  const noSelTip = () => {
    if (!state.loaded) return '正在连接云端…';
    if (!state.list.length) return '暂无批次：请先新建批次（admin/operator），或在养殖端经 POST /api/batches 写入后再查看';
    return '请先点击左侧列表选择一个批次，查看其云端档案/事件/曲线';
  };

  /* ============ 左侧：批次列表 / 新建表单 ============ */
  const pickListHtml = () => {
    if (!state.loaded) {
      return `<div class="empty-tip"><b>正在读取云端批次…</b><br>若长时间无响应，请确认已运行 node backend/server.js 并登录。</div>`;
    }
    if (!state.list.length) {
      return `<div class="empty-tip"><b>暂无溯源批次：由养殖端录入批次后生成溯源码</b><br>
        录入方式：本页「新建批次」（admin/operator），或养殖端 ERP/网关调用 ${codeTag('POST /api/batches')} 写入批次主档。<br>
        批次号（id）即溯源码，扫码查询复用 ${codeTag('GET /api/batches/:id')}。</div>`;
    }
    return state.list.map((b) => {
      const [szh, scls] = stMeta(b.status);
      const on = state.selId === b.id;
      return `<div data-act="pick" data-id="${esc(b.id)}" style="cursor:pointer;border:1px solid ${on ? '#c7d2fe' : '#f3f4f6'};border-radius:10px;padding:8px 10px;margin-bottom:8px;background:${on ? '#f5f3ff' : '#fff'};transition:border-color .15s ease-out">
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          <b style="font-size:12px;color:#111827;font-variant-numeric:tabular-nums">${esc(b.id)}</b>
          <span class="tag ${scls}">${szh}</span></div>
        <div style="font-size:12.5px;color:#374151;margin:3px 0 2px">${esc(b.name)}</div>
        <div style="font-size:10.5px;color:#9ca3af;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(b.breed || '')}${b.base ? ' · ' + esc(b.base) : ''}
          ${b.cur_count !== null && b.cur_count !== undefined ? ' · 存栏 ' + fmtNo(b.cur_count) + ' 只' : ''}
          ${b.age_days !== null && b.age_days !== undefined ? ' · ' + b.age_days + ' 日龄' : ''}</div>
      </div>`;
    }).join('');
  };

  const newBatchHtml = () => `<div class="card span-4">
    ${cardHead('egg', '新建批次 · 写入云端', '', '<span class="more" data-act="cancel-new">取消 ✕</span>')}
    <div class="card-b" style="padding-top:8px">
      <div style="display:flex;flex-direction:column;gap:9px">
        <div><label class="dv-lb">批次名称 *</label><input class="dv-in" id="nb-name" placeholder="如 云顶山散养A批 / 2026春育雏批"></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <div><label class="dv-lb">品种</label><input class="dv-in" id="nb-breed" placeholder="如 陇药土鸡"></div>
          <div><label class="dv-lb">场区/基地</label><input class="dv-in" id="nb-base" placeholder="如 步云村散养区A"></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <div><label class="dv-lb">入栏数（只）</label><input class="dv-in" id="nb-in" type="number" min="0" value="0"></div>
          <div><label class="dv-lb">当前存栏（只）</label><input class="dv-in" id="nb-cur" type="number" min="0" placeholder="默认=入栏数"></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <div><label class="dv-lb">当前日龄（天）</label><input class="dv-in" id="nb-age" type="number" min="0" value="0"></div>
          <div><label class="dv-lb">计划出栏日龄（天）</label><input class="dv-in" id="nb-target" type="number" min="0" placeholder="如 120"></div>
        </div>
        <div><label class="dv-lb">备注（雏源/免疫方案…选填）</label><input class="dv-in" id="nb-note"></div>
        <button class="btn primary" data-act="save-new">${I('circle-check', 13)} 创建批次（溯源码=批次号）</button>
        <div style="font-size:10.5px;color:#9ca3af">保存即 POST /api/batches，写入云端数据库；留空 id 由服务端生成 PYYYYMMDD-NN。</div>
      </div>
    </div>
  </div>`;

  const listCardHtml = () => {
    if (state.editor === 'new') return newBatchHtml();   // 展开态：整卡替换为新建表单
    const w = canWrite();
    return `<div class="card span-4">
      ${cardHead('box', '批次列表', '云端备案 · 溯源码=批次号',
        `<span class="tag gray" style="margin-left:auto">${state.loaded ? state.list.length : '–'} 批</span>`)}
      <div class="card-b" style="padding-top:8px">
        ${pickListHtml()}
        ${w ? `<button class="btn primary" style="width:100%;margin-top:6px" data-act="new-batch">${I('plus', 13)} 新建批次</button>` : ''}
        ${w ? '' : '<div style="margin-top:8px;font-size:11px;color:#b45309;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:7px 9px">只读：请联系管理员或操作员录入批次与事件。</div>'}
      </div>
    </div>`;
  };

  /* ============ 主区：批次档案（或编辑表单） ============ */
  const archHtml = () => {
    if (!state.selId) {
      return `<div class="card span-8">${cardHead('file-check', '批次档案 · 云端备案', '', '')}
        <div class="card-b"><div class="empty-tip"><b>${state.list.length ? '← 请选择左侧一个批次查看云端档案' : '暂无批次可查看'}</b><br>${state.list.length ? '' : '由 admin/operator 新建（POST /api/batches），或养殖端 ERP 写入批次主档。'}</div></div></div>`;
    }
    if (state.editor === 'batch') return editFormHtml();
    const b = state.detail || {};
    if (!b.id) {
      return `<div class="card span-8">${cardHead('file-check', '批次档案', '云端真实数据', '')}
        <div class="card-b"><div class="empty-tip"><b>正在读取 ${esc(state.selId)} 档案…</b></div></div></div>`;
    }
    const [szh, scls] = stMeta(b.status);
    let progTxt = '—', progW = 0;
    let progNote = '计划出栏日龄未设置（target_age_d=0），无法计算进度';
    if (num(b.target_age_d) > 0) {
      const age = Math.max(0, num(b.age_days) || 0);
      progW = Math.min(100, Math.round(age / num(b.target_age_d) * 100));
      progTxt = progW + '%';
      progNote = '生长进度 = 当前日龄 / 计划出栏日龄（' + num(b.target_age_d) + ' 天），非仿真';
    }
    return `<div class="card span-8">
      ${cardHead('file-check', '批次档案', '云端真实数据', `<span class="tag ${scls}" style="margin-left:auto">${szh}</span>`)}
      <div class="card-b" style="padding-top:8px">
        <div style="display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap">
          <div class="k-ico ico-g" style="width:46px;height:46px;border-radius:12px;flex:none">${I('egg', 22)}</div>
          <div style="flex:1;min-width:200px">
            <div style="font-size:16.5px;font-weight:700;color:#111827">${esc(b.name || '未命名批次')}</div>
            <div style="font-size:11.5px;color:#6b7280;margin-top:2px">${esc(b.breed || '品种未填')}${b.base ? ' · ' + esc(b.base) : ''}</div>
            <div style="display:flex;align-items:center;gap:8px;margin-top:7px;flex-wrap:wrap">
              <code style="font-size:14.5px;letter-spacing:.5px;background:#f3f4f6;padding:3px 9px;border-radius:7px;color:#111827">${esc(b.id)}</code>
              <button class="btn" data-act="copy-code" style="padding:3px 10px">${I('clipboard-check', 13)} 复制溯源码</button>
            </div>
            <div style="font-size:10.5px;color:#9ca3af;margin-top:4px">溯源码=批次号。扫一扫/扫码接口 = ${codeTag('GET /api/batches/:id')}，返回本档案（含事件链与称重采样）。</div>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:2px 16px;margin-top:12px">
          <div class="field-row" style="border:none;padding:4px 0"><span class="fr-name">入栏数</span><span class="fr-val">${fmtNo(b.in_count)} 只</span></div>
          <div class="field-row" style="border:none;padding:4px 0"><span class="fr-name">当前存栏</span><span class="fr-val"><b style="color:#047857">${fmtNo(b.cur_count)} 只</b></span></div>
          <div class="field-row" style="border:none;padding:4px 0"><span class="fr-name">日龄</span><span class="fr-val">${fmtNo(b.age_days)} 天</span></div>
          <div class="field-row" style="border:none;padding:4px 0"><span class="fr-name">计划出栏日龄</span><span class="fr-val">${fmtNo(b.target_age_d)} 天</span></div>
          <div class="field-row" style="border:none;padding:4px 0"><span class="fr-name">建档时间</span><span class="fr-val" style="font-size:11px">${fmtDT(b.created_at)}</span></div>
          <div class="field-row" style="border:none;padding:4px 0"><span class="fr-name">最近更新</span><span class="fr-val" style="font-size:11px">${fmtDT(b.updated_at)}</span></div>
        </div>
        ${b.note ? `<div style="font-size:11.5px;color:#6b7280;margin-top:8px;background:#f9fafb;border-radius:8px;padding:7px 10px">备注：${esc(b.note)}</div>` : ''}
        <div style="margin-top:12px">
          <div style="display:flex;justify-content:space-between;font-size:11.5px;color:#6b7280;margin-bottom:5px">
            <span>出栏进度</span><b style="color:#111827" id="tr-prog-txt">${progTxt}</b></div>
          <div class="progress"><i style="width:${progW}%"></i></div>
          <div style="font-size:10.5px;color:#9ca3af;margin-top:4px">${progNote}</div>
        </div>
        <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">
          ${canWrite() ? `<button class="btn primary" data-act="edit-batch">${I('pencil', 13)} 编辑档案 / 每日盘点（存栏·日龄）</button>` : ''}
          ${isAdmin() ? `<button class="btn danger" data-act="del-batch">${I('x', 13)} 删除批次（级联事件与采样）</button>` : ''}
        </div>
        ${canWrite() ? '<div style="font-size:10.5px;color:#9ca3af;margin-top:6px">「每日盘点」改当前存栏/日龄后保存 = PUT /api/batches/:id（局部字段），写云端数据库。</div>' : ''}
      </div>
    </div>`;
  };

  const editFormHtml = () => {
    const b = state.detail || {};
    const g = (k) => (b[k] === null || b[k] === undefined ? '' : b[k]);
    return `<div class="card span-8">
      ${cardHead('pencil', '编辑批次 ' + esc(state.selId), '修改后 PUT /api/batches/:id', '<span class="more" data-act="cancel-batch">取消 ✕</span>')}
      <div class="card-b" style="padding-top:8px">
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px 14px">
          <div><label class="dv-lb">批次名称 *</label><input class="dv-in" id="eb-name" value="${esc(g('name'))}"></div>
          <div><label class="dv-lb">品种</label><input class="dv-in" id="eb-breed" value="${esc(g('breed'))}"></div>
          <div><label class="dv-lb">场区/基地</label><input class="dv-in" id="eb-base" value="${esc(g('base'))}"></div>
          <div><label class="dv-lb">入栏数（只）</label><input class="dv-in" id="eb-in" type="number" min="0" value="${g('in_count')}"></div>
          <div><label class="dv-lb">当前存栏（只）· 每日盘点</label><input class="dv-in" id="eb-cur" type="number" min="0" value="${g('cur_count')}"></div>
          <div><label class="dv-lb">当前日龄（天）· 每日推进</label><input class="dv-in" id="eb-age" type="number" min="0" value="${g('age_days')}"></div>
          <div><label class="dv-lb">计划出栏日龄（天）</label><input class="dv-in" id="eb-target" type="number" min="0" value="${g('target_age_d')}"></div>
          <div><label class="dv-lb">状态</label>
            <select class="dv-in" id="eb-status"><option value="active"${b.status === 'active' ? ' selected' : ''}>在栏养殖 active</option>
            <option value="sold"${b.status === 'sold' ? ' selected' : ''}>已出栏 sold</option>
            <option value="archived"${b.status === 'archived' ? ' selected' : ''}>已归档 archived</option></select></div>
          <div style="grid-column:1/-1"><label class="dv-lb">备注</label><input class="dv-in" id="eb-note" value="${esc(g('note'))}"></div>
        </div>
        <div style="display:flex;gap:10px;margin-top:14px">
          <button class="btn primary" data-act="save-batch">${I('circle-check', 13)} 保存到云端</button>
          <button class="btn" data-act="cancel-batch">取消</button>
        </div>
        <div style="font-size:10.5px;color:#9ca3af;margin-top:6px">提示：称重采样不在此录入（走 POST /api/samples，见下方「生长曲线」接入说明）；事件在下方时间线登记。</div>
      </div>
    </div>`;
  };

  /* ============ 事件时间线 ============ */
  const evtHtml = () => {
    const b = state.detail;
    const evs = (b && b.events) || [];
    const headRight = hasDetail()
      ? `<span class="tag ${evs.length ? 'green' : 'gray'}" style="margin-left:auto">${evs.length} 条</span>` : '';
    if (!state.selId) {
      return `<div class="card span-6">${cardHead('route', '关键事件时间线', '', headRight)}
        <div class="card-b"><div class="empty-tip">${noSelTip()}</div></div></div>`;
    }
    let body;
    if (!state.detail) {
      body = '<div class="empty-tip">正在读取事件链…</div>';
    } else if (!evs.length) {
      body = `<div class="empty-tip"><b>该批暂无记录，用下方表单登记首个事件</b><br>
        事件类型：进栏 enter / 转料 feed / 免疫 vaccine / 称重 weight / 检疫 health / 转群 transfer / 出栏 sale<br>
        （POST /api/batches/:id/events，写入云端事件链）</div>`;
    } else {
      body = `<div class="timeline" style="padding-top:8px;max-height:290px;overflow-y:auto">` + evs.map((e) => {
        const km = kindMeta(e.kind);
        return `<div class="tl-item done">
          <div class="tl-date" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">${fmtDT(e.ts)}
            <span class="tag ${km.cls}" style="font-size:10px">${I(km.ico, 10)} ${km.zh}</span>
            ${isAdmin() ? `<span style="cursor:pointer;color:#dc2626" data-act="del-ev" data-id="${e.id}" title="删除该事件（仅管理员）">删除 ✕</span>` : ''}</div>
          <div class="tl-title">${esc(e.title)}</div>
          ${e.detail ? `<div class="tl-desc">${esc(e.detail)}</div>` : ''}
        </div>`;
      }).join('') + '</div>';
    }
    const foot = !state.detail ? '' : (!canWrite()
      ? '<div style="margin-top:10px;font-size:11px;color:#b45309;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:6px 9px">当前账号只读：请联系管理员或操作员登记事件。</div>'
      : `<div style="margin-top:12px;border-top:1px dashed #e5e7eb;padding-top:12px">
        <div style="font-size:12.5px;font-weight:600;color:#111827;margin-bottom:8px">${I('plus', 12)} 登记关键事件 · POST /api/batches/:id/events</div>
        <div style="display:grid;grid-template-columns:86px 1fr;gap:8px 10px;align-items:center">
          <label class="dv-lb" style="margin:0">类型</label>
          <select class="dv-in" id="ev-kind">${KIND.map((k) => `<option value="${k[0]}">${k[1]}（${k[0]}）</option>`).join('')}</select>
          <label class="dv-lb" style="margin:0">标题 *</label>
          <input class="dv-in" id="ev-title" placeholder="如 新城疫二免完成 / 转至散养区A"></div>
        <div style="display:grid;grid-template-columns:86px 1fr;gap:8px 10px;align-items:center;margin-top:8px">
          <label class="dv-lb" style="margin:0">详情</label>
          <input class="dv-in" id="ev-detail" placeholder="厂家/剂量/操作人/说明等（选填）"></div>
        <div style="display:grid;grid-template-columns:86px 1fr;gap:8px 10px;align-items:center;margin-top:8px">
          <label class="dv-lb" style="margin:0">发生时间</label>
          <input class="dv-in" id="ev-ts" type="datetime-local" value="${localDT()}"></div>
        <button class="btn primary" style="margin-top:10px" data-act="save-ev">${I('check', 13)} 登记事件 · 保存到云端</button>
      </div>`);
    return `<div class="card span-6">
      ${cardHead('route', '关键事件时间线', '云端事件链 · 只显示真实记录', headRight)}
      <div class="card-b" style="padding-top:6px">${body}${foot}</div>
    </div>`;
  };

  /* ============ 生长曲线 ============ */
  const growHtml = () => {
    const ws = (state.detail && state.detail.weights) || [];
    const headRight = hasDetail()
      ? `<span class="tag ${ws.length ? 'purple' : 'gray'}" style="margin-left:auto">${ws.length} 条</span>` : '';
    if (!state.selId) {
      return `<div class="card span-6">${cardHead('chart-line', '生长曲线（称重采样）', '', headRight)}
        <div class="card-b"><div class="empty-tip">${noSelTip()}</div></div></div>`;
    }
    let body;
    if (!state.detail) {
      body = '<div class="empty-tip">正在读取称重采样…</div>';
    } else if (!ws.length) {
      body = `<div class="empty-tip"><b>该批暂无称重采样——未画任何曲线，也不画品种标准对照虚线</b><br>
        接入方式：称重站/网关/移动端上报 ${codeTag('POST /api/samples')}<br>
        {"batch":"${esc(state.selId)}","kind":"avg_weight","value":212.5,"unit":"g","meta":{"age_d":12}}<br>
        （采样约定见 docs/API.md 第 3、7 节）</div>`;
    } else {
      body = `<div class="chart-lg" id="tr-chart" data-chart style="min-height:230px"></div>
        <div id="tr-chart-note" style="font-size:10.5px;color:#9ca3af;margin-top:4px">曲线=该批云端称重采样折线（均重/单只），按时间升序；无标准对照曲线。</div>
        <div style="max-height:160px;overflow-y:auto;margin-top:8px"><table class="table"><thead><tr>
          <th>日期</th><th>日龄</th><th>类型</th><th>体重</th></tr></thead><tbody>
          ${ws.map((s) => `<tr><td>${fmtShort(s.ts)}</td><td>${metaAge(s) !== null ? metaAge(s) + ' 天' : '—'}</td>
            <td>${esc(s.kind === 'avg_weight' ? '平均体重' : (s.kind === 'weight' ? '单只称重' : (s.kind || '—')))}</td>
            <td><b style="color:#111827">${num(s.value) !== null ? Number(s.value) : '—'} ${esc(s.unit || '')}</b></td></tr>`).join('')}
        </tbody></table></div>`;
    }
    return `<div class="card span-6">
      ${cardHead('chart-line', '生长曲线（称重采样）', '真实采样数据', headRight)}
      <div class="card-b" style="padding-top:8px">${body}</div>
    </div>`;
  };

  const layoutHtml = () => `<div class="content-scroll"><div class="grid">
    ${listCardHtml()}
    ${archHtml()}
    ${evtHtml()}
    ${growHtml()}
  </div></div>`;

  /* ---------- 渲染 ---------- */
  function disposeChart() {
    if (state.chart) {
      try { state.chart.dispose && state.chart.dispose(); } catch (e) { /* 忽略 */ }
      state.chart = null; state.chartEl = null;
    }
  }
  function render() {
    const root = Q('page-trace');
    if (!root) return;
    disposeChart();
    root.innerHTML = layoutHtml();
    drawChart();
    state.lastSnap = snapOf();
  }
  function drawChart() {
    const box = Q('tr-chart');
    const ws = (state.detail && state.detail.weights) || [];
    if (!box || !ws.length) return;
    const xs = [];
    const series = {};   // name -> {data:[]}
    const order = [];
    ws.forEach((w, i) => {
      const agd = metaAge(w);
      xs.push(agd !== null ? agd + ' 日龄' : '第 ' + (i + 1) + ' 次');
      const nm = w.kind === 'avg_weight' ? '平均体重' : (w.kind === 'weight' ? '单只称重' : (w.kind || '采样'));
      if (!series[nm]) { series[nm] = { data: new Array(i).fill(null) }; order.push(nm); }
      order.forEach((k) => {
        while (series[k].data.length < i) series[k].data.push(null);
        series[k].data.push(k === nm ? num(w.value) : null);
      });
    });
    const u0 = ws.find((w) => w.unit);
    const opt = {
      tooltip: { trigger: 'axis' },
      legend: { data: order },
      grid: { left: 54, right: 18, top: 34, bottom: 26 },
      xAxis: { type: 'category', data: xs },
      yAxis: { type: 'value', name: (u0 && u0.unit) || 'g', scale: true },
      series: order.map((k) => ({
        name: k, type: 'line', smooth: true, showSymbol: true, symbolSize: k === '平均体重' ? 7 : 5,
        connectNulls: false, lineStyle: { width: k === '平均体重' ? 2.4 : 1.6 }, data: series[k].data
      }))
    };
    const chart = YQC.make(box, opt);
    if (!chart) {
      const note = Q('tr-chart-note');
      if (note) note.innerHTML = '图表组件未加载：请以上方采样明细表为准。';
    }
  }

  /* ---------- 数据 ---------- */
  async function loadList() {
    const list = await UIx.api('batches');
    if (!list) { state.err = true; return; }
    state.err = false;
    state.loaded = true;
    state.list = list;
    if (state.selId && !list.some((x) => x.id === state.selId)) {
      state.selId = null; state.detail = null;
    }
  }
  async function loadDetail() {
    if (!state.selId) { state.detail = null; return; }
    const d = await UIx.api('batches/' + encodeURIComponent(state.selId));
    if (d && d.id) {
      state.detail = d;
    } else if (d === null) {
      // 后端不可达：保留旧档案，避免闪空
    } else {
      toast('读取批次失败', (d && d.error) || '批次可能已被删除', 'err');
      state.selId = null; state.detail = null;
    }
  }
  function snapOf() {
    const d = state.detail;
    const ww = (d && d.weights) || [];
    return JSON.stringify([
      state.list.map((x) => x.id + '@' + (x.updated_at || '') + '#' + (x.cur_count ?? '') + '#' + (x.age_days ?? '')).join('|'),
      d ? [d.id, d.updated_at, (d.events || []).length, (d.events || []).map((e) => e.id).join(','),
        ww.map((w) => w.id + ':' + w.value).join(',')].join('@') : ''
    ]);
  }
  async function refresh(force) {
    if (!state.inited) return;
    await loadList();
    if (!state.selId && state.list.length) state.selId = state.list[0].id;
    await loadDetail();
    state.polled = Date.now();
    const s = snapOf();
    if (force || s !== state.lastSnap) render();
  }

  /* 选中批次 → 拉取详情（含 events/weights）并渲染 */
  async function selectBatch(id) {
    state.selId = id;
    state.editor = '';
    state.detail = null;
    render();
    await loadDetail();
    render();
  }

  /* ---------- 操作 ---------- */
  async function createBatch() {
    const v = (id) => { const el = Q(id); return el ? el.value : ''; };
    const name = v('nb-name').trim();
    if (!name) { toast('无法创建', '请填写批次名称', 'warn'); return; }
    const p = {
      name,
      breed: v('nb-breed').trim(),
      base: v('nb-base').trim(),
      in_count: num(v('nb-in')) || 0,
      age_days: num(v('nb-age')) || 0,
      target_age_d: num(v('nb-target')) || 0,
      note: v('nb-note').trim()
    };
    const cur = num(v('nb-cur'));
    if (cur !== null && cur !== undefined) p.cur_count = cur; // 空=默认入栏数，交给后端
    const r = await UIx.apiEx('batches', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p)
    });
    if (r.status === 200 && r.data && r.data.id) {
      toast('批次已创建', r.data.id + ' 已保存到云端（溯源码=批次号）', 'ok');
      state.editor = '';
      await refresh(true);
      await selectBatch(r.data.id);
    } else {
      toast('创建失败', r.status === 403 ? '当前账号无录入权限（需 admin/operator）' : ((r.data && r.data.error) || 'HTTP ' + r.status), 'err');
    }
  }
  async function saveBatch() {
    const v = (id) => { const el = Q(id); return el ? el.value : ''; };
    const name = v('eb-name').trim();
    if (!name) { toast('保存失败', '批次名称不能为空', 'warn'); return; }
    const b = {
      name,
      breed: v('eb-breed').trim(),
      base: v('eb-base').trim(),
      in_count: num(v('eb-in')) || 0,
      cur_count: num(v('eb-cur')) || 0,
      age_days: num(v('eb-age')) || 0,
      target_age_d: num(v('eb-target')) || 0,
      status: v('eb-status') || 'active',
      note: v('eb-note').trim()
    };
    const r = await UIx.apiEx('batches/' + encodeURIComponent(state.selId), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b)
    });
    if (r.status === 200) {
      toast('已保存到云端', state.selId + ' 档案已更新（PUT /api/batches/:id）', 'ok');
      state.editor = '';
      await refresh(true);
    } else {
      toast('保存失败', r.status === 403 ? '当前账号无编辑权限（需 admin/operator）' : ((r.data && r.data.error) || 'HTTP ' + r.status), 'err');
    }
  }
  async function delBatch() {
    if (!state.selId) return;
    if (!confirm('删除批次 ' + state.selId + ' 将级联删除其全部关键事件与称重采样（不可恢复）。确认删除？')) return;
    const r = await UIx.apiEx('batches/' + encodeURIComponent(state.selId), { method: 'DELETE' });
    if (r.status === 200) {
      toast('已删除', state.selId + ' 及级联事件/采样已从云端移除', 'ok');
      state.selId = null; state.detail = null; state.editor = '';
      await refresh(true);
      if (state.list.length) await selectBatch(state.list[0].id);
    } else {
      toast('删除失败', r.status === 403 ? '仅管理员可删除批次' : ((r.data && r.data.error) || 'HTTP ' + r.status), 'err');
    }
  }
  async function addEvent() {
    const v = (id) => { const el = Q(id); return el ? el.value : ''; };
    const title = v('ev-title').trim();
    if (!title) { toast('无法登记', '请填写事件标题', 'warn'); return; }
    const body = { kind: v('ev-kind') || 'enter', title, detail: v('ev-detail').trim() };
    const ts = v('ev-ts');
    if (ts) body.ts = ts;
    const r = await UIx.apiEx('batches/' + encodeURIComponent(state.selId) + '/events', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    if (r.status === 200) {
      toast('事件已登记', '已保存到云端事件链（#EV' + r.data.id + '）', 'ok');
      await loadDetail();
      render();
    } else {
      toast('登记失败', r.status === 403 ? '当前账号无录入权限（需 admin/operator）' : ((r.data && r.data.error) || 'HTTP ' + r.status), 'err');
    }
  }
  async function delEvent(eid) {
    if (!isAdmin()) return;
    if (!confirm('确认删除该条事件记录？（仅删除云端该条事件，不可恢复）')) return;
    const r = await UIx.apiEx('batches/' + encodeURIComponent(state.selId) + '/events/' + eid, { method: 'DELETE' });
    if (r.status === 200) {
      toast('事件已删除', '该记录已从云端移除', 'ok');
      await loadDetail();
      render();
    } else {
      toast('删除失败', r.status === 403 ? '仅管理员可删除事件' : ((r.data && r.data.error) || 'HTTP ' + r.status), 'err');
    }
  }
  async function copyCode() {
    const code = state.selId;
    if (!code) return;
    const okTip = () => toast('溯源码已复制', code + '（扫码查询 GET /api/batches/' + code + '）', 'ok');
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(code);
        okTip();
      } else throw new Error('no-clip');
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = code;
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok2 = false;
      try { ok2 = document.execCommand('copy'); } catch (e2) { ok2 = false; }
      document.body.removeChild(ta);
      if (ok2) okTip(); else toast('复制失败', '请手动选择批次号复制', 'err');
    }
  }

  /* ---------- 事件委托 ---------- */
  function bind() {
    const root = Q('page-trace');
    root.addEventListener('click', (e) => {
      const hit = e.target.closest('[data-act]');
      if (!hit) return;
      const a = hit.dataset.act;
      const id = hit.dataset.id;
      if (a === 'pick') { selectBatch(id); return; }
      if (a === 'new-batch') { state.editor = 'new'; render(); return; }
      if (a === 'cancel-new') { state.editor = ''; render(); return; }
      if (a === 'edit-batch') { state.editor = 'batch'; render(); return; }
      if (a === 'cancel-batch') { state.editor = ''; render(); return; }
      if (a === 'save-new') { createBatch(); return; }
      if (a === 'save-batch') { saveBatch(); return; }
      if (a === 'del-batch') { delBatch(); return; }
      if (a === 'save-ev') { addEvent(); return; }
      if (a === 'del-ev') { delEvent(id); return; }
      if (a === 'copy-code') { copyCode(); return; }
    });
  }

  /* ---------- 生命周期 ---------- */
  function init() {
    if (state.inited) return;
    state.inited = true;
    const root = Q('page-trace');
    root.innerHTML = `<div class="content-scroll"><div class="grid">
      <div class="card span-12"><div class="card-b"><div class="empty-tip" style="padding:70px 10px"><b>正在连接云端…</b><br>读取批次 / 档案 / 事件 / 称重采样</div></div></div>
    </div></div>`;
    bind();
    refresh(true);
  }
  /* tick：节流 ≥3s；未 init / 展开编辑器 / 正在输入时不刷新整页 */
  function tick() {
    if (!state.inited || state.editor) return;
    const root = Q('page-trace');
    if (!root) return;
    if (document.activeElement && root.contains(document.activeElement)) return;
    if (Date.now() - state.polled < 3000) return;
    refresh(false);
  }
  function onShow() {
    if (!state.inited) init();
    else { state.editor = ''; refresh(true); }
  }

  global.PAGES = global.PAGES || {};
  global.PAGES.trace = { name: '云端溯源中心', init, tick, onShow };
})(window);
