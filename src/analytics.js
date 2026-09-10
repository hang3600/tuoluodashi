/**
 * 零成本埋点（微信小游戏「场景分析 / 分支曝光上报」）
 * ==========================================================================
 * 传输：wx.reportUserBehaviorBranchAnalytics({ branchId, branchDim, eventType })
 *  - 这是**小游戏**官方数据分析接口（场景分析 / 分支曝光上报）。
 *    注意：wx.reportAnalytics 是「小程序」自定义分析接口，小游戏后台没有"事件管理"
 *    模块，调了也会被静默丢弃、后台查不到 —— 所以这里必须用分支上报。
 *  - branchId 来自 MP 后台（统计 → 基础数据 → 场景分析 → 场景管理）为每个场景分配的
 *    ID，写在 config.js 的 analyticsBranch。未配置（空串）时不上报，绝不报错、不影响玩法。
 *  - eventType：1=曝光，2=点击。这里 3 个事件都按"发生一次 = 曝光一次"上报。
 *  - branchDim：类型 String，取值 [1,100] 整数，仅当场景创建时勾了"参数设置"才统计。
 *      stage（关卡号，天然 1-100）直接塞进 branchDim，用于关卡分布 / 人均局数。
 *  - ver 维度：branchDim 仅接受 1-100 整数，放不下版本号字符串，故改用
 *      「发布前后时间段对比」—— 场景分析 DAY+1 出数，按 P0-1 上线日切前后两段看曲线，
 *      与"按版本切片"等价，还更省事。
 *
 * 所有调用对 wx 缺失 / API 缺失 / 异常做防御，Node 无头测试环境 require 安全。
 * 本模块不引入任何 npm 依赖，纯零成本。
 */

let _branchIds = {};
try {
  const _cfg = require('./config');
  _branchIds = (_cfg && _cfg.CONFIG && _cfg.CONFIG.analyticsBranch) || {};
} catch (e) {
  _branchIds = {};
}

// 进程内一次性守卫：避免异常重入时 boot 重复上报
let _bootFired = false;

// 底层上报：branchId 未配置 / wx 缺失 / API 缺失 / 异常 时静默跳过
function reportBranch(branchId, branchDim, eventType) {
  if (!branchId) return;                       // 未配置则不上报（避免空打）
  if (typeof wx === 'undefined' || !wx.reportUserBehaviorBranchAnalytics) return;
  try {
    // branchDim 必须 String 整数；非整数维度会被后台忽略不统计
    const dim = (branchDim == null) ? '' : String(branchDim);
    const et = (eventType === 2) ? 2 : 1;      // 仅 1/2 合法，默认 1=曝光
    wx.reportUserBehaviorBranchAnalytics({
      branchId: branchId,
      branchDim: dim,
      eventType: et
    });
  } catch (e) {
    // 埋点失败绝不能影响玩法
  }
}

// 冷启动：每进程仅一次（未配置 branchId 时直接跳过，不消耗本次启动）
function reportBoot() {
  if (!_branchIds.boot) return;
  if (_bootFired) return;
  _bootFired = true;
  reportBranch(_branchIds.boot, '', 1);
}

// 每局开始（stage 用于关卡分布 / 人均局数；天然 1-100，直接作为 branchDim）
function reportBattleStart(stage) {
  const dim = Math.max(1, Math.min(100, Math.floor(stage || 1)));
  reportBranch(_branchIds.battleStart, dim, 1);
}

// 首局完成去重键（按安装存储，一生一次）
const FIRST_DONE_KEY = 'bb_first_battle_done_reported';

function _firstDoneRead() {
  try {
    if (typeof wx !== 'undefined' && wx.getStorageSync) return !!wx.getStorageSync(FIRST_DONE_KEY);
  } catch (e) {}
  return false;
}

function _firstDoneMark() {
  try {
    if (typeof wx !== 'undefined' && wx.setStorageSync) wx.setStorageSync(FIRST_DONE_KEY, 1);
  } catch (e) {}
}

// 首局完成：每位用户（每安装）仅上报一次。
// 返回 true=本次真正上报；false=未配置或已上报过，跳过（去重）。
function reportFirstBattleDone() {
  const bid = _branchIds.firstBattleDone;
  if (!bid) return false;                       // 未配置不上报、不写去重
  if (_firstDoneRead()) return false;
  reportBranch(bid, '', 1);
  _firstDoneMark();
  return true;
}

// ===================== 新增 5 个漏斗（U10） =====================
// 全部复用 reportBranch + config.analyticsBranch，未配 branchId 零上报、
// wx 缺失/异常静默；与既有 3 个事件完全同构。

// 抽卡：tierIndex(0-4) 映射为 1-5，作为「抽到稀有度分布」维度。
// 触发点 game.js draw() 成功分支（返回 null=付不起，不报）。
function reportDraw(tierIndex) {
  const dim = Math.max(1, Math.min(5, Math.floor((tierIndex || 0) + 1)));
  reportBranch(_branchIds.draw, dim, 1);
}

// 合成：合成产物的 tierIndex(0-4) 映射为 1-5。
// 触发点 game.js tryMerge() 成功返回 merged 前。
function reportMerge(tierIndex) {
  const dim = Math.max(1, Math.min(5, Math.floor((tierIndex || 0) + 1)));
  reportBranch(_branchIds.merge, dim, 1);
}

// 战败：关卡 stage（天然 1-100）作为维度，与 battle_start 对齐。
// 触发点 main.js 战斗 result=lose 分支（_resultPlayed 守卫，每局一次）。
function reportBattleDefeat(stage) {
  const dim = Math.max(1, Math.min(100, Math.floor(stage || 1)));
  reportBranch(_branchIds.battleDefeat, dim, 1);
}

// 分享：无维度。触发点 game.js doShare() 成功（shareCount++ 后）。
function reportShare() {
  reportBranch(_branchIds.share, '', 1);
}

// 广告：激励视频看完（watchAdEnergy 成功），无维度。
// 触发点 game.js watchAdEnergy() 成功（adEnergyCount++ 后）。
function reportAdWatch() {
  reportBranch(_branchIds.adWatch, '', 1);
}

module.exports = {
  reportBoot,
  reportBattleStart,
  reportFirstBattleDone,
  reportDraw,
  reportMerge,
  reportBattleDefeat,
  reportShare,
  reportAdWatch,
  FIRST_DONE_KEY
};
