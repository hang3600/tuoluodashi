// 冒烟套件 8 —— 批次F：抽打力度曲线重构 + 命中定帧（hitstop）
//
// 背景（批次F 之前）：
// - 力度 clamp 到 maxSpeed，滑动 25px 即饱和（屏宽 375）→ 三档评级与滑动距离完全不影响得分，
//   "准划优于快划"的设计意图失效，玩家学不到任何技巧。
// - 全文件无 hitstop，碰撞只有粒子+6px 震屏，缺少打击感最大的单项杠杆。
process.env.TZ = 'Asia/Shanghai';
const path = require('path');

const SRC_DIR = path.resolve(__dirname, '..', 'src');
const { GameState } = require(path.join(SRC_DIR, 'game.js'));
const { Beyblade } = require(path.join(SRC_DIR, 'beyblade.js'));
const {
  SpintopBattle, WHIP_DIST_FULL, WHIP_DIST_MIN, WHIP_DIST_MAX,
  FORCE_CAP_MULT, SHAKE_MAX, HITSTOP_COLLISION, HITSTOP_CRIT, CRIT_MULT, TARGET_REF_MULT
} = require(path.join(__dirname, '..', 'battle', 'spintop.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

function mkBattle(tier = 0, lv = 1) {
  const g = new GameState();
  const b = new SpintopBattle(g, 375, 812);
  b.safeTop = 56;
  b.safeBottom = 24;
  b.start(new Beyblade(tier, lv));
  b.countdown = 0;
  return b;
}

/**
 * 造一次抽打：起点在陀螺正下方 dist 处，沿"偏离指向陀螺 angleOffDeg 度"的方向划 dist px。
 * 因起点在正下方，angleToTop 恒为 -90°，故 angleDiff 就等于 angleOffDeg：
 *   0° → perfect ／ 30° → normal ／ 90° → miss
 * 每次调用前重置转速/连击/计时，隔离掉 overSpin、连击加成、爆发等干扰。
 */
function whipOnce(b, dist, angleOffDeg) {
  const top = b.top;
  b.top.angularVelocity = 0;      // 排除 overSpin 衰减干扰
  b.combo = 0;                    // 排除连击加成干扰
  b.score = 0;
  b.lastWhipTime = 0;             // gap=9999 → 不触发爆发
  b._burstCd = 0;
  b.activePowerups.doubleScore = false;
  b.elementMult = 1;              // 隔离元素倍率（敌方元素随机，不固定会让结果不可复现）

  b.whipStartX = top.x;
  b.whipStartY = top.y + dist;
  const a = -Math.PI / 2 + angleOffDeg * Math.PI / 180;
  b.whipEndX = b.whipStartX + Math.cos(a) * dist;
  b.whipEndY = b.whipStartY + Math.sin(a) * dist;
  b._calculateWhipForce();
  return b.score;
}

console.log('\n【F-a】滑动距离真正影响得分（旧版 25px 即饱和，长划与短划同分）');
{
  const b = mkBattle(0, 1);
  const shortW = whipOnce(b, 40, 0);    // 完美 · 短划
  const midW = whipOnce(b, 100, 0);
  const longW = whipOnce(b, 220, 0);    // 完美 · 长划
  ok(`短划 ${shortW} < 中划 ${midW}`, shortW < midW);
  ok(`中划 ${midW} < 长划 ${longW}`, midW < longW);
  ok(`长划/短划 = ${(longW / shortW).toFixed(2)}x（>1.5 说明距离确实有效）`,
    longW / shortW > 1.5, 'ratio=' + (longW / shortW).toFixed(2));
}

console.log('\n【F-b】三档评级真正影响得分（旧版三档同分，只影响断不断连击）');
{
  const b = mkBattle(0, 1);
  const perfect = whipOnce(b, 200, 0);
  const normal = whipOnce(b, 200, 30);
  const miss = whipOnce(b, 200, 90);
  ok(`perfect ${perfect} > normal ${normal}`, perfect > normal);
  ok(`normal ${normal} > miss ${miss}`, normal > miss);
  ok(`perfect/miss = ${(perfect / miss).toFixed(1)}x（>3 说明准划有回报）`,
    perfect / miss > 3, 'ratio=' + (perfect / miss).toFixed(1));
}

console.log('\n【F-c】力度仍是有界的（不放任超长滑动击穿目标分校准）');
{
  const b = mkBattle(0, 1);
  const huge = whipOnce(b, 3000, 0);    // 荒谬的长划（完美档 ⇒ 必定暴击）
  // 得分链 = floor(fEff*30) × scoreMultiplier × elemMult × critMult，故 score/30 已含暴击 1.5。
  // FORCE_CAP_MULT(2.8) 正是按 1.15(划满)×1.6(完美)×1.5(暴击)=2.76 定的，留了 0.04 余量。
  const cap = b.top.maxSpeed * FORCE_CAP_MULT;
  ok(`3000px 荒谬长划得分 ${huge}，折算力度 ${(huge / 30).toFixed(1)} ≤ 上限 ${cap.toFixed(1)}`,
    huge / 30 <= cap + 1, 'force=' + (huge / 30).toFixed(1) + ' cap=' + cap.toFixed(1));
  ok(`距离系数上限生效（WHIP_DIST_MAX=${WHIP_DIST_MAX}）`, WHIP_DIST_MAX <= 1.3);
  ok(`震屏被封顶 ≤ ${SHAKE_MAX}`, b.screenShake <= SHAKE_MAX, 'shake=' + b.screenShake);
}

console.log('\n【F-d】爆发不弱于普通满划（修掉的耦合陷阱）');
{
  // 旧代码 fEff = min(force*1.5, maxSpeed)：新曲线下力道可超过 maxSpeed，
  // 会把爆发反而砍回 maxSpeed，导致"爆发 < 普通满划"。这里锁死该回归。
  const b1 = mkBattle(0, 1);
  const plain = whipOnce(b1, 200, 0);

  const b2 = mkBattle(0, 1);
  const top = b2.top;
  b2.top.angularVelocity = 0;
  b2.combo = 0;
  b2.score = 0;
  b2._burstCd = 0;
  b2.lastWhipGrade = 'perfect';
  b2.lastWhipTime = Date.now();          // gap≈0 < 450ms → 触发爆发
  b2.whipStartX = top.x;
  b2.whipStartY = top.y + 200;
  b2.whipEndX = top.x;
  b2.whipEndY = top.y;
  b2._calculateWhipForce();
  const burst = b2.score;

  ok(`爆发 ${burst} > 普通满划 ${plain}`, burst > plain, 'burst=' + burst + ' plain=' + plain);
}

console.log('\n【F-e】命中定帧：暴击触发 + 冻结玩法时间 + 震屏仍衰减');
{
  const b = mkBattle(0, 1);
  whipOnce(b, 200, 0);                   // 完美划 → efficiency 1.6 > 0.85 → 暴击
  ok(`暴击触发定帧（_hitstopT = ${b._hitstopT.toFixed(3)}s）`, b._hitstopT > 0);
  ok(`定帧时长 = HITSTOP_CRIT(${HITSTOP_CRIT})`, Math.abs(b._hitstopT - HITSTOP_CRIT) < 1e-6,
    'v=' + b._hitstopT);

  const tBefore = b.timeRemaining;
  const avBefore = b.top.angularVelocity;
  const shakeBefore = b.screenShake;
  b.update(0.016);                       // 定帧中的一帧

  ok('定帧期间玩法时间不推进（timeRemaining 不变）', b.timeRemaining === tBefore,
    tBefore + ' → ' + b.timeRemaining);
  ok('定帧期间物理不推进（转速不变）', b.top.angularVelocity === avBefore,
    avBefore + ' → ' + b.top.angularVelocity);
  ok('定帧期间震屏仍在衰减（否则画面会像卡死）', b.screenShake < shakeBefore,
    shakeBefore + ' → ' + b.screenShake);
}

console.log('\n【F-f】命中定帧会正常结束（不会永久冻死）');
{
  const b = mkBattle(0, 1);
  whipOnce(b, 200, 0);
  let frames = 0;
  while (b._hitstopT > 0 && frames < 60) { b.update(0.016); frames++; }
  ok(`定帧在 ${frames} 帧内结束`, b._hitstopT <= 0 && frames < 60, 'frames=' + frames);

  const t0 = b.timeRemaining;
  b.update(0.016);                       // 定帧结束后应恢复推进
  ok('定帧结束后时间恢复推进', b.timeRemaining < t0, t0 + ' → ' + b.timeRemaining);
}

console.log('\n【F-g】未暴击时不触发定帧（避免过度顿帧）');
{
  const b = mkBattle(0, 1);
  whipOnce(b, 200, 90);                  // 打偏 → 非暴击
  ok(`打偏不触发定帧（_hitstopT = ${b._hitstopT}）`, b._hitstopT === 0, 'v=' + b._hitstopT);
}

console.log('\n【P1-3】暴击倍率真正进入得分（旧版 critMult 是死变量，暴击零收益）');
{
  // 用 _critChance 精确隔离暴击：普通档 efficiency=0.65 < 0.85 不会因评级暴击，
  // 且 lastWhipTime=0 不触发爆发，于是"是否暴击"只由 _critChance 决定 —— 唯一变量。
  const scoreWith = (critChance) => {
    const b = mkBattle(0, 1);
    b._critChance = critChance;
    return whipOnce(b, 200, 30);   // 普通档长划
  };
  const noCrit = scoreWith(0);
  const crit = scoreWith(1);
  ok(`常暴击 ${crit} > 不暴击 ${noCrit}`, crit > noCrit, [crit, noCrit].join(' / '));
  ok(`倍率 = ${(crit / noCrit).toFixed(2)} 等于 CRIT_MULT(${CRIT_MULT})`,
    Math.abs(crit / noCrit - CRIT_MULT) < 0.02, 'ratio=' + (crit / noCrit).toFixed(3));
}

console.log('\n【P1-3-b】完美划必定暴击（efficiency 1.6 > 0.85，非随机事件）');
{
  const b = mkBattle(0, 1);
  b._critChance = 0;              // 关掉随机暴击，只留评级判定
  const perfect = whipOnce(b, 200, 0);
  // 普通档同样长度、同样关掉随机暴击，作为对照（多出来的部分即 CRIT_MULT）
  const b2 = mkBattle(0, 1);
  b2._critChance = 0;
  const normal = whipOnce(b2, 200, 30);
  ok(`完美 ${perfect} / 普通 ${normal} = ${(perfect / normal).toFixed(2)}`, perfect > normal);
  // 力度比 1.6/0.65 = 2.46，再乘暴击 1.5 → 约 3.69
  ok(`完美/普通 ≈ 力度比(2.46) × 暴击(${CRIT_MULT}) = ${(2.46 * CRIT_MULT).toFixed(2)}`,
    Math.abs(perfect / normal - 2.46 * CRIT_MULT) < 0.15, 'ratio=' + (perfect / normal).toFixed(2));
}

console.log('\n【F-i】持续贴身不会把游戏卡死（撞击定帧的两道闸门）');
{
  // 回归背景：最初只有"碰撞即定帧"，两个陀螺贴着蹭时会陷入
  // "定帧→物理停→解除→又碰撞→再定帧"的循环，实测 60 帧里 52 帧处于定帧（87%），
  // 游戏近乎静止，连胜利结算都被拖到 5 秒后才触发。
  // 现在有 HITSTOP_MIN_IMPACT(相对速度阈值) + HITSTOP_COLLISION_CD(冷却) 两道闸门。
  const b = mkBattle(0, 1);
  b.score = b.targetScore + 100;    // 达标，确保最终会走结算
  const dt = 1 / 60;
  let frozen = 0, frames = 0;
  while (b.phase === 'playing' && frames < 300) {
    b.update(dt);
    if (b._hitstopT > 0) frozen++;
    frames++;
  }
  const pct = frozen / Math.max(1, frames) * 100;
  ok(`300 帧内定帧占比 ${pct.toFixed(0)}%（<40%，不会卡死）`, pct < 40, 'pct=' + pct.toFixed(0));
  ok('仍能正常走到结算', b.phase === 'result', 'phase=' + b.phase + ' frames=' + frames);
  ok(`结算未因定帧被拖延（${(frames * dt).toFixed(2)}s ≈ 0.8s 胜利锁定）`,
    frames * dt < 1.5, 't=' + (frames * dt).toFixed(2) + 's');
}

console.log('\n【F-h】撞击定帧强于暴击定帧');
{
  ok(`HITSTOP_COLLISION(${HITSTOP_COLLISION}) > HITSTOP_CRIT(${HITSTOP_CRIT})`,
    HITSTOP_COLLISION > HITSTOP_CRIT);
  ok(`定帧时长在合理区间（30~120ms）`,
    HITSTOP_COLLISION >= 0.03 && HITSTOP_COLLISION <= 0.12 &&
    HITSTOP_CRIT >= 0.03 && HITSTOP_CRIT <= 0.12);
}

console.log('\n────────────────────────');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
