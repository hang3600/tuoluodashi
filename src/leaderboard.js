/**
 * P0-2 开放数据域好友排行榜（零后端 · 2026-10-31）
 * ==========================================================================
 * 架构：
 *   主域（本文件）  —— 把自家战绩写入微信用户云存储 wx.setUserCloudStorage；
 *   开放数据域（opencontext/game.js）—— wx.getFriendCloudStorage 读全好友数据，
 *                     渲染到 sharedCanvas；主域 render.js drawImage 上屏。
 *   链路：battle 胜利 → game.noteBattleScore() → syncLeaderboard()（本文件，节流）
 *         → 榜单面板打开 → render 向 opencontext postMessage({board,w,h}) → 好友榜绘制。
 *
 * KV 设计（4 个 key，opencontext/game.js 按同一套约定解析）：
 *   arenaPts    本周竞技积分（跨周由 game._checkArenaReset 归零后随下次胜利同步）
 *   highScore   历史最高单局得分
 *   streak      当周连胜峰值（game.streakWeekMax）
 *   streakWeek  streak 所属周 key（Y-M-D 周一，与 game._weekKey 同公式）；
 *               opencontext 据此丢弃过期周的连胜（好友存档里上周的 streak 不该上榜）
 *
 * 纪律：
 *   - 最小写入间隔 SYNC_MIN_MS 节流（连胜快速连刷时避免高频写云存储）；
 *   - wx 缺失 / API 缺失 / 失败 → 静默跳过，绝不影响玩法；
 *   - 假好友榜（game.friendList 的 3 个本地假人）已随本功能下线。
 */

// 最小同步间隔（ms）：单局最快 ~15s，10s 节流下每局最多 1 次写入，防连战高频写
const SYNC_MIN_MS = 10000;

let _lastSyncAt = 0;

/** 周 key（Y-M-D 周一）：与 game._weekKey 完全同公式。周一 0 点起换周。 */
function weekKey(d) {
  const n = d || new Date();
  const day = (n.getDay() + 6) % 7; // 周一=0 ... 周日=6
  const t = new Date(n.getFullYear(), n.getMonth(), n.getDate() - day);
  return t.getFullYear() + '-' + (t.getMonth() + 1) + '-' + t.getDate();
}

/** 生成 KVDataList（纯函数，可单测） */
function buildKVDataList(game, wk) {
  const week = wk || weekKey();
  const pts = Math.max(0, Math.floor((game && game.arenaPts) || 0));
  const high = Math.max(0, Math.floor((game && game.highScore) || 0));
  // 连胜只在本周有效：streakWeek 不是本周 → 按 0 上报（好友端无需再判）
  const streakSameWeek = (game && game.streakWeek === week);
  const streak = streakSameWeek ? Math.max(0, Math.floor(game.streakWeekMax || 0)) : 0;
  return [
    { key: 'arenaPts', value: String(pts) },
    { key: 'highScore', value: String(high) },
    { key: 'streak', value: String(streak) },
    { key: 'streakWeek', value: week }
  ];
}

/**
 * 同步战绩到用户云存储（节流）。返回 true=本次真正发起了写入。
 * 触发点：game.noteBattleScore（每局胜利）。wx.onHide 时可再调 force 版本兜底。
 */
function syncLeaderboard(game, force) {
  try {
    if (typeof wx === 'undefined' || !wx.setUserCloudStorage) return false;
    const now = Date.now();
    if (!force && now - _lastSyncAt < SYNC_MIN_MS) return false;
    _lastSyncAt = now;
    wx.setUserCloudStorage({
      KVDataList: buildKVDataList(game),
      fail: function (e) {
        // 失败静默：榜单缺席不影响玩法；下次胜利会再试（节流窗口已重置）
        try { console.warn('[ldb] setUserCloudStorage fail', e && e.errMsg); } catch (e2) {}
      }
    });
    return true;
  } catch (e) { return false; }
}

/** 主域获取开放数据域上下文（渲染 sharedCanvas 用）；不可用返回 null（Node/旧基础库） */
function getOpenDataContext() {
  try {
    if (typeof wx !== 'undefined' && wx.getOpenDataContext) return wx.getOpenDataContext();
  } catch (e) {}
  return null;
}

module.exports = { weekKey, buildKVDataList, syncLeaderboard, getOpenDataContext, SYNC_MIN_MS };
