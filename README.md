# 陇药步云 · 山地散养鸡云监控平台

云端数据监控平台：前端（总览/视频/无人机/补食/健康/溯源/报警/设备）+ 云端后端（SQLite 数据库 + REST API + 登录鉴权）。
**页面 100% 只展示云端真实数据**：在「设备与网关」登记真实无人机、摄像头、补食机等，网关心跳上报后自动点亮并可在云端下发控制指令；未接入时页面只显示真实的“未连接/未接入”空态引导。

## 后台访问入口

```bash
node backend/server.js    # 或直接 node server.js（兼容入口）
# 浏览器打开 → http://127.0.0.1:8600
```

**登录账号**（首次登录后请立即在右上角账号菜单中修改密码）：

| 账号 | 密码 | 角色 | 权限 |
|---|---|---|---|
| admin | 123456 | 管理员 | 设备增删改/用户管理/全部控制 |
| operator | 123456 | 操作员 | 查看 + 控制指令 + 告警处理 |
| gateway01 | gw-8600-secret | 设备网关 | 仅遥测上报/告警上报/指令回执轮询 |

- 「设备与网关」页 = 设备台账后台（替换真实设备的入口）
- 「天气检测」页 = **手机天气式多地区天气预报**：默认基地 SITE-1（真实地区：甘肃陇西县菜子镇步云村），
  可**搜索/切换任意城市、县、镇**查看当地预报（Photon/OSM 地理编码 + Open-Meteo：当前实况 + 24h 趋势 + 3 日），
  最近查看地区自动记忆；**预警自动上报**：规则引擎（backend/weather.js RULES）命中即写入云端告警中心——
  基地与已设「监测点」（后台每 10 分钟自动巡检，不打开页面也在盯防）持续巡检；**其它任何地区在查看或
  「立即检测」时命中同样自动上报**（按坐标区分、同地区同类 open/10 分钟去重防刷屏）→ 全局铃铛/角标联动、
  报警中心统一处置。
- 「用户/接口/部署」见 [docs/DEPLOY.md](docs/DEPLOY.md)（含 Docker、HTTPS、上线清单）
## 设备“连接”语义（上线模式）

- **没有真实接入的设备一律显示「未连接」**（前端不存在任何模拟动画/模拟数值）；
- 判定规则：设备在最近 90 秒内有真实遥测/心跳（`POST /api/telemetry`，网关 2~60s 定时上报即可）且未标记离线 → 显示「已连接」；
- 全局顶部横幅会提示“尚未接入真实设备 / 已接入 N 台”；
- 接入点亮后：无人机页机队卡片显示真机电量/高度/坐标、态势图按云端航点连线，视频页按摄像头心跳点亮通道并播放所配 HTTP 流。

## 删除 / 改名 / 总览 KPI 是怎么工作的

- **删除后不再复活**：默认设备模板只在**首次启动**（或显式“恢复模板”）时写入一次。您在
  「设备与网关」删除的无人机/摄像头**重启后端也不会恢复**，无人机页/视频页随之显示“暂无设备”空态引导；
  需要默认模板时由管理员点「恢复默认模板」（或 `POST /api/devices/restore-template`，仅 admin，403 越权保护）。
- **名称完全可自定义**：设备表点设备 ID（带 ✎ 光标）或行尾「编辑」，名称/用途/型号/厂商/SN/协议/视频流地址
  均可改，改完点“保存到云端数据库”，无人机页/视频页/总览等所有页面下次刷新即用新名称。
- **总览 KPI（存栏/今日产蛋/今日补食/健康指数）不是编出来的**：它们显示的是“业务指标”
  （`POST /api/metrics`）里的**云端上报值**，无人上报时显示「未接入」占位与接入说明，绝不显示仿真数值。
  数据源由您的场区上报：集蛋线计数、电子地磅称重、料塔余量网关、鸡群健康评估/ERP 系统等，例如：

```bash
# 集蛋线/计数网关每小时上报一次即可
curl -X POST http://127.0.0.1:8600/api/metrics -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"type":"birds","name":"存栏","value":1286,"unit":"只","source":"count-gw-01","note":"晨点"}'
# 支持类型：birds / eggs_today / feed_kg_today / water_kg_today / health_index …
# GET /api/metrics 读取；DELETE /api/metrics/:type 删除（仅 admin）
```

- **总览页还提供「环境控制面板」**：风机/湿帘/喷雾/料线/补光/散放门 7 路开关，每路先在下拉框绑定一台
  执行设备（网关/补食机/机巢…），拨动开关即向该设备下发 `relay` 控制指令 → 网关执行并回执（闭环同设备指令）。

## 客户接入三步走（上线交付场景）

1. **账号**：管理员在后台建客户账号（admin/operator/device）；
2. **登记设备**：客户在「设备与网关」登记自己的无人机/摄像头（型号、SN、协议、RTSP/HLS 地址）；
3. **网关接入**：
   - 无人机：运行 `gateway/drone_bridge.py`（MAVLink）→ 自动上报遥测/领取指令并回执 → 页面“已连接”；
   - 摄像头：网关心跳 `POST /api/telemetry {"deviceId":"CAM-XX","status":"online"}` + 配置可播放流地址 → 通道点亮出画面；
   - 验证命令：`node tools/e2e-customer.mjs`（22 项上线测试，全 PASS 后交付）。

- 数据库文件：`data/yqcloud.db`（SQLite，Node >= 22.5 内置 `node:sqlite`，零依赖）
- **数据保留与下载**：遥测/告警/指令/采样默认保存最近 30 天（`DATA_KEEP_DAYS` 可调），自动删除过期记录；
  「设备与网关 → 数据下载窗口」可按月一键导出 CSV（接口见 docs/API.md 6.2）
- 前端必须通过后端访问（登录鉴权 + 云端数据），不可直接双击打开。

## 目录结构

```
backend/db.js     数据库 schema + 一次性默认设备模板
backend/server.js REST API + 静态服务 + 指令回执（开发联调带 DEMO_ACK）
backend/weather.js Open-Meteo 预报代理 + 天气预警规则引擎
docs/API.md       接口契约（页面与网关唯一数据约定）
js/pages/*.js     各监控页（全部只消费 REST 接口）
tools/lint-nosim.mjs  仿真残留静态检查
```

## REST API（前缀 /api）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/bootstrap | 站点+设备+KV 全量 |
| GET/POST | /api/devices | 设备列表 / 新增 |
| GET/PUT/DELETE | /api/devices/:id | 单个设备 查/改/删 |
| POST | /api/devices/:id/command | **下发控制指令**（落库，网关可取走执行） |
| GET | /api/commands | 指令列表与回执状态 |
| POST | /api/telemetry | **遥测上报**（网关/设备调此接口推送经纬度/电量/状态） |
| GET | /api/devices/:id/telemetry | 遥测历史 |
| GET/POST | /api/alarms | 告警查询 / 设备告警上报 |
| POST | /api/alarms/:id/ack | 确认告警 |
| GET/POST | /api/waypoints | 无人机航线（按 device_id） |
| GET/PUT | /api/sites | 站点（含机巢坐标，可在页面用地图定位回写） |
| GET/POST | /api/metrics | 业务指标（总览 KPI：存栏/产蛋/补食量/健康指数…） |
| DELETE | /api/metrics/:type | 删除指标（仅 admin） |
| GET/POST | /api/samples | 采样时序（均重/发病率/逐时产量，网关/称重站上报） |
| GET/POST/PUT/DELETE | /api/batches | 溯源批次主档（含事件、生长采样详情） |
| POST | /api/batches/:id/events | 批次关键事件（进栏/免疫/检疫/出栏…） |
| GET | /api/devices/:id/telemetry?metric=temp | 遥测历史或按指标提取曲线 |
| GET | /api/commands?cmd=feed_now&status= | 指令流水（可按指令/状态过滤） |
| GET/PUT | /api/kv/:key | 策略配置（自动补食、无人机联动等，网关轮询） |
| POST | /api/devices/restore-template | 恢复默认设备模板（仅 admin） |
| GET | /api/weather?lat&lon&label | 天气（默认基地；带坐标=自定义地区，含预警评估 warnings/rules/codes） |
| GET | /api/geocode?q= | 地区搜索（城市/县/镇 → 坐标，Photon/OSM 免费无 Key） |
| POST | /api/weather/check | 立即天气巡检（无坐标=基地并自动上报；带坐标=仅本地评估） |
| GET | /api/weather/alerts | 最近天气预警（alarms · SEN-03 气象站） |
| GET | /api/cloudsat · /api/geoip | 风云四号卫星云图帧 / IP 定位（后端代理，接口保留） |

> 完整字段与网关上报示例见 [docs/API.md](docs/API.md)。页面接口明细见 [docs/API.md](docs/API.md)。

## 登记您的真实设备（无人机 / 摄像头 / 补食机 / 传感器）

### 1. 无人机（大疆 / 御3E 等）
1. 进入「设备与网关」页登记/编辑您的无人机：填写 **名称/型号/SN/协议**（支持任意自定义名称，改完云端所有页面同步）；
2. 图传：把设备的 `视频流地址` 填为网关转流后的 HTTP 地址（`http://…/index.m3u8` 等），无人机页 FPV 自动播放；
3. 云控链路（推荐方式）：网关机运行 MAVLink 桥接 `gateway/drone_bridge.py`，**轮询**
   `GET /api/commands?status=sent` 取到 `takeoff / rtl / land / start_patrol / charge / stream_on` 后经
   MAVLink 执行，`POST /api/telemetry` 回报实况、`POST /api/commands/:id/ack` 回执。

### 2. 监控摄像头（海康/大华/萤石等）
1. 登记摄像头并把 RTSP/转流地址填到 `视频流地址`；
2. 视频监控页按台账动态生成通道：心跳点亮后出画面；云台/抓拍/录像/喊话按钮下发
   `gimbal_home/gimbal/shot/record/speaker` 指令（需网关按 ONVIF/厂商 SDK 执行并回执）；
3. 无真实流时页面只显示静态"未连接/无视频流"占位，**不渲染模拟画面**（RTSP/RTMP 需转流，见 docs/STREAMING.md）。

### 3. 传感器 / 补食机 / 气象 / 围栏
在设备页登记（协议填 Modbus/RS485/MQTT 等）。补食机料位经遥测 `extra.level_pct` 上报、总览 KPI 经
`/api/metrics` 上报、批次健康/产量经 `/api/samples` 上报、告警经 `/api/alarms` 上报，页面随即点亮。

## 云端控制与回执闭环

页面点「起飞/返航/云台/补食/环境开关」→ `POST /api/devices/:id/command` 写入 commands 表（queued→sent）→
**真实网关**（无人机 `gateway/drone_bridge.py`，摄像头/补食机为 MQTT/Modbus 网关）轮询
`GET /api/commands?status=sent` 取走执行 → 执行完 `POST /api/commands/:id/ack` 回执 →「设备与网关」页查看指令流水。
设备离线时指令自动标记 `fail`。

> 开发模式（未设置 `NODE_ENV=production` 且 `DEMO_ACK!=0`）下后端自带 4 秒自动回执（仅联调用）；
> **生产部署 `NODE_ENV=production` 后模拟回执自动关闭**，只认真实网关回执（见 docs/DEPLOY.md）。

## 遥测上报示例（网关侧）

```bash
curl -X POST http://127.0.0.1:8600/api/telemetry \
  -H 'Content-Type: application/json' \
  -d '{"deviceId":"DRONE-01","lat":34.96123,"lon":104.45211,"alt":55,"batt":72,"status":"patrol"}'
```

无人机位置/状态实时显示在无人机页机队卡片与态势图注记；遥测 90 秒窗口内设备自动点亮为"已连接"。
更多示例（环境键、指标、采样、回执）见 [docs/API.md](docs/API.md) 第 7 节。

## 高精度定位（北斗/GNSS）

站点表（SITE-1）记录机巢/天气预警计算点的 RTK 坐标与行政区信息，为云端数据源；
「设备与网关 → 机巢站点」卡可查看，各设备经纬度可在设备编辑表单维护。
真实厘米级定位需终端北斗/GNSS 接收机（机巢、无人机、手持端）上报 RTK 解算坐标。

## 注意
- 页面 100% 只展示后端真实接口数据：设备未接入=“未连接”、指标未上报=“未接入/—”；
  无任何仿真引擎或模拟画面（校验：`node tools/lint-nosim.mjs`）；
- 默认设备模板只在首次启动或管理员点击「恢复默认模板」时写入，删除即永久生效。
