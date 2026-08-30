// 冒烟套件 4/4 —— P2 八项打磨
process.env.TZ = 'Asia/Shanghai';
const path = require('path');

const SRC_DIR = path.resolve(__dirname, '..', 'src');
const { GameState } = require(path.join(SRC_DIR, 'game.js'));
const { Beyblade, TIERS, randomBeyblade } = require(path.join(SRC_DIR, 'beyblade.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

console.log('\n【P2-1】codexCount / codexTotal 在 collection 为 null 时安全');
{
  const g = new GameState();
  g.collection = null;
  ok('codexCount(null) 不抛错且返回 0', g.codexCount() === 0, 'val=' + g.codexCount());
  ok('codexTotal(null) 不抛错且返回 0', g.codexTotal() === 0, 'val=' + g.codexTotal());
}

console.log('\n【P2-6】合成台（platformSlots）陀螺计入元素羁绊');
{
  const g = new GameState();
  g.inventory = [];
  const mk = (lvl) => new Beyblade(0, lvl); // 土·普通，elementIdx 由 tier×level 确定性派生
  g.platformSlots = [mk(1), mk(1), mk(1)];
  const bond = g.bondResonance();
  ok('合成台 3 个同元素计入 count=3', bond.count === 3, 'count=' + bond.count);
  ok('元素共鸣激活(>=3)', bond.active === true);
  ok('共鸣元素 == 台上陀螺派生元素', bond.elementIdx === g.platformSlots[0].elementIdx, 'bond=' + bond.elementIdx + ' sample=' + g.platformSlots[0].elementIdx);
  // 反例：背包里 3 个、台上一 0 个，应一致计数
  const g2 = new GameState();
  g2.inventory = [mk(1), mk(1), mk(1)];
  g2.platformSlots = [null, null, null];
  const bond2 = g2.bondResonance();
  ok('仅背包 3 个同样 count=3', bond2.count === 3);
}

console.log('\n【P2-7】背包满时抽卡折算金币，lastDrawConverted 标记');
{
  const g = new GameState();
  g.energy = 1e6;
  // 填满背包到硬上限（与 draw() 内 INVENTORY_HARD_CAP 对齐）
  const CAP = 400;
  g.inventory = [];
  for (let i = 0; i < CAP; i++) g.inventory.push(new Beyblade(0, 1));
  const coinsBefore = g.coins;
  const bb = g.draw();
  ok('满背包抽卡仍返回 bb（供 UI 判定）', bb != null);
  ok('lastDrawConverted > 0（折算金币数）', g.lastDrawConverted > 0, 'conv=' + g.lastDrawConverted);
  ok('金币因折算增加', g.coins > coinsBefore, coinsBefore + ' → ' + g.coins);
  ok('背包未越界（仍 = 上限）', g.inventory.length === CAP, 'len=' + g.inventory.length);
}

console.log('\n【P2-8】randomBeyblade(luck)：luck 越大越偏向高稀有度，luck=1 行为不变');
{
  const N = 40000;
  const avg = (luck) => { let s = 0; for (let i = 0; i < N; i++) s += randomBeyblade(luck).tierIndex; return s / N; };
  const a1 = avg(1);
  const a2 = avg(2);
  const expected = TIERS.reduce((s, t, i) => s + t.chance * i, 0); // 理论均值 ≈ 1.10
  ok('luck=1 均值 ≈ 分布期望(≈1.10)', Math.abs(a1 - expected) < 0.05, 'a1=' + a1.toFixed(3) + ' exp=' + expected.toFixed(3));
  ok('luck=2 平均稀有度显著高于 luck=1', a2 > a1 + 0.1, 'luck1=' + a1.toFixed(3) + ' luck2=' + a2.toFixed(3));
}

console.log('\n────────────────────────');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
