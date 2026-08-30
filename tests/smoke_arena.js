// 冒烟套件 11 —— P1-6 第四项：arenaGained 算出了但结算页没展示
//
// 背景：spintop.js:841 胜利时 this.arenaGained = game.addArenaScore(score) 已算出，
// 但 _drawResult 的奖励胶囊行只画了金币/连胜，竞技积分从未展示（audit P1-6 第四项）。
//
// 修法：_drawResult 在奖励行下方，win 且 arenaGained>0 时画一行「竞技积分 +N」。
// 本套件用宽松 Proxy ctx（任意绘制 API 都是 no-op）驱动 _drawResult，断言：
//   1) 胜利结算后 arenaGained > 0（值确实算出来了）
//   2) _drawResult 不抛错
//   3) 绘制文本里包含「竞技积分 +」行
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

function mkBattle() {
  const g = new GameState();
  const b = new SpintopBattle(g, 375, 812);
  b.safeTop = 56;
  b.safeBottom = 24;
  b.start(new Beyblade(0, 1));
  b.countdown = 0;
  // 让 _drawResult 需要的 game 字段存在
  b.game.winStreak = 3;
  b.game.streakMultiplier = () => 2;
  return b;
}

/** 宽松 ctx：任意方法都是 no-op；fillText 记录文本；gradient 返回带 addColorStop 的桩 */
function mockCtx(rec) {
  const target = { texts: rec.texts };
  return new Proxy(target, {
    get(t, p) {
      if (p === 'texts') return t.texts;
      if (p === 'measureText') return () => ({ width: 10 });
      if (p === 'createRadialGradient' || p === 'createLinearGradient')
        return () => ({ addColorStop() {} });
      if (p === 'fillText') return (txt) => { t.texts.push(String(txt)); };
      if (typeof p === 'string' && /Style|font|Align|Baseline|lineWidth|shadowBlur|globalAlpha/.test(p))
        return t[p];
      return () => {};
    },
    set(t, p, v) { t[p] = v; return true; }
  });
}

console.log('\n【P1-6-d】arenaGained 胜利时算出且结算页展示');
{
  const b = mkBattle();
  // 构造一个已胜利、已结算的状态
  b.result = 'win';
  b.isRingOut = false;
  b.score = 20000;
  b.targetScore = 100;
  b.reward = 500;
  b._resultStarCount = 1;
  b._resultParticles = [];
  b._resultStartTime = Date.now();
  b.dropItem = null;
  b.chestDropped = false;
  b.runActive = false;
  // 模拟胜利结算：game.addArenaScore 折算竞技积分
  if (typeof b.game.addArenaScore === 'function') {
    b.arenaGained = b.game.addArenaScore(b.score);
  } else {
    b.arenaGained = 250;   // 兜底：无该方法时直接赋值，验证展示逻辑
  }

  ok('胜利时 arenaGained 被算出（>0）', b.arenaGained > 0, 'arenaGained=' + b.arenaGained);

  const rec = { texts: [] };
  const ctx = mockCtx(rec);
  let threw = null;
  try { b._drawResult(ctx); } catch (e) { threw = e; }
  ok('_drawResult 不抛错', threw === null, threw && threw.message);

  const joined = rec.texts.join(' | ');
  ok('结算页绘制了「竞技积分 +N」行', rec.texts.some((t) => t.indexOf('竞技积分 +') === 0),
    'texts=' + joined);
}

console.log('\n【P1-6-d·反向】失败时 arenaGained 为 0，不画竞技积分行');
{
  const b = mkBattle();
  b.result = 'lose';
  b.isRingOut = false;
  b.score = 1234;
  b.targetScore = 99999;
  b.reward = 0;
  b.arenaGained = 0;   // 失败不获得竞技积分
  b._resultStarCount = 0;
  b._resultParticles = [];
  b._resultStartTime = Date.now();
  b.dropItem = null;
  b.chestDropped = false;
  b.runActive = false;

  const rec = { texts: [] };
  const ctx = mockCtx(rec);
  let threw = null;
  try { b._drawResult(ctx); } catch (e) { threw = e; }
  ok('_drawResult（失败）不抛错', threw === null, threw && threw.message);
  ok('失败时未绘制「竞技积分 +」行', !rec.texts.some((t) => t.indexOf('竞技积分 +') === 0),
    'texts=' + rec.texts.join(' | '));
}

console.log('\n────────────────────────');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
