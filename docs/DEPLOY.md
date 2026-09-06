# 陇药步云 · 上线部署指南（DEPLOY）

## 0. 访问入口

- 本地开发：`node backend/server.js` → 浏览器打开 **http://127.0.0.1:8600**
- 登录：默认 `admin / 123456`（`operator / 123456` 只读值班号；`gateway01 / gw-8600-secret` 设备网关服务账号）
- **上线第一件事：右上角账号菜单 → 修改密码**

## 1. 需要准备的资源（公网上线）

| 资源 | 说明 |
|---|---|
| 云服务器（1 核 2G 起） | 腾讯云/阿里云/华为云等，Ubuntu 22.04/24.04 |
| 域名 | 国内服务器需 ICP 备案（约 1~3 周），备案后才能用 80/443 |
| HTTPS 证书 | Let's Encrypt 免费（certbot） |
| （可选）对象存储 | 录像/抓拍文件多时用 COS/OSS |

> 没有服务器时的过渡方案：frp/ngrok/Tailscale 内网穿透到本机 8600 端口即可先让手机远程访问（仅演示与开发，正式请用云服务器）。

## 2. 一键部署（Docker）

```bash
# 服务器上
git clone <你的仓库> /opt/longxi-yunbu && cd /opt/longxi-yunbu
docker compose up -d --build
# 验证：curl -i http://127.0.0.1:8600/api/auth/me   → 401（说明服务正常、鉴权生效）
```

免 Docker（systemd）：把目录放到 `/opt/longxi-yunbu`，按 `deploy/longxi-web.service` 安装。

## 3. Nginx + HTTPS

按 `deploy/nginx.conf.example` 配置反代后：

```bash
sudo certbot --nginx -d your.domain.com
```

安全建议：
- 服务器安全组只放行 80/443（**不要**对公网开放 8600），SSH 改密钥登录；
- Node 服务只监听 `127.0.0.1`（HOST=127.0.0.1）；
- 定期备份：`data/yqcloud.db`（SQLite 单文件，直接复制即可，WAL 模式需同时拷贝 -wal/-shm 或先 `PRAGMA wal_checkpoint`）。

## 4. 账号与权限（已内置）

- `admin`：设备增删改、航线编辑、站点定位、用户管理、全部指令；
- `operator`：查看 + 控制指令 + 告警处理（不可改设备/删除）；
- `device`：仅供**设备网关**上报遥测/告警、轮询指令回执，无页面权限。

管理用户 API（管理员）：
```bash
TOKEN=$(curl -s -X POST http://127.0.0.1:8600/api/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"你的新密码"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')

curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8600/api/users                  # 用户列表
curl -X POST http://127.0.0.1:8600/api/users -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"username":"zhang","name":"张场长","role":"admin","password":"******"}'
curl -X PUT http://127.0.0.1:8600/api/users/2/password -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"newPassword":"******"}'
```

## 5. 真实设备接入上线清单

1. **摄像头**：设备页填真实 RTSP → 视频页已显示通道配置；播放画面需在网关做
   HLS/WebRTC 转流（参考 ZLMediaKit/WVP 或海康 NVR 对接），把 `stream_url` 换成可播放地址；
2. **无人机**：DJI 上云 API（机场/遥控器 4G 上云）或地面站 MAVLink 桥（pymavlink 脚本）
   轮询 `/api/commands` 执行起飞/返航等并回执，遥测经 `/api/telemetry` 推 GPS/电量（前端地图已预留标记层）；
3. **传感器/补食机**：Modbus/RS485 采集网关（DTU 或工控机）定时上报；
4. **告警**：网关调用 `POST /api/alarms`（用 device 账号 token）。
5. **安全**：网关与服务器之间建议走 HTTPS + 专用 `device` 账号；局域网设备不做端口映射，
   由网关主动出站连接（MQTT/HTTPS 轮询均可）。

## 6. 合规与运营提醒

- 视频监控涉及个人信息/公共区域需按《个人信息保护法》做告知与最小化存储；
- 地图瓦片：正式商用请申请高德开放平台 Key（lbs.amap.com）替换公开瓦片；
- 服务器所在地法规：经营性平台可能需 ICP 许可证，个人农场自用一般备案即可；
- 无人机飞行：遵守当地空域规定（禁飞区/报备），DJI 机型默认遵守 GEO 限飞。

## 7. 环境变量速查

| 变量 | 默认 | 说明 |
|---|---|---|
| PORT | 8600 | 服务端口 |
| HOST | 0.0.0.0 | 监听地址（生产建议 127.0.0.1 由 nginx 反代） |
| YQ_DB | data/yqcloud.db | 数据库路径 |
| YQ_LOG | data/logs/access.log | 访问日志 |
| CORS_ORIGIN | 空 | 跨域来源白名单（默认同源部署） |
| NODE_ENV | - | production 后写日志文件、控制台安静 |
