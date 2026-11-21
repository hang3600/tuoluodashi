// 冒烟套件 1/4 —— 核心：白虎保底品质、保底计数清零、保底券语义、每日时区口径、签到去重、每日限额、每日任务
// 路径相对化：无论从哪个目录调用，都基于本文件位置定位 src/
process.env.TZ = 'Asia/Shanghai';

const path = require('path');
const SRC_DIR = path.resolve(__dirname, '..', 'src');
const { GameState, SIGN_REWARDS } = require(path.join(SRC_DIR, 'game.js'));
const { TIERS } = require(path.join(SRC_DIR, 'beyblade.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

/** 冻结时间：用本地时间构造 */
function freeze(y, mo, d, h, mi) {
  const fixed = new Date(y, mo - 1, d, h || 0, mi || 0, 0).getTime();
  const RealDate = Date;
  global.Date = class extends RealDate {
    constructor(...a) { if (a.length === 0) super(fixed); else super(...a); }
    static now() { return fixed; }
  };
}
function unfreeze() { global.Date = require('vm').runInThisContext('Date'); }

console.log('\n【1】白虎保底产出品质（P0-1）');
{
  const g = new GameState();
  g.energy = 1e6;
  g.pityLegend = 29;   // 下一抽触发白虎保底
  g.pityEpic = 0;
  const bb = g.draw();
  ok('保底产出 tierIndex === 4', bb.tierIndex === 4, '实际 ' + bb.tierIndex + ' ' + TIERS[bb.tierIndex].name);
  ok('保底产出是金·白虎', TIERS[bb.tierIndex].key === 'metal', TIERS[bb.tierIndex].name);
}

console.log('\n【2】白虎保底计数只在真传说时清零（P0-2）');
{
  const g = new GameState();
  g.energy = 1e6;
  let eliteDidNotReset = true, legendDidReset = true, sawElite = false, sawLegend = false;
  for (let i = 0; i < 4000; i++) {
    const before = g.pityLegend;
    const bb = g._rollWithPity();
    if (bb.tierIndex === 3) {
      sawElite = true;
      if (before + 1 >= 30) continue;           // 保底触发的那次跳过
      if (g.pityLegend === 0) eliteDidNotReset = false;  // 抽到精英却被清零 = bug
    }
    if (bb.tierIndex === 4) {
      sawLegend = true;
      if (g.pityLegend !== 0) legendDidReset = false;
    }
  }
  ok('抽到火·精英(3) 不清零白虎保底', eliteDidNotReset && sawElite, '样本命中=' + sawElite);
  ok('抽到金·白虎(4) 清零白虎保底', legendDidReset && sawLegend, '样本命中=' + sawLegend);
}

console.log('\n【3】保底券 = 下一抽必出（同族修复）');
{
  const g = new GameState();
  g.energy = 1e6;
  g.pityLegend = 3;
  g._pendingReturn = 'grand';
  const r = g.claimReturn();
  ok('回归大礼包发放白虎保底券', r && r.coupon === true);
  ok('券把 pityLegend 置 29（而非 0）', g.pityLegend === 29, '实际 ' + g.pityLegend);
  const bb = g.draw();
  ok('下一抽确实出金·白虎', bb.tierIndex === 4, TIERS[bb.tierIndex].name);
}
{
  const g = new GameState();
  g.pityEpic = 2;
  g.level = 4; g.exp = 0;
  g.addExp(4 * 80);
  ok('升级里程碑发放史诗保底券', g.pityEpic === 9, '实际 ' + g.pityEpic);
  g.energy = 1e6;
  const bb = g.draw();
  ok('下一抽至少出水·史诗(>=2)', bb.tierIndex >= 2, TIERS[bb.tierIndex].name);
}

console.log('\n【4】_todayKey 走本地时区（P0-3）');
{
  const g = new GameState();
  freeze(2026, 8, 29, 7, 0);   // 本地 07:00 = UTC 8-28 23:00
  ok('本地 07:00 → 2026-08-29（UTC 口径会错成 08-28）', g._todayKey() === '2026-08-29', g._todayKey());
  unfreeze();
  freeze(2026, 8, 29, 9, 0);
  ok('本地 09:00 → 2026-08-29', g._todayKey() === '2026-08-29', g._todayKey());
  unfreeze();
  freeze(2026, 3, 1, 10, 0);
  ok('跨月边界 _dayKeyOffset(-1) → 2026-02-28', g._dayKeyOffset(-1) === '2026-02-28', g._dayKeyOffset(-1));
  unfreeze();
  freeze(2026, 1, 1, 10, 0);
  ok('跨年边界 _dayKeyOffset(-1) → 2025-12-31', g._dayKeyOffset(-1) === '2025-12-31', g._dayKeyOffset(-1));
  unfreeze();
  freeze(2024, 3, 1, 10, 0);
  ok('闰年边界 _dayKeyOffset(-1) → 2024-02-29', g._dayKeyOffset(-1) === '2024-02-29', g._dayKeyOffset(-1));
  unfreeze();
}

console.log('\n【5】签到去重：UTC+8 凌晨窗口（P0-3 复现路径）');
{
  const g = new GameState();
  freeze(2026, 8, 29, 7, 0);            // 本地 07:00（UTC 仍为 8-28）
  const r1 = g.checkIn();
  ok('第一次签到成功', !!r1);
  const r2 = g.checkIn();
  ok('同一时刻重复签到被拒', r2 === null);
  unfreeze();
  freeze(2026, 8, 29, 9, 0);            // 同日 09:00（UTC 已进入 8-29）
  const r3 = g.checkIn();
  ok('同日 09:00 再签到被拒（修复前会成功）', r3 === null, r3 ? '仍签到了：day=' + r3.day : '');
  ok('连续签到未被误清零', g.signStreak === 1, 'streak=' + g.signStreak);
  unfreeze();
  freeze(2026, 8, 30, 10, 0);           // 次日
  const r4 = g.checkIn();
  ok('次日可正常签到', !!r4);
  ok('连签累计为 2', g.signStreak === 2, 'streak=' + g.signStreak);
  unfreeze();
  freeze(2026, 9, 2, 10, 0);            // 隔 3 天 → 断签
  g.canSign();
  ok('断签后 streak 清零', g.signStreak === 0, 'streak=' + g.signStreak);
  unfreeze();
}

console.log('\n【5.5】免费抽卡券（D1 留客钩子 · 2026-11-20）：签到第2/4/6天发放 + 分享 +1 + 消耗 + 存档');
{
  const g = new GameState();
  ok('奖励表：第2天发免费抽卡券×1', SIGN_REWARDS[1].freeDraw === 1);
  ok('奖励表：第4天发免费抽卡券×1', SIGN_REWARDS[3].freeDraw === 1);
  ok('奖励表：第6天发免费抽卡券×1', SIGN_REWARDS[5].freeDraw === 1);
  ok('初始无券', (g.freeDraws || 0) === 0);
  const r1 = g.checkIn();   // 第 1 天：金币日，无券
  ok('第1天不发券', r1.freeDraw === 0 && g.freeDraws === 0);
  ok('无券时消耗被拒', g.consumeFreeDraw() === false);
  // 跳到第 2 天签到 → 应发券
  g.signDate = g._dayKeyOffset(-1);
  g.signClaimed = false;
  const r2 = g.checkIn();
  ok('第2天签到发券×1', r2 && r2.freeDraw === 1 && g.freeDraws === 1, 'freeDraw=' + (r2 && r2.freeDraw) + ' held=' + g.freeDraws);
  ok('有券时可消耗', g.consumeFreeDraw() === true && g.freeDraws === 0);
  // 分享 +1 券（上限 3 防囤积）
  g.doShare();
  ok('分享奖励含免费抽卡券+1', g.freeDraws === 1);
  for (let i = 0; i < 5; i++) g.doShare();
  ok('分享发券封顶 3 张（防囤积）', g.freeDraws === 3, 'held=' + g.freeDraws);
  // 存档往返：本套件无 wx 环境（save 为空操作），块内临时挂最小存储桩验证，结束后还原
  const savedWx = typeof global.wx !== 'undefined' ? global.wx : undefined;
  const memStore = {};
  const mockWx = {
    setStorageSync: function (k, v) { memStore[k] = v; },
    getStorageSync: function (k) { return Object.prototype.hasOwnProperty.call(memStore, k) ? memStore[k] : ''; },
  };
  global.wx = mockWx;
  g.save(true);
  const g2 = new GameState();
  g2.load();
  ok('存档往返保留 freeDraws', (g2.freeDraws || 0) === 3, 'loaded=' + g2.freeDraws);
  // 老档缺字段 → Number 兜底 0（键名与 src/game.js STORAGE_KEY 一致）
  memStore.beyblade_master_save_v2 = JSON.stringify({ schemaVersion: 2 });
  const g3 = new GameState();
  g3.load();
  ok('老档缺字段安全（Number 兜底 0）', typeof g3.freeDraws === 'number');
  if (savedWx === undefined) delete global.wx; else global.wx = savedWx;
}

console.log('\n【5.6】官方「朋友推荐」组件接入门禁（2026-11-21）：官方常量 openlink + 纯自发引导（无道具奖励）');
{
  const fs2 = require('fs');
  const mainSrc2 = fs2.readFileSync(path.join(SRC_DIR, 'main.js'), 'utf8');
  ok('main.js 定义 _openGameRecommend（官方最佳实践）',
     /_openGameRecommend\(\)[\s\S]{0,600}createPageManager/.test(mainSrc2));
  ok('使用官方推荐组件 OPENLINK 常量',
     mainSrc2.indexOf('TWFRCqV5WeM2AkMXhKwJ03MhfPOieJfAsvXKUbWvQFQtLyyA5etMPabBehga950uzfZcH3Vi3QeEh41xRGEVFw') >= 0);
  ok('监听 destroy 回调感知真实推荐（isRecommended）',
     /on\(\s*'destroy'[\s\S]{0,200}isRecommended/.test(mainSrc2) || /isRecommended/.test(mainSrc2));
  ok('无道具奖励刺激（官方不提倡：doClubRecommend 已移除）',
     mainSrc2.indexOf('doClubRecommend') < 0);
  const spinSrc2 = fs2.readFileSync(path.join(SRC_DIR, '..', 'battle', 'spintop.js'), 'utf8');
  ok('结算胜利屏含「推荐」键（battle_recommend）', spinSrc2.indexOf('battle_recommend') >= 0);
}

console.log('\n【6】其余每日限额走同一口径');
{
  const g = new GameState();
  freeze(2026, 8, 29, 7, 0);
  ok('助力：第 1 次可领', g.claimBoost() === true);
  let boostN = 1;
  for (let i = 0; i < 6; i++) if (g.claimBoost()) boostN++;
  ok('助力当日封顶 5 次（含首次）', boostN === 5, '实际 ' + boostN);
  unfreeze();
  freeze(2026, 8, 29, 9, 0);
  ok('同日 09:00 助力不再重置（修复前会再给 5 次）', g.claimBoost() === false);
  unfreeze();
}
{
  const g = new GameState();
  freeze(2026, 8, 29, 7, 0);
  g.battleChest = { quality: 0, count: 3 };
  ok('免费开箱第 1 次成功', !!g.openBattleChest(false));
  ok('同日免费开箱第 2 次被拒', g.openBattleChest(false) === null);
  unfreeze();
  freeze(2026, 8, 29, 9, 0);
  ok('同日 09:00 免费开箱仍被拒', g.openBattleChest(false) === null);
  unfreeze();
}

console.log('\n【7】每日任务口径统一');
{
  const g = new GameState();
  freeze(2026, 8, 29, 7, 0);
  g.recordDailyTask('draw');
  ok('任务进度记录成功', g.dailyTasks[2] === 1);
  unfreeze();
  freeze(2026, 8, 29, 9, 0);
  g._checkDailyReset();
  ok('同日 09:00 任务进度不重置', g.dailyTasks[2] === 1, '实际 ' + g.dailyTasks[2]);
  unfreeze();
  freeze(2026, 8, 30, 9, 0);
  g._checkDailyReset();
  ok('次日任务进度重置', g.dailyTasks[2] === 0);
  unfreeze();
}

console.log('\n────────────────────────');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
