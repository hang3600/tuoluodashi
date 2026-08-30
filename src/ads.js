/**
 * 激励视频广告封装（打磨版 + 降级方案）
 * - 微信真机 + 占位广告位：不再直接发奖，Toast 提醒开发者先配置ID
 * - 浏览器 / 无广告环境：模拟 1.2s 播放后发奖（仅用于本地调试）
 * - 加载失败走 onFail（UI 提示"广告暂不可用"，不消耗次数）
 * - 广告加载超时处理（10秒超时）
 * - 广告加载重试机制（最多2次）
 * - 广告不可用时的降级方案
 * - 广告加载状态统计
 */

const STATE = {
  ad: null,
  adUnitId: '',  // 单一来源见 src/config.js 的 CONFIG.adUnitId；此处空串仅作未初始化占位，isPlaceholderId() 会拦截误用，真实值由 main.js 的 Rewarded.init(CONFIG.adUnitId) 注入
  pending: null,
  settled: false,  // 单次展示是否已结算（onClose 已处理则 handleFailure 不再发 onFail，防双触发）
  // 广告加载状态统计
  stats: {
    totalShow: 0,
    success: 0,
    failed: 0,
    timeout: 0,
    retries: 0
  },
  // 广告加载配置
  config: {
    maxRetry: 2,        // 最大重试次数
    loadTimeout: 10000, // 加载超时（毫秒）
    retryDelay: 1000    // 重试间隔（毫秒）
  },
  // 广告是否可用（连续失败超过阈值时标记为不可用，避免反复尝试）
  adAvailable: true,
  consecutiveFailures: 0,
  maxConsecutiveFailures: 3 // 连续失败超过3次，标记广告不可用
};

function isPlaceholderId() {
  return !STATE.adUnitId || /^adunit-0+$/.test(STATE.adUnitId);
}

function _toast(msg) {
  try {
    if (typeof wx !== 'undefined' && wx.showToast) {
      wx.showToast({ title: msg, icon: 'none', duration: 1800 });
    }
  } catch (e) {}
}

/**
 * 标记广告失败，连续失败超过阈值时标记为不可用
 */
function _markAdFailed() {
  STATE.consecutiveFailures++;
  STATE.stats.failed++;
  if (STATE.consecutiveFailures >= STATE.maxConsecutiveFailures) {
    STATE.adAvailable = false;
    console.warn(`[ad] 连续失败${STATE.consecutiveFailures}次，广告暂时不可用，5分钟后重试`);
    // 5分钟后重置，允许再次尝试
    setTimeout(() => {
      STATE.adAvailable = true;
      STATE.consecutiveFailures = 0;
      console.log('[ad] 广告可用性已重置');
    }, 5 * 60 * 1000);
  }
}

/**
 * 标记广告成功，重置连续失败计数
 */
function _markAdSuccess() {
  STATE.consecutiveFailures = 0;
  STATE.stats.success++;
}

function ensureAd() {
  if (STATE.ad) return STATE.ad;
  if (typeof wx === 'undefined' || !wx.createRewardedVideoAd) return null;
  try {
    const ad = wx.createRewardedVideoAd({ adUnitId: STATE.adUnitId });
    ad.onError((err) => {
      console.warn('[ad] error', err);
      // 广告加载错误统计
      if (err && err.errMsg && /timeout/i.test(err.errMsg)) {
        STATE.stats.timeout++;
      }
    });
    ad.onClose((res) => {
      // B：部分基础库 onClose 无参或 isEnded 缺失，未明确中断即算看完，避免"看完却没发奖"
      const ended = !res || res.isEnded !== false;
      const cb = STATE.pending;
      STATE.pending = null;
      // C：标记已结算，避免 show promise 的 reject 链路在 onClose 之后又触发 onFail（双触发竞态）
      STATE.settled = true;
      if (cb) {
        if (ended) {
          _markAdSuccess();
          if (cb.onReward) cb.onReward();
        }
        if (cb.onClose) cb.onClose(ended);
      }
    });
    STATE.ad = ad;
    return ad;
  } catch (e) { return null; }
}

const Rewarded = {
  init(adUnitId) {
    if (adUnitId) STATE.adUnitId = adUnitId;
    // 广告创建移出启动同步链路：wx.createRewardedVideoAd 在部分机型会阻塞 JS 线程，
    // 直接拖慢首帧渲染/总启动耗时。改为首帧之后延迟预加载 + 首次 show 时懒创建兜底。
    try {
      if (typeof setTimeout === 'function') {
        setTimeout(function () { ensureAd(); }, 3000);
      }
    } catch (e) {}
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

    // 广告不可用时的降级处理
    if (!STATE.adAvailable) {
      console.warn('[ad] 广告暂时不可用（连续失败过多），走降级流程');
      _toast('广告暂不可用，请稍后再试');
      setTimeout(() => {
        if (opts.onFail) opts.onFail(new Error('广告连续失败过多，已临时禁用5分钟'));
        else if (opts.onClose) opts.onClose(false);
      }, 150);
      return;
    }

    // C：新一次展示开始前重置结算标志，避免被上一次展示的 settled 状态误伤
    STATE.settled = false;

    const ad = ensureAd();
    if (ad) {
      STATE.pending = opts;
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
        if (STATE.settled) { cleanupTimeout(); return; }
        cleanupTimeout();
        console.warn('[ad] show failed', error);

        // 重试机制
        if (retryCount < STATE.config.maxRetry) {
          STATE.stats.retries++;
          console.log(`[ad] 第${retryCount + 1}次重试...`);
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

        // 达到最大重试次数，标记失败
        _markAdFailed();
        STATE.pending = null;
        if (opts.onFail) opts.onFail(error);
        else if (opts.onClose) opts.onClose(false);
      };

      // 设置加载超时
      timeoutId = setTimeout(() => {
        if (STATE.pending === opts) {
          console.warn('[ad] 广告加载超时');
          STATE.stats.timeout++;
          handleFailure(new Error('timeout'));
        }
      }, STATE.config.loadTimeout);

      // 显示广告
      const p = ad.show();
      if (p && p.catch) {
        p.catch(() => {
          // show失败，尝试load后再show
          if (STATE.settled) return;  // C：广告已看完结算，不再二次展示/触发失败
          ad.load()
            .then(() => ad.show())
            .catch((e) => handleFailure(e));
        });
      } else if (p && p.then) {
        p.then(() => {
          // show成功，清除超时
          cleanupTimeout();
        }).catch((e) => handleFailure(e));
      }
      return;
    }

    const isWx = typeof wx !== 'undefined';
    if (isWx && isPlaceholderId()) {
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
      _markAdSuccess();
      if (opts.onReward) opts.onReward();
      if (opts.onClose) opts.onClose(true);
    }, 1200);
  },

  /**
   * 获取广告加载统计
   * @returns {Object} 统计信息
   */
  getStats() {
    return Object.assign({}, STATE.stats, {
      adAvailable: STATE.adAvailable,
      consecutiveFailures: STATE.consecutiveFailures
    });
  },

  /**
   * 重置广告状态（调试用）
   */
  reset() {
    STATE.adAvailable = true;
    STATE.consecutiveFailures = 0;
    STATE.stats = {
      totalShow: 0,
      success: 0,
      failed: 0,
      timeout: 0,
      retries: 0
    };
  }
};

// ============================================================
// 插屏广告封装（隐藏式自动弹）：用于「连续抽卡每 N 抽自动插播」
// - 与 Rewarded 不同：插屏无奖励、无用户选择，平台强制在场景断点自动弹出
// - 微信对插屏有频控：两次最小间隔 INTERSTITIAL_MIN_INTERVAL、单日上限由业务层(game.js)控制
// - 浏览器 / 无 createInterstitialAd / 占位ID / 不可用 → 静默跳过（不报错、不弹）
// ============================================================
const INTERSTITIAL_MIN_INTERVAL = 60000; // 两次插屏最小间隔(ms)，与微信平台频控对齐，避免被吞/被限

const ISTATE = {
  ad: null,
  adUnitId: '',          // 单一来源见 src/config.js 的 CONFIG.interstitialAdUnitId；空串仅作未初始化占位
  lastShown: 0,          // 上次展示时间戳（用于最小间隔守卫）
  adAvailable: true,     // 连续失败过多时临时禁用
  pending: null
};

function _iIsPlaceholder() {
  return !ISTATE.adUnitId || /^adunit-0+$/.test(ISTATE.adUnitId);
}

function _iEnsure() {
  if (ISTATE.ad) return ISTATE.ad;
  if (typeof wx === 'undefined' || !wx.createInterstitialAd) return null;
  try {
    const ad = wx.createInterstitialAd({ adUnitId: ISTATE.adUnitId });
    ad.onError((err) => { console.warn('[i-ad] error', err); });
    ad.onClose(() => {
      const cb = ISTATE.pending;
      ISTATE.pending = null;
      if (cb && cb.onClose) cb.onClose();
    });
    ISTATE.ad = ad;
    return ISTATE.ad;
  } catch (e) { return null; }
}

const Interstitial = {
  init(adUnitId) {
    if (adUnitId) ISTATE.adUnitId = adUnitId;
    // 广告创建移出启动同步链路：延迟预加载，避免阻塞首帧
    try {
      if (typeof setTimeout === 'function') setTimeout(function () { _iEnsure(); }, 3500);
    } catch (e) {}
    // 占位ID提醒（仅 console，不打扰玩家；真机未配置时静默跳过）
    try {
      if (typeof wx !== 'undefined' && typeof wx.createInterstitialAd === 'function' && _iIsPlaceholder()) {
        console.warn('[i-ad] 插屏广告位ID未配置（占位），隐藏广告将静默跳过');
      }
    } catch (e) {}
  },

  /** 当前是否允许展示（最小间隔 + 能力 + 占位ID + 可用性）。业务层还需自行判每日上限。 */
  canShow() {
    if (!ISTATE.adAvailable) return false;
    if (typeof wx === 'undefined' || !wx.createInterstitialAd) return false;
    if (_iIsPlaceholder()) return false;
    if (Date.now() - ISTATE.lastShown < INTERSTITIAL_MIN_INTERVAL) return false;
    return true;
  },

  /**
   * 展示插屏广告。
   * @param {Object} opts
   * @param {Function} opts.onShown 实际展示成功回调（业务层在此计每日上限）
   * @param {Function} opts.onSkip  未展示回调（占位/能力缺失/被频控吞掉/加载失败）——不计数
   */
  show(opts = {}) {
    const ad = _iEnsure();
    if (!ad) { if (opts.onSkip) opts.onSkip(); return; }
    // 二次频控守卫（canShow 已判一次，这里再判以防御重入）
    if (Date.now() - ISTATE.lastShown < INTERSTITIAL_MIN_INTERVAL) { if (opts.onSkip) opts.onSkip(); return; }
    ISTATE.lastShown = Date.now();
    ISTATE.pending = opts;
    const onShown = () => { if (opts.onShown) opts.onShown(); };
    const onFail = () => { ISTATE.pending = null; if (opts.onSkip) opts.onSkip(); };
    const retry = () => {
      try {
        const p2 = ad.show();
        if (p2 && p2.then) p2.then(onShown).catch(onFail);
        else onShown();
      } catch (e) { onFail(); }
    };
    try {
      const p = ad.show();
      if (p && p.then) {
        p.then(onShown).catch(() => { try { ad.load().then(retry).catch(onFail); } catch (e) { onFail(); } });
      } else if (p && p.catch) {
        p.catch(() => { try { ad.load().then(retry).catch(onFail); } catch (e) { onFail(); } });
      } else {
        onShown();
      }
    } catch (e) { onFail(); }
  }
};

module.exports = { Rewarded, Interstitial };
