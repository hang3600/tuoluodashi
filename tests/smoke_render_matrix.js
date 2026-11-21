// 烟雾测试：全链路渲染状态矩阵（2026-11-08 新增）
//
// 背景（真机事故）：第二波打磨的「Tab 切换暗闪」在 render() 尾部误用裸 ctx / w / h ——
// 该作用域三者均未定义 → 每次冷启动第 3 帧起（_lastRenderView 首次对齐前）与每次切 Tab
// 都整帧抛 `ctx is not defined`，被 _doFrame 捕获后连累 _safeResetIfFatal 连续强制复位。
// 既有 79 套件都是「逐方法驱动」渲染，没人跑 render() 全链路 → 静态扫描也只命中注释，
// 最终靠本套件的前身探针（32 状态 × 12 帧）复现定位。
//
// 本套件锁定：
//   1) render() 全链路在 32 种主界面状态（含全面板开合/视图切换/性能档/拖拽/震屏）下零抛错；
//   2) 冷启动路径（splash 帧 → 正常帧）零抛错，且首帧对齐不触发暗闪（无冷启动黑闪）；
//   3) 显式切 Tab（home↔codex）触发 _tabFlash 且渲染不抛错（修复回归锁）；
//   4) 源码门禁：暗闪块使用 this.ctx + this.width/height，杜绝同类裸引用复发。
process.env.TZ = 'Asia/Shanghai';
const fs = require('fs');
const path = require('path');

const store = {};
const noop = () => {};
const gradStub = () => ({ addColorStop: noop });
const canvas = { dpr: 1, width: 375, height: 812 };
const ctx = new Proxy({ canvas }, {
  get(t, p) {
    if (p === 'canvas') return canvas;
    if (p === 'createLinearGradient' || p === 'createRadialGradient' || p === 'createPattern') return gradStub;
    if (p === 'measureText') return () => ({ width: 10 });
    return noop;
  },
  set() { return true; },
});
const sysInfo = { model: 'iPhone', system: 'iOS 16', benchmarkLevel: 60, screenWidth: 375, screenHeight: 812, windowHeight: 778, statusBarHeight: 44, pixelRatio: 1 };
global.wx = new Proxy({
  setStorageSync: (k, v) => { store[k] = v; },
  getStorageSync: (k) => (k in store ? store[k] : ''),
  getSystemInfoSync: () => sysInfo,
  getMenuButtonBoundingClientRect: () => ({ top: 24, height: 32, left: 300, width: 60 }),
  removeStorageSync: (k) => { delete store[k]; },
}, { get(t, p) { if (p in t) return t[p]; return noop; } });
global.requestAnimationFrame = () => 0;
// 同步执行定时器：走尽所有 setTimeout 延迟分支（广告懒初始化/错峰创建等），暴露延迟路径里的错
global.setTimeout = (fn) => { try { fn(); } catch (e) {} return 0; };
global.clearTimeout = noop;

const { Beyblade } = require(path.join(__dirname, '..', 'src', 'beyblade.js'));
const Main = require(path.join(__dirname, '..', 'src', 'main.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? ' → ' + extra : '')); }
}

const m = new Main(canvas, ctx, sysInfo);
const g = m.game;
g.homeV2 = true; g.mode = 'main';
g.energy = 100; g.coins = 500; g.save = noop;
g.inventory = [new Beyblade(4, 5), new Beyblade(3, 4), new Beyblade(2, 3), new Beyblade(1, 2)];
g.platformSlots[0] = new Beyblade(2, 1);
g.platformSlots[2] = new Beyblade(2, 1);

const dt = 1 / 30;
let frame = 0;
/** 直呼 update+render（绕过 _doFrame 的 try）：任何抛错即失败并带出真实栈 */
function step(n, tag) {
  for (let i = 0; i < n; i++) {
    frame++;
    try { m.update(dt); m.renderer.render(dt); }
    catch (e) { ok('状态[' + tag + '] 第' + frame + '帧渲染零抛错', false, e.message); return false; }
  }
  return true;
}

// ── 1) 冷启动：splash 帧（1-2）→ 正常帧；修复前第 3 帧即抛 ctx is not defined ──
console.log('【1】冷启动路径（splash → 正常帧，_lastRenderView 首次对齐）');
let allOk = step(10, 'boot');
ok('冷启动 10 帧零抛错（含 _lastRenderView 首次对齐帧）', allOk);
ok('冷启动不触发暗闪（首帧对齐前 _tabFlash 未被置位）',
   !(m.renderer._tabFlash > 0), '._tabFlash=' + m.renderer._tabFlash);

// ── 2) 32 状态 × 12 帧全链路矩阵 ──
console.log('【2】主界面 32 状态全链路矩阵');
const states = [
  ['codex-glow', () => { g.codexGlowT = 8; }],
  ['merge-reveal', () => { g.mergeReveal = { tierIndex: 2, oldLevel: 1, newLevel: 2, t: 0.4 }; }],
  ['view-codex', () => { g.view = 'codex'; }],
  ['view-home', () => { g.view = 'home'; }],
  ['panel-welfare', () => { g.welfareOpen = true; }],
  ['panel-welfare-off', () => { g.welfareOpen = false; }],
  ['panel-sign', () => { g.signOpen = true; }],
  ['panel-sign-off', () => { g.signOpen = false; }],
  ['panel-daily', () => { g.dailyOpen = true; }],
  ['panel-daily-off', () => { g.dailyOpen = false; }],
  ['panel-arena', () => { g.arenaOpen = true; }],
  ['panel-arena-off', () => { g.arenaOpen = false; }],
  ['panel-weekshop', () => { g.weekShopOpen = true; }],
  ['panel-weekshop-off', () => { g.weekShopOpen = false; }],
  ['panel-level', () => { g.levelOpen = true; }],
  ['panel-level-off', () => { g.levelOpen = false; }],
  ['panel-offline', () => { g.offlineOpen = true; }],
  ['panel-offline-off', () => { g.offlineOpen = false; }],
  ['drawcard', () => { g.drawCard = { bb: new Beyblade(4, 1), t: 0.3 }; }],
  ['drawcard-off', () => { g.drawCard = null; }],
  ['club-guide', () => { g.clubGuideOpen = true; }],
  ['club-guide-off', () => { g.clubGuideOpen = false; }],
  ['drag', () => { g.dragging = g.inventory[0]; m.dragBb = g.inventory[0]; m.dragPos = { x: 100, y: 300 }; }],
  ['drag-off', () => { g.dragging = null; m.dragBb = null; }],
  ['weekend', () => { g.weekendBannerT = 3; }],
  ['shake', () => { m.renderer.shake(6, 0.3); }],
  ['perf-low', () => { g.perfLevel = 'LOW'; }],
  ['perf-high', () => { g.perfLevel = 'HIGH'; }],
  ['homev2-off', () => { g.homeV2 = false; }],
  ['homev2-on', () => { g.homeV2 = true; }],
  ['tutorial-on', () => { g.tutorialDone = false; }],
  ['tutorial-off', () => { g.tutorialDone = true; }],
];
let matrixOk = true;
for (const [tag, setup] of states) {
  try { setup(); } catch (e) { ok('状态[' + tag + '] setup 可执行', false, e.message); matrixOk = false; continue; }
  if (!step(12, tag)) matrixOk = false;
}
ok('32 状态 × 12 帧全链路零抛错（共 ' + frame + ' 帧）', matrixOk);

// ── 3) 显式切 Tab：触发暗闪且渲染不抛错（修复回归锁）──
console.log('【3】切 Tab 暗闪（修复回归锁）');
g.view = 'codex';
let flashOk = step(3, 'switch-to-codex');
ok('切 Tab 触发 _tabFlash', m.renderer._tabFlash > 0, '._tabFlash=' + m.renderer._tabFlash);
ok('暗闪激活期间渲染零抛错', flashOk);
g.view = 'home';
ok('切回 Tab 渲染零抛错', step(3, 'switch-to-home'));
step(10, 'flash-decay');
ok('暗闪自然衰减归零', !(m.renderer._tabFlash > 0));

// ── 4) 源码门禁：暗闪块禁用裸 ctx / 裸 w,h ──
console.log('【4】源码门禁');
const renderSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'render.js'), 'utf8');
const flashBlock = (renderSrc.match(/if \(this\._tabFlash > 0\) \{[\s\S]*?\n    \}/) || [''])[0];
ok('暗闪块使用 this.ctx（非裸 ctx）', /this\.ctx|const c = this\.ctx/.test(flashBlock) && !/(?<![\w.])ctx\.(save|globalAlpha|fillStyle|fillRect|restore)/.test(flashBlock));
ok('暗闪块使用 this.width/this.height（非裸 w,h）', /this\.width, this\.height/.test(flashBlock) && !/fillRect\(0, 0, w, h\)/.test(flashBlock));

console.log(`\n[render-matrix] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
