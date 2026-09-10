// 冒烟套件 27 —— #8 怒气必杀（怒气积累 / 满怒必杀按钮 / 释放演出+得分爆发 / HUD 怒气条）
//
// 背景（整体审计 #8）：玩家缺"反转局面的高光手段"。引入怒气(0..100)由命中/撞击积累，
// 满则 HUD 出现「必杀」按钮，点按触发全屏演出（白闪+震屏+定帧+粒子冲击波）+ 得分爆发。
// 纯 Canvas + WebAudio，无第三方资源依赖。
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
  b.start(new Beyblade(tier, lv));
  b.countdown = 0;
  return b;
}
// 与 #7 一致的确定性无头抽打驱动：0°=perfect/暴击，30°=normal，90°=miss
function whipOnce(b, dist, angleOffDeg, critChance = 0) {
  const top = b.top;
  b.top.angularVelocity = 0; b.combo = 0; b.score = 0;
  b.lastWhipTime = 0; b._burstCd = 0; b.activePowerups.doubleScore = false;
  b.elementMult = 1; b._critChance = critChance;
  b.whipStartX = top.x; b.whipStartY = top.y + dist;
  const a = -Math.PI / 2 + angleOffDeg * Math.PI / 180;
  b.whipEndX = b.whipStartX + Math.cos(a) * dist;
  b.whipEndY = b.whipStartY + Math.sin(a) * dist;
  b._calculateWhipForce();
}
// Proxy 桩 ctx：所有方法 no-op，渐变/measureText 给合理返回，供 _drawHUD 跑通不抛错
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

console.log('\n【#8 怒气积累】命中/撞击积攒怒气，打偏不攒，封顶 100');
{
  const b = mkBattle(0, 1);
  whipOnce(b, 200, 0);   // perfect → 暴击
  ok('完美暴击后怒气 > 0', b.rage > 0, 'rage=' + b.rage.toFixed(2));
  ok('怒气不超过 100', b.rage <= 100, 'rage=' + b.rage.toFixed(2));

  const b2 = mkBattle(0, 1);
  const r0 = b2.rage;
  whipOnce(b2, 40, 90);  // 90° → miss
  ok('打偏(miss)不积累怒气', b2.rage === r0, 'rage=' + b2.rage);

  const b3 = mkBattle(0, 1);
  for (let i = 0; i < 20; i++) whipOnce(b3, 200, 0);
  ok('连续命中怒气封顶 100', b3.rage === 100, 'rage=' + b3.rage);
}

console.log('\n【#8 撞击积累】碰撞解算也给怒气');
{
  const b = mkBattle(0, 1);
  const top = b.top, en = b.enemy;
  top.x = 180; top.y = 400; top.vx = 40; top.vy = 0;
  en.x = 200; en.y = 400; en.vx = -40; en.vy = 0;
  b.rage = 0;
  b._resolveCollision(top, en);
  ok('碰撞后怒气 +5', b.rage === 5, 'rage=' + b.rage);
}

console.log('\n【#8 释放守卫】怒气未满不可释放');
{
  const b = mkBattle(0, 1);
  b.rage = 50;
  const s0 = b.score;
  const played = [];
  b.audio = { play: (t) => played.push(t) };
  const res = b._releaseUltimate();
  ok('怒气未满返回 false', res === false, 'res=' + res);
  ok('怒气未满时怒气不变', b.rage === 50, 'rage=' + b.rage);
  ok('怒气未满时分数不变', b.score === s0, 'score=' + b.score);
  ok('怒气未满不触发演出', b._ultActive === false, 'ultActive=' + b._ultActive);
  ok('怒气未满不播放 ultimate 音', played.indexOf('ultimate') < 0, 'played=' + JSON.stringify(played));
}

console.log('\n【#8 释放成功】满怒释放：演出 + 得分爆发 + 怒气归零');
{
  const b = mkBattle(0, 1);
  b.score = 1000;
  b.rage = 100;
  const played = [];
  b.audio = { play: (t) => played.push(t) };
  const res = b._releaseUltimate();
  ok('满怒释放返回 true', res === true, 'res=' + res);
  ok('释放后怒气归零', b.rage === 0, 'rage=' + b.rage);
  ok('释放触发演出(ultActive)', b._ultActive === true, 'ultActive=' + b._ultActive);
  ok('释放触发全屏白闪(ultFlash=1)', b._ultFlash === 1, 'flash=' + b._ultFlash);
  ok('播放 ultimate 音', played.indexOf('ultimate') >= 0, 'played=' + JSON.stringify(played));
  // 得分爆发 = floor(score*0.4 + 300) = floor(400+300)=700
  ok('得分爆发 +700（分数翻倍期望）', b.score === 1700, 'score=' + b.score);
}

console.log('\n【#8 HUD 怒气条 / 必杀按钮】未满显示怒气条，满了出现必杀按钮');
{
  const b = mkBattle(0, 1);
  b.whipCount = 99;   // 跳过新手提示绘制，专注怒气 HUD
  const ctx = mockCtx();

  b.rage = 50;
  let threw = null;
  try { b._drawHUD(ctx); } catch (e) { threw = e; }
  ok('_drawHUD(怒气50) 不抛错', threw === null, threw && threw.message);
  ok('怒气未满：无必杀按钮(_ultButton=null)', b._ultButton === null, 'btn=' + JSON.stringify(b._ultButton));

  b.rage = 100;
  threw = null;
  try { b._drawHUD(ctx); } catch (e) { threw = e; }
  ok('_drawHUD(怒气满) 不抛错', threw === null, threw && threw.message);
  ok('怒气满：出现必杀按钮(action=ultimate)', b._ultButton && b._ultButton.action === 'ultimate',
    'btn=' + JSON.stringify(b._ultButton));
  if (b._ultButton) {
    const inX = b._ultButton.x >= 0 && b._ultButton.x + b._ultButton.w <= b.width;
    const inY = b._ultButton.y >= 0 && b._ultButton.y + b._ultButton.h <= b.height;
    ok('必杀按钮在屏幕内', inX && inY, JSON.stringify(b._ultButton));
  }
}

console.log('\n════════════════════════════');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
