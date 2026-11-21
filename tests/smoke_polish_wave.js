// 冒烟套件 —— P2 细度波（2026-10-31）：
//   #1 爆发抽打免费化 / #3 广告预告 / #4 图鉴引导 / #6 福利中心 / #7 赛季荣耀 / #8 流派协同 / #9 回归延后
// （#2 战败不扣能由 smoke_energy 锁定；#5 imgb64 经核实为 DevTools 预览资产而非死代码，不删）
process.env.TZ = 'Asia/Shanghai';
const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

const { GameState } = require('../src/game.js');
const { Beyblade } = require('../src/beyblade.js');
const { SpintopBattle } = require('../battle/spintop.js');
const Main = require('../src/main.js');
const { CONFIG } = require('../src/config.js');

console.log('\n【1】爆发抽打不扣能量（节流只靠 0.9s 冷却）');
{
  const g = new GameState();
  const b = new SpintopBattle(g, 375, 812);
  b.safeTop = 56; b.safeBottom = 24;
  b.start(new Beyblade(0, 1));
  b.countdown = 0;
  const e0 = g.energy;
  // 连续两鞭（间隔 <450ms → 第二鞭触发爆发路径）
  const whip = (a) => {
    const rad = (a || 0) * Math.PI / 180;
    const cx = b.width / 2, cy = b.height / 2;
    const x0 = cx - Math.cos(rad) * 90, y0 = cy - Math.sin(rad) * 90;
    const x1 = cx + Math.cos(rad) * 90, y1 = cy + Math.sin(rad) * 90;
    b.whipStart(x0, y0); b.whipMove(x1, y1); b.whipEnd(x1, y1);
  };
  whip(0); whip(0);
  ok('两鞭后能量分文未动（含爆发路径）', g.energy === e0, 'e=' + e0 + ' → ' + g.energy);
  const src = fs.readFileSync(path.join(__dirname, '..', 'battle', 'spintop.js'), 'utf8');
  ok('爆发块已无能量扣除语句', src.indexOf('this.game.energy -= 1') < 0);
  ok('爆发条件已不含能量门槛', src.indexOf('this.game.energy > 0 && this.lastWhipGrade') < 0);
  ok('冷却节流仍在（_burstCd = 0.9）', src.indexOf('this._burstCd = 0.9') >= 0);
}

console.log('\n【2】收卡广告预告：抽中待播位即 toast（不破坏手势窗口）');
{
  const m = Object.create(Main.prototype);
  const toasts = [];
  m._toast = (s) => { toasts.push(s); };
  m.game = { _drawRewardKey: null, shouldScheduleDrawInterstitial: () => 'draw3' };
  m._maybeScheduleDrawAd();
  ok('广告位 key 已记录', m.game._drawRewardKey === 'draw3');
  // P2 广告优化（2026-11-01）：奖励升级为免费再抽 → 预告文案随之切换
  ok('预告 toast 已弹（含奖励说明）', toasts.length === 1 && toasts[0].indexOf('广告') >= 0 && toasts[0].indexOf('免费再抽') >= 0, JSON.stringify(toasts));
  // 关闭预告开关 → 不弹
  CONFIG.drawAdPreview = false;
  const toasts2 = [];
  m._toast = (s) => { toasts2.push(s); };
  m.game._drawRewardKey = null;
  m._maybeScheduleDrawAd();
  ok('drawAdPreview=false → 静默（key 照常记录）', toasts2.length === 0 && m.game._drawRewardKey === 'draw3');
  CONFIG.drawAdPreview = true;
}

console.log('\n【3】图鉴引导：首次收卡 → toast + tab 光晕（一次性）');
{
  const g = new GameState();
  const m = Object.create(Main.prototype);
  m.game = g;
  const toasts = [];
  m._toast = (s) => { toasts.push(s); };
  ok('nudgeCodex 首次 true / 二次 false', g.nudgeCodex() === true && g.nudgeCodex() === false);
  // 走完整 _dismissDrawCard 路径（无广告 key 也不影响引导触发）
  g.codexNudged = false;
  g.drawCard = { bb: new Beyblade(0, 1), t: 0 };
  g.lastDrawConverted = 0;
  m._dismissDrawCard();
  ok('首次收卡弹图鉴引导 toast', toasts.some(t => t.indexOf('图鉴') >= 0), JSON.stringify(toasts));
  ok('图鉴入口光晕点亮 8s', g.codexGlowT === 8, 'glowT=' + g.codexGlowT);
  g.drawCard = { bb: new Beyblade(0, 1), t: 0 };
  m._dismissDrawCard();
  ok('二次收卡不再引导', toasts.filter(t => t.indexOf('图鉴') >= 0).length === 1);
  const rsrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'render.js'), 'utf8');
  ok('图鉴 tab 呼吸光晕已接入渲染', rsrc.indexOf('codexGlowT') >= 0 && rsrc.indexOf('tabCodex.x - 3') >= 0);
}

console.log('\n【4】福利中心：状态聚合 + 单入口（header/subBar/tabs 三处收敛）');
{
  const g = new GameState();
  const meta = g.welfareMeta();
  ok('三行：签到/任务/助力', meta.rows.length === 3 && meta.rows.map(r => r.key).join(',') === 'sign,daily,boost');
  ok('新档任一可领 → anyDue true + 签到 due', meta.anyDue === true && meta.rows[0].due === true);
  g.checkIn();
  ok('签到后 sign 行 due=false', g.welfareMeta().rows[0].due === false);
  const rsrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'render.js'), 'utf8');
  ok('header 签到钮已改为福利入口（action welfare）', rsrc.indexOf("action: 'welfare'") >= 0);
  ok('subBar 助力按钮已移除（并入福利中心）', rsrc.indexOf("action: 'boost_open'") < 0);
  ok('tabs 行任务钮已升级为福利钮（label 福利）', rsrc.indexOf("ctx.fillText('福利', tBtnX + 25") >= 0);
  ok('福利中心面板已注册进渲染调度', /welfareOpen\) this\.drawWelfarePanel\(\)/.test(rsrc));
  const msrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  ok('main 分发：福利开关 + 三条直跳', msrc.indexOf("'welfare'") >= 0 && msrc.indexOf("'welfare_go_sign'") >= 0 &&
    msrc.indexOf("'welfare_go_daily'") >= 0 && msrc.indexOf("'welfare_go_boost'") >= 0);
}

console.log('\n【5】赛季荣耀：巅峰段位记录 + 首达大师限定（一次性）');
{
  const g = new GameState();
  ok('老档缺省 peakTier -1', g.arenaPeakMeta().peakIndex === -1);
  // 模拟上周打到大师（8000 分）后跨周
  g.arenaWeek = '2000-01-03';
  g.arenaPts = 8000;
  g.arenaClaimedWeek = '';
  const invBefore = g.inventory.length;
  g.arenaMeta();   // 触发跨周结算
  ok('跨周结算：巅峰段位记为大师(5)', g.arenaPeakMeta().peakIndex === 5 && g.arenaPeakMeta().peakName === '大师');
  ok('首达大师 → 赛季限定「大师白虎」Lv3 双词条入队',
    g.arenaMasterGranted === true && g.inventory.length === invBefore + 1 &&
    g.inventory[g.inventory.length - 1].tierIndex === 4 && g.inventory[g.inventory.length - 1].level === 3 &&
    g.inventory[g.inventory.length - 1].traits.length === 2);
  ok('结算奖励带 master 标记', !!(g._arenaWeekReward && g._arenaWeekReward.master));
  // 再来一周大师 → 不重复发
  g.arenaWeek = '2000-01-10';
  g.arenaPts = 9000;
  g.arenaClaimedWeek = '';
  const invAfter = g.inventory.length;
  g.arenaMeta();
  ok('二度大师不重复发限定', g.inventory.length === invAfter);
  // 中段位也记巅峰
  const g2 = new GameState();
  g2.arenaWeek = '2000-01-03';
  g2.arenaPts = 1600;   // 黄金档（1500）
  g2.arenaClaimedWeek = '';
  g2.arenaMeta();
  ok('黄金段位记入巅峰', g2.arenaPeakMeta().peakIndex === 2 && g2.arenaMasterGranted === false);
}

console.log('\n【6】run buff 流派协同：同流派 2 层触发加成');
{
  const mk = (buffs) => {
    const g = new GameState();
    const b = new SpintopBattle(g, 375, 812);
    b.safeTop = 56; b.safeBottom = 24;
    b.start(new Beyblade(0, 1), null, { active: true, stage: 1, buffs: buffs.slice() });
    b.countdown = 0;
    return b;
  };
  const atk = mk(['torque', 'knock', 'shield']);
  ok('攻势流派触发（攻 2 层）', atk._runSynergies.length === 1 && atk._runSynergies[0].school === 'attack');
  const gain = mk(['score', 'coin']);
  ok('得金流派触发', gain._runSynergies.length === 1 && gain._runSynergies[0].school === 'gain');
  const guard = mk(['shield', 'target']);
  ok('守护流派触发（护盾 1+1=2）', guard._runSynergies.length === 1 && guard._runSynergies[0].school === 'guard' && guard._shieldCharges === 2);
  const none = mk(['torque', 'score', 'shield']);
  ok('各 1 层不触发', none._runSynergies.length === 0);
  ok('协同飘字在清屏后补发（可见）', atk.floatingTexts.length >= 1);
  const src = fs.readFileSync(path.join(__dirname, '..', 'battle', 'spintop.js'), 'utf8');
  ok('协同计算挂在 start 的 run buff 应用之后', src.indexOf('this._applyRunSynergy();') >= 0);
}

console.log('\n【7】回归礼包延后到首次结算（首屏零阻挡最后一公里）');
{
  ok('config 门控默认开启', CONFIG.returnDeferToSettle === true);
  const msrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  ok('onTap 不再直接触发回归（被门控包住）', msrc.indexOf('if (!CONFIG.returnDeferToSettle) this._maybePromptReturn();') >= 0);
  ok('结算触发点存在（result 分支内）', /_resultPlayed = true;[\s\S]{0,120}returnDeferToSettle\) this\._maybePromptReturn\(\)/.test(msrc));
  ok('兜底延长到 30s（防离线奖励沉没）', msrc.indexOf('Math.max(CONFIG.returnGraceMs || 8000, 30000)') >= 0);
}

console.log('\n────────────────────────');
console.log('P2 细度波结果：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
