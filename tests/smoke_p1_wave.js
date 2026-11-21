// 冒烟套件 —— P1 第二波（2026-10-31）：#5 激斗周末 / #6 挑战券 / #7 影子战
//
// 锁定行为：
//   【1】挑战券：每日 5 免费 + 广告/分享各 +2；消耗顺序 免费→加发券→能量门票；
//        只作用于「新开一局」（_confirmBattleBuff），_battleAgain 连胜免票路径不变。
//   【2】周末商店：3 限量商品 / 限购按周记账周一清零 / 非周末拒售 / 金币校验 / 持久化。
//   【3】BOSS 积分×2：仅激斗周末 + BOSS 关生效。
//   【4】影子战：纪录局关卡号随 noteBattleScore 记录；ghost 局目标分 ≥ 纪录×1.05；
//        老档 ghostStage 缺省 1。
//   【5】UI/派发接线（源码级）：周末条/商店/影子按钮/券条 + main 分发 + 挑战券进开战校验。
process.env.TZ = 'Asia/Shanghai';
const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

const gameMod = require('../src/game.js');
const GameState = gameMod.GameState;
const Beyblade = require('../src/beyblade.js').Beyblade;

// 统一构造：activityInfo 可注入（周末/平日确定性）
function mkGame(weekend) {
  const g = new GameState();
  g.activityInfo = () => ({ weekend: !!weekend, weekendDouble: !!weekend, festival: false, festivalName: '' });
  return g;
}

console.log('\n【1】挑战券：免费 5/日 → 加发券 → 能量门票');
{
  const g = mkGame(false);
  ok('初始免费券 5', g.freeTicketsLeft() === 5);
  const types = [];
  for (let i = 0; i < 5; i++) types.push(g.consumeBattleTicket().type);
  ok('前 5 次全走免费券', types.join(',') === 'free,free,free,free,free', types.join(','));
  ok('免费券期间能量分文未动', g.energy === 150, 'energy=' + g.energy);
  ok('免费券用尽 → freeTicketsLeft 0', g.freeTicketsLeft() === 5 - 5);
  ok('无加发券且能量充足 → 走能量门票（150→130）', g.consumeBattleTicket().type === 'energy' && g.energy === 130);
  g.energy = 10;
  ok('三种凭证都不足 → null', g.consumeBattleTicket() === null);

  ok('分享加发 +2', g.grantBonusTickets(2, 'share') === 2 && g.bonusTickets === 2);
  ok('加发券先于能量消耗', g.consumeBattleTicket().type === 'bonus' && g.energy === 10);
  ok('广告加发 +2（第 1 次）', g.grantBonusTickets(2, 'ad') === 2);
  ok('广告第 2 次只发 1 张（每日 3 张封顶）', g.grantBonusTickets(2, 'ad') === 1 && g.ticketAdCount === 3);
  ok('第 3 次广告 → 0', g.grantBonusTickets(2, 'ad') === 0);

  // 跨日重置
  g.ticketDate = '2000-01-01';
  ok('跨日重置：免费券恢复 5、加发券清零', g.freeTicketsLeft() === 5 && g.bonusTickets === 0 && g.ticketAdCount === 0);

  // 开战校验集成：免费券优先，能量不动；battleOpts 透传（影子战用）
  const Main = require('../src/main.js');
  const m = Object.create(Main.prototype);
  m.game = mkGame(false);
  m.game.buffBb = new Beyblade(0, 1);
  m._toast = () => {};
  m.audio = { play: () => {} };
  const starts = [];
  m._startBattle = (bb, buff, opts) => { starts.push(opts); };
  m._confirmBattleBuff(null, { stage: 3, ghost: true });
  ok('_confirmBattleBuff 消耗免费券（能量 150 不变）', m.game.energy === 150 && m.game.freeTicketsUsed === 1);
  ok('battleOpts 透传（stage 3 + ghost）', starts.length === 1 && starts[0].stage === 3 && starts[0].ghost === true);
}

console.log('\n【2】周末商店：限量 / 周记账 / 非周末拒售 / 持久化');
{
  const g2 = mkGame(true); g2.coins = 10000;
  g2.buyWeekShopItem('energy');
  ok('能量大包：能量 +100（封顶 maxEnergy）', g2.energy === 150, 'e=' + g2.energy);

  const g3 = mkGame(true); g3.coins = 10000;
  g3.buyWeekShopItem('coupon');
  ok('玄武保底券：pityEpic 置 9（下一抽必出）', g3.pityEpic === 9);

  const g4 = mkGame(true); g4.coins = 10000;
  const invBefore = g4.inventory.length;
  const r4 = g4.buyWeekShopItem('legend');
  ok('白虎图纸：直购白虎 Lv1 入队（带 1 词条）',
    r4.ok && g4.inventory.length === invBefore + 1 && g4.inventory[g4.inventory.length - 1].tierIndex === 4 &&
    g4.inventory[g4.inventory.length - 1].level === 1 && g4.inventory[g4.inventory.length - 1].traits.length === 1);

  const g5 = mkGame(true); g5.coins = 10000;
  g5.buyWeekShopItem('legend');
  ok('限购：传说限 1，第二件拒售', g5.buyWeekShopItem('legend').error === 'limit');
  const g6 = mkGame(true); g6.coins = 100;
  ok('金币不足拒售', g6.buyWeekShopItem('energy').error === 'coins' && g6.coins === 100);
  const g7 = mkGame(false); g7.coins = 10000;
  ok('非周末拒售', g7.buyWeekShopItem('energy').error === 'nonweekend');

  // 周记账：换周清零
  const g8 = mkGame(true); g8.coins = 10000;
  g8.buyWeekShopItem('energy');
  g8.weekShopWeek = '2000-01-03';   // 伪造上周 key → 下次 meta/buy 触发重置
  const meta8 = g8.weekendShopMeta();
  ok('换周清零限购', meta8.items[0].bought === 0);
}

console.log('\n【3】BOSS 竞技积分 ×2（仅周末 × BOSS）');
{
  const gw = mkGame(true);
  ok('周末 BOSS：1000 分 → 100 积分', gw.addArenaScore(1000, true) === 100);
  ok('周末非 BOSS：1000 分 → 50 积分', gw.addArenaScore(1000, false) === 50);
  const gn = mkGame(false);
  ok('平日 BOSS：1000 分 → 50 积分（不加倍）', gn.addArenaScore(1000, true) === 50);
}

console.log('\n【4】影子战：纪录局关卡 + 目标分抬到纪录 ×1.05');
{
  const g = mkGame(false);
  g.winStreak = 2;
  g.noteBattleScore(1200, 3);
  ok('纪录局关卡号随 noteBattleScore 记录', g.highScore === 1200 && g.ghostStage === 3);
  g.winStreak = 1;
  g.noteBattleScore(1000, 7);
  ok('低分局不刷新纪录与关卡', g.ghostStage === 3);
  g.noteBattleScore(2000, 5);
  ok('破纪录同时刷新关卡', g.highScore === 2000 && g.ghostStage === 5);

  const SpintopBattle = require('../battle/spintop.js').SpintopBattle;
  // 纪录需高于当前练度天然目标分才能体现"抬升"：Lv1 白板 stage1 天然目标 ~2.6 万，
  // 故把纪录设为 30000（第 5 关刷出），验证 ghost 局目标分被抬到 ≥31500。
  g.highScore = 30000;
  g.ghostStage = 5;
  const sb = new SpintopBattle(g, 375, 812);
  sb.safeTop = 56; sb.safeBottom = 24;
  sb.start(new Beyblade(0, 1), null, { active: true, stage: g.ghostStage, buffs: [], ghost: true });
  sb.countdown = 0;
  ok('ghost 局目标分 ≥ 纪录 ×1.05（30000 → ≥31500）', sb.ghostChallenge === true && sb.targetScore >= 31500, 'target=' + sb.targetScore);
  const sb2 = new SpintopBattle(g, 375, 812);
  sb2.safeTop = 56; sb2.safeBottom = 24;
  sb2.start(new Beyblade(0, 1), null, { active: true, stage: 1, buffs: [] });
  sb2.countdown = 0;
  ok('非 ghost 局不受影响（ghostChallenge=false，目标分未抬到纪录线）',
    sb2.ghostChallenge === false && sb2.targetScore < 31500, 'target=' + sb2.targetScore);

  // 老档：无 ghostStage 字段 → 缺省 1
  const store = {};
  global.wx = {
    getStorageSync: (k) => (k in store ? store[k] : ''),
    setStorageSync: (k, v) => { store[k] = v; }
  };
  const gL = mkGame(false);
  gL.highScore = 500;
  gL.save(true);
  const legacy = JSON.parse(store['beyblade_master_save_v2']);
  delete legacy.ghostStage;
  store['beyblade_master_save_v2'] = JSON.stringify(legacy);
  const gL2 = new GameState();
  ok('老档 ghostStage 缺省 1', gL2.ghostStage === 1);
  global.wx = undefined;
}

console.log('\n【5】UI / 派发接线（源码级）');
{
  // 相对 readFileSync 以 CWD 解析（runner 从项目根 spawn）→ 必须锚定 __dirname
  const renderSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'render.js'), 'utf8');
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const gameSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'game.js'), 'utf8');
  const spintopSrc = fs.readFileSync(path.join(__dirname, '..', 'battle', 'spintop.js'), 'utf8');
  ok('竞技场面板：周末条 + 限时商店按钮 + 影子挑战按钮',
    renderSrc.indexOf("'weekshop'") >= 0 && renderSrc.indexOf("'ghost_challenge'") >= 0);
  ok('周末商店面板已注册进渲染调度', /weekShopOpen\) this\.drawWeekShopPanel\(\)/.test(renderSrc));
  ok('选陀螺面板：挑战券条 + 广告/分享得券按钮',
    renderSrc.indexOf("'ticket_ad'") >= 0 && renderSrc.indexOf("'ticket_share'") >= 0 && renderSrc.indexOf('免费挑战') >= 0);
  ok('main 分发：商店/得券/分享/影子', mainSrc.indexOf("'wshop_buy_'") >= 0 &&
    mainSrc.indexOf("'ticket_ad'") >= 0 && mainSrc.indexOf("'ticket_share'") >= 0 && mainSrc.indexOf("'ghost_challenge'") >= 0);
  ok('main._confirmBattleBuff 走挑战券层（consumeBattleTicket）', /_confirmBattleBuff\(buff, battleOpts\)[\s\S]{0,400}consumeBattleTicket\(\)/.test(mainSrc));
  ok('doShare 加发 2 张挑战券', /doShare\(\)[\s\S]{0,300}grantBonusTickets\(2, 'share'\)/.test(gameSrc));
  ok('_battleAgain 不走挑战券层（连胜免票语义不变）', !/_battleAgain\(\)[\s\S]{0,400}consumeBattleTicket/.test(mainSrc));
  ok('spintop：addArenaScore 传 isBoss / noteBattleScore 传 runStage / ghost 目标抬升',
    spintopSrc.indexOf('addArenaScore(this.score, this.isBoss)') >= 0 &&
    spintopSrc.indexOf('noteBattleScore(this.score, this.runStage)') >= 0 &&
    spintopSrc.indexOf('highScore * 1.05') >= 0);
}

console.log('\n────────────────────────');
console.log('P1 第二波结果：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
