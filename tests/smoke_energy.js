// 冒烟套件 7 —— P0-3 战败能量惩罚（扣除额与结算页显示一致）
//
// 背景：历史上出现过三处漂移 —— 注释写 -25、代码实际扣 50、结算页却显示「能量 -15」。
// 玩家看到的损失只有真实值的 30%。现在收敛为常量 LOSE_ENERGY_PENALTY，
// 扣除与文案都读它，本套件锁死二者永不脱节。
process.env.TZ = 'Asia/Shanghai';
const fs = require('fs');
const path = require('path');

const SRC_DIR = path.resolve(__dirname, '..', 'src');
const { GameState } = require(path.join(SRC_DIR, 'game.js'));
const { Beyblade } = require(path.join(SRC_DIR, 'beyblade.js'));
const { SpintopBattle, LOSE_ENERGY_PENALTY } = require(path.join(__dirname, '..', 'battle', 'spintop.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

console.log('\n【P0-3-a】战败实际扣除额 == 结算页显示值');
{
  const g = new GameState();
  const b = new SpintopBattle(g, 375, 812);
  b.safeTop = 56;
  b.safeBottom = 24;
  b.start(new Beyblade(0, 1));
  b.countdown = 0;
  b.score = 0;              // 远未达标 → 超时判负
  b.timeRemaining = 0.01;

  const before = g.energy;
  b.update(0.02);           // 触发超时结算
  const delta = before - g.energy;

  ok('判定为失败', b.result === 'lose', 'result=' + b.result + ' phase=' + b.phase);
  ok(`实际扣除 ${delta} 等于常量 LOSE_ENERGY_PENALTY(${LOSE_ENERGY_PENALTY})`,
    delta === LOSE_ENERGY_PENALTY, 'delta=' + delta);
}

console.log('\n【P0-3-b】胜利不扣惩罚（负向用例）');
{
  const g = new GameState();
  const b = new SpintopBattle(g, 375, 812);
  b.safeTop = 56;
  b.safeBottom = 24;
  b.start(new Beyblade(0, 1));
  b.countdown = 0;
  b.score = b.targetScore + 100;    // 直接达标
  const before = g.energy;
  const dt = 1 / 60;
  let t = 0;
  while (b.phase === 'playing' && t < 5) { b.update(dt); t += dt; }

  ok('判定为胜利', b.result === 'win', 'result=' + b.result);
  ok('胜利不额外扣能量（仅门票）', g.energy === before, before + ' → ' + g.energy);
}

console.log('\n【P0-3-c】结算页文案由常量生成，源码无硬编码数字');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'battle', 'spintop.js'), 'utf8');
  ok('扣能文案由 LOSE_ENERGY_PENALTY 拼接', /'−'\s*\+\s*LOSE_ENERGY_PENALTY/.test(src));
  const hardcoded = src.match(/'能量\s*-\d+'/g) || [];
  ok('无硬编码的「能量 -N」字面量', hardcoded.length === 0, hardcoded.join(', '));
  const literalDeduct = src.match(/this\.game\.energy - \d+/g) || [];
  ok('扣除处无硬编码数字字面量', literalDeduct.length === 0, literalDeduct.join(', '));
}

console.log('\n【P0-3-d】惩罚值合理性（保留张力但不劝退）');
{
  const g = new GameState();
  const ratio = LOSE_ENERGY_PENALTY / g.maxEnergy;
  ok(`惩罚 > 0（保留"输比赢亏"的张力）`, LOSE_ENERGY_PENALTY > 0, 'v=' + LOSE_ENERGY_PENALTY);
  ok(`占能量上限 ${(ratio * 100).toFixed(0)}%（≤20%，首次战败不至于掉一大截）`,
    ratio <= 0.2, 'ratio=' + ratio.toFixed(3) + ' maxEnergy=' + g.maxEnergy);
  ok(`失败总成本(门票20+惩罚${LOSE_ENERGY_PENALTY}) 仍显著高于胜利成本(20)`,
    20 + LOSE_ENERGY_PENALTY > 20, 'lose=' + (20 + LOSE_ENERGY_PENALTY) + ' win=20');
}

console.log('\n────────────────────────');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
