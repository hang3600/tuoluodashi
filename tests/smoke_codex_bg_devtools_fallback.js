// 图鉴背景「模拟器(DevTools)兜底」回归测试 —— 与 smoke_home_bg_devtools_fallback.js 对称，
// 守防「本地模拟器图鉴页显示紫色默认渐变、看不到自定义背景」。
// 复现场景：DevTools 下包内路径 images/codex/codex_atlas.jpg 404（模拟器历史 404 行为），
// 此时应回退到内嵌 base64（codexbg.js 内联）仍能加载出图；而非像旧 pkg-first 实现那样
// 先撞 404 再兜底（F5：消除无谓的 404 控制台噪声）。
// 关键断言：模拟器下「优先 base64」（primary = b64 || pkg），故包内 404 永不被触发、直接出图。
process.env.TZ = 'Asia/Shanghai';
const path = require('path');
const SRC = path.resolve(__dirname, '..', 'src');

// 模拟器 wx：platform==='devtools' → _CODEX_B64 捕获为 codexbg.js 内联的 base64
let createdSrcs = [];   // 记录本次 drawBackground 触发的全部 src（区分 home/codex，防误判）
let lastSrc = null;
global.wx = {
  getSystemInfoSync: () => ({ platform: 'devtools', system: 'iOS 15.0', model: 'iPhone', pixelRatio: 3, screenWidth: 390, screenHeight: 844, windowWidth: 390, windowHeight: 844, SDKVersion: '3.17.1' }),
  // 包内路径（非 data:）一律失败（模拟 404），data: 成功 —— 验证「模拟器优先 base64、不撞 404」链
  createImage: function () {
    const im = {};
    im._ok = false;
    Object.defineProperty(im, 'src', {
      configurable: true,
      get() { return lastSrc; },
      set(v) {
        lastSrc = v;
        createdSrcs.push(v);
        if (typeof v === 'string' && v.slice(0, 5) === 'data:') { if (im.onload) im.onload(); }
        else { if (im.onerror) im.onerror(); }
      },
    });
    return im;
  },
};

const { Renderer } = require(path.join(SRC, 'render.js'));
const { GameState } = require(path.join(SRC, 'game.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

function makeCtx() {
  const self = {};
  const handler = {
    get(t, p) {
      if (p === 'save' || p === 'restore') return () => {};
      if (p === 'measureText') return (s) => ({ width: String(s).length * 8 });
      if (p === 'createLinearGradient' || p === 'createRadialGradient') return () => ({ addColorStop() {} });
      if (p === 'canvas') return { width: 390, height: 844 };
      if (p in self) return self[p];
      return function () {};
    },
    set(t, p, v) { self[p] = v; return true; },
  };
  return new Proxy({}, handler);
}

const g = new GameState();
g.homeV2 = true;
g.view = 'codex';   // ← 切到图鉴视图，触发 _ensureCodexBgImage
const r = new Renderer({ width: 390, height: 844 }, makeCtx(), g, 56, 24, { left: 350, top: 10, width: 87, height: 32 });
r.shadowScale = 1;
r._reflow();

console.log('\n【模拟器(DevTools)·图鉴】包内路径 404 → 应优先 base64 直接出图（不紫色回退、不撞 404）');
createdSrcs = [];   // 仅统计本次 codex draw 触发的 src（隔离上面 Renderer 构造/reflow 期间的图标加载）
r.drawBackground();
ok('图鉴背景经 base64 兜底加载成功（_codexBgImage._ok=true）', !!(r._codexBgImage && r._codexBgImage._ok === true),
   'codexBgImage=' + (r._codexBgImage ? ('_ok=' + r._codexBgImage._ok) : 'null'));
ok('最终加载的是 data: base64（模拟器优先 base64、未触发包内 404）', typeof lastSrc === 'string' && lastSrc.slice(0, 5) === 'data:',
   String(lastSrc).slice(0, 20));
// 反向守防：若 loader 仍「pkg 优先」则会先 push 一个包内路径（onerror→撞 404）。
// 此处要求：本次 codex draw 触发的首个 src 即 base64，且全程无包内路径(非 data:)探针。
const dataSrcCount = createdSrcs.filter((s) => typeof s === 'string' && s.slice(0, 5) === 'data:').length;
const nonDataSrcCount = createdSrcs.filter((s) => typeof s !== 'string' || s.slice(0, 5) !== 'data:').length;
ok('首个尝试即 base64 且全程无包内 404 探测', createdSrcs.length >= 1 && typeof createdSrcs[0] === 'string' && createdSrcs[0].slice(0, 5) === 'data:' && nonDataSrcCount === 0,
   'first=' + (createdSrcs[0] ? String(createdSrcs[0]).slice(0, 8) : 'null') + ' dataSrc=' + dataSrcCount + ' nonDataSrc=' + nonDataSrcCount);

console.log('\n────────────────────────');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
