// 冒烟套件 —— 方案A：元素 = f(品质, 等级)，25 种「神兽×元素」组合（2026-09-13 回退）
//
// 背景：上一轮把元素名从神兽名回退成 金/木/水/火/土 单字（解决「玄武 元素·白虎」撞名）。
//   随后短暂试过「方案B：元素绑到品质」（麒麟恒土/青龙恒木…），但用户复核后认为——
//   25 种「神兽×元素」组合对「升级产出不同元素同神兽」「25 款皮肤差异化生产」更有价值，
//   于是**回退到方案A**：元素由 (tierIndex*7 + (level%5)*3)%5 算出，随等级变、不绑品质。
//
// 本套件锁死方案A（防止后人改回"绑定品质"或改乱相克）：
//   ① elementIdx = (tier*7 + (level%5)*3)%5 精确；每档 5 级覆盖全部 5 元素；25 组合满
//   ② 元素环 beats 仍是 金→木→水→火→土→金（倍率 1.35/0.75/1 不动）
//   ③ 羁绊「同元素 ≥3」按元素计数（跨品质，不坍缩成"同品质"）
//   ④ 敌方元素取 randomBeyblade 的 elementIdx（旧的 rollEnemyElement 随机元素不得复活）
//   ⑤ 老档零迁移（元素派生，不入档）
//   ⚠️ 倍率、beats 索引、抽卡概率、档位顺序、贴图 key 一律不动。

process.env.TZ = 'Asia/Shanghai';
const fs = require('fs');
const path = require('path');

const store = {};
global.wx = {
  setStorageSync: (k, v) => { store[k] = v; },
  getStorageSync: (k) => (store[k] === undefined ? '' : store[k]),
  setStorage: (o) => { if (o && o.key) store[o.key] = o.data; if (o && o.success) o.success(); },
  getSystemInfoSync: () => ({ model: 'iPhone', system: 'iOS 16', benchmarkLevel: 60, screenWidth: 375, screenHeight: 812, windowHeight: 778, statusBarHeight: 44, pixelRatio: 1 }),
  createImage: () => ({ set src(v) {}, onload: null, onerror: null }),
  createCanvas: () => ({ width: 0, height: 0, getContext: () => null }),
};
global.requestAnimationFrame = () => 0;

const SRC = path.resolve(__dirname, '..', 'src');
const { GameState } = require(path.join(SRC, 'game.js'));
const { Beyblade, TIERS, ELEMENTS, elementMultiplier, elementBeatenBy } =
  require(path.join(SRC, 'beyblade.js'));
const { SpintopBattle } = require(path.join(__dirname, '..', 'battle', 'spintop.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

const BEASTS = ['麒麟', '青龙', '玄武', '朱雀', '白虎'];
const CN = ['金', '木', '水', '火', '土'];

// 方案A 期望表：TIERS[t] 在 Lv1..Lv5 的元素名（写死，改公式必须先过这一关）
// (t*7 + (l%5)*3)%5 ，ELEMENTS 顺序=金(0)木(1)水(2)火(3)土(4)
const EXPECT = [
  ['火', '木', '土', '水', '金'], // 麒麟(档0)
  ['金', '火', '木', '土', '水'], // 青龙(档1)
  ['水', '金', '火', '木', '土'], // 玄武(档2)
  ['土', '水', '金', '火', '木'], // 朱雀(档3)
  ['木', '土', '水', '金', '火'], // 白虎(档4)
];

console.log('\n【1】公式精确：(tier*7 + (level%5)*3)%5');
{
  let allOk = true, firstBad = '';
  for (let t = 0; t < 5; t++) for (let l = 1; l <= 5; l++) {
    const got = new Beyblade(t, l).elementInfo.name;
    const exp = EXPECT[t][l - 1];
    if (got !== exp) { allOk = false; firstBad = `档${t} Lv${l}: got=${got} exp=${exp}`; }
  }
  ok('25 种组合的 elementInfo.name 全部命中期望表', allOk, firstBad);
  ok('构造函数用公式 (tierIndex * 7 + (level % 5) * 3) % 5',
    /this\.elementIdx = \(tierIndex \* 7 \+ \(level % 5\) \* 3\) % 5;/.test(
      fs.readFileSync(path.join(SRC, 'beyblade.js'), 'utf8')));
  ok('elementBeatenBy 与 beats 互为逆向（每个元素恰好被 1 个克）',
    ELEMENTS.every((e, i) => ELEMENTS[elementBeatenBy(i)].beats === i));
}

console.log('\n【2】每档 5 级覆盖全部 5 元素；25 组合满');
{
  let perTierOk = true;
  const combos = new Set();
  for (let t = 0; t < 5; t++) {
    const els = [1, 2, 3, 4, 5].map(l => new Beyblade(t, l).elementIdx);
    if (new Set(els).size !== 5) perTierOk = false;
    for (let l = 1; l <= 5; l++) combos.add(TIERS[t].name + '·' + new Beyblade(t, l).elementInfo.name);
  }
  ok('每档 5 个等级恰好各占一个不同元素（无重复）', perTierOk);
  ok('25 种「神兽×元素」组合互不重复 = 满 25', combos.size === 25, 'size=' + combos.size);
  // 每个元素在 25 格里出现恰好 5 次
  const cnt = [0, 0, 0, 0, 0];
  for (let t = 0; t < 5; t++) for (let l = 1; l <= 5; l++) cnt[new Beyblade(t, l).elementIdx]++;
  ok('每个元素在 25 格里恰好出现 5 次', cnt.every(c => c === 5), cnt.join(','));
  // 升级产出不同元素的同神兽（用户要的核心价值）
  ok('升级改元素（用户实例）：火麒麟=麒麟Lv1 / 木麒麟=麒麟Lv2 / 水麒麟=麒麟Lv4；木白虎=白虎Lv1 / 水白虎=白虎Lv3；水朱雀=朱雀Lv2 / 金朱雀=朱雀Lv3',
    new Beyblade(0, 1).elementInfo.name === '火' &&
    new Beyblade(0, 2).elementInfo.name === '木' &&
    new Beyblade(0, 4).elementInfo.name === '水' &&
    new Beyblade(4, 1).elementInfo.name === '木' &&
    new Beyblade(4, 3).elementInfo.name === '水' &&
    new Beyblade(3, 2).elementInfo.name === '水' &&
    new Beyblade(3, 3).elementInfo.name === '金');
}

console.log('\n【3】元素环与倍率（金→木→水→火→土→金，1.35/0.75/1）');
{
  ok('beats 仍是元素环（金→木→土→水→火→金，对应 [1,4,3,0,2]）',
    ELEMENTS.every((e, i) => e.beats === [1, 4, 3, 0, 2][i]));
  ok('金克木 = 1.35', elementMultiplier(0, 1) === 1.35);
  ok('土克水 = 1.35', elementMultiplier(4, 2) === 1.35);
  ok('木被金克 = 0.75', elementMultiplier(1, 0) === 0.75);
  ok('同元素持平 = 1.0', elementMultiplier(2, 2) === 1);
  ok('spintop HUD 仍拼接真实倍率（克制 x + this.elementMult，不退化）',
    fs.readFileSync(path.join(__dirname, '..', 'battle', 'spintop.js'), 'utf8')
      .indexOf("克制 x' + this.elementMult") >= 0);
}

console.log('\n【4】羁绊按元素计数（跨品质，不坍缩成"同品质"）');
{
  // 火(3) 出现：白虎 Lv1(火)、朱雀 Lv2(水✘)… 用明确的三只火元素拼出羁绊
  // 火元素 idx=3：麒麟 Lv2(火? 麒麟档0 Lv2=木)、查 EXPECT：火元素来源 = 麒麟Lv1/青龙Lv2/玄武Lv3/朱雀Lv4/白虎Lv5
  const fire = [new Beyblade(0, 1), new Beyblade(1, 2), new Beyblade(2, 3)];
  const g = new GameState();
  g.inventory = fire;
  const r = g.bondResonance();
  ok('三只不同神兽但同元素(火) → 羁绊触发（跨品质）',
    r.active && r.elementIdx === 3 && r.count === 3, 'active=' + r.active + ' idx=' + r.elementIdx);
  ok('羁绊加成仍是 +10%', Math.abs(r.bonus - 0.1) < 1e-9, 'bonus=' + r.bonus);
  // 两只同元素不触发
  const two = new GameState(); two.inventory = [new Beyblade(0, 1), new Beyblade(1, 2)];
  ok('仅 2 只同元素 → 不触发', !two.bondResonance().active);
}

console.log('\n【5】敌方元素 = randomBeyblade 的 elementIdx（rollEnemyElement 不得复活）');
{
  const spintopSrc = fs.readFileSync(path.join(__dirname, '..', 'battle', 'spintop.js'), 'utf8');
  const gameSrc = fs.readFileSync(path.join(SRC, 'game.js'), 'utf8');
  const strip = (t) => t.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ok('spintop.start 用敌方陀螺的 elementIdx（this.enemyElementIdx = enemyBb.elementIdx）',
    /this\.enemyElementIdx = enemyBb\.elementIdx;/.test(spintopSrc));
  ok('敌方由 randomBeyblade() 生成（非 rollEnemyElement 随机元素）',
    /const enemyBb = randomBeyblade\(\);/.test(spintopSrc));
  ok('★ 剥离注释后 game+spintop 无 rollEnemyElement 调用',
    !/rollEnemyElement/.test(strip(gameSrc) + '\n' + strip(spintopSrc)));
  // 运行时：同一档位在不同等级下元素不同（方案A 核心，证明敌方克制不是恒定品质环）
  const sameTier = [1, 2, 3, 4, 5].map(l => new Beyblade(4, l).elementIdx);
  ok('白虎(档4) 的 5 个等级元素各不相同（敌方克制随等级浮动）',
    new Set(sameTier).size === 5, sameTier.join(','));
}

console.log('\n【6】老档零迁移（元素派生，不入档）');
{
  const gameSrc = fs.readFileSync(path.join(SRC, 'game.js'), 'utf8');
  ok('load 用 new Beyblade(tierIndex, level) 重建（元素自动按公式派生）',
    /const bb = new Beyblade\(\s*clamp\(item\.tierIndex \| 0/.test(gameSrc));
  store['beyblade_master_save_v2'] = JSON.stringify({
    coins: 100, energy: 50, inventory: [{ tierIndex: 2, level: 2, id: 'legacy-bb-1' }],
  });
  const g2 = new GameState();
  // 玄武(档2) Lv2 在方案A = 金（见 EXPECT[2][1]）
  ok('★ 老档载入后 inventory[0] 元素 = 金（无需任何迁移代码）',
    !!(g2.inventory[0] && g2.inventory[0].elementInfo && g2.inventory[0].elementInfo.name === '金'),
    g2.inventory[0] ? g2.inventory[0].elementInfo.name : 'no-inventory');
  ok('老档载入不抛错、不影响其他字段', g2.coins === 100);
}

console.log('\n【7】源码级防回退（"绑定品质"与随机元素不得复活）');
{
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const bbSrc = read('src/beyblade.js');
  const gameSrc = read('src/game.js');
  const renderSrc = read('src/render.js');
  const spintopSrc = read('battle/spintop.js');
  const strip = (t) => t.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const allExec = [bbSrc, gameSrc, renderSrc, spintopSrc].map(strip).join('\n');

  ok('★ 无 ELEMENT_OF_TIER / elementIdxForTier（绑定品质的残留）',
    !/ELEMENT_OF_TIER/.test(allExec) && !/elementIdxForTier/.test(allExec));
  ok('★ rollEnemyElement 零残留（随机元素不得复活）', !/rollEnemyElement/.test(allExec));
  ok('元素索引仍只在 Beyblade 构造器赋值（没有第二处写入点）',
    (bbSrc.match(/this\.elementIdx\s*=/g) || []).length === 1);
  ok('面板行显示「元素·X」单字（不含"克 X / 被 Y 克"链）',
    renderSrc.indexOf("'元素·' + el.name") >= 0 &&
    renderSrc.indexOf("' · 克 ' + _beatsName") < 0 && renderSrc.indexOf("' · 被 ' + _beatenByName + ' 克'") < 0);
  ok('HUD 文案带上双方神兽名（把"土克水"读成"麒麟克玄武"）',
    spintopSrc.indexOf("_pTn + '·' + pEl.name") >= 0 && spintopSrc.indexOf("_eTn + '·' + eEl.name") >= 0);
}

console.log('\n【8】真实 Main 渲染：面板行只画「元素·X」单字');
{
  const texts = [];
  const gradStub = () => ({ addColorStop: () => {} });
  const canvas = { dpr: 1, width: 375, height: 812 };
  const ctx = new Proxy({ canvas }, {
    get(t, p) {
      if (p === 'canvas') return canvas;
      if (p === 'createLinearGradient' || p === 'createRadialGradient' || p === 'createPattern') return gradStub;
      if (p === 'measureText') return () => ({ width: 10 });
      if (p === 'fillText') return (s) => { texts.push(String(s)); };
      return () => {};
    },
    set() { return true; },
  });
  const Main = require(path.join(SRC, 'main.js'));
  const m = new Main(canvas, ctx, global.wx.getSystemInfoSync());
  const g = m.game;
  g.homeV2 = true; g.mode = 'main'; g.tutorialDone = true; g.drawCard = null;
  g.energy = 100; g.coins = 500; g.save = () => {};
  g.inventory = [new Beyblade(2, 3), new Beyblade(4, 5), new Beyblade(0, 1), new Beyblade(3, 2)];
  m._openBattleSelect();
  for (let i = 0; i < 30; i++) m.update(0.02);
  for (let i = 0; i < 8; i++) { m.renderer.render(0.016); if (m.renderer.modalRects.length) break; }

  const rowHits = texts.filter(s => /^元素·[金木水火土]$/.test(s));
  ok('面板至少画出一个「元素·X」行（X 为单字五行）', rowHits.length >= 1, 'rows=' + rowHits.length);
  ok('★ 没有任何一行画出「克 X · 被 Y 克」链（方案B 残留）',
    !texts.some(s => /克 .* 克/.test(s)));
  ok('已选行带「元素·X」且不含「·克」',
    texts.some(s => s.indexOf('已选：') === 0 && s.indexOf('元素·') >= 0 && s.indexOf('·克') < 0));
}

console.log('\n────────────────────────');
console.log((fail === 0 ? '✅' : '❌') + ' smoke_element_formula：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
