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

// ===================== 生死漏斗（P0-1 · 2026-10-31） =====================
// 五级漏斗：boot → first_draw(首抽) → first_battle(首战) → first_win(首胜) → d1_return(D1回访)
//
// 为什么另起 reportEvent 通道：branchId 必须在 MP 后台逐场景创建后回填（analyticsBranch
// 目前全空 = branch 通道线上不上报），而 wx.reportEvent 的事件名由代码定义，只需在
// MP 后台「运维中心 → WE分析 → 数据管理 → 上报管理」新建同名事件即可收数（一次配置）。
// 两通道互补：branch 看场景/维度分布，reportEvent 看漏斗转化率。
//
// 纪律（与 branch 通道同构）：
//   - 全部 once-per-install（storage 去重），重复调用不重复计数；
//   - 未在后台注册的事件，上报被微信静默丢弃 —— 绝不影响玩法；
//   - wx 缺失 / API 缺失 / 异常 → 静默跳过（Node 无头测试安全）；
//   - 统一上报 { count: 1 } 数值维度，后台可直接求和。

// 一次性配置：CONFIG.funnel = { enabled, prefix }（见 config.js 顶部注释）
let _funnelCfg = { enabled: true, prefix: 'bb_funnel_' };
try {
  const _cfg2 = require('./config');
  if (_cfg2 && _cfg2.CONFIG && _cfg2.CONFIG.funnel) _funnelCfg = _cfg2.CONFIG.funnel;
} catch (e) {}

// 本地日期 key（与 game._todayKey 同口径：本地时区零填充 YYYY-MM-DD。
// 此前若有两套口径会差一天，D1 判定必须与签到/每日重置一致）
function _dayKey(d) {
  const n = d || new Date();
  const m = n.getMonth() + 1, dd = n.getDate();
  return n.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (dd < 10 ? '0' + dd : dd);
}

// 安装日（首次启动那天）：第一次调用时写入 storage，此后恒定。
function _installDay() {
  try {
    if (typeof wx === 'undefined' || !wx.getStorageSync) return '';
    let day = wx.getStorageSync('bb_install_day');
    if (!day) {
      day = _dayKey();
      if (wx.setStorageSync) wx.setStorageSync('bb_install_day', day);
    }
    return String(day);
  } catch (e) { return ''; }
}

// storage 去重：该 key 已标记过 → true（并保证不重写）；未标记 → 标记并返回 false
function _onceMark(key) {
  try {
    if (typeof wx === 'undefined' || !wx.getStorageSync) return true; // 无 storage 视为已处理（不上报）
    if (wx.getStorageSync(key)) return true;
    if (wx.setStorageSync) wx.setStorageSync(key, 1);
    return false;
  } catch (e) { return true; }
}

// 底层：WE分析自定义事件。事件未在后台注册时微信静默丢弃，此处只做防御不感知。
function _reportEvent(name) {
  try {
    if (!_funnelCfg || !_funnelCfg.enabled) return;
    if (typeof wx === 'undefined' || !wx.reportEvent) return;
    wx.reportEvent(String(name), { count: 1 });
  } catch (e) {}
}

// 单步漏斗（once-per-install）：step = boot/first_draw/first_battle/first_win/d1_return
function _funnelOnce(step) {
  const key = 'bb_funnel_once_' + step;
  if (_onceMark(key)) return false;
  _reportEvent((_funnelCfg.prefix || 'bb_funnel_') + step);
  return true;
}

// 冷启动（每安装一次）。触发点 main.js 构造尾部，与 reportBoot 并列。
function reportFunnelBoot() { return _funnelOnce('boot'); }

// 首抽（每安装一次，含新号白送 6 连抽里的第一抽）。触发点 game.draw() 成功分支。
function reportFunnelFirstDraw() { return _funnelOnce('first_draw'); }

// 首战（每安装一次，胜/负都算；_startBattle 是全部开战路径唯一入口）。触发点 main._startBattle。
function reportFunnelFirstBattle() { return _funnelOnce('first_battle'); }

// 首胜（每安装一次）。触发点 spintop._settle 胜利分支。
function reportFunnelFirstWin() { return _funnelOnce('first_win'); }

// D1 回访（每安装一次）：启动时安装日恰好是昨天 → 该用户完成了"次日回访"。
// 跨过一天以上的回流不算 D1（那是 D3/D7 的事，后续需要再加一步即可）。
function reportFunnelD1Return() {
  try {
    const install = _installDay();
    if (!install) return false;
    const today = _dayKey();
    if (install === today) return false;                 // 安装当天启动，不算回访
    const yesterday = _dayKey(new Date(Date.now() - 86400000));
    if (install !== yesterday) return false;             // 隔了 2+ 天才回，不算 D1
    return _funnelOnce('d1_return');
  } catch (e) { return false; }
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
  FIRST_DONE_KEY,
  // 生死漏斗（P0-1）
  reportFunnelBoot,
  reportFunnelFirstDraw,
  reportFunnelFirstBattle,
  reportFunnelFirstWin,
  reportFunnelD1Return
};
