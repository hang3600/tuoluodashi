/**
 * 陀螺贴图真机矢量修复（续）：离屏画布不可用时「直接画 PNG 兜底」回归测试。
 *
 * 真机事实（用户 2026-09-01 回传日志实锤）：主包里 wx.createOffscreenCanvas 在真机
 * 持续返回不可用对象（[topimg] spr FAIL reason=offscreen），导致 getBeybladeSprite
 * 返回 {fail:true}，旧代码 dr·awBeyblade 把它当成「退回矢量」—— 这正是主页/图鉴
 * 真机矢量、对战却正常（对战在分包、晚调用离屏才正常）的根因。
 *
 * 修复：drawBeyblade 在 spr.fail 时不再退回矢量，而是把真实 PNG 直接 drawImage 到主画布
 * （与对战页最终 drawImage 到主画布是同一原语，稳定可靠）。
 *
 * 本测试：mock 让 wx.createOffscreenCanvas 返回 null（模拟真机离屏坏掉），
 * 断言 drawBeyblade 仍把真实 PNG 直接画出来（pngDraws≥5），且出现 [topimg] directdraw 日志，
 * 且检测到 [topimg] spr FAIL（说明确实走了「离屏坏→兜底」分支，而非侥幸没触发离屏）。
 * 运行：node tests/smoke_topimg_directdraw.js
 */
const path = require('path');
const MOD = path.join(__dirname, '..', 'src', 'beyblade.js');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const noop = () => {};
const grad = { addColorStop: noop };

// 捕获 [topimg] 诊断日志
const topimgLogs = [];
const origLog = console.log;
console.log = function (...a) { if (a[0] === '[topimg]') topimgLogs.push(a.slice(1).join(' ')); else origLog.apply(console, a); };

// 统计：drawBeyblade 直接把真实 image 画到主画布的次数（带 onload 的是 wx.Image，离屏 canvas 不带）
let pngDraws = 0;
function makeCtx() {
  return {
    drawImage(...a) { if (a[0] && typeof a[0].onload === 'function') pngDraws++; },
    beginPath: noop, arc: noop, save: noop, restore: noop, clip: noop, stroke: noop,
    fill: noop, fillRect: noop, strokeRect: noop, fillText: noop, strokeText: noop,
    translate: noop, rotate: noop, scale: noop, setLineDash: noop, closePath: noop,
    moveTo: noop, lineTo: noop, quadraticCurveTo: noop, bezierCurveTo: noop, clearRect: noop,
    createRadialGradient: () => grad, createLinearGradient: () => grad, createPattern: () => null,
    measureText: () => ({ width: 10 }),
    set strokeStyle(v) {}, set fillStyle(v) {}, set lineWidth(v) {}, set font(v) {},
    set textAlign(v) {}, set textBaseline(v) {}, set globalAlpha(v) {}, set shadowBlur(v) {},
    set shadowColor(v) {}, set lineCap(v) {}, set lineJoin(v) {}, set globalCompositeOperation(v) {}
  };
}
const ctx = makeCtx();

// mock wx：createImage 异步 onload（模拟真机包内路径加载成功）；createOffscreenCanvas 返回 null（模拟真机离屏坏掉）
global.wx = {
  getSystemInfoSync() { return { platform: 'android' }; }, // 真机 + jsbridge 就绪
  createImage() {
    const im = {
      _src: '', _ok: false, width: 0, height: 0, onload: null, onerror: null,
      set src(v) { this._src = v; const self = this; setTimeout(() => { self.width = 256; self.height = 256; self._ok = true; self.onload && self.onload(); }, 0); },
      get src() { return this._src; }
    };
    return im;
  },
  createOffscreenCanvas() { return null; } // ← 关键：模拟真机离屏画布不可用
};

let fails = 0;
function assert(cond, msg) { if (!cond) { fails++; console.log('  ❌ ' + msg); } else { console.log('  ✅ ' + msg); } }

(async () => {
  const B = require(MOD);
  const TIERS = ['土', '木', '水', '火', '金'];

  // 首轮：PNG 尚未就绪（模拟启动早期），应走矢量/等待，不直接画 PNG
  pngDraws = 0;
  for (let t = 0; t < 5; t++) B.drawBeyblade(ctx, 0, 0, new B.Beyblade(t, 1), 1);

  await sleep(60); // 等异步 onload

  // 次轮：PNG 已就绪，离屏又不可用 → 必须走「直接画 PNG」兜底，绝不矢量
  pngDraws = 0;
  for (let t = 0; t < 5; t++) B.drawBeyblade(ctx, 0, 0, new B.Beyblade(t, 1), 1);
  // 再画两轮，确认 _offscreenBroken 后置位、不再每帧重试离屏，但 PNG 持续直接出图
  for (let t = 0; t < 5; t++) B.drawBeyblade(ctx, 0, 0, new B.Beyblade(t, 1), 1);

  console.log('\n═══ 离屏坏掉 → 直接画 PNG 兜底 验证 ═══\n');
  assert(pngDraws >= 5, '5 系陀螺均直接把真实 PNG 画到主画布（drawImage 调用 = ' + pngDraws + ' 次，≥5 即通过；若为矢量则 =0）');
  const hasDirect = topimgLogs.some(l => l.indexOf('directdraw') === 0);
  assert(hasDirect, '[topimg] directdraw 兜底日志已出现（证明走了「离屏坏→直接画 PNG」分支）');
  const hasFail = topimgLogs.some(l => l.indexOf('spr FAIL') === 0);
  assert(hasFail, '检测到 [topimg] spr FAIL（证明确实触发了离屏不可用，而非没走到离屏）');
  const failCount = topimgLogs.filter(l => l.indexOf('spr FAIL') === 0).length;
  assert(failCount <= 3, 'spr FAIL 仅打印少量（' + failCount + ' 次，置位 _offscreenBroken 后不再每帧重试离屏）');
  const noVector = pngDraws >= 5; // 若退回矢量，pngDraws 必为 0
  assert(noVector, '未退回矢量（矢量分支不画带 onload 的 image，pngDraws 仍 ≥5 即说明直接画了 PNG）');

  const pass = fails === 0;
  console.log('\n═══ ' + (pass ? '✅ 离屏坏→直接画 PNG 兜底 验证通过' : '❌ 验证失败（' + fails + ' 项）') + ' ═══\n');
  process.exit(pass ? 0 : 1);
})();
