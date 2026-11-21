// 烟雾测试：多广告位支持（宝箱 adunit-9d11e5b028812190 / 能量 adunit-af16958aaf84edbf 均独立）
// 验证：init 预创建默认位+宝箱位+能量位；show({adUnitId:'X'}) 只调用 X 实例、不连坐其他位；
//       某位连续失败只禁用自己、不影响其他位。
const realSetTimeout = setTimeout;
// 让所有 setTimeout 立即执行，便于同步断言（本测试独立进程，无副作用）
global.setTimeout = (fn) => { try { fn(); } catch (e) {} return 0; };

const created = {};
let lastShowUnit = null;
function makeAd(adUnitId) {
  let onCloseCb = null;
  return {
    _unit: adUnitId,
    onError: () => {},
    onClose: (cb) => { onCloseCb = cb; },
    load: () => Promise.resolve(),
    show: () => {
      lastShowUnit = adUnitId;
      if (onCloseCb) onCloseCb({ isEnded: true });
      return Promise.resolve();
    }
  };
}
global.wx = {
  createRewardedVideoAd: (opts) => {
    const id = opts.adUnitId;
    if (!created[id]) created[id] = makeAd(id);
    return created[id];
  }
};

const { Rewarded } = require('../src/ads.js');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}
const flush = () => new Promise((r) => realSetTimeout(r, 0));

(async () => {
  // 初始化：默认位 AD_A + 宝箱位 AD_B + 能量位 AD_C
  Rewarded.init({ adUnitId: 'AD_A', chestAdUnitId: 'AD_B', energyAdUnitId: 'AD_C' });
  // 预创建上限 = maxInstances - 1：预留 >=1 空位给正在展示的位，避免刚预满就 evict 默认兜底位抖动；
  // 余下的低频位（此处宝箱 AD_B）由首次 show 懒建兜底。
  const preloadN = Rewarded.getStats().maxInstances - 1;
  ok('init 预创建 maxInstances-1 个广告位（预留空位防 evict 抖动）', Rewarded.getStats().adUnitCount === preloadN);

  // 宝箱位使用独立广告位 AD_B
  let bReward = false;
  Rewarded.show({ adUnitId: 'AD_B', onReward: () => { bReward = true; }, onFail: () => {} });
  await flush;
  ok('宝箱位调用的是 AD_B 实例', lastShowUnit === 'AD_B');
  ok('未预建的宝箱位 AD_B 在首次 show 时懒建（adUnitCount=预建+1）', Rewarded.getStats().adUnitCount === preloadN + 1);
  ok('宝箱位看完触发 onReward', bReward === true);

  // 能量位使用独立广告位 AD_C
  let cReward = false;
  Rewarded.show({ adUnitId: 'AD_C', onReward: () => { cReward = true; }, onFail: () => {} });
  await flush;
  ok('能量位调用的是 AD_C 实例', lastShowUnit === 'AD_C');
  ok('能量位看完触发 onReward', cReward === true);

  // 默认位（复活）仍用 AD_A，互不干扰
  let aReward = false;
  Rewarded.show({ onReward: () => { aReward = true; }, onFail: () => {} });
  await flush;
  ok('默认位调用的是 AD_A 实例', lastShowUnit === 'AD_A');
  ok('默认位看完触发 onReward', aReward === true);

  // 隔离性：宝箱位 AD_B 连续失败，应只禁用 B、不影响 A
  const bAd = created['AD_B'];
  bAd.show = () => { lastShowUnit = 'AD_B'; throw new Error('component not ready'); };
  let bFail = 0;
  for (let i = 0; i < 3; i++) {
    Rewarded.show({ adUnitId: 'AD_B', onReward: () => {}, onFail: () => { bFail++; } });
    await flush;
  }
  ok('宝箱位失败被记录', bFail >= 1);
  ok('宝箱位失败后默认位 AD_A 仍可用（隔离，未连坐）', Rewarded.getStats().adAvailable === true);

  console.log(`\n[ads-multiunit] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
