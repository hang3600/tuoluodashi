// 冒烟套件 7 —— 战败能量策略（P2 细度重写 2026-10-31）
//
// 历史背景：曾收敛为常量 LOSE_ENERGY_PENALTY(15)，扣除与结算页文案都读它。
// P2 细度修复：战败惩罚**整体停用** —— 门票 20 + 战败扣 15 + 回能 2/秒 构成对失败者的
// 三重惩罚，新手挫败感叠加；竞品惯例是失败不扣资源、节奏全靠门票控制。
// 本套件改为锁定新行为：战败零扣除 + 结算页不再渲染「−N」扣能文案 +
// 惩罚常量保持 0（保留导出防兼容断裂，恢复路径见常量注释）。
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

console.log('\n【P2-a】战败不扣能量（门票 20 是全部成本）');
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
  ok(`战败零扣除（${before} → ${g.energy}，delta=${delta}）`, delta === 0, 'delta=' + delta);
  ok('LOSE_ENERGY_PENALTY 常量为 0（兼容导出保留）', LOSE_ENERGY_PENALTY === 0);
}

console.log('\n【P2-b】胜利同样不扣（负向用例不变）');
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

console.log('\n【P2-c】结算页不再渲染「−N」扣能文案；扣除代码已移除');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'battle', 'spintop.js'), 'utf8');
  ok('结算页无「−」+ LOSE_ENERGY_PENALTY 扣能文案', !/'−'\s*\+\s*LOSE_ENERGY_PENALTY/.test(src));
  ok('_settle 失败分支无能量扣除行', src.indexOf('this.game.energy - LOSE_ENERGY_PENALTY') < 0);
  const hardcoded = src.match(/'能量\s*-\d+'/g) || [];
  ok('无硬编码的「能量 -N」字面量', hardcoded.length === 0, hardcoded.join(', '));
}

console.log('\n【P2-d】失败总成本 = 门票 20（与胜利同价，输赢差只体现在收益侧）');
{
  ok('战败总成本 20 == 胜利总成本 20（门票同价，惩罚为 0）', 20 + LOSE_ENERGY_PENALTY === 20);
}

console.log('\n────────────────────────');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
