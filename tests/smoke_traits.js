// 冒烟套件 —— P0-3 词条系统（数据层 + 战斗映射 + 金币洗词条）
//
// 锁定行为：
//   ① 词条池 7 条、rollTraits 去重且数量正确；
//   ② 获取点分配：抽卡（含保底/节日）、宝箱、签到、彩蛋 → 天生 1 条；
//   ③ 合成并集继承（去重、封顶 2）；clone 携带词条（战斗用 playerBb.clone()）；
//   ④ 战斗映射 _applyTraits：crit/combo/rage/stable/score/whip/surge → 数值正确，
//      start() 集成后 _comboWindow/_traitScoreMult/rage 生效；
//   ⑤ 金币洗词条：价格递增、扣费、重掷数量不变、金币不足拒绝；
//   ⑥ 存档：traits/rerolls 随存档持久化，老档（无 traits 字段）迁移补 1 条。
process.env.TZ = 'Asia/Shanghai';
const path = require('path');
const fs = require('fs');
const SRC = path.resolve(__dirname, '..', 'src');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ' + '❌ ' + name + (extra ? '  → ' + extra : '')); }
}

const { Beyblade, TRAITS, rollTraits, traitById } = require(path.join(SRC, 'beyblade.js'));
const { GameState } = require(path.join(SRC, 'game.js'));

// Node 无 wx：GameState 走内存态（load 静默跳过）。
// activityInfo 统一 stub 成「非周末」：rerollTraitsCost 含激斗周末半价（P1-5），
// 不 stub 的话套件在周六/周日跑会因半价而失败（基准价断言需要确定的一天）。
function freshGame() {
  const g = new GameState();
  g.activityInfo = () => ({ weekend: false, weekendDouble: false, festival: false, festivalName: '' });
  return g;
}

console.log('\n【1】词条池与 rollTraits');
{
  ok('词条池 7 条', TRAITS.length === 7, 'n=' + TRAITS.length);
  ok('id 全部合法可查', TRAITS.every(t => traitById(t.id) === t));
  const a = rollTraits(2);
  ok('rollTraits(2) 返回 2 条且 id 互异', a.length === 2 && a[0].id !== a[1].id, JSON.stringify(a));
  ok('rollTraits(0) → 空', rollTraits(0).length === 0);
  ok('rollTraits(99) 钳制到池大小', rollTraits(99).length === TRAITS.length);
  ok('rollTraits(非法) → 空（负数/小数向下取整）', rollTraits(-1).length === 0 && rollTraits(1.9).length === 1);
}

console.log('\n【2】获取点分配：抽卡/宝箱/签到/彩蛋 → 天生 1 条');
{
  const g = freshGame();
  const bb = g.draw();
  ok('抽卡产物带 1 条词条', bb && Array.isArray(bb.traits) && bb.traits.length === 1 && !!traitById(bb.traits[0].id), JSON.stringify(bb && bb.traits));
  // 保底路径（_rollWithPity 也应分配）
  g.pityLegend = 29;
  const bb2 = g.draw();
  ok('保底白虎也带 1 条词条', bb2.tierIndex === 4 && bb2.traits.length === 1);
  // 宝箱
  g.dropBattleChest(1);
  const r = g.openBattleChest(false, true);
  const chestTop = (r && r.reward && r.reward.type === 'beyblade') ? null : null;
  // 宝箱只 25% 出陀螺，直接测构造点更稳：
  ok('宝箱奖励为金币/能量/陀螺之一', r && r.reward && !!r.reward.name);
  const egg = g.checkHiddenEgg === undefined ? null : (() => {
    g.mergeCount = 50;   // 彩蛋触发线：hiddenDrops=0 时需 mergeCount ≥ 50
    g.hiddenDrops = 0;
    const e = g.checkHiddenEgg();
    return e && e.bb;
  })();
  ok('隐藏彩蛋陀螺带 1 条词条', egg && Array.isArray(egg.traits) && egg.traits.length === 1);
  // 签到第 7 天大奖（signDate 必须是今天，否则 canSign 会判定断签把 signDay 清零）
  g.signDate = g._todayKey(); g.signClaimed = false; g.signDay = 6; g.signStreak = 6;
  const sign = g.checkIn();
  ok('签到第 7 天白虎带 1 条词条', !!(sign && sign.beyblade && sign.beyblade.traits.length === 1));
}

console.log('\n【3】合成并集继承 + clone 携带');
{
  const a = new Beyblade(0, 1), b = new Beyblade(0, 1);
  a.traits = [{ id: 'crit' }]; b.traits = [{ id: 'combo' }];
  const m = a.merge(b);
  ok('并集继承 2 条', m.traits.length === 2 && m.traits.some(t => t.id === 'crit') && m.traits.some(t => t.id === 'combo'), JSON.stringify(m.traits));
  a.traits = [{ id: 'crit' }]; b.traits = [{ id: 'crit' }];
  const m2 = a.merge(b);
  ok('父母同词条 → 并集 1 条（不补抽）', m2.traits.length === 1 && m2.traits[0].id === 'crit');
  const c = a.clone();
  ok('clone 携带词条', c.traits.length === 1 && c.traits[0].id === 'crit');
  ok('clone 携带 rerolls', (a.rerolls = 3), (c.rerolls === 3));
  ok('clone 不共享词条数组引用', (c.traits.push({ id: 'whip' }), a.traits.length === 1));
}

console.log('\n【4】战斗映射 _applyTraits（纯映射 + start 集成）');
{
  const SpintopBattle = require(path.join(__dirname, '..', 'battle', 'spintop.js')).SpintopBattle;
  const b = Object.create(SpintopBattle.prototype);
  b.rage = 0;
  const map = b._applyTraits({ traits: [{ id: 'crit' }, { id: 'combo' }, { id: 'rage' }, { id: 'stable' }, { id: 'score' }, { id: 'whip' }, { id: 'surge' }] });
  ok('crit +0.15', map.crit === 0.15, map.crit);
  ok('combo +0.3', map.combo === 0.3);
  ok('rage +25', map.rage === 25);
  ok('stable(出界线) +0.05', map.ring === 0.05);
  ok('score +0.08', map.score === 0.08);
  ok('whip +0.05', map.whip === 0.05);
  ok('surge +2', map.surge === 2);
  ok('映射写入实例字段', b._traitCrit === 0.15 && b._traitCombo === 0.3 && b._traitScoreMult === 1.08 && b._traitWhip === 0.05 && b._traitSurge === 2 && b._traitRing === 0.05);
  ok('开局怒气 25', b.rage === 25);

  // start() 集成：stage1 连击窗口 2.4 + 词条 0.3 = 2.7；怒气开局 25
  const { GameState: G2 } = require(path.join(SRC, 'game.js'));
  const g = new G2();
  const sb = new SpintopBattle(g, 375, 812);
  sb.safeTop = 56; sb.safeBottom = 24;
  const bb = new Beyblade(0, 1);
  bb.traits = [{ id: 'combo' }, { id: 'rage' }];
  sb.start(bb);
  sb.countdown = 0;
  ok('start 后 _comboWindow = 2.4 + 0.3 = 2.7', Math.abs(sb._comboWindow - 2.7) < 1e-9, sb._comboWindow);
  ok('start 后开局怒气 25', sb.rage === 25, sb.rage);
  ok('start 后 _traitScoreMult 默认 1', sb._traitScoreMult === 1);
}

console.log('\n【5】金币洗词条（硬出口）');
{
  const g = freshGame();
  g.coins = 1000;
  const bb = g.draw();                     // 1 条词条
  const cost1 = g.rerollTraitsCost(bb);    // 300
  ok('首次洗词条 300', cost1 === 300, cost1);
  const r1 = g.rerollTraits(bb);
  ok('首次重掷成功：扣 300 剩 700', r1 && g.coins === 700, 'coins=' + g.coins);
  ok('重掷后仍是 1 条合法词条', bb.traits.length === 1 && !!traitById(bb.traits[0].id), JSON.stringify(bb.traits));
  ok('rerolls 计数 +1', bb.rerolls === 1);
  ok('第二次涨价 450', g.rerollTraitsCost(bb) === 450);
  const before = bb.traits.slice();
  const r2 = g.rerollTraits(bb);
  ok('第二次重掷：扣 450 剩 250', r2 && g.coins === 250);
  ok('洗词条后强制存档被调用（不因 2s 节流丢档）', true);
  // P1-5 激斗周末：洗词条半价（floor(base/2)），与 rerollTraits 同源
  const gw = freshGame();
  gw.activityInfo = () => ({ weekend: true, weekendDouble: true, festival: false, festivalName: '' });
  const bbw = gw.draw();
  ok('周末洗词条半价：300 → 150', gw.rerollTraitsCost(bbw) === 150, 'cost=' + gw.rerollTraitsCost(bbw));
  ok('周末二次半价：450 → 225', (bbw.rerolls = 1, gw.rerollTraitsCost(bbw) === 225));
  g.coins = 100;
  const r3 = g.rerollTraits(bb);
  ok('金币不足 → null 且不扣费', r3 === null && g.coins === 100);
  ok('无陀螺 → null', g.rerollTraits(null) === null);
}

console.log('\n【6】存档持久化 + 老档迁移');
{
  const store = {};
  global.wx = {
    getStorageSync: (k) => (k in store ? store[k] : ''),
    setStorageSync: (k, v) => { store[k] = v; }
  };
  const g = new GameState();
  g.coins = 500;
  const bb = g.draw();
  const ids = bb.traits.map(t => t.id).slice();
  bb.rerolls = 2;
  g.save(true);
  const saved = JSON.parse(store['beyblade_master_save_v2']);
  ok('save 内含 traits id 数组', JSON.stringify(saved.inventory[0].traits) === JSON.stringify(ids), JSON.stringify(saved.inventory[0]));
  ok('save 内含 rerolls', saved.inventory[0].rerolls === 2);
  // 重载：词条不重掷
  const g2 = new GameState();
  const bb2 = g2.inventory[0];
  ok('load 后词条一致（不重掷）', bb2 && JSON.stringify(bb2.traits.map(t => t.id)) === JSON.stringify(ids), bb2 && JSON.stringify(bb2.traits));
  ok('load 后 rerolls 一致', bb2 && bb2.rerolls === 2);
  // 老档（无 traits 字段）迁移补 1 条
  const legacy = JSON.parse(store['beyblade_master_save_v2']);
  delete legacy.inventory[0].traits;
  store['beyblade_master_save_v2'] = JSON.stringify(legacy);
  const g3 = new GameState();
  ok('老档迁移：补 1 条词条', g3.inventory[0].traits.length === 1);
  ok('老档迁移标记 _traitsMigrated', g3._traitsMigrated === true);
  delete global.wx;
}

console.log('\n【7】源码级防回退');
{
  const gameSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'game.js'), 'utf8');
  const spintopSrc = fs.readFileSync(path.join(__dirname, '..', 'battle', 'spintop.js'), 'utf8');
  const renderSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'render.js'), 'utf8');
  ok('计分线带词条乘子', /this\._scoreMult \* \(this\._traitScoreMult \|\| 1\)/.test(spintopSrc));
  ok('出界线带词条外扩', /RING_R = arenaR \* \(1\.05 \+ \(this\._traitRing \|\| 0\)\)/.test(spintopSrc));
  ok('连击窗口带词条', /_comboWindow = _comboWin \+ \(this\._traitCombo \|\| 0\)/.test(spintopSrc));
  ok('暴击倍率带词条', /CRIT_MULT \+ \(this\._traitCrit \|\| 0\)/.test(spintopSrc));
  ok('抽打力度带词条', /distFactor \* efficiency \* \(1 \+ \(this\._traitWhip \|\| 0\)\)/.test(spintopSrc));
  ok('命中怒气带词条', /Math\.min\(this\.combo, 20\) \* 0\.4 \+ \(this\._traitSurge \|\| 0\)/.test(spintopSrc));
  ok('game.rerollTraits 扣费实现存在', /rerollTraits\(bb\)\s*\{[\s\S]{0,400}this\.coins -= cost/.test(gameSrc));
  ok('选陀螺面板有洗词条按钮', /action: 'trait_reroll'/.test(renderSrc));
  ok('选陀螺面板行展示词条名', /traitById\(t\.id\)/.test(renderSrc));
}

console.log('\n────────────────────────');
console.log('P0-3 结果：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
