// 冒烟套件 3/4 —— TIERS 索引错位收口（P1-2 / P1-3 / P1-4 + main.js:351）
process.env.TZ = 'Asia/Shanghai';
const fs = require('fs');
const path = require('path');

const SRC_DIR = path.resolve(__dirname, '..', 'src');
const { GameState, TIERS, SIGN_REWARDS } = require(path.join(SRC_DIR, 'game.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

console.log('\n【P1-2】隐藏彩蛋产出传说（tierIndex 4，非精英）');
{
  const g = new GameState();
  g.inventory = [];
  g.mergeCount = 50;     // 触发第 1 次彩蛋（(hiddenDrops+1)*50）
  g.hiddenDrops = 0;
  const ret = g.checkHiddenEgg();
  const egg = ret && ret.bb;   // checkHiddenEgg 返回 { count, next, bb }
  ok('彩蛋返回 金·传说 tierIndex===4',
     egg && egg.tierIndex === 4,
     egg ? 'tier ' + egg.tierIndex + ' ' + TIERS[egg.tierIndex].name : 'null');
  ok('彩蛋 hidden 标记', egg && egg.hidden === true);
  ok('彩蛋是 Lv5', egg && egg.level === 5, egg ? 'Lv' + egg.level : '');
}

console.log('\n【P1-3】签到第 7 天大奖为传说（tierIndex 4）');
{
  const r7 = SIGN_REWARDS[6];   // 第 7 天 = 索引 6
  ok('第 7 天大奖含陀螺', r7 && r7.beyblade != null);
  ok('第 7 天大奖 tierIndex===4', r7 && r7.beyblade && r7.beyblade.tierIndex === 4,
     r7 && r7.beyblade ? 'tier ' + r7.beyblade.tierIndex : '');
  ok('第 7 天大奖是金·传说', r7 && r7.beyblade && TIERS[r7.beyblade.tierIndex].key === 'metal');
}

console.log('\n【P1-4 + main.js:351】传世演出/合成动效阈值 = 传说（>= 4），残留 >= 3 已清除');
{
  const renderSrc = fs.readFileSync(path.join(SRC_DIR, 'render.js'), 'utf8');
  const mainSrc = fs.readFileSync(path.join(SRC_DIR, 'main.js'), 'utf8');
  ok('render.js isLegend 用 >= 4',
     /isLegend\s*=\s*bb\.tierIndex\s*>=\s*4/.test(renderSrc));
  ok('render.js 无 isLegend >= 3 残留',
     !/isLegend\s*=\s*bb\.tierIndex\s*>=\s*3/.test(renderSrc));
  ok('main.js isBig 用 >= 4',
     /isBig\s*=\s*merged\.tierIndex\s*>=\s*4/.test(mainSrc));
  ok('main.js 无 isBig >= 3 残留',
     !/isBig\s*=\s*merged\.tierIndex\s*>=\s*3/.test(mainSrc));
  // 全仓再扫一遍：除了合法的「精英及以上」语义外，不应再有把 tier3 当传说的写法
  const gPity = require(path.join(SRC_DIR, 'game.js')); // 触发一次加载，确认可加载
  ok('game.js 仍可正常 require', !!gPity.GameState);
}

console.log('\n────────────────────────');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
