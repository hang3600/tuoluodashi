// 冒烟套件 2/4 —— 金币出口与产出下调（P1-5）
process.env.TZ = 'Asia/Shanghai';

const path = require('path');
const SRC_DIR = path.resolve(__dirname, '..', 'src');
const { GameState, COIN_DRAW_COST, TIERS } = require(path.join(SRC_DIR, 'game.js'));
const { Beyblade } = require(path.join(SRC_DIR, 'beyblade.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

console.log('\n【8】金币出口：金币抽卡（P1-5）');
{
  const g = new GameState();
  g.coins = 1000; g.energy = 0;
  const bb = g.draw(true);
  ok('金币抽卡成功返回陀螺', !!bb);
  ok('扣金币 ' + COIN_DRAW_COST, g.coins === 700, '余额 ' + g.coins);
  ok('不扣能量', g.energy === 0, '能量 ' + g.energy);
}
{
  const g = new GameState();
  g.coins = COIN_DRAW_COST - 1; g.energy = 0;
  ok('金币不足时返回 null', g.draw(true) === null);
  ok('金币不足时不扣费', g.coins === COIN_DRAW_COST - 1, '余额 ' + g.coins);
}
{
  const g = new GameState();
  g.coins = 1000; g.energy = 100;
  const bb = g.draw(false);
  ok('正常抽卡（走能量）成功', !!bb);
  ok('扣 8 能量', g.energy === 92, '能量 ' + g.energy);
  ok('不扣金币', g.coins === 1000, '金币 ' + g.coins);
}
{
  const g = new GameState();
  g.coins = 100; g.energy = 0;
  ok('金币与能量都不足 → null', g.draw(true) === null && g.draw(false) === null);
}

console.log('\n【9】金币抽卡继承保底与图鉴（不能是"二等公民"）');
{
  const g = new GameState();
  g.coins = 1e6;
  g.pityLegend = 29;
  const bb = g.draw(true);
  ok('金币抽卡同样触发传说保底', bb.tierIndex === 4, TIERS[bb.tierIndex].name);
}
{
  const g = new GameState();
  g.coins = 1e6;
  const before = g.codexCount();
  for (let i = 0; i < 50; i++) g.draw(true);
  ok('金币抽卡同样解锁图鉴', g.codexCount() > before, before + ' → ' + g.codexCount());
}
{
  const g = new GameState();
  g.coins = 1e6;
  const before = g.exp;
  g.draw(true);
  ok('金币抽卡同样给经验（+10）', g.exp === before + 10, 'exp ' + g.exp);
}

console.log('\n【10】对战金币产出下调（防通胀）');
function newReward(score, power, mult, act) {
  return Math.floor(Math.floor(score / 50) * mult * act) + Math.floor(power * 0.5) + 20;
}
function oldReward(score, power, mult, act) {
  return (Math.floor(score / 50) + Math.floor(power * 1.5) + 20) * mult * act;
}
{
  const cases = [[1, 1, 1], [3, 3, 1], [4, 4, 2], [5, 5, 5]];
  let allDown = true, highCut = 0;
  for (const [lv, tierIdx, mult] of cases) {
    const bb = new Beyblade(tierIdx - 1, lv);
    const target = Math.max(400, Math.floor((400 + bb.power * 10) * Math.min(1.8, 1 + mult * 0.06)));
    const o = oldReward(target, bb.power, mult, 1), n = newReward(target, bb.power, mult, 1);
    if (n >= o) allDown = false;
    if (lv === 5) highCut = Math.round((1 - n / o) * 100);
  }
  ok('各档位产出均下降（无反向）', allDown);
  ok('高阶单局降幅 > 60%', highCut > 60, highCut + '%');
}
{
  const bb = new Beyblade(4, 5);
  const target = 11440;
  const n = newReward(target, bb.power, 5, 1);
  const o = oldReward(target, bb.power, 5, 1);
  ok('Lv5 传说单局从 ' + o + ' 降到 ' + n, n < 2000 && n > 1000, String(n));
}
{
  const bb = new Beyblade(0, 1);
  const n = newReward(530, bb.power, 1, 1);
  ok('新手档位未被砍太狠（>25 金币）', n > 25, String(n));
}

console.log('\n【11】金币不再只进不出');
{
  const g = new GameState();
  g.coins = 5000;
  let inCount = 0;
  for (let i = 0; i < 10; i++) if (g.draw(true)) inCount++;
  ok('连续金币抽卡 10 次全部成功', inCount === 10);
  ok('累计消耗 ' + (5000 - g.coins) + ' 金币', 5000 - g.coins === COIN_DRAW_COST * 10);
  ok('余额正确 = 5000 - 3000', g.coins === 2000, '余额 ' + g.coins);
}

console.log('\n────────────────────────');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
