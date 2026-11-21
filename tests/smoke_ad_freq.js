// 冒烟套件 —— 广告频控纪律（文章铁律3）
// 被动激励位：一局最多 gameMax 次、且距上次广告至少 gapMin 分钟；主动位（看广告得能量）不受此限。
process.env.TZ = 'Asia/Shanghai';
const path = require('path');
const fs = require('fs');
const SRC = path.resolve(__dirname, '..', 'src');
const { CONFIG } = require(path.join(SRC, 'config.js'));
const Main = require(path.join(SRC, 'main.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}
function mkMain() {
  const m = Object.create(Main.prototype);
  m._lastRewardedAd = 0;
  m._rewardsThisBattle = 0;
  m._toast = () => {};
  return m;
}

console.log('\n【1 config】频控参数');
{
  ok('adFreq 默认 gameMax=2 / gapMin=3', CONFIG.adFreq && CONFIG.adFreq.gameMax === 2 && CONFIG.adFreq.gapMin === 3,
    JSON.stringify(CONFIG.adFreq));
}

console.log('\n【2 网关行为】');
{
  const m = mkMain();
  ok('首放可过（无间隔无上限）', m._adFreqGate() === true, 'r=' + m._rewardsThisBattle);
  // 同一毫秒内再次 → 间隔未满 3min → 拒绝
  ok('3 分钟内第二次被拒（间隔）', m._adFreqGate() === false, 'r=' + m._rewardsThisBattle);
}

console.log('\n【3 一局 ≤ gameMax】');
{
  const m = mkMain();
  m._lastRewardedAd = -3600000;   // 1 小时前，间隔已过
  ok('第1次通过', m._adFreqGate() === true);
  m._lastRewardedAd = -3600000;
  ok('第2次通过（gameMax=2）', m._adFreqGate() === true);
  m._lastRewardedAd = -3600000;
  ok('第3次被拒（本局已达2次）', m._adFreqGate() === false, 'r=' + m._rewardsThisBattle);
  ok('本局 ≤2 的计数', m._rewardsThisBattle === 2, 'r=' + m._rewardsThisBattle);
}

console.log('\n【4 每局重置】');
{
  const m = mkMain();
  m._lastRewardedAd = Date.now();  // 刚弹过
  ok('先被间隔拒', m._adFreqGate() === false);
  m._rewardsThisBattle = 0;        // start 新一局重置
  m._lastRewardedAd = -3600000;
  ok('新局后可再弹', m._adFreqGate() === true);
}

console.log('\n【5 主动位不被网关】源码级：能量位不进 _adFreqGate');
{
  const src = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
  // 能量位分支（adenergy）附近不应出现 _adFreqGate 拒绝
  const seg = src.slice(src.indexOf("a === 'adenergy'"), src.indexOf("a === 'adenergy'") + 400);
  ok('能量位代码段不含频控拒绝', seg.indexOf('_adFreqGate') < 0);
  // 纠正后契约：频控只作用于「被动自动插播」；玩家主动点的按钮广告不做冷却（避免挡复活/开箱/翻倍）
  ok('不再有任何「广告冷却中」拒绝 toast（按钮位已撤）', !/_toast\('广告冷却中，稍后再看'\)/.test(src));
  ok('主动位·能量仍不进 _adFreqGate（豁免）', seg.indexOf('_adFreqGate') < 0);
  // P2 广告优化（2026-11-01）：gate 拦截时 key 顺延不沉没（回写 _drawRewardKey），
  // 频控本身仍保留——断言升级为「拦截 + 回写」双语义
  ok('被动自动插播·频控保留且拦截时 key 顺延不沉没',
    /if \(!this\._adFreqGate\(\)\)\s*\{[\s\S]{0,240}_drawRewardKey = adKey/.test(src));
  ok('_adFreqGate 只被被动自动插播调用（this. 调用共1处）', (src.match(/this\._adFreqGate\(\)/g) || []).length === 1);
}

console.log('\n════════════════════════════');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);