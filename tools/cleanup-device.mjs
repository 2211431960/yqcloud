'use strict';
// 清理工具：删除某台设备的指令/遥测残留（e2e 或测试专用）
import { DatabaseSync } from 'node:sqlite';
const ids = process.argv.slice(2);
if (!ids.length) { console.log('用法: node tools/cleanup-device.mjs DEVICE_ID [...]'); process.exit(0); }
const db = new DatabaseSync('data/yqcloud.db');
for (const id of ids) {
  const c1 = db.prepare('DELETE FROM commands WHERE device_id=?').run(id).changes;
  const c2 = db.prepare('DELETE FROM telemetry WHERE device_id=?').run(id).changes;
  console.log(id + ': 清理 commands=' + c1 + ' telemetry=' + c2);
}
db.close();
