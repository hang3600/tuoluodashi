// Phase-2a JPG 压缩回归测试：确保背景/分享卡在"不损视觉质量"前提下保持精简体积。
// 防止后续美术重新导出高保真原图把包体再次撑大（原 home_cosmic 曾达 273KB、share-card 150KB）。
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(desc, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + desc + (extra ? ' — ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + desc + (extra ? ' — ' + extra : '')); }
}

// 解析 JPEG 尺寸（读 SOF 标记，纯 buffer 操作，无需第三方库）
function jpegSize(buf) {
  if (buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
  let off = 2;
  while (off < buf.length) {
    if (buf[off] !== 0xFF) { off++; continue; }
    const marker = buf[off + 1];
    // SOF0..SOF15（排除 C4=DAC, C8=JPG, CC=DAC）
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      const h = buf.readUInt16BE(off + 5);
      const w = buf.readUInt16BE(off + 7);
      return { w, h };
    }
    const len = buf.readUInt16BE(off + 2);
    off += 2 + len;
  }
  return null;
}

const ROOT = path.join(__dirname, '..');
const cases = [
  { file: 'images/home/home_cosmic.jpg', maxBytes: 60000, w: 720, h: 1080, note: '主页背景(全屏,真机cover-fit放大,须保720原分辨率)' },
  { file: 'images/codex/codex_atlas.jpg', maxBytes: 20000, w: 720, h: 1080, note: '图鉴背景(同上,须保720原分辨率)' },
  { file: 'images/share-card.jpg', maxBytes: 25000, w: 621, h: 466, note: '分享卡(微信分享托盘仅小缩略图,可降至621x466)' },
];

for (const c of cases) {
  const p = path.join(ROOT, c.file);
  ok('存在: ' + c.file, fs.existsSync(p), c.note);
  if (!fs.existsSync(p)) continue;
  const buf = fs.readFileSync(p);
  const sz = jpegSize(buf);
  ok('尺寸正确: ' + c.file + ' (' + c.w + 'x' + c.h + ')',
     sz && sz.w === c.w && sz.h === c.h, sz ? (sz.w + 'x' + sz.h) : '解析失败');
  ok('体积受控: ' + c.file + ' <= ' + c.maxBytes + 'B', buf.length <= c.maxBytes, buf.length + 'B');
}

console.log('\n' + (fail ? '❌' : '✅') + ' JPG 压缩回归：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
