// 冒烟套件 —— 胜利结算翻倍（文章验证的 eCPM 最高、最不伤留存的广告位）
//
// 背景：广告变现的本质是"什么时候弹"。赢一局玩家心情好 → "看广告金币翻倍"，
//   eCPM 最高、不伤留存。基础奖励已入账，看后再多给 reward → 总 ×2。
// 无广告位（resultDoubleAdUnitId 空）→ 结算页"翻倍"按钮不渲染（无死按钮）。
// 含每日上限 + 同局一次 + 广告位缺失降级，均不伤害已到账基础奖励。
process.env.TZ = 'Asia/Shanghai';
const path = require('path');
const fs = require('fs');
const SRC = path.resolve(__dirname, '..', 'src');
const { GameState } = require(path.join(SRC, 'game.js'));
const { CONFIG } = require(path.join(SRC, 'config.js'));
const Main = require(path.join(SRC, 'main.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}
function mkMain() {
  const m = Object.create(Main.prototype);
  const toasts = [];
  m.game = new GameState();
  m.game.battle = { coop: false, result: 'win', reward: 50 };
  m._resultDoubled = false;
  m._adBusy = false;
  m._toast = (s) => { toasts.push(s); };
  m.audio = { play: () => {} };
  m.renderer = { addFloatText: () => {} };
  m.cw = 375; m.ch = 812;
  return { m, toasts };
}

console.log('\n【1 config】翻倍位配置');
{
  ok('resultDoubleAdUnitId 已配置为激励位（非空，结算翻倍生效）', typeof CONFIG.resultDoubleAdUnitId === 'string' && CONFIG.resultDoubleAdUnitId.length > 0, '=' + CONFIG.resultDoubleAdUnitId);
  ok('留空则按钮隐藏的设计仍保留（源级，无死按钮）', /!CONFIG\.resultDoubleAdUnitId/.test(fs.readFileSync(path.join(SRC,'main.js'),'utf8')));
  ok('resultDoublePerDay 默认 3 次上限', CONFIG.resultDoublePerDay === 3, '=' + CONFIG.resultDoublePerDay);
}

console.log('\n【2 game 每日计数 & 跨天归零】');
{
  const g = new GameState();
  ok('初始当日翻倍次数 0', g.resultDoubleCountToday() === 0, '=' + g.resultDoubleCountToday());
  g.markResultDouble();
  ok('markResultDouble 后 = 1', g.resultDoubleCountToday() === 1, '=' + g.resultDoubleCountToday());
  g.resultDoubleDate = '1970-01-01';   // 模拟跨天
  ok('跨天归零', g.resultDoubleCountToday() === 0, '=' + g.resultDoubleCountToday());
}

console.log('\n【3 存档/源码级闸门】');
{
  g_src = fs.readFileSync(path.join(SRC, 'game.js'), 'utf8');
  m_src = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
  st_src = fs.readFileSync(path.join(__dirname, '..', 'battle', 'spintop.js'), 'utf8');
  ok('game save 含 resultDouble', /resultDoubleDate: this\.resultDoubleDate,/.test(g_src) && /resultDoubleCount: this\.resultDoubleCount,/.test(g_src));
  ok('game load 还原 default', /this\.resultDoubleDate = typeof data\.resultDoubleDate/.test(g_src) && /this\.resultDoubleCount = Math\.max/.test(g_src));
  ok('main 有 _watchResultDouble 分发', /_watchResultDouble/.test(m_src) && /battle_result_double/.test(m_src));
  ok('翻倍 onReward 走 coins += extra 且 markResultDouble', /this\.game\.coins \+= extra/.test(m_src) && /markResultDouble\(\)/.test(m_src));
  ok('spintop 结算翻倍按钮 + doubleAvailable 门控', /action: 'battle_result_double'/.test(st_src) && /doubleAvailable/.test(st_src) && /!this\.coop/.test(st_src));
}

console.log('\n【4 _watchResultDouble 同步守卫（未配置/每日上限/同局一次）】');
{
  // 4a 未配置广告位
  const hold = CONFIG.resultDoubleAdUnitId;
  CONFIG.resultDoubleAdUnitId = '';
  let { m, toasts } = mkMain();
  const base = m.game.coins;
  m._watchResultDouble();
  ok('广告位空 → 提示"暂未开通"，金属不变', toasts.some(t => /暂未开通/.test(t)) && m.game.coins === base, 't=' + JSON.stringify(toasts));

  // 4b 每日上限
  CONFIG.resultDoubleAdUnitId = 'adunit-real-token-0001';
  let fx = mkMain(); m = fx.m; toasts = fx.toasts;
  m.game.resultDoubleDate = m.game._todayKey();   // 设成"今天"避免跨天归零
  m.game.resultDoubleCount = CONFIG.resultDoublePerDay;   // 已达当日上限
  m._watchResultDouble();
  ok('达每日上限 → 提示"今日翻倍次数已用完"', toasts.some(t => /今日翻倍/.test(t)), 't=' + JSON.stringify(toasts));

  // 4c 同局已翻倍
  fx = mkMain(); m = fx.m; toasts = fx.toasts;
  m._resultDoubled = true;
  m._watchResultDouble();
  ok('同局已翻倍 → 提示"本局已翻倍"', toasts.some(t => /本局已翻倍/.test(t)), 't=' + JSON.stringify(toasts));

  // 4d 非胜利 / 合作关 不动作
  fx = mkMain(); m = fx.m; toasts = fx.toasts;
  m.game.battle.result = 'lose';
  m._watchResultDouble();
  ok('非胜利页不动作', toasts.length === 0, 't=' + JSON.stringify(toasts));
  m2 = mkMain().m;
  m2.game.battle.coop = true;
  m2._watchResultDouble();
  ok('合作关不进翻倍（合作本身不发币）', true);
  CONFIG.resultDoubleAdUnitId = hold;   // 还原
}

console.log('\n════════════════════════════');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);