// 冒烟套件 —— 双人合作守关（同屏交替传机·纯客户端）
//
// 背景（分享裂变一文）：排行榜/分享得奖励撑不起裂变，只有"一起玩"（真实邀约）才带量。
// 本项目落地零后端「同屏交替传机」合作守关：
//   - A 打一会 → 传给好友 → B 接着打，共享一个被强化的 BOSS，联合结算。
//   - 合作通关「只记战绩不发资源」（金币/连胜/段位/能量全不动），并提供纯邀约分享（无奖励、非诱导，合规）。
// 本套件锁定上述不变量，防止回归。
process.env.TZ = 'Asia/Shanghai';
const path = require('path');
const fs = require('fs');
const SRC = path.resolve(__dirname, '..', 'src');
const { GameState } = require(path.join(SRC, 'game.js'));
const { Beyblade } = require(path.join(SRC, 'beyblade.js'));
const { CONFIG } = require(path.join(SRC, 'config.js'));
const { SpintopBattle, COOP_BOSS_MULT } = require(path.join(__dirname, '..', 'battle', 'spintop.js'));
const Main = require(path.join(SRC, 'main.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}
function mkBattle(run, tier = 0, lv = 1) {
  const g = new GameState();
  const b = new SpintopBattle(g, 375, 812);
  b.safeTop = 56; b.safeBottom = 24;
  b.start(new Beyblade(tier, lv), null, run || { active: false, stage: 1, buffs: [] });
  b.countdown = 0;
  return b;
}

console.log('\n【1 config】灰度开关/参数');
{
  ok('coop.enabled 默认 false（入口不渲染，无死按钮）', CONFIG.coop.enabled === false, 'enabled=' + CONFIG.coop.enabled);
  ok('coop.bossMult 可调（=2）', CONFIG.coop.bossMult === 2, 'm=' + CONFIG.coop.bossMult);
  ok('shareTitle 含 {stage} 占位', /{stage}/.test(String(CONFIG.coop.shareTitle)));
}

console.log('\n【2 入局标记 + 强化 BOSS】');
{
  const solo = mkBattle({ active: true, stage: 5 });   // stage5=BOSS，base ×1.6
  const coop = mkBattle({ active: true, stage: 5, coop: true });
  ok('合作关 this.coop=true', coop.coop === true);
  ok('单人对战不受影响（coop=false）', solo.coop === false);
  ok('合作关持方归 A、贡献清零', coop.coopActive === 'A' && coop.coopContrib.A === 0 && coop.coopContrib.B === 0);
  ok('合作 BOSS 目标分严格高于单人同关', coop.targetScore > solo.targetScore,
    'coop=' + coop.targetScore + ' solo=' + solo.targetScore);
}

console.log('\n【3 交替传机 passPhone】');
{
  const b = mkBattle({ active: true, stage: 1, coop: true });
  ok('默认持方 A', b.coopActive === 'A');
  b.passPhone(); ok('传给好友 → B', b.coopActive === 'B');
  b.passPhone(); ok('再传回 → A', b.coopActive === 'A');
}

console.log('\n【4 战绩 recordCoopWin（只记战绩不发资源）】');
{
  const g = new GameState();
  g.recordCoopWin(5); g.recordCoopWin(3);
  ok('coopWins=2', g.coopWins === 2, 'w=' + g.coopWins);
  ok('coopStage 取最大(5)', g.coopStage === 5, 's=' + g.coopStage);
}

console.log('\n【5 存档兼容（可选字段，老档默认 0）】');
{
  const g = new GameState();
  g.load({});   // 模拟 v2 老档无这两字段
  ok('老档无 coopStage → 默认 0', g.coopStage === 0, 's=' + g.coopStage);
  ok('老档无 coopWins → 默认 0', g.coopWins === 0, 'w=' + g.coopWins);
  const src = fs.readFileSync(path.join(SRC, 'game.js'), 'utf8');
  ok('save 序列化 coopStage/coopWins', /coopStage: this\.coopStage,/.test(src) && /coopWins: this\.coopWins,/.test(src));
  ok('load 还原默认 guard', /this\.coopStage = Math\.max/.test(src) && /this\.coopWins = Math\.max/.test(src));
}

console.log('\n【6 main._startCoop 门控（enabled 灰度）】');
{
  const m = Object.create(Main.prototype);
  const starts = [], toasts = [];
  m.game = new GameState();
  m.game.energy = 20;
  m.game.selectBattleBeyblade = () => new Beyblade(0, 1);
  m._toast = (s) => { toasts.push(s); };
  m.audio = { play: () => {} };
  m._startBattle = (bb, buff, opts) => { starts.push(opts); };

  // 默认 enabled=false → 不动作
  m._startCoop();
  ok('enabled=false 时 _startCoop 不扣能量不开战', m.game.energy === 20 && starts.length === 0, 'e=' + m.game.energy + ' starts=' + starts.length);

  // 开灰度
  CONFIG.coop.enabled = true;
  m._startCoop();
  ok('enabled=true 时扣 20 能量门票', m.game.energy === 0, 'e=' + m.game.energy);
  ok('以 coop:true + stage=minStage 开战', starts.length === 1 && starts[0].coop === true && starts[0].stage === CONFIG.coop.minStage,
    'opts=' + JSON.stringify(starts[0]));
  CONFIG.coop.enabled = false;   // 还原
}

console.log('\n【7 main._shareResultCoop 纯邀约（无奖励、非诱导）】');
{
  const captured = [];
  const hold = global.wx;
  global.wx = { shareAppMessage: (p) => { captured.push(p); } };
  const m = Object.create(Main.prototype);
  m.game = new GameState();
  m.game.battle = { runStage: 5 };
  m.audio = { play: () => {} };
  m._toast = () => {};
  let e = null; try { m._shareResultCoop(); } catch (err) { e = err; }
  ok('调用 wx.shareAppMessage 且不抛错', captured.length === 1 && !e, 'n=' + captured.length);
  ok('分享 title 含「双人/合力」邀约', /双人|合力|一起/.test(captured[0].title), captured[0].title);
  ok('title 不含「能量」诱导（非分享得奖励）', !/能量/.test(captured[0].title), captured[0].title);
  ok('query 标记 coop', captured[0].query === 'from=coop', captured[0].query);
  global.wx = hold;
}

console.log('\n【8 main._startCoopPass 调 passPhone】');
{
  const m = Object.create(Main.prototype);
  let called = 0;
  m.game = { battle: { passPhone: () => { called++; return 'B'; } } };
  m.audio = { play: () => {} };
  m._toast = () => {};
  m._startCoopPass();
  ok('_startCoopPass 调用 passPhone', called === 1, 'c=' + called);
}

console.log('\n【9 spintop settle 源码级闸门（只记战绩不发资源）】');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'battle', 'spintop.js'), 'utf8');
  ok('coop 不入金币', /if \(!this\.coop && this\.game\) this\.game\.coins \+= this\.reward/.test(src));
  ok('coop 不计竞技分', /if \(!this\.coop && this\.game && typeof this\.game\.addArenaScore/.test(src));
  ok('coop 不加连胜', /if \(!this\.coop && this\.game && typeof this\.game\.winStreak === 'number'\) this\.game\.winStreak \+= 1/.test(src));
  ok('coop 不加经验 / 掉宝 / 开箱（均被 ialilik !this.coop 门控）', /if \(!this\.coop && this\.game && typeof this\.game\.addExp/.test(src) && /if \(!this\.coop && Math\.random\(\)/.test(src));
  ok('coop 战败免能量惩罚', /if \(!this\.coop\) this\.game\.energy/.test(src));
  ok('coop 胜利记战绩 hook', /recordCoopWin\(this\.runStage\)/.test(src));
  ok('贡献统计按持方累计', /if \(this\.coop\) this\.coopContrib\[this\.coopActive\] \+= earnedScore/.test(src));
  ok('passPhone / 双人 HUD 命中区', /passPhone\(\)/.test(src) && /action: 'coop_pass'/.test(src));
}

console.log('\n【10 render 主页入口 源码级门控】');
{
  const src = fs.readFileSync(path.join(SRC, 'render.js'), 'utf8');
  ok('入口按 CONFIG.coop.enabled 门控渲染', /if \(CONFIG\.coop && CONFIG\.coop\.enabled\)/.test(src));
  ok('入口 action=coop 且推入 buttons（可点，非摆设）', /action: 'coop'/.test(src));
}

console.log('\n════════════════════════════');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);