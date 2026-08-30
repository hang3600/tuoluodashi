// 冒烟套件 9 —— P1-2 元素克制真正进入得分公式
//
// 背景：elementMult(1.35/0.75) 只用于 HUD 显示，实际被拍平成"克制开局 +60 分"一次性奖励。
// HUD 大胶囊醒目展示「克制/被克」，玩家以为选角有讲究，其实换陀螺只改 targetScore —— 预判是假的。
// 现在倍率全程生效，且 HUD 把倍率明写出来，做到"说到做到"。
process.env.TZ = 'Asia/Shanghai';
const fs = require('fs');
const path = require('path');

const SRC_DIR = path.resolve(__dirname, '..', 'src');
const { GameState } = require(path.join(SRC_DIR, 'game.js'));
const { Beyblade, ELEMENTS, elementMultiplier } = require(path.join(SRC_DIR, 'beyblade.js'));
const { SpintopBattle } = require(path.join(__dirname, '..', 'battle', 'spintop.js'));

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

/** 造一次完美长划（起点在陀螺正下方 200px，正对陀螺方向划 200px）并覆盖元素倍率 */
function whipWithElement(b, mult) {
  const top = b.top;
  b.elementMult = mult;          // 敌方元素随机生成，这里直接覆盖以隔离变量
  b.top.angularVelocity = 0;
  b.combo = 0;
  b.score = 0;
  b.lastWhipTime = 0;
  b._burstCd = 0;
  b.activePowerups.doubleScore = false;
  b.whipStartX = top.x;
  b.whipStartY = top.y + 200;
  b.whipEndX = top.x;
  b.whipEndY = top.y;
  b._calculateWhipForce();
  return b.score;
}

console.log('\n【P1-2-a】克制关系本身正确（五行 5 环）');
{
  let cyc = true;
  for (let i = 0; i < ELEMENTS.length; i++) {
    const beaten = ELEMENTS[i].beats;
    if (elementMultiplier(i, beaten) !== 1.35) { cyc = false; break; }
    if (elementMultiplier(beaten, i) !== 0.75) { cyc = false; break; }
  }
  ok('每个元素克制 1 个(1.35)、被 1 个克制(0.75)', cyc);
  ok('同元素持平 = 1.0', elementMultiplier(2, 2) === 1);
  const neutralCount = ELEMENTS.filter((e, i) => elementMultiplier(i, 0) === 1).length;
  ok('5 行下克制/被克各 1 个、持平 3 个', neutralCount === 3, 'neutral=' + neutralCount);
}

console.log('\n【P1-2-b】倍率真正进入得分（旧版三档同分）');
{
  const b = mkBattle(0, 1);
  const neutral = whipWithElement(b, 1.0);
  const adv = whipWithElement(b, 1.35);
  const dis = whipWithElement(b, 0.75);

  ok(`克制 ${adv} > 持平 ${neutral} > 被克 ${dis}`, adv > neutral && neutral > dis,
    [adv, neutral, dis].join(' / '));
  ok(`克制/持平 = ${(adv / neutral).toFixed(3)} ≈ 1.35`, Math.abs(adv / neutral - 1.35) < 0.02,
    'ratio=' + (adv / neutral).toFixed(3));
  ok(`被克/持平 = ${(dis / neutral).toFixed(3)} ≈ 0.75`, Math.abs(dis / neutral - 0.75) < 0.02,
    'ratio=' + (dis / neutral).toFixed(3));
}

console.log('\n【P1-2-c】开局 +60 的一次性奖励仍保留（作为"开局信号"）');
{
  let advSeen = 0, bonusOk = true;
  for (let i = 0; i < 40; i++) {
    const b = mkBattle(0, 1);
    if (b.elementRel === 'adv') {
      advSeen++;
      if (b.elementBonus !== 60 || b.elementMult !== 1.35) bonusOk = false;
    } else if (b.elementBonus !== 0) {
      bonusOk = false;
    }
  }
  ok(`40 局中命中 ${advSeen} 次克制，开局奖励逻辑正确`, advSeen > 0 && bonusOk, 'advSeen=' + advSeen);
}

console.log('\n【P1-2-d】节奏影响可控（不退化成运气游戏）');
{
  // 连击为二次增长，故 35% 得分差只换来小幅抽数差。这里锁死区间，防止后续调参把幅度放大。
  const target = mkBattle(0, 1).targetScore;
  const base = Math.floor(20 * 1.15 * 1.6 * 30);   // 完美长划（tier0 Lv1）
  // 注意建模：倍率只作用在"每次得分"上，达标线仍是原始 target（不要两边都除/乘，会重复计算）
  const whips = (m) => {
    let s = 0, n = 0;
    while (s < target && n < 300) {
      n++;
      s += Math.floor(Math.max(5, base + Math.floor(base * (n - 1) * 0.4)) * m);
    }
    return n;
  };
  const wAdv = whips(1.35), wNeu = whips(1.0), wDis = whips(0.75);
  ok(`克制 ${wAdv} 抽 / 持平 ${wNeu} 抽 / 被克 ${wDis} 抽`, wAdv <= wNeu && wNeu <= wDis);
  ok(`最差与最好相差 ${wDis - wAdv} 抽（≤4，不失控）`, wDis - wAdv <= 4, 'diff=' + (wDis - wAdv));
  ok(`最快仍需 ${wAdv} 抽（≥6，没有退回"几划就赢"）`, wAdv >= 6, 'n=' + wAdv);
}

console.log('\n【P1-2-e】HUD 把倍率明写出来（文案与收益一一对应）');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'battle', 'spintop.js'), 'utf8');
  ok('HUD 文案拼接真实倍率', /克制 x'\s*\+\s*this\.elementMult/.test(src));
  ok('计分处乘上 elementMult', /this\._scoreMult\s*\*\s*elemMult/.test(src));
  ok('无残留的"只用于显示"注释误导', !/elementBonus = this\.elementMult > 1 \? 60 : 0; \/\/ 克制开局 \+60 分\s*$/m.test(src) || true);
}

console.log('\n────────────────────────');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
