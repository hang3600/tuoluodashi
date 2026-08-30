// 冒烟套件 5 —— P0-1 战斗节奏回归（目标分公式 + 达标即结算）
//
// 背景：旧公式 targetScore = (400 + power*10) * ramp，新号仅 500 分，
// 而满速单次抽打就有 600 分（maxSpeed 20 × 30）→ "划一下就赢 + 空转到 30 秒"。
// 本套件锁死三个不变量，防止该问题回归。
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

function mkBattle(tier, lv) {
  const g = new GameState();
  const b = new SpintopBattle(g, 375, 812);
  b.safeTop = 56;
  b.safeBottom = 24;
  b.start(new Beyblade(tier, lv));
  b.countdown = 0;   // 跳过开局 3-2-1-GO 倒计时
  return b;
}

console.log('\n【P0-1-a】目标分远大于单次满速抽打（防"一划即赢"回归）');
{
  for (const [tier, lv] of [[0, 1], [1, 2], [2, 3], [4, 5]]) {
    const b = mkBattle(tier, lv);
    const singleWhip = Math.floor(b.top.maxSpeed * 30);  // 与 spintop.js:486 同源
    const ratio = b.targetScore / singleWhip;
    ok(`tier${tier} Lv${lv}: 目标/单次抽打 = ${ratio.toFixed(1)} ≥ 8`,
      ratio >= 8,
      'target=' + b.targetScore + ' singleWhip=' + singleWhip);
  }
}

console.log('\n【P0-1-b】达标需合理抽打次数（8~20 抽，保证 30s 全程有事做）');
{
  // 复刻计分链路：连击不断时第 i 抽得 floor((base + floor(base*(i-1)*0.4)) * scoreMultiplier)
  // 注：这里用「力道 = 1.0×maxSpeed」这个中间档（约等于"完美短划 40px"）作基准。
  // 批次F 力度曲线落地后，实际档位为：完美长划 1.84x(8抽) / 完美短划 0.90x(11抽)
  // / 普通长划 0.75x(13抽) / 打偏 0.29x(21抽)。技巧档位差异的断言见 smoke_whip_feel.js。
  for (const [tier, lv] of [[0, 1], [2, 3], [4, 5]]) {
    const b = mkBattle(tier, lv);
    const base = Math.floor(b.top.maxSpeed * 30);
    let score = 0, n = 0;
    while (score < b.targetScore && n < 200) {
      n++;
      const comboBonus = Math.floor(base * (n - 1) * 0.4);
      score += Math.floor(Math.max(5, base + comboBonus) * b.scoreMultiplier);
    }
    ok(`tier${tier} Lv${lv}: 需 ${n} 抽达标（8~20 区间）`, n >= 8 && n <= 20,
      'n=' + n + ' target=' + b.targetScore);
  }
}

console.log('\n【P0-1-c】达标即结算（不再空转到 30s）');
{
  const b = mkBattle(0, 1);
  b.score = b.targetScore + 100;      // 越过目标线
  const dt = 1 / 60;
  let t = 0;
  while (b.phase === 'playing' && t < 5) { b.update(dt); t += dt; }

  ok('达标后 1s 内结算（0.8s 胜利锁定窗口）', b.phase === 'result' && t < 1.0,
    't=' + t.toFixed(2) + 's phase=' + b.phase);
  ok('判定为胜利', b.result === 'win', 'result=' + b.result);
  ok('剩余时间仍充裕（证明不是等到超时才结算）', b.timeRemaining > 20,
    'timeRemaining=' + b.timeRemaining.toFixed(1) + 's');
  ok('胜利锁定计时器已归零', b._winLockT <= 0, '_winLockT=' + b._winLockT);
}

console.log('\n【P0-1-d】未达标时不会提前结算（负向用例）');
{
  const b = mkBattle(0, 1);
  b.score = 10;                        // 远未达标
  const dt = 1 / 60;
  let t = 0;
  while (b.phase === 'playing' && t < 2) { b.update(dt); t += dt; }
  ok('2s 内保持 playing（不被误判达标）', b.phase === 'playing', 'phase=' + b.phase);
  ok('胜利锁定计时器未启动', b._winLockT === 0, '_winLockT=' + b._winLockT);
}

console.log('\n【P0-1-e】连击窗口随阶段收紧（新手期容错）');
{
  const early = mkBattle(0, 1);        // stage 0
  ok('stage 0 连击窗口 = 2.4s（新手容错）', early._comboWindow === 2.4, 'v=' + early._comboWindow);
  ok('新号首战目标分 > 1 万（不再是 500）', early.targetScore > 10000, 'target=' + early.targetScore);
}

console.log('\n────────────────────────');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
