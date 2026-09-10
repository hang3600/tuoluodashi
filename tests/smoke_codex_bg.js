// 冒烟套件 —— 图鉴独立背景接入（与主页「宇宙星海战场」区分）
// 锁定：
//   1) src/codexbg.js 现已把 base64 内联：devtools 分支直接返回 JPEG data URI（规避 404），
//      真机（无 wx / 非 devtools）返回 null（省 ~8.6KB 常驻内存，仅 devtools 加载 base64）；
//   2) 无头环境下 _ensureCodexBgImage 安全跳过（无 Image API），_codexBgImage 保持 null，
//      不抛异常、不污染主渲染；
//   3) drawBackground 在 view==='codex' 时走图鉴场景分支（_drawCodexScene），
//      在无图回退路径下不抛异常；view!=='codex' 时仍走主页场景分支；
//   4) _drawCodexScene / _drawHomeScene 在回退（无图）时不被调用，save/restore 平衡。
process.env.TZ = 'Asia/Shanghai';
const path = require('path');
const SRC = path.resolve(__dirname, '..', 'src');
const { Renderer } = require(path.join(SRC, 'render.js'));
const { GameState } = require(path.join(SRC, 'game.js'));
const codexbgPath = path.join(SRC, 'codexbg.js');

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

function mkRenderer(view) {
  Renderer.prototype._loadIcons = function () {};
  const g = new GameState();
  g.homeV2 = true;
  g.view = view || 'home';
  const r = new Renderer({ width: 390, height: 844 }, makeCtx(), g, 56, 24,
    { left: 350, top: 10, width: 87, height: 32 });
  r.shadowScale = 1;
  r._reflow();
  return r;
}

// codexbg.js 已内联 base64：无 wx 时返回 null（真机省内存，不加载 base64）。
delete require.cache[require.resolve(codexbgPath)];
delete global.wx;
const codexbgHeadless = require(codexbgPath);
ok('无 wx 时 codexbg.js 返回 null（真机省内存，不加载 base64）', codexbgHeadless === null);

// devtools 分支：codexbg.js 返回内联 base64（模拟器规避 404）。
global.wx = { getSystemInfoSync: () => ({ platform: 'devtools' }) };
delete require.cache[require.resolve(codexbgPath)];
const codexbgDevtools = require(codexbgPath);
delete global.wx;

console.log('\n【图鉴背景资源】codexbg.js 内联 base64（devtools 用，规避 404）');
ok('codexbg 是 JPEG data URI（真资源，模拟器用）', /^data:image\/jpeg;base64,/.test(codexbgDevtools), String(codexbgDevtools).slice(0, 20));
ok('codexbg 体积合理（1KB~40KB，远低 data-URI 上限；防重生回全分辨率紫色）', codexbgDevtools.length > 1000 && codexbgDevtools.length < 40000, codexbgDevtools.length + ' chars');
{
  const b64 = String(codexbgDevtools).split(',')[1] || '';
  const buf = Buffer.from(b64, 'base64');
  let dims = null;
  for (let i = 2; i + 9 < buf.length; i++) {
    if (buf[i] === 0xFF && buf[i + 1] >= 0xC0 && buf[i + 1] <= 0xCF && buf[i + 1] !== 0xC4 && buf[i + 1] !== 0xC8) {
      dims = { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) }; break;
    }
  }
  ok('codexbg 解码为 480x720（模拟器小图，真机另走全分辨率包内 JPG）', dims && dims.w === 480 && dims.h === 720, dims ? (dims.w + 'x' + dims.h) : 'parse-fail');
}

console.log('\n【无头环境】图鉴背景加载安全跳过，回退不崩');
{
  const r = mkRenderer('codex');
  let threw = null;
  try { r.drawBackground(); } catch (e) { threw = e.message; }
  ok('view=codex drawBackground 不抛异常', !threw, threw);
  ok('无头下 _codexBgImage 保持 null（无 Image API 跳过加载）', r._codexBgImage === null);
  ok('_codexBgTried 已置位（只尝试一次）', r._codexBgTried === true);
  ok('save/restore 平衡', r.ctx.getDepth() === 0, 'depth=' + r.ctx.getDepth());
  r.drawBackground();
  ok('二次 drawBackground 仍不抛异常（守卫幂等）', r._codexBgTried === true);
}

console.log('\n【视图选图】codex 与 home 背景分流');
{
  const rc = mkRenderer('codex');
  rc.drawBackground();
  ok('view=codex → 尝试加载图鉴背景（_codexBgTried）', rc._codexBgTried === true);
  ok('view=codex 不触碰主页背景守卫（_homeBgTried 仍为 false）', rc._homeBgTried === false);

  const rh = mkRenderer('home');
  rh.drawBackground();
  ok('view=home → 尝试加载主页背景（_homeBgTried）', rh._homeBgTried === true);
  ok('view=home 不触碰图鉴背景守卫（_codexBgTried 仍为 false）', rh._codexBgTried === false);
}

console.log('\n────────────────────────');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
