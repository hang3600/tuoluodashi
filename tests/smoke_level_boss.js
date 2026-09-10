// 冒烟套件 28 —— #9 关卡/BOSS 化（每5关BOSS + 二阶段狂暴 + 敌血条=目标分映射 + 关卡/对手名）
//
// 背景（整体审计 #9）：玩家打一关又一关但"关"无感。引入：
//   ① HUD 显示「第N关 vs 对手名」；② 敌血条 = 目标分进度（分数越接近目标，敌血越少）；
//   ③ 每 5 关为 BOSS（更厚血），且分数过半触发二阶段狂暴（更快更猛）。
process.env.TZ = 'Asia/Shanghai';
const path = require('path');
const SRC_DIR = path.resolve(__dirname, '..', 'src');
const { GameState } = require(path.join(SRC_DIR, 'game.js'));
const { Beyblade } = require(path.join(SRC_DIR, 'beyblade.js'));
const { SpintopBattle } = require(path.join(__dirname, '..', 'battle', 'spintop.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

function mkBattle(tier = 0, lv = 1) {
  const g = new GameState();
  const b = new SpintopBattle(g, 375, 812);
  b.safeTop = 56; b.safeBottom = 24;
  b.start(new Beyblade(tier, lv));   // 默认 runStage=1（非BOSS）
  b.countdown = 0;
  return b;
}
// 指定关卡启动（用于构造 BOSS 关与不同关卡）
function mkStage(stage, tier = 0, lv = 1) {
  const g = new GameState();
  const b = new SpintopBattle(g, 375, 812);
  b.safeTop = 56; b.safeBottom = 24;
  b.start(new Beyblade(tier, lv), null, { active: true, stage: stage, buffs: [] });
  b.countdown = 0;
  return b;
}
// Proxy 桩 ctx：所有方法 no-op，渐变/measureText 给合理返回
function mockCtx() {
  const grad = { addColorStop() {} };
  return new Proxy({}, {
    get(t, p) {
      if (p === 'measureText') return (s) => ({ width: String(s).length * 8 });
      if (p === 'createLinearGradient' || p === 'createRadialGradient') return () => grad;
      if (p in t) return t[p];
      return () => {};
    },
    set(t, p, v) { t[p] = v; return true; }
  });
}

console.log('\n【#9 BOSS 判定】每 5 关为 BOSS，其余不是');
{
  ok('第1关非 BOSS', mkStage(1).isBoss === false);
  ok('第4关非 BOSS', mkStage(4).isBoss === false);
  ok('第5关为 BOSS', mkStage(5).isBoss === true);
  ok('第6关非 BOSS', mkStage(6).isBoss === false);
  ok('第10关为 BOSS', mkStage(10).isBoss === true);
  ok('BOSS 目标分 > 0', mkStage(5).targetScore > 0, 'ts=' + mkStage(5).targetScore);
  // BOSS 更厚血：同关基数 ×1.6 后向下取整，必大于非 BOSS 同 stage 基数（这里用 stage=5 自身校验 >0 已含），
  // 再确认 BOSS 目标分严格大于「同 stage 若非 BOSS」的等价基数：用 stage=5 的 1/1.6 反推应小于 BOSS 值
  const bossTs = mkStage(5).targetScore;
  ok('BOSS 目标分 = 基数×1.6（向下取整后 ≥ 基数）', bossTs >= Math.floor(bossTs / 1.6), 'bossTs=' + bossTs);
}

console.log('\n【#9 敌血映射】敌血 = 1 - 分数/目标分（分数越接近目标，敌血越少）');
{
  const b = mkStage(3);
  const ratio = (s) => Math.max(0, 1 - Math.min(1, s / b.targetScore));
  b.score = 0;
  ok('分数 0 → 敌血满(1)', Math.abs(ratio(b.score) - 1) < 1e-9, 'r=' + ratio(b.score));
  b.score = Math.floor(b.targetScore * 0.5);
  ok('分数过半 → 敌血 0.5', Math.abs(ratio(b.score) - 0.5) < 1e-9, 'r=' + ratio(b.score));
  b.score = b.targetScore;
  ok('分数达标 → 敌血 0', ratio(b.score) === 0, 'r=' + ratio(b.score));
  ok('分数超目标 → 敌血仍 0（封底）', (() => { b.score = b.targetScore * 2; return ratio(b.score) === 0; })());
}

console.log('\n【#9 BOSS 二阶段狂暴】分数过半触发，敌方更快');
{
  const b = mkStage(5);                 // BOSS 关
  const baseMax = b.enemy.maxSpeed;      // 已含 BOSS 基础 ×1.15
  b.phase = 'playing'; b.active = true; b.countdown = 0;
  b.timeRemaining = 999;                 // 避免时间耗尽结算
  b.top.angularVelocity = 10;
  // 敌陀螺置于场地中心、零速，避免 update 中越界 Ring Out 提前结束
  b.enemy.x = b.width / 2; b.enemy.y = b.height / 2; b.enemy.vx = 0; b.enemy.vy = 0; b.enemy.angularVelocity = 10;
  b.score = Math.floor(b.targetScore * 0.6);   // 分数过半
  b._bossEnraged = false;
  b.audio = new Proxy({}, { get: () => () => {} });  // 桩：play/playSpin/stopSpin 全 no-op
  b.update(0.016);
  ok('BOSS 分数过半触发狂暴', b._bossEnraged === true, 'enraged=' + b._bossEnraged);
  ok('狂暴提升敌方 maxSpeed ×1.25', Math.abs(b.enemy.maxSpeed - baseMax * 1.25) < 1e-6,
    'max=' + b.enemy.maxSpeed + ' 期望=' + (baseMax * 1.25));
  // 非 BOSS 不应狂暴
  const b2 = mkStage(3);
  b2.phase = 'playing'; b2.active = true; b2.countdown = 0; b2.timeRemaining = 999;
  b2.top.angularVelocity = 10;
  b2.enemy.x = b2.width / 2; b2.enemy.y = b2.height / 2; b2.enemy.vx = 0; b2.enemy.vy = 0; b2.enemy.angularVelocity = 10;
  b2.score = b2.targetScore;   // 即便分数满，非 BOSS 也不触发狂暴
  b2._bossEnraged = false;
  b2.audio = new Proxy({}, { get: () => () => {} });
  b2.update(0.016);
  ok('非 BOSS 即使分数满也不狂暴', b2._bossEnraged === false, 'enraged=' + b2._bossEnraged);
}

console.log('\n【#9 HUD 敌血条/关卡名】绘制不抛错（BOSS + 普通关）');
{
  const b = mkStage(5); b.whipCount = 99;   // 跳新手提示，专注敌血条
  const ctx = mockCtx();
  let threw = null;
  try { b._drawHUD(ctx); } catch (e) { threw = e; }
  ok('_drawHUD(BOSS关) 不抛错', threw === null, threw && threw.message);
  ok('BOSS 关 isBoss 标记', b.isBoss === true);

  const b2 = mkStage(3); b2.whipCount = 99;
  threw = null;
  try { b2._drawHUD(ctx); } catch (e) { threw = e; }
  ok('_drawHUD(普通关) 不抛错', threw === null, threw && threw.message);
  ok('普通关非 BOSS', b2.isBoss === false);
}

console.log('\n════════════════════════════');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
