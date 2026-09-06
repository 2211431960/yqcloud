/* ============================================================
 * 图表公共封装（基于 ECharts，主题统一，组件失效时可优雅降级）
 * ============================================================ */
(function (global) {
  'use strict';
  const AXIS = {
    text: '#111827',
    muted: '#6b7280',
    line: '#e5e7eb',
    split: 'rgba(229,231,235,.8)'
  };
  const PALETTE = ['#6366f1', '#059669', '#d97706', '#dc2626', '#7c3aed', '#0891b2', '#65a30d'];

  function avail() { return typeof global.echarts !== 'undefined'; }

  /* 创建一个带统一主题的图表，失败返回 null（页面需自行容错） */
  function make(el, opts, height) {
    if (!el || !avail()) return null;
    try {
      const chart = global.echarts.init(el);
      if (height) el.style.height = height + 'px';
      try { el.dataset.chart = ''; } catch (e) { /* 非元素容器忽略 */ }
      const base = {
        color: PALETTE,
        textStyle: { color: AXIS.text, fontFamily: 'system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif' },
        grid: { left: 48, right: 18, top: 34, bottom: 26 },
        legend: { textStyle: { color: AXIS.muted, fontSize: 11 }, itemWidth: 12, itemHeight: 8, icon: 'roundRect' },
        tooltip: {
          backgroundColor: '#ffffff', borderColor: '#e5e7eb',
          textStyle: { color: '#111827', fontSize: 12 },
          axisPointer: { type: 'cross', crossStyle: { color: '#9ca3af' }, label: { backgroundColor: '#4f46e5', color: '#fff' } }
        },
        xAxis: { axisLine: { lineStyle: { color: AXIS.line } }, axisLabel: { color: AXIS.muted, fontSize: 11 }, splitLine: { show: false } },
        yAxis: { axisLine: { show: false }, axisLabel: { color: AXIS.muted, fontSize: 11 }, splitLine: { lineStyle: { color: AXIS.split } } }
      };
      chart.setOption(deep(base, opts), true);
      return chart;
    } catch (e) {
      if (el) el.innerHTML = '<div class="chart-loading"><div class="spinner"></div><div>图表组件加载失败</div></div>';
      return null;
    }
  }
  function deep(dst, src) {
    if (!src) return dst;
    Object.keys(src).forEach((k) => {
      const v = src[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) deep(dst[k], v);
      else dst[k] = v;
    });
    return dst;
  }
  function resizeAll() {
    global.echarts && global.echarts.getInstanceByDom && Array.from(document.querySelectorAll('div[data-chart]')).forEach((el) => {
      const c = global.echarts.getInstanceByDom(el);
      c && c.resize();
    });
  }
  function gaugeColor(v) { return v > 0.6 ? '#059669' : (v > 0.35 ? '#d97706' : '#dc2626'); }
  function lvColor(lv) { return lv === 'crit' ? '#dc2626' : (lv === 'warn' ? '#d97706' : '#2563eb'); }
  function lvTag(lv) { return lv === 'crit' ? 'tag red' : (lv === 'warn' ? 'tag amber' : 'tag sky'); }
  function lvIcoBox(lv) { return lv === 'crit' ? 'ico-r' : (lv === 'warn' ? 'ico-a' : 'ico-s'); }

  global.YQC = { AXIS, PALETTE, make, resizeAll, gaugeColor, lvColor, lvTag, lvIcoBox, avail };
})(window);
