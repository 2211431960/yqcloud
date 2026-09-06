# 无人机 MAVLink 网关桥（gateway/drone_bridge.py）

把云端页面上的「起飞 / 返航 / 降落 / 定点 / 巡线」按钮变成对真实无人机的控制：

```
云端页面(admin 点按钮) 
   → backend commands 表(status=sent)
   → 本桥轮询 → pymavlink 执行 → POST /api/commands/:id/ack 回执
   → 本桥每 2s 上报遥测(GPS/电量/高度/状态) → 前端设备页/地图可见
```

## 安装与运行

```bash
pip install pymavlink
python3 gateway/drone_bridge.py \
    --api http://127.0.0.1:8600 \
    --user gateway01 --password gw-8600-secret \
    --mav udpin:127.0.0.1:14550 \
    --device DRONE-01
```

| 参数 | 说明 |
|---|---|
| --mav | 飞控连接串：SITL `udpin:127.0.0.1:14550`；数传 TCP `tcp:192.168.x.x:5760`；USB 串口 `COM3:57600` 或 `/dev/ttyUSB0:57600` |
| --device | 对应「设备与网关」页里的无人机 ID（DRONE-01/02/03） |
| --user/--password | 用 device 角色账号（默认 gateway01 / gw-8600-secret），无页面权限，只能上报与回执 |

## 与后端回执的关系

- 后端开发模式默认带「演示回执模拟器」（4 秒自动 ack，方便无设备联调）；
- **接真实无人机时请启动后端为生产模式** `NODE_ENV=production node backend/server.js`（模拟器自动关闭，
  回执以本桥为准），或仅关模拟器：`DEMO_ACK=0 node backend/server.js`。

## 支持指令（与页面按钮一一对应）

| 页面按钮 | cmd | 桥动作（ArduPilot） |
|---|---|---|
| 起飞 | takeoff | GUIDED + 解锁 + NAV_TAKEOFF（高度取设备备注 alt 或 40m） |
| 返航 | rtl | MAV_CMD_NAV_RETURN_TO_LAUNCH |
| 降落 | land | 切 LAND 模式 |
| 定点 | goto_point | SET_POSITION_TARGET_GLOBAL_INT（params: lat/lon/alt） |
| 巡线 | start_patrol | 读取云端航线表逐点 goto（可选 return_after） |
| 图传 | stream_on | 确认（流由转流服务处理，见 docs/STREAMING.md） |
| 充电/喊话/云台 | - | 回执 fail「本网关不支持」（按需扩展） |

## 没有真机时怎么联调（ArduPilot SITL）

```bash
# 1) 安装 ArduPilot 开发环境后启动模拟器（Copter）
sim_vehicle.py -v ArduCopter --console --map

# 2) 另开终端启动本桥（SITL 默认从 14550 UDP 输出）
python3 gateway/drone_bridge.py --mav udpin:127.0.0.1:14550

# 3) 浏览器 → 设备与网关页 → DRONE-01「起飞」
#    SITL 画面可见起飞，指令流水出现「ack MAVLink 指令已执行」，设备遥测 GPS/电量开始更新
```

## 安全清单（务必阅读）

1. 首次真机测试：拆桨、RTL/急停校验、遥控器接管逻辑确认；
2. 本桥不校验地理围栏/空域，务必配合 DJI GEO / 飞控 FENCE / 航线文件使用；
3. 建议 systemd 守护：`deploy/longxi-web.service` 同款写法，开机自启网关；
4. 云端建议 4G/宽带公网可达；若后端在内网，用 frp/tailscale 打通。
