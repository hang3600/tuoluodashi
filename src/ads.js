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
  adUnitId: 'adunit-1183de0d72298c4d',
  pending: null,
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
      const ended = !!(res && res.isEnded);
      const cb = STATE.pending;
      STATE.pending = null;
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

module.exports = { Rewarded };
