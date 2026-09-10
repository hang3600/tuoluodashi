/**
 * 全局错误捕获与上报模块
 * 
 * 功能：
 * 1. 捕获全局未处理的异常（wx.onError）
 * 2. 捕获Promise未处理的拒绝（unhandledrejection）
 * 3. 捕获游戏主循环中的异常
 * 4. 上报错误信息到控制台（或远程服务器）
 * 5. 错误信息包含：错误消息、堆栈、时间戳、设备信息、游戏状态
 * 
 * 使用：
 * const { ErrorHandler } = require('./error-handler');
 * ErrorHandler.init();
 * 
 * 在主循环中：
 * try {
 *   // 游戏逻辑
 * } catch (e) {
 *   ErrorHandler.capture(e, 'mainLoop');
 * }
 */

const MAX_ERROR_LOGS = 50; // 最大错误日志数量
const MAX_STACK_LENGTH = 2000; // 最大堆栈长度

class ErrorHandler {
  constructor() {
    this._initialized = false;
    this._errors = []; // 错误日志列表
    this._errorCount = 0; // 总错误计数
    this._lastErrorTime = 0; // 最后一次错误时间
    this._gameState = null; // 游戏状态引用（用于错误上报时附带状态）
  }

  /**
   * 初始化全局错误捕获
   * @param {Object} options - 配置选项
   * @param {Object} options.gameState - 游戏状态引用
   * @param {Function} options.onError - 自定义错误回调
   * @param {string} options.reportUrl - 远程上报URL（可选）
   */
  init(options = {}) {
    if (this._initialized) return;
    this._initialized = true;
    this._gameState = options.gameState || null;
    this._onErrorCallback = options.onError || null;
    this._reportUrl = options.reportUrl || null;

    // 运维中心崩溃上报配置（零后端，详见 config.js 的 crashReport）
    //   gameLog : 小游戏实时日志（base lib 3.7.4+），写全量 errorLog 供按 openid 查
    //   eventId : 崩溃计数事件 ID，wx.reportEvent(id,{crash_count:1}) 做计数/告警。
    //             注意：wx.reportMonitor 自基础库 2.31.1 起已「停止维护」，
    //             本项目基础库 3.17.1 必须用 wx.reportEvent（事件在 运维中心/WE分析
    //             → 数据管理 → 上报管理 新建）。旧基础库无 reportEvent 时回退 reportMonitor。
    const report = options.report || {};
    this._reportGameLog = (report.gameLog !== false);   // 默认开启
    this._eventId = (typeof report.eventId === 'string') ? report.eventId : '';
    this._logManager = null;   // 懒初始化，避免 devtools/低版本 base lib 缺失时崩溃

    console.log('[ErrorHandler] 初始化全局错误捕获...');

    // 1. 微信小游戏全局错误捕获
    try {
      if (typeof wx !== 'undefined' && wx.onError) {
        wx.onError((msg, stack) => {
          this.capture({ message: msg, stack: stack }, 'wx.onError');
        });
        console.log('[ErrorHandler] wx.onError 已注册');
      }
    } catch (e) {
      console.warn('[ErrorHandler] wx.onError 注册失败:', e.message);
    }

    // 2. 浏览器环境全局错误捕获
    try {
      if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('error', (event) => {
          this.capture({
            message: event.message || 'Unknown error',
            stack: event.error && event.error.stack ? event.error.stack : ''
          }, 'window.error');
        });
        window.addEventListener('unhandledrejection', (event) => {
          this.capture({
            message: 'Unhandled Promise rejection: ' + (event.reason && event.reason.message ? event.reason.message : String(event.reason)),
            stack: event.reason && event.reason.stack ? event.reason.stack : ''
          }, 'unhandledrejection');
        });
        console.log('[ErrorHandler] window.error / unhandledrejection 已注册');
      }
    } catch (e) {
      console.warn('[ErrorHandler] window error 监听失败:', e.message);
    }

    // 3. Node.js环境全局错误捕获
    try {
      if (typeof process !== 'undefined' && process.on) {
        process.on('uncaughtException', (err) => {
          this.capture(err, 'uncaughtException');
        });
        process.on('unhandledRejection', (reason) => {
          this.capture({
            message: 'Unhandled Rejection: ' + (reason && reason.message ? reason.message : String(reason)),
            stack: reason && reason.stack ? reason.stack : ''
          }, 'unhandledRejection');
        });
        console.log('[ErrorHandler] process uncaughtException / unhandledRejection 已注册');
      }
    } catch (e) {
      // 非Node.js环境，忽略
    }

    console.log('[ErrorHandler] 初始化完成');
  }

  /**
   * 捕获错误
   * @param {Error|Object} error - 错误对象或错误信息
   * @param {string} source - 错误来源（如 'mainLoop', 'render', 'input' 等）
   * @param {Object} extra - 额外信息
   */
  capture(error, source = 'unknown', extra = {}) {
    try {
      this._errorCount++;
      this._lastErrorTime = Date.now();

      // 构建错误日志
      const errorLog = {
        id: this._errorCount,
        timestamp: new Date().toISOString(),
        source: source,
        message: error && error.message ? error.message : String(error),
        stack: this._truncateStack(error && error.stack ? error.stack : ''),
        extra: extra,
        device: this._getDeviceInfo(),
        gameState: this._getGameStateSummary()
      };

      // 添加到错误日志列表
      this._errors.push(errorLog);
      if (this._errors.length > MAX_ERROR_LOGS) {
        this._errors.shift(); // 移除最旧的错误
      }

      // 输出到控制台
      console.error(`[ErrorHandler][${source}] ${errorLog.message}`);
      if (errorLog.stack) {
        console.error(errorLog.stack);
      }
      if (Object.keys(extra).length > 0) {
        console.error('额外信息:', extra);
      }

      // 调用自定义回调
      if (typeof this._onErrorCallback === 'function') {
        try {
          this._onErrorCallback(errorLog);
        } catch (e) {
          console.warn('[ErrorHandler] 自定义错误回调失败:', e.message);
        }
      }

      // 远程上报（可选，运维中心通道）
      this._reportCrash(errorLog);

      // 远程上报（可选，自定义 URL，极少用）
      if (this._reportUrl) {
        this._reportError(errorLog);
      }

      return errorLog;
    } catch (e) {
      // 错误处理本身失败，避免无限递归
      console.error('[ErrorHandler] 错误处理失败:', e.message);
    }
  }

  /**
   * 包装函数，自动捕获错误
   * @param {Function} fn - 要包装的函数
   * @param {string} source - 错误来源
   * @returns {Function} 包装后的函数
   */
  wrap(fn, source = 'wrapped') {
    const self = this;
    return function (...args) {
      try {
        return fn.apply(this, args);
      } catch (e) {
        self.capture(e, source);
        return null;
      }
    };
  }

  /**
   * 包装异步函数，自动捕获错误
   * @param {Function} fn - 要包装的异步函数
   * @param {string} source - 错误来源
   * @returns {Function} 包装后的异步函数
   */
  wrapAsync(fn, source = 'wrappedAsync') {
    const self = this;
    return async function (...args) {
      try {
        return await fn.apply(this, args);
      } catch (e) {
        self.capture(e, source);
        return null;
      }
    };
  }

  /**
   * 获取错误统计
   * @returns {Object} 错误统计信息
   */
  getStats() {
    return {
      totalErrors: this._errorCount,
      errorCount: this._errors.length,
      lastErrorTime: this._lastErrorTime ? new Date(this._lastErrorTime).toISOString() : null,
      errorsBySource: this._getErrorsBySource()
    };
  }

  /**
   * 获取所有错误日志
   * @returns {Array} 错误日志列表
   */
  getErrors() {
    return this._errors.slice();
  }

  /**
   * 清空错误日志
   */
  clear() {
    this._errors = [];
    this._errorCount = 0;
    this._lastErrorTime = 0;
  }

  /**
   * 设置游戏状态引用
   * @param {Object} gameState - 游戏状态引用
   */
  setGameState(gameState) {
    this._gameState = gameState;
  }

  // ==========================================================
  // 内部方法
  // ==========================================================

  /**
   * 截断堆栈信息，避免过长
   * @private
   */
  _truncateStack(stack) {
    if (!stack || typeof stack !== 'string') return '';
    if (stack.length > MAX_STACK_LENGTH) {
      return stack.substring(0, MAX_STACK_LENGTH) + '\n...(truncated)';
    }
    return stack;
  }

  /**
   * 获取设备信息
   * @private
   */
  _getDeviceInfo() {
    try {
      const info = {};
      if (typeof wx !== 'undefined' && wx.getSystemInfoSync) {
        const si = wx.getSystemInfoSync();
        info.platform = si.platform;
        info.system = si.system;
        info.model = si.model;
        info.version = si.version;
        info.SDKVersion = si.SDKVersion;
        info.benchmarkLevel = si.benchmarkLevel;
        info.devicePixelRatio = si.devicePixelRatio;
        info.screenWidth = si.screenWidth;
        info.screenHeight = si.screenHeight;
      } else if (typeof navigator !== 'undefined') {
        info.platform = navigator.platform;
        info.userAgent = navigator.userAgent;
      }
      return info;
    } catch (e) {
      return { error: e.message };
    }
  }

  /**
   * 获取游戏状态摘要（避免完整序列化导致性能问题）
   * @private
   */
  _getGameStateSummary() {
    try {
      if (!this._gameState) return null;
      const gs = this._gameState;
      return {
        coins: gs.coins,
        energy: gs.energy,
        maxEnergy: gs.maxEnergy,
        inventoryCount: gs.inventory ? gs.inventory.length : 0,
        platformSlots: gs.platformSlots ? gs.platformSlots.map(s => s ? `${s.tierIndex}-${s.level}` : null) : [],
        level: gs.level,
        exp: gs.exp,
        winStreak: gs.winStreak,
        arenaPts: gs.arenaPts,
        mergeCount: gs.mergeCount,
        signDay: gs.signDay,
        dailyActive: gs.dailyActive
      };
    } catch (e) {
      return { error: e.message };
    }
  }

  /**
   * 按来源统计错误数量
   * @private
   */
  _getErrorsBySource() {
    const stats = {};
    for (const err of this._errors) {
      stats[err.source] = (stats[err.source] || 0) + 1;
    }
    return stats;
  }

  /**
   * 远程上报错误
   * @private
   */
  _reportError(errorLog) {
    try {
      if (typeof wx !== 'undefined' && wx.request) {
        wx.request({
          url: this._reportUrl,
          method: 'POST',
          data: errorLog,
          header: { 'content-type': 'application/json' },
          fail: (e) => {
            console.warn('[ErrorHandler] 远程上报失败:', e.errMsg || e.message);
          }
        });
      } else if (typeof fetch !== 'undefined') {
        fetch(this._reportUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(errorLog)
        }).catch(e => {
          console.warn('[ErrorHandler] 远程上报失败:', e.message);
        });
      }
    } catch (e) {
      console.warn('[ErrorHandler] 远程上报异常:', e.message);
    }
  }

  /**
   * 运维中心崩溃上报（零后端）
   * - GameLogManager（小游戏实时日志）：写全量 errorLog，后台按 openid 可查，定位真机崩溃
   * - 计数告警：wx.reportEvent(eventId, {crash_count:1, source})（基础库 2.31.1 起
   *   reportMonitor 已停止维护，本项目 3.17.1 用 reportEvent；旧 Lib 无 reportEvent 时回退 reportMonitor）
   * 守卫：wx 缺失 / API 缺失 / devtools 环境 → 静默跳过，绝不抛错、绝不污染生产监控。
   * @private
   */
  _reportCrash(errorLog) {
    try {
      // devtools 下不写运维中心：避免本机调试把生产崩溃计数 / 日志打脏
      if (this._isDevtools()) return;

      // 1) 实时日志：全量 errorLog（stack 已截断，安全）
      if (this._reportGameLog) {
        const lm = this._getLogManager();
        if (lm) {
          try {
            lm.error('[crash] ' + (errorLog.source || 'unknown') + ' | ' + (errorLog.message || ''));
            if (errorLog.stack) lm.error(errorLog.stack);
            // 设备 + 游戏状态摘要：定位「哪类机子 / 哪个进度」崩溃
            const dev = errorLog.device || {};
            lm.warn('device=' + JSON.stringify(dev) + ' state=' + JSON.stringify(errorLog.gameState || null));
          } catch (e) {
            // 实时日志写失败不能影响玩法
          }
        }
      }

      // 2) 计数告警：崩溃事件 +1（未配置 eventId 则跳过）
      if (this._eventId && typeof wx !== 'undefined') {
        try {
          if (typeof wx.reportEvent === 'function') {
            // 主路径（基础库 ≥2.31.1）：事件在 运维中心/WE分析 → 数据管理 → 上报管理 新建
            // 崩溃总数 = 事件触发次数（后台自动按 occurrence 统计，与是否传参数无关）。
            // source 维度：在后台给该事件加一个 string 型参数 source 即可按来源
            // (render/mainLoop/input…) 下钻；未注册则被静默忽略，不影响总数。
            wx.reportEvent(this._eventId, {
              source: errorLog.source || 'unknown'
            });
          } else if (typeof wx.reportMonitor === 'function') {
            // 旧基础库兜底（reportMonitor 自 2.31.1 起已停止维护，仅保险用）
            wx.reportMonitor(this._eventId, 1);
          }
        } catch (e) {
          // 计数上报失败静默
        }
      }
    } catch (e) {
      // 上报链路自身失败，绝对不能反噬主流程
      console.warn('[ErrorHandler] 运维中心上报异常:', e.message);
    }
  }

  /**
   * 懒初始化小游戏实时日志管理器（base lib 3.7.4+）
   * @private
   */
  _getLogManager() {
    if (this._logManager !== null) return this._logManager; // 已尝试过（含失败=null）
    this._logManager = null;
    try {
      if (typeof wx !== 'undefined' && typeof wx.getGameLogManager === 'function') {
        this._logManager = wx.getGameLogManager();
      }
    } catch (e) {
      this._logManager = null;
    }
    return this._logManager;
  }

  /**
   * 是否开发者工具环境（不写运维中心，避免污染生产监控）
   * @private
   */
  _isDevtools() {
    try {
      if (typeof wx === 'undefined' || !wx.getSystemInfoSync) return false;
      const si = wx.getSystemInfoSync();
      return si && si.platform === 'devtools';
    } catch (e) {
      return false;
    }
  }
}

// 导出单例
const errorHandler = new ErrorHandler();

module.exports = {
  ErrorHandler: errorHandler,
  ErrorHandlerClass: ErrorHandler
};
