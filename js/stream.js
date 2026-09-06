/* ============================================================
 * 真实视频流播放器（浏览器侧）
 * 支持：
 *   - HLS (.m3u8)        —— hls.js / Safari 原生
 *   - HTTP-FLV (.flv)    —— flv.js（DJI/部分摄像头）
 *   - MP4/WebM 直链      —— 原生 video
 *   - RTSP/RTMP          —— 浏览器无法直连，返回 'need-relay'，
 *                           请用 mediamtx/ZLMediaKit 转 HLS 后填入 HTTP 地址
 *                           （见 docs/STREAMING.md）
 * 用法：
 *   const r = StreamBox.play(feedBox, url);   // feedBox 内自动建 <video>
 *   StreamBox.stop(feedBox);                  // 还原画布（若有）
 * ============================================================ */
(function (global) {
  'use strict';

  function current(feedBox) {
    return feedBox.querySelector('video.real-vid');
  }

  /* 停止并移除当前播放 */
  function stop(feedBox) {
    const v = current(feedBox);
    if (!v) return;
    try {
      if (v.__hls) v.__hls.destroy();
      if (v.__flv) v.__flv.destroy();
      v.pause();
      v.removeAttribute('src');
      v.load();
    } catch (e) { /* 忽略 */ }
    v.remove();
    const cv = feedBox.querySelector('canvas');
    if (cv) cv.style.display = '';
    const badge = feedBox.querySelector('.feed-badge');
    if (badge && badge.dataset.orig) badge.innerHTML = badge.dataset.orig;
  }

  function showBadge(feedBox, txt, cls) {
    const badge = feedBox.querySelector('.feed-badge');
    if (!badge) return;
    if (!badge.dataset.orig) badge.dataset.orig = badge.innerHTML;
    badge.innerHTML = '<span class="rec-dot"></span>' + txt;
    if (cls) badge.style.background = cls;
  }

  /*
   * 播放 HTTP 流。返回状态：
   *   'playing' 已挂载播放 | 'na' 非HTTP不处理 | 'error' 播放失败
   */
  function play(feedBox, url, opts) {
    // 幂等：同源视频已在播放则不重建（避免周期性刷新闪烁）
    const existing = current(feedBox);
    if (existing && existing.dataset.src === url) {
      try { if (existing.paused) existing.play(); } catch (e) { /* */ }
      return 'playing';
    }
    stop(feedBox);
    if (!url) return 'na';
    if (/^(rtsp|rtmp|rtmps):/i.test(url)) {
      // 需要转流：提示后保持原画布（见 docs/STREAMING.md）
      const bd = feedBox.querySelector('.feed-badge');
      if (bd && !bd.dataset.orig) bd.dataset.orig = bd.innerHTML;
      if (bd) bd.innerHTML = '<span class="rec-dot"></span>待转流·' + url.split(':')[0].toUpperCase();
      const nm = feedBox.querySelector('.feed-name');
      if (nm) nm.textContent = nm.textContent.split(' · ')[0] + ' · 已配 ' + url.split(':')[0].toUpperCase() + '，配置 HLS 后自动播放';
      return 'relay';
    }
    if (!/^https?:\/\//i.test(url)) return 'na';
    const v = document.createElement('video');
    v.className = 'real-vid';
    v.dataset.src = url || '';
    v.playsInline = true;
    v.muted = (opts && opts.muted !== undefined) ? !!opts.muted : true;
    v.autoplay = true;
    v.controls = !!(opts && opts.controls);
    feedBox.appendChild(v);
    const cv = feedBox.querySelector('canvas');
    if (cv) cv.style.display = 'none';
    const isHls = /\.m3u8([?#]|$)/i.test(url);
    const isFlv = /\.flv([?#]|$)/i.test(url);
    const onErr = () => { stop(feedBox); return 'error'; };

    try {
      if (isHls) {
        if (global.Hls && global.Hls.isSupported()) {
          const hls = new global.Hls({ maxBufferLength: 20, liveSyncDurationCount: 3 });
          v.__hls = hls;
          hls.loadSource(url);
          hls.attachMedia(v);
          hls.on(global.Hls.Events.ERROR, (ev, data) => {
            if (data && data.fatal) { if (data.type === 'networkError') hls.startLoad(); else if (hls) { try { hls.destroy(); } catch (e) { /* */ } } }
          });
          showBadge(feedBox, 'LIVE·HLS');
          return 'playing';
        }
        if (v.canPlayType('application/vnd.apple.mpegurl')) {
          v.src = url;
          showBadge(feedBox, 'LIVE·HLS');
          return 'playing';
        }
        return onErr();
      }
      if (isFlv) {
        if (global.flvjs && global.flvjs.isSupported()) {
          const f = global.flvjs.createPlayer({ type: 'flv', isLive: true, url }, { enableStashBuffer: false });
          v.__flv = f;
          f.attachMediaElement(v);
          try { f.load(); f.play(); } catch (e) { /* */ }
          showBadge(feedBox, 'LIVE·FLV');
          return 'playing';
        }
        return onErr();
      }
      // 原生可播格式
      v.src = url;
      showBadge(feedBox, 'LIVE');
      return 'playing';
    } catch (e) {
      return onErr();
    }
  }

  global.StreamBox = { play, stop, current };
})(window);
