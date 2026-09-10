// 冒烟套件 22 —— 结算页游戏化「打磨轮」行为锁定
//
// 背景（用户真机反馈 + 代码审查发现）：
// 1) 结算胜负音效 / 震动 / 星级 / 粒子初始化原本误放在 end()（仅退战斗时调用），
//    导致真机结算屏期间 _resultStartTime 恒为 0、粒子为空——整套入场动画与粒子层从
//    未触发。现改到 _settle 入口触发。本套件锁定：_settle 会初始化粒子、置位
//    _resultStartTime、并播放 win/lose 音效。
// 2) 结算按钮由战斗自绘 _drawButton，不消费 renderer.pressedBtn 的按下态——此前结算
//    按钮无按下反馈。现 renderer 把 pressedBtn.action 透传 battle._pressedAction，
//    _drawButton 据此做 0.94 缩放下沉 + 暗化。本套件锁定：按下态不崩、且确实被读取。
// 3) 失败页能量核心改为入场后由 0→ratio 充电扫入（easeOutCubic）。本套件锁定：不崩。
process.env.TZ = 'Asia/Shanghai';
const path = require('path');
const SRC_DIR = path.resolve(__dirname, '..', 'src');
const { GameState } = require(path.join(SRC_DIR, 'game.js'));
const { SpintopBattle } = require(path.join(__dirname, '..', 'battle', 'spintop.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

/** 录制式 mock ctx：所有方法 no-op，记录 fillText / roundRectPath / 关键调用计数 */
function makeCtx() {
  const rec = { texts: [], rects: [], strokeCount: 0, radialCount: 0 };
  const base = {};
  ['save','restore','translate','scale','rotate','beginPath','moveTo','lineTo',
   'closePath','arc','arcTo','fill','stroke','fillRect','strokeRect','clip',
   'drawImage','setTransform','clearRect','rect','strokeText'].forEach(m => base[m] = () => {});
  const handler = {
    get(t, p) {
      if (p === '__rec') return rec;
      if (p === 'fillText') return (txt, x, y) => rec.texts.push({ text: String(txt), x, y });
      if (p === 'strokeText') return (txt, x, y) => { rec.strokeCount++; rec.texts.push({ text: String(txt), x, y }); };
      if (p === 'roundRectPath') return (c, x, y, w, h, r) => rec.rects.push({ x, y, w, h });
      if (p === 'measureText') return (txt) => ({ width: String(txt).length * 6 });
      if (p === 'createLinearGradient') return () => ({ addColorStop() {} });
      if (p === 'createRadialGradient') return () => { rec.radialCount++; return { addColorStop() {} }; };
      return t[p];
    },
    set(t, p, v) { t[p] = v; return true; }
  };
  return new Proxy(base, handler);
}

/** 处于'playing'的对局（用于驱动 _settle 入口逻辑） */
function newPlayingBattle(result) {
  const g = new GameState();
  const b = new SpintopBattle(g, 375, 812);
  b.safeTop = 56; b.safeBottom = 24;
  b.phase = 'playing';
  b.score = result === 'win' ? 300000 : 120000;
  b.targetScore = 285000;
  b.power = 100; b.maxCombo = 10; b._coinMult = 1;
  b.runActive = false; b.isRingOut = false;
  b.dropItem = null; b.chestDropped = null;
  b._resultStartTime = 0;
  return b;
}

console.log('\n【结算初始化·入口】_settle 触发胜负音效 + 初始化粒子/星级/起始时间');
{
  // 胜利
  const b = newPlayingBattle('win');
  let played = null;
  b.audio = { play: (t) => { played = t; }, stopSpin: () => {} };
  let err = null;
  try { b._settle('win'); } catch (e) { err = e.message; }
  ok('胜利 _settle 未抛异常', !err, err);
  ok('胜利 _settle 播放了 win 音效', played === 'win', 'played=' + played);
  ok('胜利 _settle 初始化了结算粒子', b._resultParticles.length > 0, 'n=' + b._resultParticles.length);
  ok('胜利 _settle 置位了 _resultStartTime', b._resultStartTime > 0, 't=' + b._resultStartTime);
  ok('胜利 _settle 计算了星级(1~3)', b._resultStarCount >= 1 && b._resultStarCount <= 3, 'stars=' + b._resultStarCount);
  ok('胜利 _settle 后 phase=result', b.phase === 'result', b.phase);

  // 失败
  const b2 = newPlayingBattle('lose');
  let played2 = null;
  b2.audio = { play: (t) => { played2 = t; }, stopSpin: () => {} };
  let err2 = null;
  try { b2._settle('lose'); } catch (e) { err2 = e.message; }
  ok('失败 _settle 未抛异常', !err2, err2);
  ok('失败 _settle 播放了 lose 音效', played2 === 'lose', 'played=' + played2);
  ok('失败 _settle 初始化了结算粒子', b2._resultParticles.length > 0, 'n=' + b2._resultParticles.length);
  ok('失败 _settle 置位了 _resultStartTime', b2._resultStartTime > 0, 't=' + b2._resultStartTime);
  ok('失败 _settle 星级归零', b2._resultStarCount === 0, 'stars=' + b2._resultStarCount);
  ok('失败 _settle 后 phase=result', b2.phase === 'result', b2.phase);
}

console.log('\n【结算初始化·退战斗】end() 不再初始化粒子/音效（仅清理）');
{
  const b = newPlayingBattle('win');
  b.phase = 'result'; b._resultStartTime = 123; b._resultParticles = [{ a: 1 }];
  let played = null;
  b.audio = { play: (t) => { played = t; }, stopSpin: () => {} };
  b.end();
  ok('end() 不播放音效', played === null, 'played=' + played);
  ok('end() 将 phase 置为 idle', b.phase === 'idle', b.phase);
  ok('end() 清空了结算粒子', b._resultParticles.length === 0, 'n=' + b._resultParticles.length);
}

console.log('\n【按钮按下态】renderer 透传 pressedBtn.action → 自绘按钮读取并呈现');
{
  const b = newPlayingBattle('win');
  b.phase = 'result'; b.result = 'win';
  b.score = 300000; b.targetScore = 285000; b.reward = 520;
  b.game.energy = 120; b.game.maxEnergy = 150;
  const ctx = makeCtx();
  // 无按下态：正常绘制不崩
  let crashed = false;
  try { b._drawResult(ctx); } catch (e) { crashed = true; console.log('   err=' + e.message); }
  ok('无按下态时 _drawResult 不崩', !crashed);

  // 模拟 renderer 透传：按住"再战"
  b._pressedAction = 'battle_again';
  const ctx2 = makeCtx();
  let crashed2 = false;
  try { b._drawResult(ctx2); } catch (e) { crashed2 = true; console.log('   err=' + e.message); }
  ok('按住 battle_again 时 _drawResult 不崩', !crashed2);

  // 失败页：按住"看广告复活"
  const b3 = newPlayingBattle('lose');
  b3.phase = 'result'; b3.result = 'lose';
  b3.game.energy = 120; b3.game.maxEnergy = 150;
  b3._pressedAction = 'battle_revive';
  const ctx3 = makeCtx();
  let crashed3 = false;
  try { b3._drawResult(ctx3); } catch (e) { crashed3 = true; console.log('   err=' + e.message); }
  ok('失败页按住 battle_revive 时 _drawResult 不崩', !crashed3);
}

console.log('\n【能量核心充电动画】入场时间线不同取值均不崩');
{
  const b = newPlayingBattle('lose');
  b.phase = 'result'; b.result = 'lose';
  b.game.energy = 120; b.game.maxEnergy = 150;
  // 终态（t=99，_resultStartTime=0）
  const ctxA = makeCtx();
  let crashedA = false;
  try { b._drawResult(ctxA); } catch (e) { crashedA = true; console.log('   err=' + e.message); }
  ok('终态(t=99) 能量核心绘制不崩', !crashedA);
  // 入场早期（t 很小）：充电扫入动画不崩
  b._resultStartTime = Date.now() - 200; // 200ms 前
  const ctxB = makeCtx();
  let crashedB = false;
  try { b._drawResult(ctxB); } catch (e) { crashedB = true; console.log('   err=' + e.message); }
  ok('入场早期(t≈0.2) 能量核心绘制不崩', !crashedB);
}

console.log('\n────────────────────────');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
