# 云端接口契约（前端页面 / 网关 唯一数据来源）

> 本文件是「页面只消费真实接口」改造的权威契约。前端任何一页都不允许出现
> 随机数、仿真引擎(YQ.state)、静态“演示”行、假装在线的状态。
> 未接入时页面显示：真实空态引导（`empty-tip` 样式）或 `— / 未连接`，绝不显示模拟数值。

## 0. 通用约定

- 基址 `http://127.0.0.1:8600/api`；除 login 外全部需要 `Authorization: Bearer <token>`。
- 角色：`admin`（全权）、`operator`（查看+控制+业务录入）、`device`（网关上报：telemetry/alarms/samples/commands ack 轮询）。
- 前端助手（js/ui.js）：`UI.api(path, opts)` → 数据或 null（401 自动弹登录门）；
  `UI.apiEx(path, opts)` → `{status, data}`（需区分 403 时用）；
  `UI.auth.user`（含 role）；`UI.watchCmd(deviceId, cmdId, label)`；
  `UI.toast(title, msg, kind)`；`UI.Q/$$/esc/setNum/nowText/pad`。
- 图表：`global.YQC.make(el, option, height?)`（ECharts 封装，失败返回 null 需容错），
  空数据时给图表容器下方一条空态说明（不画假曲线）。
- 空态文案风格：先说“暂无/未接入”，再说怎么接入（设备/网关如何上报），可引用 README 接口名。
- 页面模块外壳保持一致：IIFE + `global.PAGES.x = { name, init, tick, onShow }`；
  `tick()` 每秒被 app 调用但必须自带节流（模块级 `tickSeq++`/时间戳），未 init 时直接 return。
- **禁止**引用 js/data.js 的任何仿真对象（YQ.state/YQ.tick/YQ.actions/仿真常量/随机），页面自带所需常量或从接口读。

## 1. 设备与连接

- `GET /api/devices?type=drone|camera|feeder|sensor|gateway|nest|rtk|weather`
  行内字段：`id,type,sub,name,model,vendor,sn,protocol,stream_url,lat,lon,alt,batt,status,config,note,
  updated_at,live,last_seen`。`live=true` ⇔ 最近 90s 有遥测且未 offline。**已连接判定只用 live**。
- `GET /api/devices/:id`；`POST/PUT/DELETE /api/devices`、`/api/devices/:id`（写仅 admin）。
- `POST /api/devices/:id/command {cmd, params}` → 返回 commands 行（`id`）。cmds：
  drone `takeoff|rtl|land|charge|start_patrol|stream_on`；camera `gimbal_home|reboot|shot|record|speaker|gimbal{dir}`；
  feeder `feed_now`；通用 `relay {relay,state}`（总览环境控制）。
- `GET /api/commands?device_id=&status=&cmd=&limit=`（指令=任务/操作流水，含 `id,cmd,status(queued/sent/ack/fail),ack_msg,created_at`）。
- `POST /api/commands/:id/ack {status:'ack'|'fail', msg}`（网关回执）。
- `POST /api/telemetry {deviceId, lat,lon,alt?,batt?,status?,extra?}`：网关心跳/实况上报；
  extra 任意 JSON（温湿度键如 `{temp,hum,nh3,level_pct,feed_kg_today,...}`），服务端会把
  `speed/mode/armed/heading` 并入 device.config 为 `tel_*`。
- `GET /api/devices/:id/telemetry?limit=60` → 原始遥测行（含 `extra` JSON 字符串，自行 parse）。
- `GET /api/devices/:id/telemetry?metric=temp&limit=120` → `[{ts, v}]`（内置键 lat/lon/alt/batt；
  其余从 extra 或 extra.weather 提取数值键），是环境/设备趋势图唯一数据源。

## 2. 业务指标（最新快照）

- `GET /api/metrics` → `[{type,name,value,unit,source,note,ts}]`（每 type 一条最新值）。
- `POST /api/metrics {type,value,unit?,name?,source?,note?}`（网关/ERP/人工，upsert）。
- `DELETE /api/metrics/:type`（admin）。
- 语义 type 约定：`birds 存栏只`、`eggs_today 今日产蛋枚`、`feed_kg_today 今日补食kg`、
  `water_kg_today 今日饮水kg`、`health_index 健康指数0-100`、`mortality 死亡率%`。

## 3. 采样时序（健康/批次/逐时趋势）

- `GET /api/samples?kind=&batch=&device_id=&limit=`（按 id 倒序最新在前）。
- `POST /api/samples {kind, value, unit?, batch?, device_id?, meta?}`（device/admin/operator 均可=网关上报方）。
- `DELETE /api/samples/:id`（admin）。
- kind 约定：`avg_weight`(批次均重 g, meta.age_d 日龄)、`weight`(个体)、`sick_rate`(发病率%每日一条)、
  `isolate_event`(隔离记录 value=1, meta:{zone,note} 列表用)、`intake_h`(逐时采食kg meta.hour)、
  `eggs_h`(逐时产蛋枚 meta.hour)。

## 4. 批次与溯源

- `GET /api/batches` → 批次列表；`GET /api/batches/:id` → 批次 + `events[]` + `weights[]`(该批 avg_weight/weight 采样)。
- `POST /api/batches {id?,name,breed?,base?,in_count?,cur_count?,age_days?,target_age_d?,status?,note?}`（admin/operator）。
- `PUT /api/batches/:id`（admin/operator，可改 `cur_count/age_days/status/note/...` 每日盘点/日龄推进）；
  `DELETE /api/batches/:id`（admin，级联事件与采样）。
- `POST /api/batches/:id/events {kind?,title,detail?,ts?}` / `GET /api/batches/:id/events` /
  `DELETE /api/batches/:id/events/:eid`（admin）。
- kind 约定：enter 进栏 / feed 转料 / vaccine 免疫 / weight 称重 / health 检疫 / transfer 转群 / sale 出栏。
- 扫码= `GET /api/batches/:id`（id 即溯源码）。

## 5. 告警

- `GET /api/alarms?status=open|ack|misreport&device_id=&limit=` → `[{id,device_id,lv(crit|warn|info),type,ico,msg,status,created_at}]`。
- `POST /api/alarms {deviceId?,lv?,type?,ico?,msg}`（网关经 device 账号/`x-gw` 头上报）。
- `POST /api/alarms/:id` 确认；`POST /api/alarms/:id/misreport` 误报（admin/operator）。

## 6. 站点 / 策略 / 杂项

- `GET /api/sites`（SITE-1 …）；`PUT /api/sites/:id {lat,lon,...}`（admin）。
- `GET /api/kv/:key` → `{k,v}`；`PUT /api/kv/:key {v}`（admin）。策略开关落 KV，网关轮询：
  约定键 `policy.feed_auto`（自动补食 0/1）、`policy.drone.*`（自动返航/夜间巡检/告警推送 0/1）。

### 数据保留与导出（第 6.2 节）

- **保留策略**：遥测 telemetry / 告警 alarms / 指令流水 commands / 采样 samples 默认保留最近
  `DATA_KEEP_DAYS` 天（默认 30，环境变量可调），服务启动后 30 秒 + 每 6 小时自动删除过期记录；
  档案型数据（设备/用户/站点/批次与溯源事件/业务指标快照）长期保留，不参与自动清理。
- `GET /api/export?month=YYYY-MM&kind=telemetry|alarms|commands|samples`（admin/operator）：
  按月导出 CSV（UTF-8 + BOM，Excel 直接打开），流式返回不占内存；月份格式校验，历史月份若已被策略
  清理则仅返回表头。
- `POST /api/system/purge`（仅 admin）：立即执行一次过期数据清理，返回 `{keepDays, removed:{telemetry,alarms,commands,samples}}`。

### 天气检测（第 6.1 节）

- `GET /api/weather`：默认返回**基地 SITE-1** 的 Open-Meteo 预报（`current` 实况 + `hourly` 逐时 + `daily` 3日），
  并附预警引擎评估结果：`warnings[]`（命中项 lv/type/ico/msg）、`rules[]`（7 项要素当前值/阈值/状态）、`codes[]`。
- `GET /api/weather?lat=30.66&lon=104.06&label=成都`：**自定义地区**（手机天气式）。校验经纬度范围；
  label 会写入 `location.name/address`；自定义地区不会写 SEN-03 遥测（不污染基地设备数据）。
  引擎命中即写入云端告警中心（device_id=`WX-<坐标>`，msg 带【地区名】前缀；与基地 SEN-03 区分）。
- `GET /api/geocode?q=成都&limit=8`：地区搜索（城市/县/镇 → 坐标）。免费无 Key 服务 Photon/OSM
  （中文县级可搜，如 陇西县/菜子镇）；返回 `{ok, provider, items:[{name,region,country,kind,lat,lon}]}`，
  缓存 1 天。商用规模建议替换为高德/腾讯 Web 服务 Key。
- `POST /api/weather/check`（admin/operator）：**立即检测**。无坐标=基地、带 `{lat,lon,label}`=该地区：
  **任何地区命中都会按去重规则写入云端告警中心**（SEN-03 或 WX-坐标），返回 `{ok, base, report:true, label, warnings, rules, pushed:[alarmIds]}`。
- `GET /api/weather/alerts?device=SEN-03`：最近天气预警（默认基地；`device=all` 返回基地+全部 WX-*；
  传 `WX-<lat>_<lon>` 查指定地区）。
- **监测点（后台自动巡检名单）**：`GET /api/weather/stations`、`PUT /api/weather/stations {stations:[{name,region,lat,lon}]}`
  （admin/operator，最多 10 个）。监测点由后台每 `WEATHER_POLL_MIN` 分钟（默认 10，≥2）自动巡检并上报——
  不打开页面也持续盯防；未设点的地区在页面查看或「立即检测」时命中同样上报（即“查看即报”）。
- 去重规则：同 device（基地或某地区坐标）同类预警已 open 不重复报、10 分钟冷却。
- `GET /api/cloudsat`（风云四号卫星云图帧）、`GET /api/geoip`（IP 定位）保留供二次开发。

## 7. 上报示例（网关/ERP 侧速查）

```bash
# 心跳/实况（连接点亮）
curl -X POST /api/telemetry -H "Authorization: Bearer <device-token>" \
  -d '{"deviceId":"CAM-01","status":"online","batt":88,"extra":{"temp":26.5,"hum":71}}'
# 环境采样/批次均重
curl -X POST /api/samples -d '{"batch":"P2026-0001","kind":"avg_weight","value":212.5,"unit":"g","meta":{"age_d":12}}'
# 业务快照（存栏/产蛋/补食/健康）
curl -X POST /api/metrics -d '{"type":"health_index","value":96.2,"unit":"%","source":"app-gw"}'
# 指令执行回执
curl -X POST /api/commands/:id/ack -d '{"status":"ack","msg":"执行完成"}'
```
