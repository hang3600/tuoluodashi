// U10 内存优化回归：非当前视图释放背景图（_releaseInactiveBg）+ LOW 档解码封顶 540p（capForLevel）
// 运行：node tests/smoke_bg_memory.js   （聚合：node tests/run.js）
//
// 关键不变量：
//  1. 在 codex 视图 → 仅释放 _homeBgImage（主页背景非当前视图），保留 _codexBgImage；
//     切回 home 视图 → 仅释放 _codexBgImage，保留 _homeBgImage。
//  2. 释放同时重置 *_BgTried 标记，使切回时能重新触发加载（运行时 jsbridge 已就绪，无启动期静默挂起）。
//  3. 当前视图的背景不被触碰（幂等，不重复置空）。
//  4. capForLevel('LOW')===540，其余('MID'/'HIGH'/undefined)===720。

const path = require('path');
const SRC = path.resolve(__dirname, '..', 'src');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? ' → ' + extra : '')); }
}

// 构造无 wx / 无 document 的 Node 环境：_loadIcons 空操作、downscaleToCap 走原图返回、_getBgCache 返回 null。
const savedWx = global.wx, savedDoc = global.document;
delete global.wx;
delete global.document;

const R = require(path.join(SRC, 'render.js'));
const { Renderer, capForLevel } = R;

// ===== 1. capForLevel 纯函数（U10-C）=====
console.log('【1】capForLevel（LOW 档解码封顶 540p）');
ok("capForLevel('LOW') === 540", capForLevel('LOW') === 540);
ok("capForLevel('MID') === 720", capForLevel('MID') === 720);
ok("capForLevel('HIGH') === 720", capForLevel('HIGH') === 720);
ok("capForLevel(undefined) === 720（缺省不降级）", capForLevel(undefined) === 720);

// ===== 2. 实例化 Renderer（Node 桩）=====
console.log('【2】Node 桩实例化 Renderer（无 wx 不崩）');
const fakeCanvas = { width: 750, height: 1334, dpr: 2 };
const noop = () => {};
const fakeCtx = new Proxy({}, {
  get(t, p) {
    if (p === 'canvas') return fakeCanvas;
    if (p === 'measureText') return () => ({ width: 10 });
    if (p === 'createLinearGradient' || p === 'createRadialGradient') return () => ({ addColorStop: noop });
    return noop;
  },
  set() { return true; }
});
const fakeGame = {
  view: 'codex', perfLevel: 'LOW',
  canRefill: () => false, canWatchAdEnergy: () => false,
  homeV2: true, energy: 0, maxEnergy: 100,
  inventory: [], platformSlots: [null, null, null], collection: [],
  filterTier: -1, pityEpic: 0, pityLegend: 0, drawCard: false, signOpen: false, tutorialDone: true
};
let r = null;
try {
  r = new Renderer(fakeCanvas, fakeCtx, fakeGame);
  ok('Renderer 可实例化（无 wx/无 document）', !!r);
} catch (e) {
  ok('Renderer 可实例化（无 wx/无 document）', false, e && e.message);
}

if (r) {
  // ===== 3. codex 视图：释放主页背景（非当前视图）=====
  console.log('【3】codex 视图下释放 _homeBgImage（非当前视图）');
  r._homeBgImage = { _ok: true, width: 100, height: 100 };
  r._homeBgTried = true;
  r._codexBgImage = null;
  r._codexBgTried = false;
  r._releaseInactiveBg();
  ok('codex 视图下释放 _homeBgImage', r._homeBgImage === null, JSON.stringify(r._homeBgImage));
  ok('释放同时重置 _homeBgTried（允许切回重载）', r._homeBgTried === false);
  ok('codex 视图下不动 _codexBgImage（当前视图保留）', r._codexBgTried === false); // 本来即空，验证未被误释放逻辑改坏

  // ===== 4. 切回 home 视图：释放图鉴背景（非当前视图）=====
  console.log('【4】home 视图下释放 _codexBgImage（非当前视图）');
  r.game.view = 'home';
  r._codexBgImage = { _ok: true, width: 100, height: 100 };
  r._codexBgTried = true;
  r._homeBgImage = null;
  r._homeBgTried = false;
  r._releaseInactiveBg();
  ok('home 视图下释放 _codexBgImage', r._codexBgImage === null, JSON.stringify(r._codexBgImage));
  ok('释放同时重置 _codexBgTried（允许切回重载）', r._codexBgTried === false);

  // ===== 5. 当前视图背景不被释放（幂等）=====
  console.log('【5】当前视图背景不被释放（幂等）');
  r.game.view = 'codex';
  r._codexBgImage = { _ok: true, width: 100, height: 100 };
  r._codexBgTried = true;
  r._homeBgImage = null;
  r._homeBgTried = false;
  r._releaseInactiveBg();
  ok('codex 视图下保留 _codexBgImage（当前视图）', r._codexBgImage !== null && r._codexBgTried === true);
  ok('codex 视图下 _homeBgImage 已为 null 不再变化', r._homeBgImage === null);
}

// 还原全局环境
if (savedWx === undefined) delete global.wx; else global.wx = savedWx;
if (savedDoc === undefined) delete global.document; else global.document = savedDoc;

console.log('\n────────────────────────');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
