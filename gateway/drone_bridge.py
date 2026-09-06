#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
============================================================================
 陇药步云 · 无人机 MAVLink 云端网关桥（drone_bridge）
============================================================================
职责：
  1. 登录云端后端（device 角色账号），轮询待执行指令
     GET  /api/commands?device_id=XXX&status=sent
  2. 经 MAVLink 控制 ArduPilot/PX4 无人机执行（起飞/返航/降落/定点/巡线）
  3. 执行后回执     POST /api/commands/:id/ack {status,msg}
  4. 定时上报遥测   POST /api/telemetry  {deviceId,lat,lon,alt,batt,status}

用法：
  pip install pymavlink
  python3 gateway/drone_bridge.py \
      --api http://127.0.0.1:8600 \
      --user gateway01 --password gw-8600-secret \
      --mav udpin:127.0.0.1:14550 \
      --device DRONE-01

测试（无真机时）：ArduPilot SITL 见 gateway/README.md；
生产环境请把后端 NODE_ENV=production（自动关闭演示回执，本桥回执为准）。

安全提示：请先在模拟器上验证；真机飞行遵守当地空域法规，
并确保遥控器/返航逻辑可随时接管。
============================================================================
"""
import argparse
import json
import sys
import threading
import time
import urllib.error
import urllib.request

try:
    from pymavlink import mavutil
    from pymavlink.dialects.v20 import ardupilotmega as APM
except ImportError:
    sys.exit('[bridge] 缺少 pymavlink，请先执行：pip install pymavlink')


# --------------------------------------------------------------------------
# 云端 API 封装（仅标准库）
# --------------------------------------------------------------------------
class CloudApi:
    def __init__(self, base, username, password):
        self.base = base.rstrip('/')
        self.user = username
        self.pwd = password
        self.token = None
        self._lock = threading.Lock()

    def login(self):
        body = json.dumps({"username": self.user, "password": self.pwd}).encode()
        code, data = self._raw('POST', '/api/auth/login', body, None)
        if code != 200 or not data.get('token'):
            raise RuntimeError('登录失败(HTTP %s): %s' % (code, data))
        self.token = data['token']
        print('[cloud] 登录成功：%s (%s)' % (self.user, data['user'].get('role')))

    def _raw(self, method, path, body, token):
        req = urllib.request.Request(self.base + path, data=body, method=method)
        req.add_header('Content-Type', 'application/json')
        if token:
            req.add_header('Authorization', 'Bearer ' + token)
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                text = r.read().decode('utf-8', 'replace')
                return r.status, (json.loads(text) if text else {})
        except urllib.error.HTTPError as e:
            text = e.read().decode('utf-8', 'replace')
            try:
                return e.code, json.loads(text)
            except Exception:
                return e.code, {'error': text}
        except Exception as e:
            return -1, {'error': str(e)}

    def call(self, method, path, body=None):
        """带自动重登的请求；返回 (ok, data)"""
        with self._lock:
            code, data = self._raw(method, path, json.dumps(body).encode() if body is not None else None, self.token)
            if code == 401 and self.token:
                self.token = None
                self.login()
                code, data = self._raw(method, path,
                                       json.dumps(body).encode() if body is not None else None, self.token)
            return code == 200, data

    def get_commands(self, device_id, limit=10):
        ok, data = self.call('GET', '/api/commands?device_id=%s&status=sent&limit=%d' % (device_id, limit))
        return data if ok else []

    def ack(self, cmd_id, status, msg):
        self.call('POST', '/api/commands/%d/ack' % cmd_id, {'status': status, 'msg': msg})

    def post_telemetry(self, payload):
        self.call('POST', '/api/telemetry', payload)


# --------------------------------------------------------------------------
# MAVLink 桥
# --------------------------------------------------------------------------
CMD_MAP = {
    'takeoff':       ('起飞', 'mav'),
    'start_patrol':  ('巡线', 'mav'),
    'goto_point':    ('定点', 'mav'),
    'rtl':           ('返航', 'mav'),
    'land':          ('降落', 'mav'),
    'arm':           ('解锁', 'mav'),
    'disarm':        ('上锁', 'mav'),
    'reboot':        ('重启飞控', 'mav'),
    'charge':        ('充电', 'unsupported'),
    'stream_on':     ('图传确认', 'ackonly'),
    'speaker':       ('喊话', 'unsupported'),
    'gimbal':        ('云台', 'unsupported'),
}


class DroneBridge:
    def __init__(self, api, mav_conn, device_id, sysid=1):
        self.api = api
        self.device_id = device_id
        self.master = None
        self.mav_conn = mav_conn
        self.sysid = sysid
        self.stop_flag = False
        # 遥测缓存
        self.tel = {'lat': None, 'lon': None, 'alt': None, 'batt': None, 'armed': False, 'mode': 'UNKNOWN', 'seen': 0.0}

    # ---- 连接 ----
    def connect(self):
        while not self.stop_flag:
            try:
                print('[mav] 连接 %s …' % self.mav_conn)
                self.master = mavutil.mavlink_connection(self.mav_conn, autoreconnect=True, source_system=255)
                self.master.wait_heartbeat(timeout=30)
                self.sysid = self.master.target_system or self.sysid
                self.master.mav.heartbeat_send(mavutil.mavlink.MAV_TYPE_GCS,
                                               mavutil.mavlink.MAV_AUTOPILOT_INVALID, 0, 0, 0)
                print('[mav] 已连接 sysid=%s compid=%s，等待指令…' % (self.sysid, self.master.target_component))
                return True
            except Exception as e:
                print('[mav] 连接失败：%s，5 秒后重试' % e)
                time.sleep(5)
        return False

    # ---- 基础动作 ----
    def _cmd_long(self, cmd, p1=0, p2=0, p3=0, p4=0, p5=0, p6=0, p7=0):
        self.master.mav.command_long_send(self.sysid, self.master.target_component,
                                          cmd, 0, p1, p2, p3, p4, p5, p6, p7)

    def set_mode(self, mode_name):
        """ArduPilot 优先 set_mode_apm；回退 DO_SET_MODE(custom)"""
        if hasattr(self.master, 'set_mode_apm'):
            try:
                self.master.set_mode_apm(mode_name)
                print('[mav] 模式 -> %s' % mode_name)
                return True
            except Exception:
                pass
        MODES = {'GUIDED': 4, 'LOITER': 5, 'RTL': 6, 'LAND': 9, 'AUTO': 3, 'ALT_HOLD': 2}
        if mode_name in MODES:
            self._cmd_long(APM.MAV_CMD_DO_SET_MODE, 1, MODES[mode_name])
            print('[mav] 模式 -> %s (DO_SET_MODE)' % mode_name)
            return True
        raise RuntimeError('不支持的飞行模式：' + mode_name)

    def arm(self):
        self._cmd_long(APM.MAV_CMD_COMPONENT_ARM_DISARM, 1)
        print('[mav] 已发送解锁')

    def takeoff(self, alt):
        self.set_mode('GUIDED')
        self.arm()
        time.sleep(1.5)
        self._cmd_long(APM.MAV_CMD_NAV_TAKEOFF, 0, 0, 0, 0, 0, 0, float(alt))
        print('[mav] 起飞指令 alt=%sm' % alt)

    def rtl(self):
        self._cmd_long(APM.MAV_CMD_NAV_RETURN_TO_LAUNCH)
        print('[mav] 返航(RTL)')

    def land(self):
        self.set_mode('LAND')
        print('[mav] 降落')

    def goto(self, lat, lon, alt):
        """引导模式下飞往经纬度（无航点上传的简易定点）"""
        self.set_mode('GUIDED')
        self.master.mav.set_position_target_global_int_send(
            0, self.sysid, self.master.target_component,
            APM.MAV_FRAME_GLOBAL_RELATIVE_ALT_INT,
            0b110111111000, int(lat * 1e7), int(lon * 1e7), float(alt),
            0, 0, 0, 0, 0, 0, 0, 0)
        print('[mav] 定点 -> %.7f, %.7f @%sm' % (lat, lon, alt))

    # ---- 遥测 ----
    def _recv_loop(self):
        while not self.stop_flag:
            try:
                m = self.master.recv_match(blocking=True, timeout=1.0)
                if not m:
                    continue
                t = m.get_type()
                if t == 'HEARTBEAT':
                    self.tel['mode'] = mavutil.mode_string_v10(m) or 'UNKNOWN'
                    self.tel['armed'] = bool(m.base_mode & APM.MAV_MODE_FLAG_SAFETY_ARMED)
                    self.tel['seen'] = time.time()
                elif t == 'GLOBAL_POSITION_INT':
                    if m.lat and m.lon:
                        self.tel['lat'] = m.lat / 1e7
                        self.tel['lon'] = m.lon / 1e7
                        self.tel['alt'] = m.relative_alt / 1000.0
                        self.tel['seen'] = time.time()
                    if getattr(m, 'vx', 0) and getattr(m, 'vy', 0):
                        self.tel['speed'] = ((m.vx ** 2 + m.vy ** 2) ** 0.5) / 100.0  # cm/s -> m/s
                elif t == 'BATTERY_STATUS':
                    remaining = getattr(m, 'battery_remaining', -1)
                    if remaining is not None and 0 <= remaining <= 100:
                        self.tel['batt'] = remaining
                    elif m.voltages and m.voltages[0] not in (65535, 0):
                        # 电压估算百分比（4S LiPo 11.6V=0% / 16.8V=100%）
                        v = m.voltages[0] / 1000.0
                        self.tel['batt'] = max(0, min(100, int((v - 11.6) / (16.8 - 11.6) * 100)))
            except Exception as e:
                if not self.stop_flag:
                    time.sleep(0.5)

    def _report_loop(self):
        while not self.stop_flag:
            time.sleep(2)
            fresh = time.time() - self.tel['seen'] < 20
            status = 'offline'
            if fresh:
                status = 'flight' if self.tel['armed'] else 'standby'
            if self.tel['lat'] is None or self.tel['lon'] is None:
                payload = {'deviceId': self.device_id, 'batt': self.tel['batt'], 'status': status,
                           'extra': {'mode': self.tel['mode'], 'armed': self.tel['armed'],
                                     'speed': self.tel.get('speed')}}
            else:
                payload = {'deviceId': self.device_id, 'lat': self.tel['lat'], 'lon': self.tel['lon'],
                           'alt': self.tel['alt'], 'batt': self.tel['batt'], 'status': status,
                           'extra': {'mode': self.tel['mode'], 'armed': self.tel['armed'],
                                     'speed': self.tel.get('speed')}}
            self.api.post_telemetry(payload)

    # ---- 指令执行 ----
    def exec_cmd(self, c):
        cmd = c.get('cmd')
        params = c.get('params') or {}
        print('[cloud] 执行 CMD%d: %s %s' % (c['id'], cmd, params))
        kind = CMD_MAP.get(cmd, (cmd, 'unsupported'))[1]
        try:
            if kind == 'unsupported':
                self.api.ack(c['id'], 'fail', '该指令本网关不支持（' + cmd + '）')
                return
            if kind == 'ackonly':
                self.api.ack(c['id'], 'ack', '已确认（流/外设由其他服务处理）')
                return
            if cmd == 'takeoff':
                self.takeoff(float(params.get('alt', 40)))
            elif cmd == 'rtl':
                self.rtl()
            elif cmd == 'land':
                self.land()
            elif cmd == 'arm':
                self.arm()
            elif cmd == 'disarm':
                self._cmd_long(APM.MAV_CMD_COMPONENT_ARM_DISARM, 0)
            elif cmd == 'reboot':
                self._cmd_long(APM.MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN, 1)
            elif cmd == 'goto_point':
                self.goto(float(params.get('lat')), float(params.get('lon')), float(params.get('alt', 40)))
            elif cmd == 'start_patrol':
                # 简易巡线：读取该机航线（或使用 params.waypoints）逐点 goto
                waypoints = params.get('waypoints') or self._fetch_waypoints()
                for w in waypoints:
                    if self.stop_flag:
                        break
                    self.goto(float(w['lat']), float(w['lon']), float(w.get('alt', 40)))
                    time.sleep(float(params.get('hold', 3)))  # 悬停时间，生产可按距离动态
                if params.get('return_after'):
                    self.rtl()
            time.sleep(1.0)  # 给飞控动作落指令
            self.api.ack(c['id'], 'ack', 'MAVLink 指令已执行：' + CMD_MAP.get(cmd, (cmd,))[0])
        except Exception as e:
            print('[cloud] 执行失败 CMD%d: %s' % (c['id'], e))
            self.api.ack(c['id'], 'fail', '执行异常：%s' % e)

    def _fetch_waypoints(self):
        ok, data = self.api.call('GET', '/api/waypoints?device_id=' + self.device_id)
        if ok and data:
            return data
        raise RuntimeError('该无人机没有可用的云端航线')

    # ---- 主循环 ----
    def run(self):
        threads = [
            threading.Thread(target=self._recv_loop, daemon=True),
            threading.Thread(target=self._report_loop, daemon=True),
        ]
        for t in threads:
            t.start()
        while not self.stop_flag:
            cmds = self.api.get_commands(self.device_id)
            for c in cmds:
                self.exec_cmd(c)
            time.sleep(2)


def main():
    ap = argparse.ArgumentParser(description='陇药步云 MAVLink 无人机云端网关桥')
    ap.add_argument('--api', default='http://127.0.0.1:8600', help='云端后端地址')
    ap.add_argument('--user', default='gateway01')
    ap.add_argument('--password', default='gw-8600-secret')
    ap.add_argument('--mav', default='udpin:127.0.0.1:14550',
                    help='MAVLink 连接串，如 udpin:0.0.0.0:14550 / tcp:127.0.0.1:5760 / 串口 /dev/ttyUSB0:57600')
    ap.add_argument('--device', default='DRONE-01', help='云端设备 ID')
    args = ap.parse_args()

    api = CloudApi(args.api, args.user, args.password)
    api.login()
    bridge = DroneBridge(api, args.mav, args.device)
    try:
        if bridge.connect():
            print('[bridge] 开始云控循环（Ctrl+C 退出）')
            bridge.run()
    except KeyboardInterrupt:
        print('\n[bridge] 正在退出…')
    finally:
        bridge.stop_flag = True


if __name__ == '__main__':
    main()
