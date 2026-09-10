// 烟雾测试：抽卡插屏拆 4 个独立位（draw3/draw6/draw9/rand2）
// 验证：init 预创建 4 位；show({key}) 用对应位实例；未知 key 走 onSkip；
//       shouldScheduleDrawInterstitial 按抽数返回正确 key（里程碑必弹 + 逢2随机）。
const path = require('path');
const realSetTimeout = setTimeout;
// 让所有 setTimeout 立即执行，便于同步断言（本测试独立进程，无副作用）
global.setTimeout = (fn) => { try { fn(); } catch (e) {} return 0; };

let createdIds = [];
let lastShownId = null;
function makeAd(adUnitId) {
  createdIds.push(adUnitId);
  return {
    _id: adUnitId,
    onError: () => {},
    onClose: () => {},
    load: () => Promise.resolve(),
    show: () => { lastShownId = adUnitId; return Promise.resolve(); }
  };
}
global.wx = {
  createInterstitialAd: (opts) => makeAd(opts.adUnitId)
};

const { Interstitial } = require('../src/ads.js');
const { GameState } = require(path.join(__dirname, '..', 'src', 'game.js'));

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}
const flush = () => new Promise((r) => realSetTimeout(r, 0));

(async () => {
  // ---- 1) Interstitial 多实例（ads.js）----
  createdIds = [];
  Interstitial.init({ draw3: 'I3', draw6: 'I6', draw9: 'I9', rand2: 'IR' });
  ok('init 预创建 4 个插屏位', createdIds.length === 4);

  ok('draw3 位可展示(canShow)', Interstitial.canShow('draw3') === true);
  ok('draw9 位可展示(canShow)', Interstitial.canShow('draw9') === true);
  ok('未配置的 key 不可展示', Interstitial.canShow('drawX') === false);

  // 4 个位各自创建时绑定正确 ID：draw3→I3 / draw6→I6 / draw9→I9 / rand2→IR
  ok('4 个位分别绑定各自 ID', createdIds.join(',') === 'I3,I6,I9,IR');

  // 展示 draw3 → 用 I3 实例（验证 show(key) 的路由机制）
  lastShownId = null;
  let shown3 = false;
  Interstitial.show({ key: 'draw3', onShown: () => { shown3 = true; }, onSkip: () => {} });
  await flush;
  ok('draw3 展示用对应位 I3', lastShownId === 'I3');
  ok('draw3 onShown 触发', shown3 === true);

  // 注：平台有 60s 最小间隔，单次测试进程内只能真正展示一次；其余位（draw6/draw9/rand2）
  // 的「key→ID」映射已由上面的 createdIds 顺序断言覆盖，show 路由机制已由 draw3 验证。

  // 未知 key → onSkip（静默跳过，不报错）
  let skipped = false;
  Interstitial.show({ key: 'drawX', onShown: () => {}, onSkip: () => { skipped = true; } });
  await flush;
  ok('未知 key 走 onSkip（静默跳过）', skipped === true);

  // ---- 2) 调度映射（game.js，纯规则）----
  const g = new GameState();
  const cases = [
    [3, 'draw3'], [6, 'draw6'], [9, 'draw9'],
    [12, 'draw6'], [15, 'draw3'], [18, 'draw9'],   // 超过9抽按模循环复用
    [1, null], [5, null], [7, null], [0, null]      // 奇数/0 不弹
  ];
  for (const [n, expect] of cases) {
    g.drawsSinceAd = n;
    const r = g.shouldScheduleDrawInterstitial();
    ok('抽数 ' + n + ' → ' + (expect || 'null'), r === expect);
  }
  // rand2：逢2的倍数随机（概率 0.5）
  const origRandom = Math.random;
  Math.random = () => 0.0;  // 命中随机分支
  g.drawsSinceAd = 2; ok('抽数 2（偶·随机命中）→ rand2', g.shouldScheduleDrawInterstitial() === 'rand2');
  g.drawsSinceAd = 4; ok('抽数 4（偶·随机命中）→ rand2', g.shouldScheduleDrawInterstitial() === 'rand2');
  Math.random = () => 0.99; // 未命中
  g.drawsSinceAd = 2; ok('抽数 2（偶·随机未命中）→ null', g.shouldScheduleDrawInterstitial() === null);
  Math.random = origRandom;

  console.log(`\n[interstitial-multi] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
