# 真实视频/图传接入说明（STREAMING）

浏览器不能直接播放 `rtsp://` / `rtmp://`，因此需要一台**转流服务器**把它转成 HLS/HTTP-FLV。
本平台前端已内置播放器（`js/stream.js`，支持 HLS `.m3u8`、HTTP-FLV `.flv`、MP4/WebM），
**只要把设备页 `stream_url` 填成 http 地址，视频监控页/无人机 FPV 会自动切到真实画面**
（未填或填 RTSP 时保留原模拟画面并显示「待转流」角标）。

## 推荐方案 A：mediamtx + ffmpeg（轻量，单路起步）

```bash
# 1) 起转流服务（RTMP 1935 入、HLS/WebRTC 8888 出）
docker run -d --name mediamtx --restart unless-stopped \
  -p 1935:1935 -p 8888:8888 \
  bluenviron/mediamtx:latest

# 2) 每路摄像头一条 ffmpeg 转推（以海康为例；大华改 URL 即可）
ffmpeg -re -rtsp_transport tcp -i \
  "rtsp://admin:密码@192.168.1.21:554/Streaming/Channels/101" \
  -c copy -f flv rtmp://127.0.0.1:1935/live/cam01
```

3) 在「设备与网关」页把该摄像头 `stream_url` 填为：
   `http://服务器IP:8888/live/cam01/index.m3u8`（HLS，浏览器立即播放）
   或 `http://服务器IP:8888/live/cam01.m3u8`（看 mediamtx 版本约定，默认前者）。

> 多路/开机自启：写成 shell + systemd，或直接用 mediamtx 自带 `paths` 拉流配置（新版本支持 `source` 拉取 RTSP，可省 ffmpeg）。

## 方案 B：ZLMediaKit（国产、国标 GB28181、云台联动友好）

```bash
docker run -d --name zlm --restart unless-stopped \
  -p 1935:1935 -p 554:554 -p 8888:8888 -p 10000:10000 \
  zlmediakit/zlmediakit:master
```

- 摄像头主动把 RTSP 推到 ZLM：`rtsp://服务器IP:554/rtp/摄像头名`（或按你的 NVR 配置 GB28181）；
- 页面流地址填：`http://服务器IP:8888/rtp/摄像头名/hls.m3u8`
- 进阶：WVP 平台（wvp-GB28181-pro）可做国标设备接入 + 云台控制 + 录像回放，接口与本平台命令表对接即可。

## 无人机图传（FPV）

大疆机型图传出口常见形式：

| 来源 | 得到的流 | 填到 stream_url |
|---|---|---|
| DJI 上云 API（机场/遥控器 4G 上云） | 直播 URL（HTTP-FLV/RTMP/HLS） | 直接填（FLV 选 `.flv` 结尾，HLS 选 `.m3u8`） |
| 图传接收端输出 RTSP | 先走方案 A 转 HLS | `http://IP:8888/live/drone01/index.m3u8` |
| OBS/推流软件 | RTMP | 转 HLS 后填写 |

配置后打开「无人机检测面板」，FPV 卡自动切真机画面（HUD 仍叠加显示高度/电量/航向）。

## 播放器行为

- `.m3u8` → hls.js（Safari 原生回退）；`.flv` → flv.js；其余 http 直链原生播放；
- 无流 / 设备离线 → 保持原演示画面并标注；
- RTSP/RTMP 未转流 → 画面角标「待转流·RTSP」，按上方方案配置 http 地址后即自动播放；
- 真机视频页 4 路同时播放请保证转流服务器带宽（建议服务器在国内机房）。

## 常见问题

- **黑屏但有 LIVE 角标**：转流服务正常但视频编码不支持 → 改 ffmpeg `-c:v h264` 转码（部分 265 相机需转 H.264）；
- **卡顿**：`-rtsp_transport tcp` 必须（UDP 丢包）；或降分辨率子码流 `Channels/102`；
- **延迟**：HLS 天然 3~10s 延迟；要 1s 内低延迟用 ZLMediaKit WebRTC 或 HTTP-FLV（flv.js）。
