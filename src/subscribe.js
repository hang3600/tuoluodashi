/**
 * 一次性订阅消息封装（微信小游戏留存利器）
 * ------------------------------------------------------------
 * 用途：在「用户高意图手势」后（签到成功 / 领回归礼包）请求授权
 *       次日提醒，把用户拉回游戏。这是次日留存（D1）最大的零成本杠杆。
 *
 * 合规要点：
 *   - 必须是用户主动触发（按钮 tap 回调内）才能调 wx.requestSubscribeMessage，
 *     不能在冷启动 / 定时器里静默弹。本项目只在 sign_claim / return_claim 内调用。
 *   - 模板 ID 必须在 MP 后台「功能 → 订阅消息 → 一次性订阅」申请，并把 ID 填进
 *     config.js 的 CONFIG.subscribeTemplates，否则本封装静默 no-op，绝不报错。
 *
 * 安全降级（绝不抛错）：
 *   - 无 wx 环境（node 测试 / 非微信） → 返回 false
 *   - API 不存在（低基础库）           → 返回 false
 *   - 模板未配置（占位空串）           → 返回 false（不弹）
 */
const { CONFIG } = require('./config');

const Subscribe = {
  /**
   * 请求订阅。
   * @param {string[]} types 订阅场景键，取 CONFIG.subscribeTemplates 的 key，
   *                         例如 ['daily'] / ['daily','offline']。
   * @param {object}   opts  可选 { onResolved(res) }，res 为微信 success 回调原对象。
   * @returns {boolean} 是否真正发出了订阅请求（false = 因降级/未配置而未发）。
   */
  request(types, opts) {
    opts = opts || {};
    try {
      if (typeof wx === 'undefined') return false;
      if (typeof wx.requestSubscribeMessage !== 'function') return false;
      const tmplIds = this._resolve(types);
      if (!tmplIds.length) return false; // 模板未配置 → 静默跳过
      wx.requestSubscribeMessage({
        tmplIds,
        success: function (res) {
          if (typeof opts.onResolved === 'function') {
            try { opts.onResolved(res); } catch (e) {}
          }
        },
        fail: function () { /* 用户拒绝 / 超时：静默，不阻断主流程 */ },
        complete: function () {}
      });
      return true;
    } catch (e) {
      return false;
    }
  },

  // 把 types 解析为已配置的模板 ID 数组（过滤空占位）
  _resolve(types) {
    const map = (CONFIG && CONFIG.subscribeTemplates) || {};
    const ids = [];
    if (Array.isArray(types)) {
      for (let i = 0; i < types.length; i++) {
        const id = map[types[i]];
        if (id && typeof id === 'string' && id.length) ids.push(id);
      }
    }
    return ids;
  }
};

module.exports = { Subscribe };
