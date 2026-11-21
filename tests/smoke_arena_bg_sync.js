/**
 * 对战擂台背景「DevTools / 真机同源」回归
 *
 * 背景：对战背景图走双份素材机制 —— DevTools 模拟器读 battle/arenabg.js 内联 base64，
 * 真机读 battle/images/arena/arena_neon_bg.jpg（随 battle 分包分发）。两者本应同源，
 * 2026-09-13 发现两份是不同构图 / 比例的图（sha256 不同、720x1080 vs 1024x1436），
 * 导致「本地预览背景 ≠ 真机背景」。已以真机磁盘图为准重建 arenabg.js 内联 base64。
 *
 * 本套件锁死：arenabg.js 内联 base64 必须与磁盘 arena_neon_bg.jpg 同源
 * （sha256 一致 + 尺寸一致 + 同为 JPEG）——杜绝再次失同步。
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

let pass = 0, fail = 0;
function ok(desc, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + desc + (extra ? ' — ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + desc + (extra ? ' — ' + extra : '')); }
}

function jpegSize(b) {
  let i = 2;
  while (i < b.length - 1) {
    if (b[i] !== 0xFF) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xD8 || m === 0xD9 || (m >= 0xD0 && m <= 0xD7) || m === 0x01) { i += 2; continue; }
    if (i + 3 >= b.length) break;
    const len = b.readUInt16BE(i + 2);
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
      return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

function finish() {
  console.log('\n──────── 结果 ────────');
  console.log((fail === 0 ? '✅' : '❌') + ' 通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail === 0 ? 0 : 1);
}

function main() {
  const ROOT = path.resolve(__dirname, '..');
  const diskPath = path.join(ROOT, 'battle/images/arena/arena_neon_bg.jpg');
  const b64Path = path.join(ROOT, 'battle/arenabg.js');
  const sha = b => crypto.createHash('sha256').update(b).digest('hex');

  // 1) 真机磁盘图存在且合法
  ok('真机磁盘图存在', fs.existsSync(diskPath), diskPath);
  if (!fs.existsSync(diskPath)) { finish(); return; }
  const disk = fs.readFileSync(diskPath);
  const dSize = jpegSize(disk);
  ok('真机磁盘图为合法 JPEG 且能解析尺寸', !!dSize, dSize ? (dSize.w + 'x' + dSize.h) : '无法解析');

  // 2) 内联 base64 模块存在且导出字符串
  ok('arenabg.js 内联模块存在', fs.existsSync(b64Path));
  if (!fs.existsSync(b64Path)) { finish(); return; }
  let mod;
  try { mod = require(b64Path); } catch (e) { mod = null; }
  ok('arenabg.js 导出为字符串', typeof mod === 'string');
  if (typeof mod !== 'string') { finish(); return; }

  const m = mod.match(/^data:([^;,]+);base64,(.*)$/s);
  ok('内联为 data:image/jpeg;base64 前缀', !!m && m[1] === 'image/jpeg');
  if (!m) { finish(); return; }
  const inline = Buffer.from(m[2], 'base64');
  const iSize = jpegSize(inline);

  // 3) 尺寸一致（防止构图 / 比例不同）
  ok('内联解码为合法 JPEG 且能解析尺寸', !!iSize, iSize ? (iSize.w + 'x' + iSize.h) : '无法解析');
  if (dSize && iSize) {
    ok('内联尺寸 == 真机尺寸（防止构图/比例不同）', dSize.w === iSize.w && dSize.h === iSize.h,
      '内联 ' + iSize.w + 'x' + iSize.h + ' vs 真机 ' + dSize.w + 'x' + dSize.h);
  }

  // 4) 同源（核心防线）
  ok('内联 base64 与真机磁盘图 sha256 相同（DevTools/真机同源）', sha(inline) === sha(disk),
    '内联 ' + inline.length + 'B / 真机 ' + disk.length + 'B');

  finish();
}
main();
