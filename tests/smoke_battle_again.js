// 冒烟套件 24 —— #6 核心循环无缝化（结算页「再战」行为锁定）
//
// 背景（整体审计 #6）：结算页「再战」原分支（battle_again）存在三个割裂点，把连胜循环打断：
//   ① 每次「再战」都扣 20 能量门票 —— 连胜被能量门槛卡断，无法形成"一局接一局"的心流；
//   ② 每次固定 stage:1（最低难度）—— 若免门票会无限刷低难度；
//   ③ 漏设 this.game.mode = 'battle'，靠 mode 仍为 battle 侥幸工作，状态语义不明确。
//
// 改造方向（已落 main.js:_battleAgain，原内联分支抽出命名方法）：
//   - 连胜中（winStreak>=1）「再战」免 20 能量门票，把连胜串起来；
//   - 连胜断了（winStreak=0，上一局失败）重新开始则照常扣门票，经济规则不变；
//   - 难度由 stage 驱动递增（stage=streak+1，spintop._diffFactor 据此加权），连胜越久越难，天然收敛；
//   - 显式 this.game.mode='battle' + game.save()，状态与存档闭环。
//
// 本套件锁定上述行为，防止回归。
process.env.TZ = 'Asia/Shanghai';
const path = require('path');
const SRC = path.resolve(__dirname, '..', 'src');
const { GameState } = require(path.join(SRC, 'game.js'));
const { Beyblade } = require(path.join(SRC, 'beyblade.js'));
const Main = require(path.join(SRC, 'main.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

// 构造 Main 裸实例（只挂 _battleAgain 所需的字段，避免 canvas/wx 重依赖）
function mkMain({ winStreak, energy, bb, lastBb }) {
  const m = Object.create(Main.prototype);
  const starts = [];           // 记录 _startBattle 调用：{ stage }
  const toasts = [];
  const saves = [];
  const plays = [];
  m.game = new GameState();
  m.game.winStreak = winStreak;
  m.game.energy = energy;
  m.game.maxEnergy = 150;
  m.game.mode = 'result';      // 模拟当前处于结算屏
  m.game.save = () => { saves.push(1); };
  m.lastBattleBb = (lastBb === undefined) ? null : lastBb;
  m._chestShown = true;
  m.game.selectBattleBeyblade = () => bb;
  m._toast = (s) => { toasts.push(s); };
  m._startBattle = (b, buff, opts) => { starts.push({ bb: b, opts }); };
  m.audio = { play: (t) => { plays.push(t); } };
  return { m, starts, toasts, saves, plays };
}

console.log('\n【#6 连胜免门票】winStreak>=1 时不扣 20 能量，且 stage=streak+1');
{
  const bb = new Beyblade(0, 1);
  const { m, starts, toasts, saves, plays } = mkMain({ winStreak: 3, energy: 5, bb, lastBb: bb });
  let threw = null;
  try { m._battleAgain(); } catch (e) { threw = e.message; }
  ok('_battleAgain 不抛异常', !threw, threw);
  ok('连胜中免门票：能量未被扣除（5 → 5）', m.game.energy === 5, 'energy=' + m.game.energy);
  ok('连胜中免门票：未提示"能量不足"', toasts.length === 0, 'toasts=' + JSON.stringify(toasts));
  ok('连胜中开战：调用了 _startBattle', starts.length === 1, 'starts=' + starts.length);
  ok('连胜中 stage 随连胜递增（streak3 → stage4）',
    starts.length === 1 && starts[0].opts.stage === 4,
    'stage=' + (starts[0] && starts[0].opts.stage));
  ok('连胜中显式置 mode=battle', m.game.mode === 'battle', 'mode=' + m.game.mode);
  ok('连胜中触发 clash 音效', plays.indexOf('clash') >= 0, 'plays=' + JSON.stringify(plays));
  ok('连胜中调用了 game.save()', saves.length === 1, 'saves=' + saves.length);
  ok('连胜中记录了 lastBattleBb', m.lastBattleBb === bb, 'lastBb=' + !!m.lastBattleBb);
  ok('连胜中重置了 _chestShown', m._chestShown === false, 'chestShown=' + m._chestShown);
}

console.log('\n【#6 stage 递增】streak=1 → stage=2，streak=9 → stage=10（难度曲线驱动）');
{
  const bb = new Beyblade(0, 1);
  const a = mkMain({ winStreak: 1, energy: 0, bb, lastBb: bb });
  a.m._battleAgain();
  ok('streak=1 → stage=2', a.starts.length === 1 && a.starts[0].opts.stage === 2,
    'stage=' + (a.starts[0] && a.starts[0].opts.stage));

  const b = mkMain({ winStreak: 9, energy: 0, bb, lastBb: bb });
  b.m._battleAgain();
  ok('streak=9 → stage=10', b.starts.length === 1 && b.starts[0].opts.stage === 10,
    'stage=' + (b.starts[0] && b.starts[0].opts.stage));
}

console.log('\n【#6 连胜断了照常扣门票】winStreak=0 时仍扣 20 能量，stage=1');
{
  const bb = new Beyblade(0, 1);
  const { m, starts, toasts } = mkMain({ winStreak: 0, energy: 60, bb, lastBb: bb });
  let threw = null;
  try { m._battleAgain(); } catch (e) { threw = e.message; }
  ok('连胜断了开战不抛异常', !threw, threw);
  ok('连胜断了仍扣 20 能量（60 → 40）', m.game.energy === 40, 'energy=' + m.game.energy);
  ok('连胜断了开战：调用了 _startBattle', starts.length === 1, 'starts=' + starts.length);
  ok('连胜断了 stage 从 1 起步（streak0 → stage1）',
    starts.length === 1 && starts[0].opts.stage === 1,
    'stage=' + (starts[0] && starts[0].opts.stage));
  ok('连胜断了未提示"能量不足"', toasts.length === 0, 'toasts=' + JSON.stringify(toasts));
}

console.log('\n【#6 能量不足拦截】winStreak=0 且能量<20 → 不开战、提示能量不足');
{
  const bb = new Beyblade(0, 1);
  const { m, starts, toasts } = mkMain({ winStreak: 0, energy: 10, bb, lastBb: bb });
  let threw = null;
  try { m._battleAgain(); } catch (e) { threw = e.message; }
  ok('能量不足不抛异常', !threw, threw);
  ok('能量不足不开战（starts=0）', starts.length === 0, 'starts=' + starts.length);
  ok('能量不足提示"能量不足，无法再战"',
    toasts.length === 1 && toasts[0] === '能量不足，无法再战', 'toasts=' + JSON.stringify(toasts));
  ok('能量不足未扣能量（10 → 10）', m.game.energy === 10, 'energy=' + m.game.energy);
}

console.log('\n【#6 无陀螺拦截】lastBattleBb 与 selectBattleBeyblade 都为空 → 不开战');
{
  const { m, starts, toasts, saves } = mkMain({ winStreak: 2, energy: 5, bb: null, lastBb: null });
  let threw = null;
  try { m._battleAgain(); } catch (e) { threw = e.message; }
  ok('无陀螺不抛异常', !threw, threw);
  ok('无陀螺（连胜中免门票也不开战）starts=0', starts.length === 0, 'starts=' + starts.length);
  ok('无陀螺未误扣能量（5 → 5）', m.game.energy === 5, 'energy=' + m.game.energy);
  ok('无陀螺未调用 game.save()', saves.length === 0, 'saves=' + saves.length);
}

console.log('\n【#6 lastBattleBb 优先】有 lastBattleBb 时优先用它、不调 selectBattleBeyblade');
{
  const lastBb = new Beyblade(1, 2);
  const otherBb = new Beyblade(2, 1);
  let selectCalled = false;
  const m = Object.create(Main.prototype);
  m.game = new GameState();
  m.game.winStreak = 1; m.game.energy = 5; m.game.maxEnergy = 150; m.game.mode = 'result';
  m.game.save = () => {};
  m.lastBattleBb = lastBb;
  m._chestShown = true;
  m.game.selectBattleBeyblade = () => { selectCalled = true; return otherBb; };
  m._toast = () => {};
  let gotBb = null;
  m._startBattle = (b) => { gotBb = b; };
  m.audio = { play: () => {} };
  m._battleAgain();
  ok('lastBattleBb 优先于 selectBattleBeyblade', gotBb === lastBb && !selectCalled,
    'gotBb=' + (gotBb && gotBb.level) + ' selectCalled=' + selectCalled);
}

console.log('\n────────────────────────');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
