// 烟雾测试：首页插屏（2026-10-02 新增，key='home'；2026-11-08 弹点迁移：结算返回首页，废弃启动即弹）
// 验证：① Interstitial 模块对 home key 的 init/canShow/show 路由；
//      ② 改进后 show 走 load→show 兜底（冷创建不再被 SDK 拒）；
//      ③ 未配置/占位 ID → 静默跳过（不弹、不报错）；
//      ④ main.js 已接线（Interstitial.init({home}) + 结算 battle_back 触发 _maybeShowHomeInterstitial，
//         且开场结束处不再触发）源码门禁。
const path = require('path');
const fs = require('fs');
const realSetTimeout = setTimeout;
global.setTimeout = (fn) => { try { fn(); } catch (e) {} return 0; };

let createdIds = [];
let lastShownId = null;
let loadCalls = 0;
function makeAd(adUnitId) {
  createdIds.push(adUnitId);
  return {
    _id: adUnitId,
    onError: () => {},
    onClose: () => {},
    load: () => { loadCalls++; return Promise.resolve(); },
    show: () => { lastShownId = adUnitId; return Promise.resolve(); }
  };
}
global.wx = { createInterstitialAd: (opts) => makeAd(opts.adUnitId) };

const { Interstitial } = require('../src/ads.js');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}
const flush = () => new Promise((r) => realSetTimeout(r, 0));

(async () => {
  // ---- 1) home key 路由 + load→show 兜底 ----
  createdIds = []; loadCalls = 0; lastShownId = null;
  Interstitial.init({ home: 'IH' });
  ok('init 预创建 home 插屏位', createdIds.length === 1 && createdIds[0] === 'IH');
  ok('home 位可展示(canShow)', Interstitial.canShow('home') === true);

  let shown = false;
  Interstitial.show({ key: 'home', onShown: () => { shown = true; }, onSkip: () => {} });
  await flush();
  ok('home 展示用对应位 IH', lastShownId === 'IH');
  ok('home onShown 触发', shown === true);
  ok('show 前先 load（load→show 兜底）', loadCalls >= 1);

  // ---- 2) 未配置/占位 ID → 静默跳过 ----
  createdIds = []; lastShownId = null;
  Interstitial.init({ home: '' });                 // 空串：等同未配置
  ok('空串 ID 不可展示(canShow)', Interstitial.canShow('home') === false);
  let skipped = false;
  Interstitial.show({ key: 'home', onShown: () => {}, onSkip: () => { skipped = true; } });
  await flush();
  ok('空串 ID 走 onSkip（静默跳过，不报错）', skipped === true);
  ok('空串 ID 未创建组件', createdIds.length === 0);

  // ---- 3) main.js 接线源码门禁 ----
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
    // P2 注入优化（2026-11-01）：ads 改懒 require（ensureAds 在 loop frame≥2 执行），
  // 门禁改为断言「惰性加载器存在 + 广告 init 已延到首帧空闲（_pendingAdsInit）」
  ok('main.js 懒 require ads（ensureAds 加载器）',
     /function ensureAds\(\)\s*\{[\s\S]*?require\('\.\/ads'\)/.test(mainSrc));
  ok('main.js 广告 init 已延到首帧空闲（_pendingAdsInit + ensureAds）',
     /_pendingAdsInit\s*=\s*true/.test(mainSrc) &&
     /if \(this\._pendingAdsInit[\s\S]{0,120}ensureAds\(\);/.test(mainSrc));
  ok('main.js 调 Interstitial.init({ home: CONFIG.homeInterstitialAdUnitId })',
     /Interstitial\.init\(\{\s*home:\s*CONFIG\.homeInterstitialAdUnitId\s*\}\)/.test(mainSrc));
  ok('main.js 结算返回首页(battle_back)触发 _maybeShowHomeInterstitial（弹点迁移 2026-11-08）',
     /a === 'battle_back'[\s\S]{0,200}this\._maybeShowHomeInterstitial\(\)/.test(mainSrc));
  ok('main.js 开场结束处已不再触发（启动即弹废弃）',
     !/this\._introDone\s*=\s*true;\s*this\._maybeShowHomeInterstitial\(\)/.test(mainSrc));
  ok('main.js 定义 _maybeShowHomeInterstitial 方法',
     /_maybeShowHomeInterstitial\(\)\s*\{[\s\S]*?Interstitial\.show\(\{\s*key:\s*'home'/.test(mainSrc));
  ok('main.js 守卫 _homeInterstitialTried（一次/冷启动）',
     /this\._homeInterstitialTried\s*=\s*false/.test(mainSrc) && /if\s*\(this\._homeInterstitialTried\)\s*return;/.test(mainSrc));
  ok('main.js 先过门控 canShowHomeInterstitial 再展示',
     /if\s*\(!this\.game\.canShowHomeInterstitial\(\)\)\s*return;/.test(mainSrc));
  ok('main.js 展示成功记当日次数 markHomeInterstitialShown',
     /onShown:\s*\(\)\s*=>\s*\{\s*this\.game\.markHomeInterstitialShown\(\)/.test(mainSrc));

  // ---- 4) 门控逻辑（真实 GameState 单元验证）：首日不弹 + 每日上限 2 次 + 跨日重置 ----
  const { GameState } = require(path.join(__dirname, '..', 'src', 'game.js'));
  const g = new GameState();
  ok('门控·首次启动不弹（记录安装日）', g.canShowHomeInterstitial() === false);
  ok('门控·已记录安装日(非空)', typeof g.homeInterInstallDate === 'string' && g.homeInterInstallDate !== '');
  ok('门控·安装当天仍不弹', g.canShowHomeInterstitial() === false);
  // 模拟跨过首日：安装日改昨天
  g.homeInterInstallDate = g._dayKeyOffset(-1);
  ok('门控·过首日后当日第1次允许', g.canShowHomeInterstitial() === true);
  g.markHomeInterstitialShown();
  ok('门控·当日第2次允许', g.canShowHomeInterstitial() === true);
  g.markHomeInterstitialShown();
  ok('门控·当日第3次达上限2→不弹', g.canShowHomeInterstitial() === false);
  // 模拟跨日：每日计数日期改昨天 → 重置
  g.homeInterAdDate = g._dayKeyOffset(-1);
  ok('门控·跨日计数重置→又允许', g.canShowHomeInterstitial() === true);

  console.log(`\n[interstitial-home] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
