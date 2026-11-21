// 五灵神兽命名门禁（2026-09-13）
//
// 背景：用户反馈「陀螺名字里的『土·普通 / 木·稀有 / 水·史诗 / 火·精英 / 金·传说』不搭」，
//   要求按五灵神兽（五方）替换：麒麟(中·土) / 青龙(东·木) / 玄武(北·水) / 朱雀(南·火) / 白虎(西·金)。
// 2026-09-13 追加：用户要求把土位神兽由「黄龙」改为「麒麟」（同属中央土，作陀螺名更有神兽感）→
//   全工程已替换；key(earth) / 档位顺序 / 抽卡概率 / 相克倍率 / 五行配色 一律不变。
//   （该轮曾误把元素名也换成神兽名 → 见下方 ⑤，已于同日回退为 金/木/水/火/土 单字。）
//
// 本套件锁死（防止后人"顺手"改回去或改错顺序）：
//   ⓿ TIERS 名字 + **顺序**（索引 0→4 由弱到强：兜底 / 保底 / 图鉴 / 贴图路径全依赖顺序）
//   ① ELEMENTS 名与 TIERS 按 key 一一对应；**相克关系 beats 与倍率完全不变**
//   ② 抽卡概率 chance 一分未动（改名不许改经济）
//   ③ 运行时：25 种 品质×等级 组合的 品质名 / 元素名 都是神兽名且不含稀有度词
//   ④ 源码级一致性：图鉴筛选短名、图鉴徽章名数组与 TIERS 对齐；全工程不得残留旧名
//   ⑤ **元素名（金/木/水/火/土 单字）与陀螺名（五灵神兽）必须零重名**（2026-09-13 修）：
//      上一轮改名误把元素名也换成神兽名 → 选陀螺面板出现「玄武 Lv3 · 元素·白虎」，
//      用户报为 bug（玄武的属性叫白虎、还是最高档神兽名；另有「麒麟 · 元素·朱雀」同类）。
//      → 元素名回退为金/木/水/火/土，两轴分开命名：陀螺名=品质档名，元素名=属性名。

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

global.wx = {
  setStorageSync: () => {}, getStorageSync: () => '',
  getSystemInfoSync: () => ({}), createImage: () => ({ set src(v) {}, onload: null, onerror: null }),
};
global.requestAnimationFrame = () => 0;

const { Beyblade, TIERS, ELEMENTS, elementMultiplier } = require('../src/beyblade');

const BEASTS = ['麒麟', '青龙', '玄武', '朱雀', '白虎'];
const ELEMENT_CN = ['金', '木', '水', '火', '土'];   // 元素名（属性轴）——与陀螺名刻意分开
const KEY_BEAST = { earth: '麒麟', wood: '青龙', water: '玄武', fire: '朱雀', metal: '白虎' };
const RARITY_WORDS = ['普通', '稀有', '精英', '史诗', '传说'];
const hasRarity = (s) => RARITY_WORDS.some(w => String(s).indexOf(w) >= 0);

console.log('\n【1】TIERS（陀螺名）——五灵神兽 + 顺序不变');
{
  ok('档位数量仍为 5', TIERS.length === 5);
  ok('名字按由弱到强 = 麒麟→青龙→玄武→朱雀→白虎',
    TIERS.map(t => t.name).join(',') === BEASTS.join(','));
  ok('key 顺序未被改动（earth→wood→water→fire→metal，贴图/存档依赖）',
    TIERS.map(t => t.key).join(',') === 'earth,wood,water,fire,metal');
  ok('每个 key 对应正确神兽（earth=麒麟 wood=青龙 water=玄武 fire=朱雀 metal=白虎）',
    TIERS.every(t => t.name === KEY_BEAST[t.key]));
  ok('名字里不再含稀有度词（普通/稀有/精英/史诗/传说）', TIERS.every(t => !hasRarity(t.name)));
  ok('名字里不再含「·」拼接（旧写法「土·普通」）', TIERS.every(t => t.name.indexOf('·') < 0));
  ok('最低档（兜底/图鉴首行）是土位神兽 = 麒麟，key 仍为 earth（2026-09-13 由「黄龙」改名）',
    TIERS[0].name === '麒麟' && TIERS[0].key === 'earth');
  ok('最高档仍是金属性 metal = 白虎', TIERS[4].key === 'metal' && TIERS[4].name === '白虎');
  ok('color / glow 颜色字段保留（渲染依赖）',
    TIERS.every(t => /^#[0-9a-f]{6}$/i.test(t.color) && /^#[0-9a-f]{6}$/i.test(t.glow)));
}

console.log('\n【2】抽卡概率一分未动（改名不许改经济）');
{
  const sum = TIERS.reduce((a, t) => a + t.chance, 0);
  ok('概率总和仍为 1', Math.abs(sum - 1) < 1e-9);
  ok('由低档到高档概率单调不增', TIERS.every((t, i) => i === 0 || t.chance <= TIERS[i - 1].chance));
  ok('最低档 40% / 最高档 4% 保持原值', TIERS[0].chance === 0.40 && TIERS[4].chance === 0.04);
}

console.log('\n【3】ELEMENTS（元素名）——金木水火土单字，与陀螺名【刻意分开】');
{
  const CN = ELEMENT_CN;
  ok('元素数量仍为 5', ELEMENTS.length === 5);
  ok('元素顺序（金→木→水→火→土）未变', ELEMENTS.map(e => e.key).join(',') === 'metal,wood,water,fire,earth');
  ok('元素名 = 金/木/水/火/土 单字（用户指定）', ELEMENTS.every((e, i) => e.name === CN[i]));
  ok('★ 元素名与陀螺名【零重名】——防「玄武 元素·白虎」这类撞名回归',
    ELEMENTS.every(e => BEASTS.indexOf(e.name) < 0) && TIERS.every(t => CN.indexOf(t.name) < 0));
  ok('元素名不含稀有度词', ELEMENTS.every(e => !hasRarity(e.name)));
  ok('元素颜色仍与品质色一致（角标用色不变）',
    ELEMENTS[0].color === TIERS[4].color && ELEMENTS[4].color === TIERS[0].color);
}

console.log('\n【4】相克关系与倍率必须完全不变');
{
  ok('beats 索引未动（金克木/木克土/土克水/水克火/火克金）',
    [1, 4, 3, 0, 2].every((b, i) => ELEMENTS[i].beats === b));
  ok('克制 1.35 / 被克 0.75 / 持平 1（金克木 / 金被火克 / 金对水无克制）',
    elementMultiplier(0, 1) === 1.35 && elementMultiplier(1, 0) === 0.75 && elementMultiplier(0, 2) === 1);
  ok('克制表述成立：金克木', ELEMENTS[0].name === '金' && ELEMENTS[1].name === '木' && elementMultiplier(0, 1) === 1.35);
  ok('克制表述成立：土克水', ELEMENTS[4].name === '土' && ELEMENTS[2].name === '水' && elementMultiplier(4, 2) === 1.35);
}

console.log('\n【5】运行时：品质名 ∈ 五灵神兽，元素名 ∈ 金木水火土（两轴互不重名）');
{
  ok('Beyblade(4,1).tier.name === 白虎（最高档）', new Beyblade(4, 1).tier.name === '白虎');
  ok('Beyblade(0,1).tier.name === 麒麟（最低档）', new Beyblade(0, 1).tier.name === '麒麟');
  let allTierBeast = true, allElCN = true, crossClean = true, noRarity = true;
  for (let t = 0; t < 5; t++) {
    for (let l = 1; l <= 5; l++) {
      const b = new Beyblade(t, l);
      if (BEASTS.indexOf(b.tier.name) < 0) allTierBeast = false;
      if (ELEMENT_CN.indexOf(b.elementInfo.name) < 0) allElCN = false;
      if (BEASTS.indexOf(b.elementInfo.name) >= 0) crossClean = false;
      if (hasRarity(b.tier.name + b.elementInfo.name)) noRarity = false;
    }
  }
  ok('25 种「品质 × 等级」的 品质名 全是神兽名', allTierBeast);
  ok('25 种组合的 元素名 全是金/木/水/火/土 单字', allElCN);
  ok('★ 25 种组合里元素名从不等于陀螺名', crossClean);
  ok('25 种组合的显示名都不含稀有度词', noRarity);
}

console.log('\n【6】源码级一致性（防漏改 / 防回退）');
{
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const renderSrc = read('src/render.js');
  const spintopSrc = read('battle/spintop.js');
  const allSrc = ['beyblade.js', 'render.js', 'main.js', 'game.js', 'config.js', 'ads.js', 'analytics.js']
    .map(f => read('src/' + f)).join('\n') + spintopSrc;

  // ⚠️ beyblade.js 刻意保留了「原『土·普通 …』」历史注释（给后人交代改过什么），
  //    因此残留断言只针对**可执行代码**：先整行剔除注释再查。
  const stripComments = (t) => t.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ok('可执行代码里不再残留旧组合名（土·普通/木·稀有/水·史诗/火·精英/金·传说）',
    !/土·普通|木·稀有|水·史诗|火·精英|金·传说/.test(stripComments(allSrc)));
  ok('旧名只允许出现在注释里（历史说明，非 UI 文案）',
    /土·普通|木·稀有|水·史诗|火·精英|金·传说/.test(allSrc));
  ok('图鉴筛选短名映射键已是五灵神兽',
    /CODEX_FILT_SHORT = \{ '麒麟': '麒', '青龙': '青', '玄武': '玄', '朱雀': '朱', '白虎': '白' \};/.test(renderSrc));
  const m = /CODEX_FILT_SHORT = \{([^}]*)\}/.exec(renderSrc);
  const shorts = m ? m[1].split(',').map(s => s.split(':')[1].trim().replace(/'/g, '')) : [];
  ok('筛选短名 5 个单字且互不重复（麒/青/玄/朱/白）',
    shorts.length === 5 && new Set(shorts).size === 5);
  ok('图鉴行徽章名数组与 TIERS 严格同序',
    /const tierNames = \['麒麟', '青龙', '玄武', '朱雀', '白虎'\];/.test(renderSrc));
  ok('图鉴筛选完整名仍取 TIERS.map(t => t.name)（改名自动跟随）',
    renderSrc.indexOf('TIERS.map(t => t.name)') >= 0);
  ok('选陀螺面板行名用 bb.tier.name（改名自动跟随）',
    renderSrc.indexOf("bb.tier.name + '  Lv' + bb.level") >= 0);
  ok('战斗 HUD 双方元素名取 ELEMENTS（改名自动跟随）',
    spintopSrc.indexOf('ELEMENTS[this.enemyElementIdx]') >= 0 && spintopSrc.indexOf('ELEMENTS[this.playerBb.elementIdx]') >= 0);
  // 源码层面再兜一层：ELEMENTS 字面量段内不许出现任何神兽名
  const bbSrc = read('src/beyblade.js');
  const elSeg = bbSrc.slice(bbSrc.indexOf('const ELEMENTS = ['), bbSrc.indexOf('/** a 对 b 的克制倍率'));
  ok('★ 源码 @ELEMENTS 字面量段内零神兽名（防日后又改成同名）',
    elSeg.length > 0 && BEASTS.every(n => elSeg.indexOf(n) < 0));
  ok('抽卡大字（最高档）= 白虎陀螺',
    renderSrc.indexOf("const lTxt = '白虎陀螺';") >= 0);
  ok('签到第 7 天大奖格子 = 白虎陀螺',
    renderSrc.indexOf("ctx.fillText('白虎陀螺', p.x + cellW / 2, p.y + 34);") >= 0);
  ok('机制文案已按神兽命名（白虎保底券/玄武保底券 在，保底逻辑仍随 pityLegend）',
    renderSrc.indexOf('白虎保底券') >= 0 && renderSrc.indexOf('玄武保底券') >= 0 && allSrc.indexOf("pityLegend") >= 0);
}

console.log('\n══════════════════════');
console.log((fail === 0 ? '✅' : '❌') + ' smoke_beast_naming：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
