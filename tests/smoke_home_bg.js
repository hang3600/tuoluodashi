// 冒烟套件 —— 主页 AI 宇宙星海背景接入
// 锁定：
//   1) src/homebg.js 是合法的 JPEG data URI（可被 _prepSrc 加载）；
//   2) 无头环境下 _ensureHomeBgImage 安全跳过（无 Image API），_homeBgImage 保持 null，
//      不抛异常、不污染主渲染；
//   3) drawBackground 在「无离屏 + 无图」的回退路径下不抛异常（逐帧渐变+星点兜底）；
//   4) _getBgCache 在 headless 返回 null（触发回退），且 drawBackground 仍完成绘制。
process.env.TZ = 'Asia/Shanghai';
const path = require('path');
const SRC = path.resolve(__dirname, '..', 'src');
const { Renderer } = require(path.join(SRC, 'render.js'));
const { GameState } = require(path.join(SRC, 'game.js'));
// homebg.js 现已把 base64 内联：devtools 下才返回内嵌 data URI（规避 404），真机返回 null。
// 本套件验证 devtools 下的 data URI 合法性，故先置 devtools 平台，再重新 require homebg.js
// —— 这样 homebg 才会走到 devtools 分支拿到真实内联 data URI。
// 注：render.js 的 _HOME_B64 在它自身加载时已捕获为 null（与这里无关），故 headless 回退测试不受影响。
global.wx = { getSystemInfoSync: () => ({ platform: 'devtools' }) };
const _hbPath = path.join(SRC, 'homebg.js');
delete require.cache[_hbPath];
const homebg = require(_hbPath);

// 解析 JPEG data URI 的尺寸（SOF0 0xFFC0..0xFFCF，跳过 0xFFC4/0xFFC8 等），用于守防 dev 图被误重生为全分辨率。
function jpegDims(dataUri) {
  try {
    const b64 = String(dataUri).split(',')[1] || '';
    const buf = Buffer.from(b64, 'base64');
    for (let i = 2; i + 9 < buf.length; i++) {
      if (buf[i] === 0xFF && buf[i + 1] >= 0xC0 && buf[i + 1] <= 0xCF && buf[i + 1] !== 0xC4 && buf[i + 1] !== 0xC8) {
        const h = buf.readUInt16BE(i + 5);
        const w = buf.readUInt16BE(i + 7);
        return { w, h };
      }
    }
  } catch (e) {}
  return null;
}

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

function makeCtx() {
  let depth = 0;
  const self = {};
  const handler = {
    get(t, p) {
      if (p === 'save') return () => { depth++; };
      if (p === 'restore') return () => { depth--; if (depth < 0) throw new Error('restore 下溢'); };
      if (p === 'measureText') return (s) => ({ width: String(s).length * 8 });
      if (p === 'createLinearGradient' || p === 'createRadialGradient') return () => ({ addColorStop() {} });
      if (p === 'canvas') return { width: 390, height: 844 };
      if (p === 'getDepth') return () => depth;
      if (p in self) return self[p];
      return function () {};
    },
    set(t, p, v) { self[p] = v; return true; }
  };
  return new Proxy({}, handler);
}

function mkRenderer() {
  Renderer.prototype._loadIcons = function () {};
  const g = new GameState();
  g.homeV2 = true;
  const r = new Renderer({ width: 390, height: 844 }, makeCtx(), g, 56, 24,
    { left: 350, top: 10, width: 87, height: 32 });
  r.shadowScale = 1;
  r._reflow();
  return r;
}

console.log('\n【主页背景资源】homebg.js 合法性');
ok('homebg 是 JPEG data URI', /^data:image\/jpeg;base64,/.test(homebg), homebg.slice(0, 20));
// DevTools wx.createImage 的 data-URI 实测约 ~50KB 上限，超大会静默 onerror → 一直紫色回退。
// 故 dev base64 特意压到 ≤50KB 解码（本文件 q30 ≈40KB 解码）。
// 上限守 60KB：既不误伤本机 sips 能出的极限(~50KB)，又能拦住「死重回弹到几百 KB 紫屏」。
ok('homebg base64 体积合理（5KB~60KB，卡 DevTools data-URI ~50KB 安全线；防重生回 356KB 紫色）', homebg.length > 5000 && homebg.length < 60000, homebg.length + ' chars');
{
  const dims = jpegDims(homebg);
  ok('homebg 解码为 480x720（模拟器小图，真机另走全分辨率包内 JPG）', dims && dims.w === 480 && dims.h === 720, dims ? (dims.w + 'x' + dims.h) : 'parse-fail');
}

console.log('\n【图鉴背景资源】codexbg.js 合法性（与主页对称，base64 已内联）');
{
  const _cbPath = path.join(SRC, 'codexbg.js');
  delete require.cache[_cbPath];
  const codexbg = require(_cbPath);
  ok('codexbg 是 JPEG data URI', /^data:image\/jpeg;base64,/.test(codexbg), codexbg.slice(0, 20));
  ok('codexbg base64 体积合理（1KB~40KB）', codexbg.length > 1000 && codexbg.length < 40000, codexbg.length + ' chars');
  const dims = jpegDims(codexbg);
  ok('codexbg 解码为 480x720', dims && dims.w === 480 && dims.h === 720, dims ? (dims.w + 'x' + dims.h) : 'parse-fail');
}

console.log('\n【无头环境】背景加载安全跳过，回退不崩');
{
  const r = mkRenderer();
  let threw = null;
  try { r.drawBackground(); } catch (e) { threw = e.message; }
  ok('drawBackground 不抛异常', !threw, threw);
  ok('无头下 _homeBgImage 保持 null（无 Image API 跳过加载）', r._homeBgImage === null);
  ok('_homeBgTried 已置位（只尝试一次）', r._homeBgTried === true);
  ok('_getBgCache 回退为 null（无离屏，触发逐帧兜底）', r._getBgCache() === null);
  ok('save/restore 平衡', r.ctx.getDepth() === 0, 'depth=' + r.ctx.getDepth());
  // 二次调用也不应重复尝试（守卫）
  r.drawBackground();
  ok('二次 drawBackground 仍不抛异常（守卫幂等）', r._homeBgTried === true);
}

console.log('\n────────────────────────');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
