/**
 * imgb64.js 透明度回归（守防 2026-09-02 模拟器白方块）
 *
 * 背景：devtools 模拟器预览走 utils.prepSrc 的 data URI 分支（读取 src/imgb64.js 内联 base64）；
 * 真机走包内透明 PNG，不受影响。曾为压体积把 imgb64 内联图压成 JPEG（data:image/jpeg），
 * 而 JPEG 无 alpha 通道 → 模拟器里陀螺/图标渲染成不透明大白方块，真机却正常（用户误以为"没抠图"）。
 * 2026-09-02 重写为 PNG（保留 alpha，icons 48px / tops 72px），体积仍远小于原全分辨率版本。
 *
 * 本套件锁死：imgb64.js 内联图必须全部为 PNG（data:image/png）+ RGBA(colorType=6)，
 * 且陀螺（tops）真实含透明像素（透明占比 > 10%）——杜绝「又变回 JPEG」或「PNG 但扁平化丢透明」。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

let pass = 0, fail = 0;
function ok(desc, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + desc + (extra ? ' — ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + desc + (extra ? ' — ' + extra : '')); }
}

function decodePNG(buf) {
  let p = 8;
  let width, height, colorType;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.slice(p + 8, p + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const z = zlib.inflateSync(Buffer.concat(idat));
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1;
  const stride = width * ch;
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const ft = z[pos++];
    for (let x = 0; x < stride; x++) {
      const raw = z[pos++];
      const a = x >= ch ? out[y * stride + x - ch] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = (x >= ch && y > 0) ? out[(y - 1) * stride + x - ch] : 0;
      let v;
      switch (ft) {
        case 0: v = raw; break;
        case 1: v = raw + a; break;
        case 2: v = raw + b; break;
        case 3: v = raw + ((a + b) >> 1); break;
        case 4: { const pp = a + b - c; const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v = raw + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); break; }
        default: v = raw;
      }
      out[y * stride + x] = v & 0xff;
    }
  }
  return { width, height, colorType, ch, out };
}

function main() {
  const f = path.join(__dirname, '..', 'src', 'imgb64.js');
  const text = fs.readFileSync(f, 'utf8');
  const re = /"([a-z0-9_-]+\.png)":"(data:image\/([a-z]+);base64,([A-Za-z0-9+/=]+))"/g;
  let m, total = 0, topsCnt = 0;
  const topsFails = [];
  while ((m = re.exec(text))) {
    const key = m[1], mime = m[3], b64 = m[4];
    total++;
    const isTop = !key.startsWith('icon-');
    ok(key + ' 是 PNG（非 ' + mime + '）', mime === 'png', 'mime=data:image/' + mime);
    const buf = Buffer.from(b64, 'base64');
    let dec;
    try { dec = decodePNG(buf); } catch (e) { ok(key + ' 可解码 PNG', false, e.message); continue; }
    ok(key + ' 为 RGBA(colorType=6，含 alpha)', dec.colorType === 6, 'colorType=' + dec.colorType);
    if (isTop) {
      topsCnt++;
      // 统计透明像素（alpha 通道最后一字节）
      let trans = 0;
      for (let i = 0; i < dec.out.length; i += dec.ch) if (dec.out[i + dec.ch - 1] < 255) trans++;
      const frac = trans / (dec.width * dec.height);
      if (frac <= 0.10) topsFails.push(key + '(' + (frac * 100).toFixed(1) + '%透明)');
      ok(key + ' 含透明像素 (>10%)', frac > 0.10, '透明占比=' + (frac * 100).toFixed(1) + '%');
    }
  }
  ok('共解析到内联图（应=73）', total === 73, 'count=' + total);
  ok('陀螺 tops 全部含透明', topsFails.length === 0, topsFails.length ? topsFails.join(', ') : '30 个均透明');
  if (topsFails.length) console.log('   失败 tops: ' + topsFails.join(', '));

  console.log('\n──────── 结果 ────────');
  console.log((fail === 0 ? '✅' : '❌') + ' 通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail === 0 ? 0 : 1);
}
main();
