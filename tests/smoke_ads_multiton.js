// 烟雾测试：多广告位必须开启 multiton（多例模式） + SDK 强制单例时的兜底
//
// 背景（真机 Android 基础库 3.17.2 实测）：
//   小游戏端 wx.createRewardedVideoAd 默认是「全局单例」——不同 adUnitId 调多次，
//   返回的其实是同一个组件对象。表现为微信告警：
//     「激励视频广告组件检测到您绑定了多次 onError / onClose 事件」
//   同时各广告位 pending/_busy/settled 各存一份、互不共享 → 「展示中不可再 show」守卫失效。
//
// 本套件用两种 mock 覆盖：
//   场景 A（multiton 生效）：每个 adUnitId 拿到独立实例 → 各自绑定 1 次、互不干扰；
//                            且必须校验创建时传了 multiton:true。
//   场景 B（SDK 强制单例）：忽略 multiton 仍返回同一实例 → 事件只绑定 1 次，
//                            三个 key 共享同一 entry，A 展示中时 B 的 show 也必须被忽略。
//
// 注意：global.setTimeout 置为 no-op（不触发 fn）。
//   ads.js 的预创建(3s/5.5s/8s)、loadTimeout(10s)、retryDelay(1s) 都走 setTimeout；
//   置 no-op 后预创建不触发，改由首次 show 时的 ensureAd() 懒创建，便于同步断言。
const realSetTimeout = setTimeout;
global.setTimeout = () => 0;

let mode = 'multiton';       // 'multiton' | 'singleton'
let createCalls = [];        // { adUnitId, multiton }
let bindOnClose = 0;
let bindOnError = 0;
let showCount = 0;
let autoClose = false;
let lastShowUnit = null;
let pool = {};               // 场景 A：每 id 一个实例
const shared = {};           // 场景 B：全局唯一实例

function makeAd(adUnitId) {
  let onCloseCb = null;
  return {
    _unit: adUnitId,
    onError: () => { bindOnError++; },
    onClose: (cb) => { bindOnClose++; onCloseCb = cb; },
    load: () => Promise.resolve(),
    show: () => {
      showCount++;
      lastShowUnit = adUnitId;
      if (autoClose && onCloseCb) onCloseCb({ isEnded: true });
      return Promise.resolve();
    }
  };
}

global.wx = {
  createRewardedVideoAd: (opts) => {
    createCalls.push({ adUnitId: opts.adUnitId, multiton: opts.multiton });
    if (mode === 'singleton') {
      if (!shared.ad) shared.ad = makeAd(opts.adUnitId);
      return shared.ad;
    }
    if (!pool[opts.adUnitId]) pool[opts.adUnitId] = makeAd(opts.adUnitId);
    return pool[opts.adUnitId];
  }
};

function loadAds() {
  delete require.cache[require.resolve('../src/ads.js')];
  return require('../src/ads.js');
}

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}
const flush = () => new Promise((r) => realSetTimeout(r, 0));

(async () => {
  // ---------- 场景 A：multiton 生效（每 id 独立实例）----------
  let { Rewarded } = loadAds();
  Rewarded.init({ adUnitId: 'A', chestAdUnitId: 'B', energyAdUnitId: 'C' });

  autoClose = true;
  let reward = 0, failed = 0;
  Rewarded.show({ adUnitId: 'A', onReward: () => { reward++; }, onFail: () => { failed++; } });
  await flush;
  ok('创建时传入 multiton:true（否则小游戏端是全局单例）', createCalls.length === 1 && createCalls[0].multiton === true);
  ok('A 位创建用的是 A 的 adUnitId', createCalls[0].adUnitId === 'A');
  ok('A 看完发奖', reward === 1 && lastShowUnit === 'A');

  Rewarded.show({ adUnitId: 'B', onReward: () => { reward++; }, onFail: () => { failed++; } });
  await flush;
  Rewarded.show({ adUnitId: 'C', onReward: () => { reward++; }, onFail: () => { failed++; } });
  await flush;
  ok('3 个广告位各创建 1 个实例', createCalls.length === 3);
  ok('onClose 绑定次数 == 实例数（无重复绑定）', bindOnClose === 3);
  ok('onError 绑定次数 == 实例数（无重复绑定）', bindOnError === 3);
  ok('B/C 位分别命中各自实例', lastShowUnit === 'C' && reward === 3);

  // ---------- 场景 B：SDK 强制单例（忽略 multiton，仍返回同一实例）----------
  mode = 'singleton';
  createCalls = []; bindOnClose = 0; bindOnError = 0; showCount = 0;
  pool = {}; shared.ad = null; lastShowUnit = null;
  const ads2 = loadAds();
  Rewarded = ads2.Rewarded;
  Rewarded.init({ adUnitId: 'A', chestAdUnitId: 'B', energyAdUnitId: 'C' });

  autoClose = true;
  reward = 0;
  Rewarded.show({ adUnitId: 'A', onReward: () => { reward++; }, onFail: () => {} });
  await flush;
  Rewarded.show({ adUnitId: 'B', onReward: () => { reward++; }, onFail: () => {} });
  await flush;
  Rewarded.show({ adUnitId: 'C', onReward: () => { reward++; }, onFail: () => {} });
  await flush;
  ok('单例模式下 3 个位都登记了（adUnitCount=3）', Rewarded.getStats().adUnitCount === 3);
  ok('组件实例只创建 1 个（SDK 单例）', Object.keys(pool).length === 0 && createCalls.length === 3);
  ok('onClose 只绑定 1 次（不重复绑定，消除微信告警）', bindOnClose === 1);
  ok('onError 只绑定 1 次', bindOnError === 1);
  ok('单例模式下仍正常发奖（不因去重丢奖）', reward === 3);

  // 展示中叠加 show 守卫：A 展示中（autoClose=false），B 的 show 必须被忽略
  autoClose = false;
  let bFail = 0;
  showCount = 0;
  Rewarded.show({ adUnitId: 'A', onReward: () => {}, onFail: () => {} });
  await flush;
  const shownOnce = showCount;
  Rewarded.show({ adUnitId: 'B', onReward: () => {}, onFail: () => { bFail++; } });
  await flush;
  ok('单例共享 entry：A 展示中时 B 的 show 被忽略（不叠加 show）', showCount === shownOnce);
  ok('被忽略的 B 走 onFail 兜底（不卡死）', bFail === 1);

  console.log(`\n[ads-multiton] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
