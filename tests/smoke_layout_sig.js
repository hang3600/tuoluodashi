// 冒烟套件 12 —— P1-7：布局签名塞了浮点 energy → 每帧全量 reflow ★性能首优
//
// 背景：render.js _curSig() 的签名里原本直接拼入原始浮点 g.energy，
// 而能量是连续回充的（game.js：this.energy = Math.min(max, energy + dt*2)），每帧都变，
// 导致 _maybeReflow() 的签名比对永远不等 → 每帧调 _reflow() → 第一行就清空 _gradCache，
// 约 35 处 _grad() + 约 40 处裸 createLinearGradient 每帧重建，且 _reflow 本身是全量布局计算。
// 讽刺的是 _maybeReflow 的注释正是「避免每帧全量计算」—— 它精确实现了自己要避免的事。
//
// 修法：签名里的 energy 改用布尔 (g.energy < g.maxEnergy)，只在「满 / 未满」边界翻转一次，
// 彻底消除逐帧 reflow。能量值本身不影响布局（SubBar 可见性已由 canRefill/canWatchAdEnergy 表达）。
//
// 本套件用真实 Renderer 类，但构造期屏蔽重型 _loadIcons/_reflow，再把实例 _reflow 换成计数器，
// 精确统计「被签名比对判定为需要」的 reflow 次数：
//   1) 同一未满状态下，能量浮点每帧抖动 → 不触发额外 reflow（签名恒定）
//   2) 能量跨「满」边界 → 恰好触发一次合法 reflow
//   3) 直接断言 _curSig() 对两个不同浮点（均未满）返回完全相同的字符串
process.env.TZ = 'Asia/Shanghai';
const path = require('path');

const SRC_DIR = path.resolve(__dirname, '..', 'src');
const { GameState } = require(path.join(SRC_DIR, 'game.js'));
const { Renderer } = require(path.join(SRC_DIR, 'render.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

/** 宽松 ctx：任意方法 no-op；createLinear/RadialGradient 返回带 addColorStop 的桩 */
function mockCtx() {
  return new Proxy({}, {
    get(t, p) {
      if (p === 'measureText') return () => ({ width: 10 });
      if (p === 'createRadialGradient' || p === 'createLinearGradient')
        return () => ({ addColorStop() {} });
      return () => {};
    },
    set() { return true; }
  });
}

/** 构造一个 Renderer，屏蔽构造期重型步骤，并把实例 _reflow 换成计数器 */
function mkRenderer(energy, maxEnergy) {
  const g = new GameState();
  g.energy = energy;
  g.maxEnergy = maxEnergy;
  const canvas = { width: 375, height: 812 };
  const ctx = mockCtx();
  // 构造期屏蔽 _loadIcons（碰 wx/Image）/_reflow（全量布局），本套件只测签名决策
  const savedLoad = Renderer.prototype._loadIcons;
  const savedReflow = Renderer.prototype._reflow;
  Renderer.prototype._loadIcons = function () {};
  Renderer.prototype._reflow = function () {};
  const r = new Renderer(canvas, ctx, g, 56, 24, null);
  Renderer.prototype._loadIcons = savedLoad;
  Renderer.prototype._reflow = savedReflow;
  // 计数器桩：每次「被 _maybeReflow 判定需要」就 +1
  r._reflowCount = 0;
  r._reflow = function () { this._reflowCount++; };
  return r;
}

console.log('\n【P1-7-a】同一未满状态下，能量浮点每帧抖动不触发额外 reflow');
{
  const r = mkRenderer(12.345, 100);
  r._maybeReflow();                 // 首次：_layoutSig 为 null，必 reflow（count=1）
  const afterFirst = r._reflowCount;
  // 模拟「每帧回充 2/s」抖动 60 帧（覆盖约 30 个整数边界，未达满）
  for (let i = 0; i < 60; i++) {
    r.game.energy = 12.345 + i * 0.033;   // 12.345 → 14.325，始终 < 100
    r._maybeReflow();
  }
  ok('60 帧浮点抖动后 reflow 次数仍等于首次（=1）',
    r._reflowCount === afterFirst && afterFirst === 1,
    'reflowCount=' + r._reflowCount);

  // 再连续换 200 个随机浮点（均未满），签名必须恒定
  let stable = true;
  const base = r._reflowCount;
  for (let i = 0; i < 200; i++) {
    r.game.energy = 30 + Math.random() * 40;   // 30~70，均 < 100
    r._maybeReflow();
    if (r._reflowCount !== base) { stable = false; break; }
  }
  ok('200 个随机浮点（均未满）全程零额外 reflow', stable,
    'reflowCount=' + r._reflowCount);
}

console.log('\n【P1-7-b】能量跨「满」边界恰好触发一次合法 reflow');
{
  const r = mkRenderer(99.9, 100);
  r._maybeReflow();                 // 首次 reflow（count=1），此时 99.9<100 → 布尔 true
  const afterFirst = r._reflowCount;
  r.game.energy = 100.0;            // 100<100 → false，跨越边界
  r._maybeReflow();
  ok('从 99.9 跨到 100.0 触发恰好一次 reflow',
    r._reflowCount === afterFirst + 1,
    'reflowCount=' + r._reflowCount);

  // 继续在「满」状态抖动（100.0~100.0，都是 false），不应再 reflow
  const atFull = r._reflowCount;
  for (let i = 0; i < 30; i++) {
    r.game.energy = 100.0;          // 始终满
    r._maybeReflow();
  }
  ok('满状态持续 30 帧零额外 reflow', r._reflowCount === atFull,
    'reflowCount=' + r._reflowCount);
}

console.log('\n【P1-7-c】从满回到未满，恰好再触发一次 reflow（边界对称）');
{
  const r = mkRenderer(100.0, 100);
  r._maybeReflow();                 // 首次 reflow（count=1），100<100 → false
  const atFull = r._reflowCount;
  r.game.energy = 50.0;             // 50<100 → true，跨越边界回到未满
  r._maybeReflow();
  ok('从满(100)回到未满(50)触发恰好一次 reflow',
    r._reflowCount === atFull + 1,
    'reflowCount=' + r._reflowCount);
}

console.log('\n【P1-7-d】_curSig() 对两个不同浮点（均未满）返回完全相同的字符串');
{
  const r1 = mkRenderer(50.3, 100);
  const r2 = mkRenderer(50.7, 100);
  const s1 = r1._curSig();
  const s2 = r2._curSig();
  ok('_curSig() 在 50.3 与 50.7（均未满）下签名一致', s1 === s2,
    '\n    sig1=' + s1 + '\n    sig2=' + s2);
  // 签名里不应再出现裸浮点（旧 bug：50.3 / 50.7 这类小数）
  ok('签名不含裸浮点 energy（无 ".3"/".7" 这类小数）',
    !/\.\d/.test(s1), 'sig=' + s1);
}

console.log('\n' + (fail === 0 ? '✅' : '❌') + ' P1-7 布局签名浮点 reflow 套件：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
