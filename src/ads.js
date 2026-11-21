/**
 * 激励视频广告封装（打磨版 + 降级方案）
 * - 微信真机 + 占位广告位：不再直接发奖，Toast 提醒开发者先配置ID
 * - 浏览器 / 无广告环境：模拟 1.2s 播放后发奖（仅用于本地调试）
 * - 加载失败走 onFail（UI 提示"广告暂不可用"，不消耗次数）
 * - 广告加载超时处理（10秒超时）
 * - 广告加载重试机制（最多2次）
 * - 广告不可用时的降级方案
 * - 广告加载状态统计
 *
 * 【真机实测修正 · Android 3.17.2】多广告位必须显式开启 multiton（多例模式）：
 *   小游戏端 wx.createRewardedVideoAd 默认是「全局单例」——不同 adUnitId 调多次，
 *   返回的其实是同一个组件对象。不处理会有三个后果：
 *     ① 微信告警「激励视频广告组件检测到您绑定了多次 onError/onClose 事件」
 *     ② 一次广告关闭触发 N 个 onClose 回调，各广告位 pending/settled 状态串台
 *     ③ 各 entry 各自持有 _busy，「展示中不可再 show」的守卫对同一实例失效 → 叠加展示
 *   故创建时传 multiton:true（基础库 2.8.0+ 支持），并在创建后按「实例身份」二次去重，
 *   保证即使 SDK 仍返回同一实例，也只绑定一次事件、共享同一份状态。
 */

const STATE = {
  adUnitId: '',  // 默认激励视频位（见 src/config.js 的 CONFIG.adUnitId）；真实值由 main.js 的 Rewarded.init 注入
  inited: false, // init 幂等守卫：避免重复 init 重复预创建/重复绑定 onClose
  // 多广告位支持：每个 adUnitId 一个独立实例与独立状态（pending/settled/可用/连续失败），
  // 避免"宝箱广告位失败"连坐"复活广告位"（它们分属不同位、不同填充率）。
  ads: {},       // adUnitId -> { ad, pending, settled, available, consecFails }
  // 广告加载状态统计（全局累计，便于埋点）
  stats: {
    totalShow: 0,
    success: 0,
    failed: 0,
    timeout: 0,
    retries: 0,
    evicted: 0 // LRU 回收的实例数（超出 maxInstances 时销毁最久未用实例）
  },
  // 广告加载配置
  config: {
    maxRetry: 2,        // 最大重试次数
    loadTimeout: 10000, // 加载超时（毫秒）
    retryDelay: 1000,   // 重试间隔（毫秒）
    // 激励视频实例并发上限：本游戏共 7 个激励位（默认/能量/宝箱/抽卡3/6/9/随机）。
    // 微信对多例模式会告警「激励视频广告实例过多」（真机 iOS 3.17.2 实测 cap=5 时峰值瞬达 6 个实例即触发）。
    // 实测结论：destroy 为异步，evict 与 create 同 tick 时 SDK 瞬间仍按 cap+1 计数 —— 故把 cap 压到 3，
    // 使 SDK 峰值瞬态封顶在 4（远低于触发阈值）。LRU 在超限时销毁最久未用的空闲实例（见 _evictIfNeeded），
    // 被回收位下次 show 懒重建；高频位（默认/能量）因 lastUsed 常新而少被回收，抖动集中在低频抽卡位。
    maxInstances: 3
  },
  maxConsecutiveFailures: 3, // 单个广告位连续失败超过此数，临时禁用5分钟
  // 预创建节奏（串行错峰）：默认位 3s → 下一位 +2.5s → 再下一位 +2.5s。
  // 真机实测：同一 tick 内连创 3 个激励组件 = 3 个并发广告拉取，会顶住 JS 线程、
  // 把首帧与总启动耗时推高（并一次性堆出十几个 LifeCycle:Show 监听器）。
  preloadDelay: 3000,
  preloadStep: 2500
};

function isPlaceholderUnit(id) {
  return !id || /^adunit-0+$/.test(id);
}
function isPlaceholderId() { return isPlaceholderUnit(STATE.adUnitId); }

function _toast(msg) {
  try {
    if (typeof wx !== 'undefined' && wx.showToast) {
      wx.showToast({ title: msg, icon: 'none', duration: 1800 });
    }
  } catch (e) {}
}

/**
 * 标记某广告位失败，该位连续失败超过阈值时临时禁用
 */
function _markAdFailed(entry) {
  STATE.stats.failed++;
  if (entry) {
    entry.consecFails++;
    if (entry.consecFails >= STATE.maxConsecutiveFailures) {
      entry.available = false;
      console.warn(`[ad] 广告位连续失败${entry.consecFails}次，暂时不可用，5分钟后重试`);
      // 5分钟后重置，允许再次尝试
      setTimeout(() => {
        entry.available = true;
        entry.consecFails = 0;
        console.log('[ad] 广告位可用性已重置');
      }, 5 * 60 * 1000);
    }
  }
}

/**
 * 标记某广告位成功，重置其连续失败计数
 */
function _markAdSuccess(entry) {
  if (entry) entry.consecFails = 0;
  STATE.stats.success++;
}

/**
 * 按「组件实例身份」反查已登记的 entry。
 * SDK 返回同一实例（多例模式未生效）时用：复用同一 entry，避免重复绑定事件与状态串台。
 */
function _findEntryByAd(ad) {
  const keys = Object.keys(STATE.ads);
  for (let i = 0; i < keys.length; i++) {
    const e = STATE.ads[keys[i]];
    if (e && e.ad === ad) return e;
  }
  return null;
}

/**
 * 实例数上限回收（LRU）：微信对多例模式会告警
 * 「系统检测到您创建的激励视频广告实例过多…请减少实例创建数量或调用 destroy 方法销毁无用的实例」。
 * 超过 STATE.config.maxInstances 时，销毁「最久未使用且空闲」（不在展示中、无 pending）的实例，
 * 并从 STATE.ads 移除映射；被回收的广告位下次 show 时由 ensureAd 懒重建，行为无回归。
 * 注意：SDK 强制单例时（多 entry 共享同一组件实例）跳过销毁——销毁共用组件会导致重绑告警，
 * 且单例本身实例数恒为 1，不会超限。
 */
function _evictIfNeeded() {
  const cap = STATE.config.maxInstances || 5;
  const keys = Object.keys(STATE.ads);
  if (keys.length < cap) return;
  let victimKey = null;
  let oldest = Infinity;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const e = STATE.ads[k];
    if (!e || !e.ad || e._busy || e.pending) continue; // 展示中/待结算的位不可回收
    // 单例兜底：同一组件被多个 entry 共享时不销毁（避免销毁共用实例导致重绑）
    let sharedCount = 0;
    for (let j = 0; j < keys.length; j++) {
      const o = STATE.ads[keys[j]];
      if (o && o.ad === e.ad) sharedCount++;
    }
    if (sharedCount > 1) continue;
    const ts = e.lastUsed || 0; // 预载未用过的位视为最老，优先回收
    if (ts < oldest) { oldest = ts; victimKey = k; }
  }
  if (!victimKey) return; // 全忙：放行本次创建，功能优先，留待下次 show 再回收
  const victim = STATE.ads[victimKey];
  try {
    if (victim && victim.ad && typeof victim.ad.destroy === 'function') victim.ad.destroy();
  } catch (err) {}
  delete STATE.ads[victimKey];
  STATE.stats.evicted = (STATE.stats.evicted || 0) + 1;
}

function ensureAd(adUnitId) {
  if (!adUnitId) adUnitId = STATE.adUnitId;
  if (!adUnitId) return null;
  const existing = STATE.ads[adUnitId];
  if (existing && existing.ad) { existing.lastUsed = Date.now(); return existing; }
  _evictIfNeeded(); // 创建新实例前先回收超限的最久未用实例（防「实例过多」微信告警）
  if (typeof wx === 'undefined' || !wx.createRewardedVideoAd) return null;
  try {
    // multiton:true —— 小游戏端默认是全局单例，不传则多个 adUnitId 共用同一组件，
    // 会导致重复绑定 / 状态串台 / 叠加 show。基础库 2.8.0+ 支持，真机 3.17.2 已满足。
    let ad = null;
    try {
      ad = wx.createRewardedVideoAd({ adUnitId: adUnitId, multiton: true });
    } catch (e) {
      ad = wx.createRewardedVideoAd({ adUnitId: adUnitId }); // 老基础库无 multiton：回退
    }
    if (!ad) return null;

    // 双保险：若 multiton 未生效（SDK 仍返回同一实例），复用已登记 entry——
    // 不重复绑定 onError/onClose，且共享 pending/_busy/settled，守卫继续生效。
    const shared = _findEntryByAd(ad);
    if (shared) {
      STATE.ads[adUnitId] = shared;
      return shared;
    }

    ad.onError((err) => {
      console.warn('[ad] error', adUnitId, err);
      // 广告加载错误统计
      if (err && err.errMsg && /timeout/i.test(err.errMsg)) {
        STATE.stats.timeout++;
      }
    });
    const entry = { ad, pending: null, settled: false, available: true, consecFails: 0, _busy: false, lastUsed: Date.now() };
    ad.onClose((res) => {
      // B：部分基础库 onClose 无参或 isEnded 缺失，未明确中断即算看完，避免"看完却没发奖"
      const ended = !res || res.isEnded !== false;
      const cb = entry.pending;
      entry.pending = null;
      // C：标记已结算，避免 show promise 的 reject 链路在 onClose 之后又触发 onFail（双触发竞态）
      entry.settled = true;
      entry._busy = false; // 展示结束（看完/中途关），释放占用，允许后续 show / 外层 retry 继续
      if (cb) {
        if (ended) {
          _markAdSuccess(entry);
          if (cb.onReward) cb.onReward();
        }
        if (cb.onClose) cb.onClose(ended);
      }
    });
    STATE.ads[adUnitId] = entry;
    return entry;
  } catch (e) { return null; }
}

const Rewarded = {
  /**
   * 初始化广告。
   * @param {string|Object} arg - 可传默认广告位ID字符串，或 { adUnitId, chestAdUnitId, energyAdUnitId }
   *   宝箱 / 能量可用各自独立广告位，避免"某位失败连坐其他位"，也便于在 MP 后台分别看填充/曝光数据。
   */
  init(arg) {
    let defId = null, chestId = null, energyId = null;
    if (typeof arg === 'string') defId = arg;
    else if (arg && typeof arg === 'object') { defId = arg.adUnitId; chestId = arg.chestAdUnitId; energyId = arg.energyAdUnitId; }
    if (defId) STATE.adUnitId = defId;
    // 幂等守卫：避免重复 init（如 Main 被多次实例化）重复预创建广告位 / 重复绑定 onClose。
    // 注：STATE.ads 已有按 id 缓存、ensureAd 只建一次实例，此处为二次保险。
    if (STATE.inited) return;
    STATE.inited = true;
    // 广告创建移出启动同步链路：wx.createRewardedVideoAd 在部分机型会阻塞 JS 线程，
    // 直接拖慢首帧渲染/总启动耗时。改为首帧之后延迟预加载 + 首次 show 时懒创建兜底。
    //
    // 串行错峰（3s / 5.5s / 8s）：真机实测同一 tick 连创 3 个组件会伴随 3 个并发广告拉取，
    // 与首帧渲染抢 CPU/网络；错峰后拉取压力平摊到玩家已进入主界面之后。
    // 预创建数量上限 = maxInstances - 1：预留 >=1 个空位给「正在展示的位」，避免首屏刚预载满 cap
    // 就因玩家点开第 4 个广告位而立即 evict 最久未用者（典型即默认兜底位）-> 引发 evict<->create 抖动。
    // 余下的低频位（如宝箱/抽卡位）改由 show 时懒创建兜底（代码已有），不影响功能、降低实例峰值。
    const preloadCap = Math.max(1, (STATE.config.maxInstances || 5) - 1);
    const preloadIds = [];
    if (STATE.adUnitId) preloadIds.push(STATE.adUnitId);
    if (energyId) preloadIds.push(energyId);     // 能量独立位：点击频率最高，优先预热，分摊各广告位负载
    if (chestId) preloadIds.push(chestId);       // 宝箱独立位：宝箱恰好在战斗结束最忙瞬间点击，预热降低"show before ready"竞态
    let delay = STATE.preloadDelay;
    const preload = (id) => {
      if (!id) return;
      const d = delay;
      delay += STATE.preloadStep;
      try { if (typeof setTimeout === 'function') setTimeout(function () { ensureAd(id); }, d); } catch (e) {}
    };
    preloadIds.slice(0, preloadCap).forEach(preload);
    // 真机+占位ID：启动时就提醒，避免点按钮才知道
    try {
      if (typeof wx !== 'undefined' && typeof wx.createRewardedVideoAd === 'function' && isPlaceholderId()) {
        _toast('请配置真实激励视频广告位ID');
      }
    } catch (e) {}
  },

  /**
   * 显示激励视频广告（含重试和超时）
   * @param {Object} opts - 选项
   * @param {Function} opts.onReward - 观看完成回调
   * @param {Function} opts.onClose - 关闭回调（参数：是否观看完成）
   * @param {Function} opts.onFail - 失败回调
   * @param {number} opts.retryCount - 内部重试计数（不要手动设置）
   */
  show(opts = {}) {
    STATE.stats.totalShow++;

    // 解析本次展示要用的广告位：优先 opts.adUnitId（宝箱独立位），否则用默认位
    const unit = opts.adUnitId || STATE.adUnitId;
    if (!unit) {
      // 连默认位都没配置
      if (typeof wx === 'undefined') {
        // 浏览器 / 本地调试：模拟播放发奖
        setTimeout(() => { _markAdSuccess(null); if (opts.onReward) opts.onReward(); if (opts.onClose) opts.onClose(true); }, 1200);
        return;
      }
      _toast('请先配置真实激励视频广告位ID');
      setTimeout(() => { if (opts.onFail) opts.onFail(new Error('未配置广告位ID')); else if (opts.onClose) opts.onClose(false); }, 150);
      return;
    }

    const entry = ensureAd(unit);
    if (!entry) {
      const isWx = typeof wx !== 'undefined';
      if (isWx && isPlaceholderUnit(unit)) {
        // 微信真机 + 占位广告位：不给奖 + Toast 提醒，避免通过"功能异常"审核
        _toast('请先配置真实激励视频广告位ID');
        setTimeout(() => {
          if (opts.onFail) opts.onFail(new Error('未配置真实广告位ID'));
          else if (opts.onClose) opts.onClose(false);
        }, 150);
        return;
      }
      // 浏览器 / 无 createRewardedVideoAd 环境：本地调试模拟播放
      setTimeout(() => {
        _markAdSuccess(null);
        if (opts.onReward) opts.onReward();
        if (opts.onClose) opts.onClose(true);
      }, 1200);
      return;
    }

    // 该广告位连续失败过多：临时禁用，走降级
    if (!entry.available) {
      console.warn('[ad] 广告暂时不可用（连续失败过多），走降级流程');
      _toast('广告暂不可用，请稍后再试');
      setTimeout(() => {
        if (opts.onFail) opts.onFail(new Error('广告连续失败过多，已临时禁用5分钟'));
        else if (opts.onClose) opts.onClose(false);
      }, 150);
      return;
    }

    // 防御：同广告位展示进行中（含外层 retry 链未结束）时，忽略本次叠加请求。
    // 避免并发 ad.show() 触发 SDK 原生视图(TextView/ImageView)反复建删 → removeTextView:fail 洪流；
    // 也规避微信官方不建议的"展示中再次 show"。
    if (entry._busy) {
      console.warn('[ad] 同广告位展示进行中，忽略叠加 show 请求');
      if (opts.onFail) opts.onFail(new Error('ad busy'));
      else if (opts.onClose) opts.onClose(false);
      return;
    }
    entry._busy = true;

    // C：新一次展示开始前重置结算标志，避免被上一次展示的 settled 状态误伤
    entry.settled = false;
    entry.pending = opts;

    const ad = entry.ad;
    const retryCount = opts._retryCount || 0;

    // 加载超时处理
    let timeoutId = null;
    const cleanupTimeout = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    const handleFailure = (error) => {
      // C：若本次展示已被 onClose 结算，则放弃失败链路，杜绝双触发（复活后又弹"不可用"）
      if (entry.settled) { cleanupTimeout(); return; }
      cleanupTimeout();
      console.warn('[ad] show failed', (error && (error.errMsg || error.message)) || error, error);

      // 重试机制
      if (retryCount < STATE.config.maxRetry) {
        STATE.stats.retries++;
        console.log(`[ad] 第${retryCount + 1}次重试...`);
        entry._busy = false; // 释放占用，让外层 retry 重新进入 show（retried show 会再次置 true）
        setTimeout(() => {
          // 重新加载广告后重试
          ad.load().then(() => {
            Rewarded.show(Object.assign({}, opts, { _retryCount: retryCount + 1 }));
          }).catch(() => {
            // load失败，直接重试show
            Rewarded.show(Object.assign({}, opts, { _retryCount: retryCount + 1 }));
          });
        }, STATE.config.retryDelay);
        return;
      }

      // 达到最大重试次数，标记该广告位失败
      _markAdFailed(entry);
      entry._busy = false;
      entry.pending = null;
      if (opts.onFail) opts.onFail(error);
      else if (opts.onClose) opts.onClose(false);
    };

    // 设置加载超时（once 守卫：防止超时与 show reject 双触发 onFail）
    let done = false;
    const finishFail = (e) => { if (done) return; done = true; handleFailure(e); };
    timeoutId = setTimeout(() => {
      if (entry.pending === opts) {
        console.warn('[ad] 广告加载超时');
        STATE.stats.timeout++;
        finishFail(new Error('timeout'));
      }
    }, STATE.config.loadTimeout);

    // 显示广告：先 load 再 show —— 规避微信同实例"show before ready"导致的 show:fail/调用失败。
    // 青铜宝箱在战斗刚结束、主线程繁忙时被快速点击，最易踩此竞态；统一改为 load→show 最稳。
    // 注意：show 拒绝时不再内部二次 ad.show()（避免叠加原生视图建删风暴），交由外层 retry（间隔 retryDelay）统一兜底。
    const doShow = () => {
      try {
        const p = ad.show();
        if (p && p.then) {
          p.then(() => cleanupTimeout())
           .catch((e) => {
             if (entry.settled) return;            // C：已看完结算，放弃失败链路
             finishFail(e);                         // 交给外层 retry（隔开 1s），不再内部二次 show
           });
        } else if (p && p.catch) {
          p.catch((e) => {
            if (entry.settled) return;            // C：已看完结算，放弃失败链路
            finishFail(e);
          });
        } else {
          cleanupTimeout(); // 老基础库无 promise：依赖 onClose/onError 事件
        }
      } catch (e) {
        finishFail(e); // ad.show() 同步抛异常（组件未就绪等）：转失败兜底，避免 _adBusy 卡死
      }
    };
    if (typeof ad.load === 'function') {
      ad.load().then(doShow).catch(doShow); // 预加载后再 show，最稳
    } else {
      doShow();
    }
    return;
  },

  /**
   * 获取广告加载统计
   * @returns {Object} 统计信息
   */
  getStats() {
    const def = STATE.ads[STATE.adUnitId];
    return Object.assign({}, STATE.stats, {
      adAvailable: def ? def.available : true,
      consecutiveFailures: def ? def.consecFails : 0,
      adUnitCount: Object.keys(STATE.ads).length,
      maxInstances: STATE.config.maxInstances
    });
  },

  /**
   * 重置广告状态（调试用）
   */
  reset() {
    // 重置所有广告位状态
    Object.keys(STATE.ads).forEach((k) => {
      const e = STATE.ads[k];
      if (e) { e.available = true; e.consecFails = 0; e.pending = null; e.settled = false; e._busy = false; }
    });
    STATE.inited = false;
    STATE.stats = {
      totalShow: 0,
      success: 0,
      failed: 0,
      timeout: 0,
      retries: 0,
      evicted: 0
    };
  }
};

// ============================================================
// 插屏广告封装（隐藏式自动弹）：当前用于「进首页后自动插播」(key='home')，机制对 key 通用。
// - 与 Rewarded 不同：插屏无奖励、无用户选择，平台强制在场景断点自动弹出
// - 微信对插屏有频控：两次最小间隔 INTERSTITIAL_MIN_INTERVAL、单日上限由业务层(game.js)控制
// - 浏览器 / 无 createInterstitialAd / 占位ID / 不可用 → 静默跳过（不报错、不弹）
// ============================================================
const INTERSTITIAL_MIN_INTERVAL = 60000; // 两次插屏最小间隔(ms)，与微信平台频控对齐，避免被吞/被限

const ISTATE = {
  ids: {},               // { key: adUnitId }，多插屏位：按 key 区分（现仅 home=进首页后插播）
  ads: {},               // { key: { ad, id, available } }，按 key 懒创建+缓存
  lastShown: 0,          // 上次展示时间戳（全局最小间隔守卫，跨所有插屏位共用，对齐微信平台频控）
  adAvailable: true,     // 连续失败过多时临时禁用（全局）
  pending: null,
  // 预热节奏：插屏是「隐藏式自动弹」，玩家无感，创建时机完全可以让位给启动性能。
  // 原为启动后 3.5s 一次性创建 4 个（与激励位撞在一起 → 7 个组件并发拉取广告），
  // 改为 12s 起、每 2.5s 一个串行错峰；真要弹时 show() 内 _iEnsure 会懒创建兜底。
  preloadDelay: 12000,
  preloadStep: 2500
};

function _iIsPlaceholder(id) {
  return !id || /^adunit-0+$/.test(id);
}

/** 与 _findEntryByAd 同理：按实例身份去重，避免同一组件被重复绑定 onError/onClose */
function _iFindEntryByAd(ad) {
  const keys = Object.keys(ISTATE.ads);
  for (let i = 0; i < keys.length; i++) {
    const e = ISTATE.ads[keys[i]];
    if (e && e.ad === ad) return e;
  }
  return null;
}

function _iEnsure(key) {
  if (ISTATE.ads[key] && ISTATE.ads[key].ad) return ISTATE.ads[key].ad;
  const id = ISTATE.ids[key];
  if (!id || typeof wx === 'undefined' || !wx.createInterstitialAd) return null;
  try {
    const ad = wx.createInterstitialAd({ adUnitId: id });
    if (!ad) return null;
    // 双保险：SDK 若返回与其它 key 相同的实例，复用同一 entry，不重复绑定事件
    const shared = _iFindEntryByAd(ad);
    if (shared) {
      ISTATE.ads[key] = shared;
      return ad;
    }
    ad.onError((err) => { console.warn('[i-ad] error', id, err); });
    ad.onClose(() => {
      const cb = ISTATE.pending;
      ISTATE.pending = null;
      if (ISTATE.ads[key]) ISTATE.ads[key]._busy = false;
      if (cb && cb.onClose) cb.onClose();
    });
    ISTATE.ads[key] = { ad, id, available: true, _busy: false };
    return ad;
  } catch (e) { return null; }
}

const Interstitial = {
  /**
   * 初始化插屏广告（多广告位，按 key 区分）。
   * @param {Object} units - 各场景独立插屏位（MP 后台「插屏」类型），现仅 { home }（进首页后插播）。
   */
  init(units) {
    if (units && typeof units === 'object') ISTATE.ids = units;
    // 广告创建移出启动同步链路 + 串行错峰（12s / 14.5s / 17s / 19.5s）：
    // 真机实测启动后 3.5s 一次性创建 4 个插屏 → 与激励位撞成 7 个组件并发拉取广告，
    // 首帧与启动耗时被抬升。插屏玩家无感，故推迟到玩家已进入主界面、且彼此错开。
    try {
      if (typeof setTimeout === 'function') {
        let d = ISTATE.preloadDelay;
        Object.keys(ISTATE.ids || {}).forEach((k) => {
          const at = d;
          d += ISTATE.preloadStep;
          setTimeout(function () { _iEnsure(k); }, at);
        });
      }
    } catch (e) {}
    // 占位ID提醒（仅 console，不打扰玩家；真机未配置时静默跳过）
    try {
      if (typeof wx !== 'undefined' && typeof wx.createInterstitialAd === 'function') {
        Object.keys(ISTATE.ids || {}).forEach((k) => {
          const _id = ISTATE.ids[k];
          if (_id && _iIsPlaceholder(_id)) console.warn('[i-ad] 插屏广告位 ' + k + ' 未配置（占位），将静默跳过');
        });
      }
    } catch (e) {}
  },

  /** 指定 key 的插屏是否允许展示（该位有效性 + 全局最小间隔 + 能力 + 可用性）。业务层还需判每日上限。 */
  canShow(key) {
    if (!ISTATE.adAvailable) return false;
    if (typeof wx === 'undefined' || !wx.createInterstitialAd) return false;
    if (_iIsPlaceholder(ISTATE.ids[key])) return false;
    if (Date.now() - ISTATE.lastShown < INTERSTITIAL_MIN_INTERVAL) return false;
    return true;
  },

  /**
   * 展示指定 key 的插屏广告。
   * @param {Object} opts
   * @param {string} opts.key - 插屏位 key（draw3/draw6/draw9/rand2）
   * @param {Function} opts.onShown 实际展示成功回调（业务层在此计每日上限）
   * @param {Function} opts.onSkip  未展示回调（占位/能力缺失/被频控吞掉/加载失败）——不计数
   */
  show(opts = {}) {
    const key = opts.key;
    const ad = _iEnsure(key);
    if (!ad) { if (opts.onSkip) opts.onSkip(); return; }
    // 二次频控守卫（canShow 已判一次，这里再判以防御重入）
    if (Date.now() - ISTATE.lastShown < INTERSTITIAL_MIN_INTERVAL) { if (opts.onSkip) opts.onSkip(); return; }
    // 防御：同插屏位展示进行中，忽略叠加（避免并发 show 触发的原生视图建删风暴）
    if (ISTATE.ads[key] && ISTATE.ads[key]._busy) { if (opts.onSkip) opts.onSkip(); return; }
    ISTATE.lastShown = Date.now();
    ISTATE.pending = opts;
    if (ISTATE.ads[key]) ISTATE.ads[key]._busy = true;
    const onShown = () => { if (ISTATE.ads[key]) ISTATE.ads[key]._busy = false; if (opts.onShown) opts.onShown(); };
    const onFail = () => { if (ISTATE.ads[key]) ISTATE.ads[key]._busy = false; ISTATE.pending = null; if (opts.onSkip) opts.onSkip(); };
    // 先 load 再 show：插屏组件冷创建后直接 show 常被 SDK 拒（"not loaded"），
    // 统一 load→show 最稳，与 Rewarded 一致；load 失败则兜底 onSkip（不弹、不报错）。
    const doShow = () => {
      try {
        const p = ad.show();
        if (p && p.then) p.then(onShown).catch(onFail);
        else if (p && p.catch) p.catch(onFail);
        else onShown();
      } catch (e) { onFail(); }
    };
    if (typeof ad.load === 'function') {
      try { ad.load().then(doShow).catch(doShow); } catch (e) { doShow(); }
    } else {
      doShow();
    }
  }
};

module.exports = { Rewarded, Interstitial };
