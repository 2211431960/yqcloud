/* ============================================================
 * 安全工具：scrypt 口令哈希 + 会话 Token（node:crypto，零依赖）
 * ============================================================ */
'use strict';
const crypto = require('crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const buf = crypto.scryptSync(String(pw), salt, SCRYPT.keylen, SCRYPT);
  return { salt, hash: buf.toString('hex') };
}
function verifyPassword(pw, salt, hash) {
  const a = Buffer.from(hash, 'hex');
  const b = crypto.scryptSync(String(pw), String(salt), SCRYPT.keylen, SCRYPT);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* 会话 token：返回明文给客户端，库中只存 sha256 摘要 */
function newToken() { return crypto.randomBytes(32).toString('hex'); }
function tokenDigest(token) { return crypto.createHash('sha256').update(token).digest('hex'); }

module.exports = { hashPassword, verifyPassword, newToken, tokenDigest };
