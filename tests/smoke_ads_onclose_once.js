// 烟雾测试：广告实例单例 & onClose 单次绑定 & 展示中叠加 show 被忽略
// 守护：ensureAd 同一 id 只调用一次 wx.createRewardedVideoAd、只注册一次 onClose；
//      同广告位展示进行中（_busy）的叠加 show 被忽略，不再触发 ad.show()（避免原生视图建删风暴）。
//
// 注意：global.setTimeout 必须置为 no-op（不触发 fn）。
//   ads.js 的 loadTimeout(10s) / retryDelay(1s) 都走 setTimeout；若让其同步/延迟触发，
//   加载超时会立即走满 2 次重试链，导致每个 show 被级联调用多次 ad.show()，污染 showCount。
//   置 no-op 后：超时/重试永不触发，广告的 show→onClose 生命周期由 mock 的 ad.show() 驱动，
//   预创建改由首次 show 时的 ensureAd() 完成（等价单例），不影响单例/onClose 绑定断言。
const realSetTimeout = setTimeout;
global.setTimeout = () => 0;

let createCount = 0;   // wx.createRewardedVideoAd 调用次数
let onCloseCount = 0;  // ad.onClose 注册次数（应 == createCount，证明每实例只绑一次）
let showCount = 0;     // ad.show 调用次数
let autoClose = true;  // show 是否自动触发 onClose（模拟"看完"）

function makeAd(adUnitId) {
  let onCloseCb = null;
  return {
    _unit: adUnitId,
    onError: () => {},
    onClose: (cb) => { onCloseCount++; onCloseCb = cb; },
    load: () => Promise.resolve(),
    show: () => {
      showCount++;
      if (autoClose && onCloseCb) onCloseCb({ isEnded: true });
      return Promise.resolve();
    }
  };
}
global.wx = {
  createRewardedVideoAd: (opts) => {
    createCount++;
    return makeAd(opts.adUnitId);
  }
};

const { Rewarded } = require('../src/ads.js');
const flush = () => new Promise((r) => realSetTimeout(r, 0));

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

(async () => {
  // 初始化默认位 A（setTimeout 为 no-op，preload 不触发；首次 show 时由 ensureAd 完成单例创建）
  Rewarded.init({ adUnitId: 'A' });

  // 多次 show('A')：确保 ensureAd 被反复进入，但只建一次实例、只绑一次 onClose
  let rewardA = 0;
  for (let i = 0; i < 3; i++) {
    Rewarded.show({ adUnitId: 'A', onReward: () => { rewardA++; }, onFail: () => {} });
    await flush;
  }
  ok('init 设置默认位，且同 id 只创建 1 个激励视频实例', createCount === 1);
  ok('同 id 只注册 1 次 onClose（无重复绑定）', onCloseCount === createCount);
  ok('A 看完触发 onReward', rewardA === 3);

  // 叠加 show 守卫：自动关广告关闭，使 _busy 保持 true，验证第二次 show 被忽略
  autoClose = false;
  let failB = 0, rewardB = 0;
  Rewarded.show({ adUnitId: 'B', onReward: () => { rewardB++; }, onFail: () => { failB++; } });
  await flush;
  const shownOnce = showCount;
  // 展示进行中（_busy=true，因 autoClose=false 永不结算）立刻再 show → 应被忽略（不调 ad.show）
  Rewarded.show({ adUnitId: 'B', onReward: () => { rewardB++; }, onFail: () => { failB++; } });
  await flush;
  ok('展示进行中叠加 show 被忽略（不重复 ad.show）', showCount === shownOnce);
  ok('叠加 show 走 onFail 兜底（不卡死）', failB === 1);
  ok('B 未看完不触发 onReward', rewardB === 0);

  console.log(`\n[ads-onclose-once] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
