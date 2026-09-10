// 冒烟套件 · 青铜宝箱「开启」门控（2026-08-31 改版）
//   目标：验证「首次免费开 / 之后每次看广告开」的新逻辑在 game 层正确：
//   - 当日首次 isChestFreeOpenAvailable() 为 true，openBattleChest(false) 成功并消耗名额
//   - 之后 isChestFreeOpenAvailable() 为 false，必须走 openBattleChest(true)（看广告开，不消耗名额）
//   - 广告不可用降级 openBattleChest(false, true) 仍成功，且绕过/不消耗每日名额（防卡死底线）
//   注：面板绘制与「看广告开」的 Rewarded 编排在 smoke_ui_p2 / main 层覆盖，本套件只验纯规则。

process.env.TZ = 'Asia/Shanghai';

const path = require('path');
const SRC = path.resolve(__dirname, '..', 'src');
const { GameState } = require(path.join(SRC, 'game.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

console.log('\n【青铜宝箱·开启门控】首次免费 / 之后看广告');
{
  const g = new GameState();
  g.battleChest = { quality: 0, count: 3 };

  ok('初始：当日免费名额可用', g.isChestFreeOpenAvailable() === true);

  const r1 = g.openBattleChest(false); // 首次免费开
  ok('首次免费开成功', !!r1);
  ok('首次开后：当日免费名额已用', g.isChestFreeOpenAvailable() === false);

  const r2 = g.openBattleChest(true);  // 非首次：看广告开（不消耗免费名额）
  ok('非首次看广告开成功', !!r2);
  ok('看广告开后：免费名额仍不可用(当日)', g.isChestFreeOpenAvailable() === false);

  const r3 = g.openBattleChest(false, true); // 广告不可用时降级免费开（force 绕过每日限制）
  ok('降级免费开成功', !!r3);
  ok('降级开后：免费名额仍不可用(当日)', g.isChestFreeOpenAvailable() === false);

  ok('3 个宝箱全部开完 battleChest 置空', g.battleChest === null);
}

// 免费名额按「天」复位：模拟跨天（本地 0 点）后恢复免费名额
console.log('\n【青铜宝箱·开启门控】跨天复用免费名额');
{
  const RealDate = Date;
  function freeze(y, mo, d) {
    const fixed = new Date(y, mo - 1, d, 12, 0, 0).getTime();
    global.Date = class extends RealDate {
      constructor(...a) { if (a.length === 0) super(fixed); else super(...a); }
      static now() { return fixed; }
    };
  }
  try {
    const g = new GameState();
    g.battleChest = { quality: 1, count: 2 };
    freeze(2026, 8, 31);
    ok('D1 初始免费名额可用', g.isChestFreeOpenAvailable() === true);
    g.openBattleChest(false);
    ok('D1 开过后免费名额不可用', g.isChestFreeOpenAvailable() === false);
    freeze(2026, 9, 1); // 跨天
    ok('D2 免费名额恢复可用', g.isChestFreeOpenAvailable() === true);
  } finally {
    global.Date = RealDate;
  }
}

console.log('\n────────────────────────');
console.log('青铜宝箱开启门控套件：通过 ' + pass + ' / 失败 ' + fail);
if (fail > 0) process.exit(1);
