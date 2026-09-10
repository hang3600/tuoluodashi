// 主页背景「真机加载」回归测试 —— 守防 2026-09-02 发现的真机丢背景 bug。
// 复现条件：真机 homebg.js 经 shim 导出 null（_HOME_B64=null），此前 _ensureHomeBgImage
// 有「if (!_HOME_B64) return;」早返回 → 主页背景永远走渐变回退、包内 images/home/home_cosmic.jpg 永不加载。
// 本套件在「真机 wx（platform!=='devtools'）→ _HOME_B64 被捕获为 null」下重新加载 render.js，
// 调用 drawBackground()，断言 wx.createImage 仍被调用且 src 为包内路径（未早返回）。
process.env.TZ = 'Asia/Shanghai';
const path = require('path');
const SRC = path.resolve(__dirname, '..', 'src');

// 1) 先布置「真机」wx：platform 非 devtools → homebg.js 导出 null → render.js 捕获 _HOME_B64=null
let createdSrcs = [];
let createCalled = 0;
global.wx = {
  getSystemInfoSync: () => ({ platform: 'ios', system: 'iOS 15.0', model: 'iPhone', pixelRatio: 3, screenWidth: 390, screenHeight: 844, windowWidth: 390, windowHeight: 844, SDKVersion: '3.17.1' }),
  // 仅记录调用与所有 src，不触发 onload（断言同步即可，避免异步抖动）
  createImage: function () {
    createCalled++;
    const im = {};
    Object.defineProperty(im, 'src', {
      configurable: true,
      get() { return null; },
      set(v) { createdSrcs.push(v); },
    });
    return im;
  },
};

// 2) 清缓存，确保 render.js 在真机 wx 下重新捕获 _HOME_B64=null（homebg 模块一并清）
//    homebg.js 已内联 base64：真机(platform!=='devtools')分支返回 null → _HOME_B64=null
const rp = path.join(SRC, 'render.js');
const hbp = path.join(SRC, 'homebg.js');
for (const p of [rp, hbp]) { if (require.cache[p]) delete require.cache[p]; }
const { Renderer } = require(rp);
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

console.log('\n【真机(_HOME_B64=null)】主页背景应加载包内 JPG，而非早返回走渐变');
r.drawBackground();
ok('wx.createImage 被调用', createCalled > 0, 'createCalled=' + createCalled);
ok('真机仍请求包内 images/home/home_cosmic.jpg（未早返回走渐变）', createdSrcs.indexOf('images/home/home_cosmic.jpg') >= 0, JSON.stringify(createdSrcs));

console.log('\n────────────────────────');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
