// 冒烟套件 26 —— #7 打击感升级（命中闪光 / 拖尾强化 / 音效分层）
//
// 背景（整体审计 #7）：现有 hitstop/震屏/粒子已强，但缺"体积反馈"与"声音层次"。
// 本轮补：①命中白闪（additive）②拖尾随连击/暴击强化（更亮更粗+发光）
// ③音效分层（轻击/重击/暴击/出界各自音色）。
// 注：原「受击 squash 形变（压扁）」已移除——陀螺为硬体，硬碰硬不变形，
// 体积/打击反馈改由白闪+震屏+粒子+冲击波承担（见 spintop.js 的 _drawHitFlashes/_drawShockwaves）。
// 不改核心循环（胜利条件/得分公式未动）。
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

// 复用审计 #7 验证过的无头抽打驱动：起点在陀螺正下方，沿角度划 dist；0°=perfect/暴击，30°=normal，90°=miss
function mkBattle(tier = 0, lv = 1) {
  const g = new GameState();
  const b = new SpintopBattle(g, 375, 812);
  b.safeTop = 56; b.safeBottom = 24;
  b.start(new Beyblade(tier, lv));
  b.countdown = 0;
  return b;
}
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
// 让一次命中后，战斗保持"进行中"且不发生二次碰撞，以便纯净观察衰减：
// ①转速置非零（避免 update 判定 angularVelocity===0 直接结算）
// ②敌方置 null：update 全链路对 enemy 有 `if(this.enemy)` 守卫，置 null 既不触发
//   碰撞也不触发越界 Ring Out（把敌陀螺移到界外会立刻 _ringOut('win') 冻结后续 update）；
// ③timeRemaining 拉高，避免时间耗尽触发 _settle 提前结束 update。
function isolateForDecay(b) {
  b.top.angularVelocity = 10;
  b.top.vx = 0; b.top.vy = 0;
  b.timeRemaining = 999;
  b.enemy = null;
}

console.log('\n【#7 硬碰硬·无形变】命中后陀螺本体不变形（不压扁），受击反馈改由白闪/震屏承担');
{
  const b = mkBattle(0, 1);
  whipOnce(b, 200, 0);                 // 完美划 → 重度命中
  ok('命中后不产生 squash 形变字段（硬陀螺不变形）', b._squash === undefined,
    'squash=' + (b._squash === undefined ? 'undefined' : b._squash));
  ok('命中后屏幕震屏生效（非形变打击感仍在）', b.screenShake > 0, 'shake=' + b.screenShake.toFixed(2));
  ok('命中后命中白闪已 push（体积反馈由光斑承担）', b.hitFlashes.length >= 1, 'n=' + b.hitFlashes.length);
  isolateForDecay(b);
  for (let i = 0; i < 60; i++) b.update(0.016);   // 充分帧让衰减跑完（含定格的几帧）
  ok('update 后仍无 squash 字段（确认未偷偷形变）', b._squash === undefined,
    'squash=' + (b._squash === undefined ? 'undefined' : b._squash));
}

console.log('\n【#7 命中白闪】命中后 push 一个 hitFlash，且随时间淡出移除');
{
  const b = mkBattle(0, 1);
  whipOnce(b, 200, 0);
  ok('命中后 hitFlashes 有 1 个光斑', b.hitFlashes.length === 1, 'n=' + b.hitFlashes.length);
  ok('光斑初始 alpha > 0', b.hitFlashes[0] && b.hitFlashes[0].alpha > 0, 'a=' + (b.hitFlashes[0] && b.hitFlashes[0].alpha));
  isolateForDecay(b);
  for (let i = 0; i < 60; i++) b.update(0.016);
  ok('衰减后白闪淡出并被移除', b.hitFlashes.length === 0, 'n=' + b.hitFlashes.length);
}

console.log('\n【#7 拖尾辉光】暴击置 _trailGlow=1，重击半辉，update 衰减');
{
  const b = mkBattle(0, 1);
  whipOnce(b, 200, 0);                 // perfect → 暴击（efficiency>0.85）
  ok('暴击置 _trailGlow=1（满辉）', b._trailGlow === 1, 'glow=' + b._trailGlow);
  isolateForDecay(b);
  for (let i = 0; i < 60; i++) b.update(0.016);
  ok('约 1s 后 _trailGlow 衰减归零', b._trailGlow === 0, 'glow=' + b._trailGlow);

  const b2 = mkBattle(0, 1);
  whipOnce(b2, 220, 30);               // normal 长划（非暴击但力道大）
  ok('重击（非暴击）置 _trailGlow=0.5（半辉）', Math.abs(b2._trailGlow - 0.5) < 1e-6, 'glow=' + b2._trailGlow);
}

console.log('\n【#7 音效分层】按力度/暴击路由不同音色（轻/重/暴击）');
{
  function whipWithAudio(dist, off, critChance) {
    const b = mkBattle(0, 1);
    const played = [];
    b.audio = { play: (t, o) => played.push(t) };
    whipOnce(b, dist, off, critChance);
    return played;
  }
  const crit = whipWithAudio(200, 0);             // 完美划 → 暴击
  ok('暴击 → 播放 crit 音', crit.indexOf('crit') >= 0 && crit.indexOf('clash_light') < 0,
    'played=' + JSON.stringify(crit));

  const heavy = whipWithAudio(220, 30);           // 普通长划、力道>70% → 重击
  ok('重击 → 播放 clash_heavy', heavy.indexOf('clash_heavy') >= 0,
    'played=' + JSON.stringify(heavy));

  const light = whipWithAudio(40, 30);            // 普通短点（非暴击、力道低）→ 轻击
  ok('轻点（普通短划）→ 播放 clash_light', light.indexOf('clash_light') >= 0,
    'played=' + JSON.stringify(light));
  ok('轻点不播放 crit', light.indexOf('crit') < 0, 'played=' + JSON.stringify(light));
}

console.log('\n【#7 碰撞反馈】撞击不再压扁双方陀螺（硬碰硬），但仍产生中点白闪 + 分层音 + 震屏');
{
  const b = mkBattle(0, 1);
  const played = [];
  b.audio = { play: (t) => played.push(t) };
  const top = b.top, en = b.enemy;
  top.x = 180; top.y = 400; top.vx = 40; top.vy = 0;
  en.x = 200; en.y = 400; en.vx = -40; en.vy = 0;
  // 直接驱动一次碰撞解算（确定性，绕过物理时序）：两陀螺重叠且相向高速
  b._resolveCollision(top, en);
  // 硬碰硬：碰撞只触发非形变反馈（白闪/震屏/分层音），不再改写任何 squash 形变字段
  ok('碰撞后双方均无 squash 形变字段', b._squash === undefined && en._squash === undefined,
    'player=' + (b._squash === undefined ? 'undefined' : b._squash) +
    ' en=' + (en._squash === undefined ? 'undefined' : en._squash));
  ok('碰撞产生中点白闪', b.hitFlashes.length >= 1, 'n=' + b.hitFlashes.length);
  ok('碰撞播放分层音（轻/重）', played.some(p => p === 'clash_heavy' || p === 'clash_light'),
    'played=' + JSON.stringify(played));
  ok('碰撞触发屏幕震屏', b.screenShake > 0, 'shake=' + b.screenShake.toFixed(2));
}

console.log('\n══════════════════════════════');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
