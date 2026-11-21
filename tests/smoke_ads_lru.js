// 烟雾测试：激励视频实例数上限 + LRU 回收（防微信「实例过多」告警）
//
// 背景（真机 iOS 3.17.2 实测，2026-09-12/13 控制台导出）：
//   游戏 7 个激励位（默认/能量/宝箱/抽卡3/6/9/随机）全部 multiton:true，
//   玩家一场用到多个位即触发微信告警：
//     「系统检测到您创建的激励视频广告实例过多，由于您当前使用的是多例模式，
//       为避免影响小游戏性能，请减少实例创建数量或调用 destroy 方法销毁无用的实例」
//
// 根因：destroy 为异步，evict（同 tick 内 _evictIfNeeded 先 destroy 一个）与 create 新位发生在同一帧，
//       SDK 在 destroy 生效前仍把旧实例计入存活 -> 瞬态峰值 = cap+1。cap=5 时瞬达 6 -> 触发告警。
//
// 修复（本版）：
//   - maxInstances: 5 -> 3（瞬态峰值封顶 4，低于触发阈值）；
//   - init 预创建数量上限 = maxInstances - 1（预留空位给正在展示的位，避免刚预满就 evict 默认兜底位抖动）；
//   - 被回收的低频位下次 show 懒重建，高频位（默认/能量）因 lastUsed 常新而少被回收。
//
// 覆盖场景：
//   A. CAP 个位（=上限）不回收；第 CAP+1 个位触发 LRU，销毁最久未用者；
//   B. 被回收位下次 show 懒重建，重建时再次回收（稳态封顶）；
//   C. 展示中（busy）的位不可回收，跳过选次旧者；
//   D. SDK 强制单例（多 entry 共享同一组件）时不销毁；
//   E. 【新增·抖动门禁】连续展示全部 7 个不同位：实例总数始终 <= CAP、destroy 次数 == 必要最小值
//      （= 不同位数 - CAP）、无冗余 create、无 over-cap 瞬态 —— 即「连续展示不同位不触发 evict 抖动告警」。
//
// 注意：global.setTimeout 置 no-op（预创建 3s/5.5s/8s 不触发，全走懒创建同步断言）；
//       Date.now 换成递增假时钟，保证 lastUsed 严格递增 -> LRU 顺序确定；
//       CAP 从 getStats().maxInstances 读取，与 STATE.config.maxInstances 单一来源对齐（改 cap 无需改测试）。
const realSetTimeout = setTimeout;
global.setTimeout = () => 0;
let clock = 1000;
const realDateNow = Date.now;
Date.now = () => ++clock;

let mode = 'multiton';          // 'multiton' | 'singleton'
let createCalls = [];           // 每次 createRewardedVideoAd 的 { adUnitId, multiton }
let destroyCalls = 0;
let destroyedUnits = [];
let bindOnClose = 0;
let bindOnError = 0;
let autoClose = false;
const pool = {};                // multiton：每 id 一个（复用）实例
const shared = { ad: null };    // singleton：全局唯一实例

function makeAd(adUnitId) {
  let onCloseCb = null;
  return {
    _unit: adUnitId,
    onError: () => { bindOnError++; },
    onClose: (cb) => { bindOnClose++; onCloseCb = cb; },
    load: () => Promise.resolve(),
    show: () => {
      if (autoClose && onCloseCb) onCloseCb({ isEnded: true });
      return Promise.resolve();
    },
    destroy: () => { destroyCalls++; destroyedUnits.push(adUnitId); }
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
const resetMocks = () => {
  createCalls = []; destroyCalls = 0; destroyedUnits = [];
  bindOnClose = 0; bindOnError = 0;
  for (const k of Object.keys(pool)) delete pool[k];
  shared.ad = null;
};

// 单一来源：从 getStats 读 maxInstances，与 STATE.config.maxInstances 对齐
const CAP = loadAds().Rewarded.getStats().maxInstances;

(async () => {
  // ---------- 场景 A：CAP 个位（=上限）不回收，第 CAP+1 个触发 LRU ----------
  let { Rewarded } = loadAds();
  const units = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
  autoClose = true;
  let reward = 0;
  for (const u of units.slice(0, CAP)) {
    Rewarded.show({ adUnitId: u, onReward: () => { reward++; }, onFail: () => {} });
    await flush;
  }
  ok(`前 ${CAP} 个位（=上限 maxInstances）不触发回收`, destroyCalls === 0 && createCalls.length === CAP);
  ok(`${CAP} 个位各自独立实例、正常发奖`, reward === CAP && Rewarded.getStats().adUnitCount === CAP);

  Rewarded.show({ adUnitId: units[CAP], onReward: () => {}, onFail: () => {} });
  await flush;
  ok(`第 ${CAP + 1} 个位创建前触发回收：destroy 调用 1 次`, destroyCalls === 1 && createCalls.length === CAP + 1);
  ok('回收的是最久未使用的 A 位（LRU）', destroyedUnits[0] === 'A');
  ok('实例总数封顶（adUnitCount=CAP，不再超限）', Rewarded.getStats().adUnitCount === CAP);
  ok('stats.evicted 计数 +1', Rewarded.getStats().evicted === 1);

  // ---------- 场景 B：被回收位懒重建，稳态下重建再次回收（保持封顶） ----------
  const before = destroyCalls;
  Rewarded.show({ adUnitId: 'A', onReward: () => {}, onFail: () => {} });
  await flush;
  ok('被回收的 A 位下次 show 懒重建（重新 create）', createCalls.length === CAP + 2);
  ok('重建时再次回收当前最久未用的 B（稳态封顶）', destroyCalls === before + 1 && destroyedUnits[1] === 'B');

  // ---------- 场景 C：展示中（busy）的位不可回收，跳过选次旧者 ----------
  resetMocks();
  const ads2 = loadAds();
  Rewarded = ads2.Rewarded;
  autoClose = false; // A 展示中：_busy/pending 挂起，不结算
  Rewarded.show({ adUnitId: 'A', onReward: () => {}, onFail: () => {} });
  await flush;
  autoClose = true;
  for (const u of ['B', 'C', 'D']) {
    Rewarded.show({ adUnitId: u, onReward: () => {}, onFail: () => {} });
    await flush;
  }
  Rewarded.show({ adUnitId: 'E', onReward: () => {}, onFail: () => {} });
  await flush;
  ok('展示中的 A 不被回收（busy 守卫）', destroyedUnits.indexOf('A') === -1);
  ok('跳过 busy 的 A，回收次旧的 B（cap=3 下 D、E 各触发一次回收，共 2 次）', destroyedUnits[0] === 'B' && destroyCalls === 2);
  ok('回收后实例仍封顶（adUnitCount=CAP）', Rewarded.getStats().adUnitCount === CAP);

  // ---------- 场景 D：SDK 强制单例（共享组件）时不销毁 ----------
  resetMocks();
  mode = 'singleton';
  autoClose = true;
  const ads3 = loadAds();
  Rewarded = ads3.Rewarded;
  for (const u of units) {
    Rewarded.show({ adUnitId: u, onReward: () => {}, onFail: () => {} });
    await flush;
  }
  ok('单例模式 7 个位全登记但组件仅 1 个（onClose/onError 各只绑 1 次）', Rewarded.getStats().adUnitCount === 7 && bindOnClose === 1 && bindOnError === 1);
  ok('共享实例绝不销毁（销毁会导致重绑告警）', destroyCalls === 0);

  // ---------- 场景 E【抖动门禁】：连续展示全部 7 个不同位，实例峰值不破 CAP、destroy 仅必要值 ----------
  resetMocks();
  mode = 'multiton';
  autoClose = true;
  const ads4 = loadAds();
  Rewarded = ads4.Rewarded;
  let peakLive = 0;
  for (const u of units) {
    Rewarded.show({ adUnitId: u, onReward: () => {}, onFail: () => {} });
    await flush;
    const live = Rewarded.getStats().adUnitCount;
    if (live > peakLive) peakLive = live;
    // 每个展示瞬间实例数都不允许超过 CAP（即无 over-cap 瞬态，对应 SDK 峰值封顶）
    if (live > CAP) { ok(`展示 ${u} 时实例数越界（live=${live} > CAP=${CAP}）`, false); }
  }
  ok('连续展示不同位期间实例峰值始终 <= CAP（无 over-cap 瞬态）', peakLive <= CAP);
  ok(`destroy 次数 == 必要最小值（不同位 ${units.length} - CAP ${CAP} = ${units.length - CAP}）`, destroyCalls === units.length - CAP);
  ok('无冗余 create（每个不同位只建一次，共 ' + units.length + ' 次）', createCalls.length === units.length);
  ok('稳态实例数封顶（最终 adUnitCount=CAP）', Rewarded.getStats().adUnitCount === CAP);

  console.log(`\n[ads-lru] ${pass} passed, ${fail} failed  (CAP=${CAP})`);
  Date.now = realDateNow;
  process.exit(fail ? 1 : 0);
})();
