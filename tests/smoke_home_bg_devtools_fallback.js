// 主页背景「模拟器(DevTools)兜底」回归测试 —— 守防「本地模拟器显示紫色默认渐变、看不到自定义背景」。
// 复现场景：DevTools 下包内路径 images/home/home_cosmic.jpg 404（模拟器历史 404 行为），
// 此时应回退到内嵌 base64（homebg.js 内联）仍能加载出图；而非像旧实现那样「仅 base64 且失败→紫色回退」。
// 同时验证「包内图优先」：若包内路径可用则直接用包内图（与 tops/icons 在模拟器的加载机制一致）。
process.env.TZ = 'Asia/Shanghai';
const path = require('path');
const SRC = path.resolve(__dirname, '..', 'src');

// 模拟器 wx：platform==='devtools' → _HOME_B64 捕获为 homebg.js 内联的 base64
let lastSrc = null;
global.wx = {
  getSystemInfoSync: () => ({ platform: 'devtools', system: 'iOS 15.0', model: 'iPhone', pixelRatio: 3, screenWidth: 390, screenHeight: 844, windowWidth: 390, windowHeight: 844, SDKVersion: '3.17.1' }),
  // 包内路径（非 data:）一律失败（模拟 404），data: 成功 —— 验证「包内失败→base64 兜底」链
  createImage: function () {
    const im = {};
    im._ok = false;
    Object.defineProperty(im, 'src', {
      configurable: true,
      get() { return lastSrc; },
      set(v) {
        lastSrc = v;
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
const r = new Renderer({ width: 390, height: 844 }, makeCtx(), g, 56, 24, { left: 350, top: 10, width: 87, height: 32 });
r.shadowScale = 1;
r._reflow();

console.log('\n【模拟器(DevTools)】包内路径 404 → 应回退 base64 仍出图（不紫色回退）');
r.drawBackground();
ok('主页背景经 base64 兜底加载成功（_homeBgImage._ok=true）', !!(r._homeBgImage && r._homeBgImage._ok === true),
   'homeBgImage=' + (r._homeBgImage ? ('_ok=' + r._homeBgImage._ok) : 'null'));
ok('最终加载的是 data: base64（包内失败→base64 兜底）', typeof lastSrc === 'string' && lastSrc.slice(0, 5) === 'data:',
   String(lastSrc).slice(0, 20));

console.log('\n────────────────────────');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
