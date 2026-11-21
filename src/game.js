/**
 * 游戏核心逻辑：背包、图鉴、合成（打磨版）
 * - 存档 schema 版本号 + JSON 持久化
 * - storage 读写 try-catch
 * - inventory 硬上限 400，超限自动折价变卖，避免 storage 爆满崩档
 */

const { Beyblade, TIERS, randomBeyblade, rollTraits, traitById } = require('./beyblade');
const { clamp } = require('./utils');
const { reportDraw, reportMerge, reportShare, reportAdWatch, reportFunnelFirstDraw } = require('./analytics'); // 零成本埋点：抽卡/合成/分享/广告漏斗（U10）+ 生死漏斗·首抽（P0-1）
const { CONFIG } = require('./config');
const { syncLeaderboard } = require('./leaderboard'); // P0-2：战绩云存储同步（开放数据域好友榜）

// D1 留客钩子改版（2026-11-20 · 数据驱动）：旧表第 2/4/6 天只发能量——能量 6 秒/点自动回满，
// 体感≈0，是"签到来了也白来"的病根（后台 30 天曲线：D1 留存几乎全 0）。
// 改为第 2/4/6 天发「免费抽卡券」（明天回来 = 免费抽一陀螺，硬通货）；金币日常照旧，第 7 天大奖不变。
const SIGN_REWARDS = [
  { coins: 60,  energy: 0,  freeDraw: 0, beyblade: null },
  { coins: 0,   energy: 20, freeDraw: 1, beyblade: null },
  { coins: 120, energy: 0,  freeDraw: 0, beyblade: null },
  { coins: 0,   energy: 40, freeDraw: 1, beyblade: null },
  { coins: 200, energy: 0,  freeDraw: 0, beyblade: null },
  { coins: 0,   energy: 60, freeDraw: 1, beyblade: null },
  { coins: 300, energy: 80, freeDraw: 0, beyblade: { tierIndex: 4, level: 1 } }
];

const STORAGE_KEY = 'beyblade_master_save_v2';
const SCHEMA_VERSION = 2;
const INVENTORY_HARD_CAP = 400;

/**
 * 金币应急抽卡单价 —— 金币目前唯一的消耗出口。
 * 能量是免费途径（6/秒自动回满），金币是「用积累换速度」的付费途径，二者并行。
 * 定价依据（按下调后的对战产出）：新手 ~35 金币/局、中阶 ~105、高阶 ~2020，
 * 300 的定价让金币抽卡始终是「补最后几次」的加速手段，不会取代等回能。
 * 调平衡只需改这一个数。
 */
const COIN_DRAW_COST = 300;

/**
 * 抽卡隐藏插屏：单日展示上限。
 * 配合微信平台对插屏的频控（两次最小间隔约 60s、单用户单日也有上限），
 * 这里再设一道业务层上限做节流 + 防过度广告伤留存。达到后当日不再弹。
 */
const DRAW_INTERSTITIAL_DAILY_CAP = 12;
const HOME_INTERSTITIAL_DAILY_CAP = 2; // 首页插屏每日上限（弹点=结算返回首页；首日/首次启动不弹，之后每日<=2次）

// P1-6 挑战券（稀缺+裂变，2026-10-31）：每日 5 张免费开战券 + 广告/分享各加发 2 张。
// 消耗顺序：免费券 → 加发券 → 能量门票(20)。只作用于「新开一局」；
// 连胜中的「再战」仍走原免票路径（main._battleAgain），不过此层。
const FREE_TICKETS_PER_DAY = 5;
const TICKET_AD_DAILY_CAP = 3;   // 每日看广告得券次数（每次 +2）
const BONUS_TICKET_CAP = 12;     // 加发券持有上限（3 次广告 + 3 次分享 = 12）

class GameState {
  constructor() {
    this.coins = 0;
    this.energy = 150;
    this.maxEnergy = 150;
    this.inventory = [];
    this.collection = [];
    this.platformSlots = [null, null, null];
    this.battleBbId = null;       // 出战陀螺持久选中 id（选项B：选陀螺面板落地，跨会话记住）
    this.battleSelectId = null;   // 选陀螺面板瞬时高亮（纯 UI，不入存档）
    this.battleSelectPage = 0;    // 选陀螺面板分页（纯 UI，不入存档）
    this.battleSelectT = 0;       // 选陀螺面板入场动画计时（纯 UI，不入存档）
    this.battleSelectPages = 1;   // 选陀螺面板总页数（由 render 每帧回写，供翻页边界判定）
    this.battleSelectOpen = false;// 选陀螺面板开关（纯 UI，不入存档）
    this.battleSelectFlashId = null; // 点选脉冲高亮的陀螺 id（纯 UI，不入存档）
    this.battleSelectFlashT = 0;     // 点选脉冲剩余秒数（每帧递减，纯 UI，不入存档）
    this.battleSelectHinted = false; // 「已选择 XX · 点开始对战」toast 是否已弹过（入存档：只给新用户弹一次）
    this.filterTier = -1;
    this.invPage = 0; // 背包分页（纯 UI，不入存档；切筛选/出售后由 render 收敛）
    this.sellConfirm = null; // 出售二次确认：{ beyblade, gain }，null 表示无确认弹窗
    this.mode = 'main';
    this.view = 'main';
    this.lastSave = 0;
    this._lastSaveSig = null;   // 上次落盘状态签名；无变化则不写盘（避免每帧无谓序列化/阻塞）

    this.shareDate = '';
    this.shareCount = 0;
    this.refillDate = '';
    this.refillCount = 0;

    this.winStreak = 0;   // 对局连胜数：影响目标分数难度曲线，失败清零

    // 双人合作守关战绩（纯战绩，不发金币/段位/能量，见 spintop _settle coop 闸门）
    this.coopStage = 0;           // 合作通关最高关卡（仅战绩）
    this.coopWins = 0;            // 合作通关次数（仅战绩）

    // 批次D·收尾（play-design v1）：隐藏传说彩蛋 / 对战掉落宝箱 / 好友助力
    this.mergeCount = 0;          // 累计合成次数（隐藏彩蛋触发条件）
    this.hiddenDrops = 0;         // 已获得隐藏传说次数（限次）
    this.battleChest = null;      // 待开竞技宝箱（{ quality: 0-2, count }，纯 UI 待开）
    this.chestOpenDate = '';      // 开箱日期（每日 1 次直接开）
    this.chestAdCount = 0;        // 当日看广告开箱次数
    this.boostDate = '';          // 助力日期（每日重置）
    this.boostCount = 0;          // 当日已领助力次数（上限 5 次）
    this.resultDoubleDate = '';   // 结算翻倍日期（跨天归零）
    this.resultDoubleCount = 0;   // 当日已看「胜利翻倍」次数
    // P0-2 开放数据域好友榜（替代旧版本地模拟的假好友最高分——8000 硬编码，已删除）：
    this.highScore = 0;           // 历史最高单局得分（真数据，上云存储供好友榜用）
    this.streakWeek = '';         // 当周连胜峰值所属周 key（Y-M-D 周一）
    this.streakWeekMax = 0;       // 当周连胜峰值（上云存储供「连胜榜」用）
    this.ldbBoard = 'arena';      // 好友榜面板当前页签（arena/high/streak，纯 UI 不入存档）

    // P1-5 激斗周末 / P1-6 挑战券 / P1-7 影子战（2026-10-31）
    this.weekShopWeek = '';       // 周末商店限购所属周 key（周一换周清零）
    this.weekShopBought = null;   // 本周已购 { energy, coupon, legend }（周一清零）
    this.weekShopOpen = false;    // 周末限时商店面板开关（纯 UI 不入存档）
    this.weekShopT = 0;           // 周末商店入场动画计时（纯 UI）
    this.ticketDate = '';         // 挑战券每日重置日期 key
    this.freeTicketsUsed = 0;     // 今日已用免费挑战券（每日 5 张）
    this.bonusTickets = 0;        // 加发挑战券余额（广告/分享获得，当日有效）
    this.ticketAdCount = 0;       // 今日看广告得券次数（每日 3 次）
    this.ghostStage = 1;          // 影子战：历史最佳纪录局的关卡号（与 highScore 同源）

    // P2 细度 / P2-6 / P2-7（2026-10-31）
    this.codexNudged = false;     // 首次收卡图鉴引导是否已展示（一次性，入存档）
    this.codexGlowT = 0;          // 图鉴入口呼吸光晕剩余秒数（纯 UI 不入存档）
    this.welfareOpen = false;     // 福利中心面板开关（纯 UI 不入存档）
    this.welfareT = 0;            // 福利中心入场动画计时（纯 UI）
    this.arenaPeakTier = -1;      // 赛季荣耀：历史最高段位 index（-1=尚无结算记录，入存档）
    this.arenaMasterGranted = false; // 首达大师段位是否已发赛季限定奖励（入存档）
    this.battleChestOpen = false; // 竞技宝箱弹窗开关（纯 UI）
    this.battleChestT = 0;        // 宝箱弹窗入场动画计时（纯 UI）
    this.chestAdBroken = false;   // 广告不可用标志（运行时，单次看广告失败触发降级兜底）
    this.boostOpen = false;       // 好友助力弹窗开关（纯 UI）
    this.boostT = 0;              // 助力弹窗入场动画计时（纯 UI）

    // 保底抽卡（play-design v1）：史诗保底 10 抽、传说保底 30 抽
    this.pityEpic = 0;    // 距上次抽到史诗/传说的抽数（连续未出史诗+）
    this.pityLegend = 0;  // 距上次抽到传说的抽数（连续未出传说）

    // 每日挑战（play-design v1）：3 个日常任务 → 活跃度满 100 开当日宝箱
    this.dailyDate = '';          // 当日日期 key（用于每日刷新）
    this.dailyTasks = [0, 0, 0];  // [对战, 合成, 抽卡] 当日完成数
    this.dailyActive = 0;         // 当日活跃度 0-100
    this.dailyChestClaimed = false; // 今日宝箱是否已领
    this.dailyOpen = false;       // 每日任务面板开关（纯 UI，不入存档）
    this.dailyT = 0;              // 面板入场动画计时（纯 UI）

    // 竞技场天梯（play-design v1）：周赛积分制，段位 青铜→白银→黄金→铂金→钻石→大师
    this.arenaPts = 0;            // 本周竞技积分
    this.arenaWeek = '';          // 本周周 key（周一），用于跨周结算
    this.arenaBest = 0;           // 本周单局最高分（排名炫耀资本）
    this.arenaClaimedWeek = '';   // 已结算奖励的周 key（防重复发奖）
    this.arenaOpen = false;       // 竞技场面板开关（纯 UI，不入存档）
    this.arenaT = 0;              // 面板入场动画计时（纯 UI）
    this.homeV2 = true;           // 主界面游戏化骨架开关（纯 UI，不入存档）：false = 回退旧大厅三段式
    this.invRailV2 = true;        // 背包陈列轨道开关（纯 UI，不入存档）：false = 回退网格列表
    this.quickBattleV2 = true;    // 快速开战开关（纯 UI，不入存档）：false = 主按钮先弹局前增益面板

    // 大师等级（play-design v1）：全局经验成长线，升级提升能量上限 + 里程碑奖励
    this.exp = 0;                 // 全局经验
    this.level = 1;               // 大师等级（1 起）
    this._levelUpReward = null;   // 升级奖励提示（纯 UI，不入存档）

    // 图鉴阶段奖励（play-design v1）：收集 5/10/15/25 档发阶段大奖
    this.codexClaimed = 0;        // 已领到的阶段位（0 / 5 / 10 / 15 / 20）
    this._masterSkin = false;     // 全图鉴·大师限定皮肤标记（纯展示，不入存档可）
    this.levelOpen = false;       // 大师等级面板开关（纯 UI，不入存档）
    this.levelT = 0;              // 等级面板入场动画计时（纯 UI）

    this.drawCard = null; // 抽卡动画态 { bb, t, phase }——纯 UI，不入存档

    this.tutorialDone = true; // 新手引导已去除（用户要求不再显示）
    this.tutorialStep = 2;

    // 首程直达（2026-09-04 数据诊断：首分钟流失 61%、首日时长 2.1min vs 标杆 12.9min，
    // 根因是玩法释放速度而非广告）——不打断、不弹窗、无遮罩的 2 步轻引导：
    //   obStep 1 = 新档无陀螺 → 高亮「抽卡」；抽到第一只 → 2 = 高亮「对战」；首胜收起。
    // obDone 持久化防老玩家误触发（load 时 level>1 的老档直接视为已完成）。
    this.obStep = 1;
    this.obDone = false;
    this.obTries = 0;   // 引导期连败计数（≥3 强制收起，防失败玩家被持续打扰）
    this.adEnergyDate = '';
    this.adEnergyCount = 0;

    // 抽卡隐藏插屏广告（第3/6/9抽必弹 + 随机补；原「看广告免费抽」按钮已移除，合并为隐藏式）
    this.drawsSinceAd = 0;        // 累计抽卡次数（用于"每3抽"判定；跨会话持久化防靠重启刷次数）
    this.interAdDate = '';        // 插屏广告每日计数日期 key
    this.interAdCount = 0;        // 当日已弹插屏次数（每日上限见 DRAW_INTERSTITIAL_DAILY_CAP）
    this.interAdBroken = false;   // 插屏不可用降级标志（运行时，连续不可用触发，成功展示/次日清除）
    // 进首页插屏门控（与抽卡隐藏插屏独立计数）：首日/首次启动不弹 + 每日上限 HOME_INTERSTITIAL_DAILY_CAP 次
    this.homeInterInstallDate = '';  // 首次启动日期（记录后当天不弹，跨日后放开）
    this.homeInterAdDate = '';       // 首页插屏每日计数日期 key
    this.homeInterAdCount = 0;       // 当日已弹首页插屏次数
    this.battleTutShown = false;   // 对战「滑动屏幕抽打陀螺」新手提示仅首场前两鞭展示一次，之后永不

    this.signDate = '';
    this.signDay = 0;
    this.signClaimed = false;
    this.signOpen = false;
    this.signT = 0; // 签到面板入场动画计时（纯 UI，不入存档）
    this.signStreak = 0;           // 连续签到天数（签到升级版：满 7 进入双倍日）
    this.signMakeupDate = '';      // 补签日期（每日限 1 次）
    this._streakBeforeReset = 0;   // 断签前连续天数（补签恢复用，纯 UI 辅助）

    // 离线回归奖励（play-design v1）：离线 ≥6h 回归领礼包，≥24h 升级大礼包
    this.lastSeen = 0;             // 上次活跃时间戳（save 时更新）
    this.offlineRewardDate = '';   // 回归奖励领取日期（每日 1 次）
    this.offlineOpen = false;      // 回归礼包弹窗开关（纯 UI）
    this.offlineMs = 0;            // 本次离线时长（ms，启动时计算）
    this.freeDraws = 0;            // 免费抽卡券（签到第2/4/6天 + 分享发放；抽卡时优先消耗，不扣能量/金币）
    this.returnT = 0;              // 回归礼包弹窗入场动画计时（纯 UI）
    this.buffT = 0;               // 局前 buff 弹窗入场动画计时（纯 UI）
    this.runBuffT = 0;            // 连战三选一浮层入场动画计时（纯 UI）
    this._pendingReturn = null;    // 待领回归奖励类型（normal/grand，纯 UI）
    this.clubGuideOpen = false; // 游戏圈引导浮层是否显示（纯 UI，不入存档）
    this._shareEntryClaimed = false;

    this._initCollection();
    this.load();
    this._checkShareEntry();
  }

  _checkShareEntry(opts) {
    if (this._shareEntryClaimed) return;
    try {
      if (!opts && typeof wx !== 'undefined' && wx.getLaunchOptionsSync) {
        opts = wx.getLaunchOptionsSync();
      }
      const q = (opts && opts.query) || {};
      if (q.from === 'share') {
        this.coins += 50;
        this.energy = Math.min(this.maxEnergy, this.energy + 30);
        this._shareEntryClaimed = true;
      }
    } catch (e) {}
  }

  // 游戏圈引导：每天最多弹一次（独立存储键，不混入主存档）
  maybeOpenClubGuide() {
    // 游戏圈引导弹窗已去除（用户要求不再弹出"来游戏圈点个赞"提示）
    return false;
  }

  closeClubGuide() { this.clubGuideOpen = false; }

  _initCollection() {
    for (let t = 0; t < TIERS.length; t++) {
      for (let l = 1; l <= 5; l++) {
        this.collection.push({ tierIndex: t, level: l, unlocked: false });
      }
    }
  }

  /**
   * 抽一次卡。
   * @param {boolean} useCoins 传 true 则用金币支付（能量不足时的应急抽卡，金币的唯一出口）；
   *                           传 false / 省略则走能量（免费途径）。
   * @returns {Beyblade|null} 支付不起时返回 null，调用方负责提示。
   */
  draw(useCoins = false, free = false) {
    if (!free) {
      if (useCoins) {
        if (this.coins < COIN_DRAW_COST) return null;
        this.coins -= COIN_DRAW_COST;
      } else {
        if (this.energy < 8) return null;
        this.energy -= 8;
      }
    }
    const bb = this._rollWithPity();
    let convertedCoins = 0;
    if (this.inventory.length < INVENTORY_HARD_CAP) {
      this.inventory.push(bb);
    } else {
      convertedCoins = Math.max(1, Math.floor(bb.power * 0.1));
      this.coins += convertedCoins;
    }
    this.lastDrawConverted = convertedCoins; // 0=已入背包；>0=背包满折算金币（供 UI 区分卡牌动画/金币反馈）
    this.unlockCollection(bb.tierIndex, bb.level);
    this.recordDailyTask('draw'); // 每日挑战：抽卡任务
    this.addExp(10);              // 大师等级：抽卡 +10 经验
    reportDraw(bb.tierIndex);     // 零成本埋点：抽卡漏斗（稀有度维度 1-5）
    reportFunnelFirstDraw();      // 生死漏斗（P0-1）：首抽（每安装一次；新号白送 6 连抽即覆盖）
    if (!this.obDone && this.obStep === 1) this.obStep = 2; // 首程引导：抽到第一只 → 引导去对战
    // 限时活动（play-design v1）：节日期间抽卡 20% 概率额外掉落限定陀螺
    this._festivalDrop = null;
    if (typeof this.activityInfo === 'function' && this.activityInfo().festival && Math.random() < 0.2) {
      const extra = randomBeyblade();
      extra.traits = rollTraits(1);   // P0-3：节日掉落同样带 1 条词条
      if (this.inventory.length < INVENTORY_HARD_CAP) {
        this.inventory.push(extra);
        this.unlockCollection(extra.tierIndex, extra.level);
        this._festivalDrop = extra;
      } else {
        this.coins += Math.max(1, Math.floor(extra.power * 0.1));
      }
    }
    return bb;
  }

  /**
   * 首程引导收口（对战结束时由 main.js 调用）。
   * 首胜即完成；连败 3 场兜底强制收起（防失败玩家被持续高亮打扰）。
   * @param {boolean} win 本局是否胜利
   * @returns {boolean} true = 本次调用收起了引导（可用于埋点/提示）
   */
  onBattleEnd(win) {
    if (this.obDone) return false;
    if (win || ++this.obTries >= 3) {
      this.obDone = true;
      this.obStep = 0;
      return true;
    }
    return false;
  }

  /** 保底抽卡：史诗 10 抽保底、传说 30 抽保底（play-design v1），进度可读 pityEpic/pityLegend */
  _rollWithPity() {
    this.pityEpic = (this.pityEpic || 0) + 1;
    this.pityLegend = (this.pityLegend || 0) + 1;
    let bb;
    if (this.pityLegend >= 30) {
      bb = new Beyblade(4, 1);   // 传说保底：必出白虎（TIERS[4]）
    } else if (this.pityEpic >= 10) {
      bb = new Beyblade(2, 1);   // 史诗保底：必出玄武（TIERS[2]）
    } else {
      bb = randomBeyblade();
    }
    if (bb.tierIndex >= 2) this.pityEpic = 0;   // 出了史诗+ → 史诗保底计数清零
    if (bb.tierIndex >= 4) this.pityLegend = 0; // 出了白虎 → 传说保底计数清零
    bb.traits = rollTraits(1);                  // P0-3：抽到的陀螺天生 1 条词条
    return bb;
  }

  // =====================================================
  // 每日挑战（play-design v1）：3 个日常任务 → 活跃度满 100 开当日宝箱
  // 任务：完成 3 局对战(+40) / 合成 3 次(+30) / 抽卡 3 次(+30)
  // =====================================================
  /**
   * 本地日期 key（零填充 YYYY-MM-DD）—— 全项目「今日」判定的唯一口径。
   * ⚠️ 此前混用两套口径：toISOString().slice(0,10) 取的是 UTC，getDate() 取的是本地。
   *    在 UTC+8 下本地 00:00–08:00 两者差一天，导致签到/开箱/助力/分享/广告能量
   *    在同一天里被判定为跨天 → 可重复领取。现统一为本地日期。
   *    零填充是为了与历史存档里 toISOString 写下的字面格式保持一致，
   *    老玩家在非凌晨时段存下的日期能平滑衔接，不会被误判成跨天。
   */
  _todayKey() {
    const n = new Date();
    const m = n.getMonth() + 1, d = n.getDate();
    return n.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (d < 10 ? '0' + d : d);
  }

  /** 相对今天偏移 offsetDays 天的本地日期 key（传 -1 取昨天）。
   *  用 Date 构造而非 Date.now() - 86400000：后者在跨月/夏令时边界会算错。 */
  _dayKeyOffset(offsetDays) {
    const n = new Date();
    const t = new Date(n.getFullYear(), n.getMonth(), n.getDate() + offsetDays);
    const m = t.getMonth() + 1, d = t.getDate();
    return t.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (d < 10 ? '0' + d : d);
  }

  _dailyKey() {
    return this._todayKey();
  }

  _checkDailyReset() {
    const k = this._dailyKey();
    if (this.dailyDate !== k) {
      this.dailyDate = k;
      this.dailyTasks = [0, 0, 0];
      this.dailyActive = 0;
      this.dailyChestClaimed = false;
    }
  }

  // 每日任务进度表：[{ key, name, icon, cur, goal, active }]
  dailyTasksMeta() {
    return [
      { key: 'battle', name: '对战', icon: 'daily-battle', cur: this.dailyTasks[0], goal: 3, active: 40 },
      { key: 'merge',  name: '合成', icon: 'daily-merge',  cur: this.dailyTasks[1], goal: 3, active: 30 },
      { key: 'draw',   name: '抽卡', icon: 'daily-draw',   cur: this.dailyTasks[2], goal: 3, active: 30 }
    ];
  }

  // 记录一次任务行为（对战 / 合成 / 抽卡），进度封顶 goal，活跃度封顶 100
  recordDailyTask(type) {
    this._checkDailyReset();
    const meta = this.dailyTasksMeta();
    const idx = meta.findIndex(m => m.key === type);
    if (idx < 0) return;
    if (this.dailyTasks[idx] < meta[idx].goal) {
      this.dailyTasks[idx] += 1;
      this.dailyActive = Math.min(100, this.dailyActive + meta[idx].active);
    }
  }

  // 领取当日宝箱：活跃度满 100 且未领 → 随机金币 / 能量 / 稀有陀螺；已领或未满返回 null
  claimDailyChest() {
    this._checkDailyReset();
    if (this.dailyActive < 100 || this.dailyChestClaimed) return null;
    this.dailyChestClaimed = true;
    const roll = Math.random();
    if (roll < 0.4) {
      this.coins += 300;
      return { type: 'coins', value: 300 };
    } else if (roll < 0.75) {
      this.energy = Math.min(this.maxEnergy, this.energy + 60);
      return { type: 'energy', value: 60 };
    }
    // 30%：随机玄武陀螺
    const bb = new Beyblade(2, 1);
    bb.traits = rollTraits(1);   // P0-3
    if (this.inventory.length < INVENTORY_HARD_CAP) {
      this.inventory.push(bb);
      this.unlockCollection(bb.tierIndex, bb.level);
      return { type: 'top', value: '玄武陀螺' };
    }
    this.coins += 200;
    return { type: 'coins', value: 200 };
  }

  // =====================================================
  // 竞技场天梯（play-design v1）：周赛积分制，段位 青铜→白银→黄金→铂金→钻石→大师
  // 每局对战胜利按得分折算竞技积分，跨周（周一 0 点）按段位发赛季奖励并重置
  // =====================================================
  _weekKey() {
    const n = new Date();
    const day = (n.getDay() + 6) % 7; // 周一=0 ... 周日=6
    const d = new Date(n.getFullYear(), n.getMonth(), n.getDate() - day);
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  // 竞技场段位表：升段所需累计积分 + 周结算奖励
  static arenaTiers() {
    return [
      { name: '青铜', pts: 0,    reward: { coins: 200 },                    color: '#cd7f32', icon: 'rank-bronze' },
      { name: '白银', pts: 500,  reward: { coins: 400, energy: 20 },        color: '#c0c8d4', icon: 'rank-silver' },
      { name: '黄金', pts: 1500, reward: { coins: 800, energy: 40 },        color: '#ffc107', icon: 'rank-gold' },
      { name: '铂金', pts: 3000, reward: { coins: 1500, energy: 60 },       color: '#4dd0e1', icon: 'rank-platinum' },
      { name: '钻石', pts: 5000, reward: { coins: 2500, energy: 80 },       color: '#4fc3f7', icon: 'rank-diamond' },
      { name: '大师', pts: 8000, reward: { coins: 4000, energy: 120 },      color: '#ffd54f', icon: 'rank-master' }
    ];
  }

  // 当前段位（含 index）
  arenaTier() {
    const tiers = GameState.arenaTiers();
    for (let i = tiers.length - 1; i >= 0; i--) {
      if (this.arenaPts >= tiers[i].pts) return { index: i, ...tiers[i] };
    }
    return { index: 0, ...tiers[0] };
  }

  // 距下一段位所需积分（大师返回 0 表示已满级）
  arenaToNext() {
    const tiers = GameState.arenaTiers();
    const t = this.arenaTier();
    if (t.index >= tiers.length - 1) return 0;
    return tiers[t.index + 1].pts - this.arenaPts;
  }

  // 跨周结算：周 key 变化时，按上周段位发赛季奖励并重置本周积分/最高分。
  // P2-7 赛季制：结算时更新历史最高段位（赛季荣耀），首达大师发「赛季限定·大师白虎」。
  _checkArenaReset() {
    const k = this._weekKey();
    if (this.arenaWeek !== k) {
      if (this.arenaWeek !== '' && this.arenaClaimedWeek !== this.arenaWeek) {
        const t = this.arenaTier();
        const r = t.reward || {};
        this.coins += r.coins || 0;
        this.energy = Math.min(this.maxEnergy, this.energy + (r.energy || 0));
        this.arenaClaimedWeek = this.arenaWeek;
        this._arenaWeekReward = { tier: t.name, coins: r.coins || 0, energy: r.energy || 0 };
        // 赛季荣耀：历史最高段位（只升不降）
        if (t.index > (this.arenaPeakTier == null ? -1 : this.arenaPeakTier)) this.arenaPeakTier = t.index;
        // 首达大师 → 赛季限定陀螺「大师白虎」Lv3（双词条，一次性）
        if (t.index >= 5 && !this.arenaMasterGranted) {
          this.arenaMasterGranted = true;
          const master = new Beyblade(4, 3);
          master.traits = rollTraits(2);
          if (this.inventory.length < INVENTORY_HARD_CAP) {
            this.inventory.push(master);
            this.unlockCollection(4, 3);
          } else {
            this.coins += Math.max(1, Math.floor(master.power * 0.1));
          }
          this._arenaWeekReward.master = true;
        }
      }
      this.arenaWeek = k;
      this.arenaPts = 0;
      this.arenaBest = 0;
    }
  }

  /** 赛季荣耀（竞技场面板展示用）：历史最高段位名 / 是否已获大师限定 */
  arenaPeakMeta() {
    const tiers = GameState.arenaTiers();
    const idx = (this.arenaPeakTier == null || this.arenaPeakTier < 0) ? -1 : Math.min(this.arenaPeakTier, tiers.length - 1);
    return {
      peakIndex: idx,
      peakName: idx >= 0 ? tiers[idx].name : '',
      masterGranted: !!this.arenaMasterGranted
    };
  }

  // =====================================================
  // P2-6 福利中心：签到 / 每日任务 / 好友助力 合并单入口（纯状态聚合，不改各面板逻辑）
  // =====================================================
  welfareMeta() {
    this._checkDailyReset();
    const today = this._todayKey();
    const signDue = (this.signDate !== today) || !this.signClaimed;
    const dailyChestReady = this.dailyActive >= 100 && !this.dailyChestClaimed;
    const dailyDue = this.dailyActive < 100 || !this.dailyChestClaimed;
    const boostDue = this.canClaimBoost();
    return {
      rows: [
        {
          key: 'sign', name: '每日签到', action: 'welfare_go_sign',
          sub: signDue ? ('今日未签 · 连续 ' + (this.signStreak || 0) + ' 天') : '今日已签 · 明天再来',
          due: signDue
        },
        {
          key: 'daily', name: '每日任务', action: 'welfare_go_daily',
          sub: dailyChestReady ? '宝箱可领取！' : ('活跃度 ' + (this.dailyActive || 0) + '/100'),
          due: dailyDue
        },
        {
          key: 'boost', name: '好友助力', action: 'welfare_go_boost',
          sub: boostDue ? ('可领 ' + (5 - (this.boostCount || 0)) + '/5 次') : '今日已领完',
          due: boostDue
        }
      ],
      anyDue: signDue || dailyDue || boostDue
    };
  }

  /** 首次收卡图鉴引导（一次性）：返回 true 表示本次是首次（调用方据此 toast + 点亮光晕） */
  nudgeCodex() {
    if (this.codexNudged) return false;
    this.codexNudged = true;
    return true;
  }

  // 每局对战结算调用：竞技积分 += 得分折算（得分/20，至少 1 点）；记录本周最高分。
  // P1-5：isBoss=true 且激斗周末进行中 → 竞技积分 ×2（平日攒、周末爆的节律钩子）。
  addArenaScore(score, isBoss) {
    this._checkArenaReset();
    let gained = Math.max(1, Math.floor((score || 0) / 20));
    try {
      if (isBoss && this.activityInfo && this.activityInfo().weekendDouble) gained *= 2;
    } catch (e) {}
    this.arenaPts += gained;
    if ((score || 0) > this.arenaBest) this.arenaBest = score;
    return gained;
  }

  // =====================================================
  // P1-6 挑战券（稀缺+裂变）：每日 5 张免费 + 广告/分享各加发 2 张
  // 次数限制本身就是分享动机；能量门票退为深层保底，等待感被"裂变得券"替代。
  // =====================================================
  _checkTicketReset() {
    const today = this._todayKey();
    if (this.ticketDate !== today) {
      this.ticketDate = today;
      this.freeTicketsUsed = 0;
      this.bonusTickets = 0;
      this.ticketAdCount = 0;
    }
  }

  /** 今日剩余免费挑战券（0-5） */
  freeTicketsLeft() {
    this._checkTicketReset();
    return Math.max(0, FREE_TICKETS_PER_DAY - (this.freeTicketsUsed || 0));
  }

  /**
   * 消耗一张开战凭证（新开一局时调用）：免费券 → 加发券 → 能量门票。
   * @returns {{type:'free'|'bonus'|'energy', left:number}|null} null=三种凭证都不足
   */
  consumeBattleTicket() {
    this._checkTicketReset();
    if ((this.freeTicketsUsed || 0) < FREE_TICKETS_PER_DAY) {
      this.freeTicketsUsed++;
      return { type: 'free', left: FREE_TICKETS_PER_DAY - this.freeTicketsUsed };
    }
    if ((this.bonusTickets || 0) > 0) {
      this.bonusTickets--;
      return { type: 'bonus', left: this.bonusTickets };
    }
    if ((this.energy || 0) >= 20) {
      this.energy -= 20;
      return { type: 'energy', left: Math.floor(this.energy) };
    }
    return null;
  }

  /**
   * 加发挑战券（看广告/分享后调用）。
   * @param {number} n 想加发的张数（调用方按 2 传）
   * @param {'ad'|'share'} source 广告受 TICKET_AD_DAILY_CAP 限（每日 3 次），分享复用 canShare 的每日 3 次上限
   * @returns {number} 实际加发张数（受上限钳制后可能 <n 或 0）
   */
  grantBonusTickets(n, source) {
    this._checkTicketReset();
    let budget = Math.max(0, Math.floor(n || 0));
    if (source === 'ad') budget = Math.min(budget, Math.max(0, TICKET_AD_DAILY_CAP - (this.ticketAdCount || 0)));
    budget = Math.min(budget, Math.max(0, BONUS_TICKET_CAP - (this.bonusTickets || 0)));
    if (budget <= 0) return 0;
    if (source === 'ad') this.ticketAdCount = (this.ticketAdCount || 0) + budget;
    this.bonusTickets = (this.bonusTickets || 0) + budget;
    return budget;
  }

  /** 广告得券是否还有当日名额（UI 置灰用） */
  canEarnAdTickets() {
    this._checkTicketReset();
    return (this.ticketAdCount || 0) < TICKET_AD_DAILY_CAP;
  }

  // 竞技场面板数据：段位 / 积分 / 距下一段 / 本周最高分 / 赛季剩余天数
  arenaMeta() {
    this._checkArenaReset();
    const t = this.arenaTier();
    const tiers = GameState.arenaTiers();
    const toNext = this.arenaToNext();
    // 赛季剩余：本周日 24:00 前
    const n = new Date();
    const day = (n.getDay() + 6) % 7;
    const sunday = new Date(n.getFullYear(), n.getMonth(), n.getDate() + (6 - day), 23, 59, 59);
    const remainDays = Math.max(0, Math.ceil((sunday - n) / 86400000));
    return {
      tierIndex: t.index,
      tierName: t.name,
      tierColor: t.color,
      tierIcon: t.icon,
      pts: this.arenaPts,
      toNext: toNext,
      nextName: t.index < tiers.length - 1 ? tiers[t.index + 1].name : '',
      best: this.arenaBest,
      remainDays: remainDays
    };
  }

  // =====================================================
  // 大师等级（play-design v1）：全局经验成长线
  // 经验来源：对战胜利+50 / 合成+20 / 抽卡+10；升级提升能量上限+5
  // =====================================================
  levelNextExp(level) { return (level || 1) * 80; } // 升到下一级所需经验（当前级内）

  levelMeta() {
    const lv = Math.max(1, this.level || 1);
    const prev = (lv - 1) * 80;
    return {
      level: lv,
      inLv: Math.max(0, this.exp - prev),          // 本级内经验
      need: this.levelNextExp(lv),                  // 本级升级所需
      cap: Math.min(50, this.maxEnergy || 150)      // 当前能量上限
    };
  }

  // 加经验，自动连续升级；返回是否升级（供 toast）
  addExp(amount) {
    if (!amount || amount <= 0) return false;
    this.exp += amount;
    let lv = this.level || 1;
    let leveled = false;
    while (lv < 50 && this.exp >= lv * 80) {
      lv++;
      this.maxEnergy = Math.min(9999, (this.maxEnergy || 150) + 5); // 每级能量上限+5
      leveled = true;
    }
    if (leveled) {
      this.level = lv;
      // 里程碑：每 5 级送玄武保底券（= 下一抽必出玄武）
      // _rollWithPity 是先 +1 再判 >=10，置 9 才等价于「下一抽触发」；置 0 反而要再攒 10 抽。
      if (lv % 5 === 0 && this.pityEpic < 9) {
        this.pityEpic = 9;
        this._levelUpReward = { level: lv, bonus: '玄武保底券' };
      } else {
        this._levelUpReward = { level: lv, bonus: '能量上限+5' };
      }
    }
    return leveled;
  }

  // =====================================================
  // 图鉴阶段奖励（play-design v1）：收集 5/10/15/25 档发阶段大奖
  // =====================================================
  codexStages() {
    return [
      { n: 5,  title: '初窥门径',     reward: { coins: 500 } },
      { n: 10, title: '收藏新秀',     reward: { coins: 200, energy: 50 } },
      { n: 15, title: '图鉴专家',     reward: { coins: 500, energy: 80 } },
      { n: 25, title: '全图鉴·大师',  reward: { coins: 1000, energy: 100, master: true } }
    ];
  }

  codexCount() {
    return this.collection ? this.collection.filter(c => c && c.unlocked).length : 0;
  }

  // 下一个可领阶段（返回 null 表示无可领）
  codexNextStage() {
    const count = this.codexCount();
    const stages = this.codexStages();
    for (const s of stages) {
      if (count >= s.n && this.codexClaimed < s.n) return s;
    }
    return null;
  }

  // 领取当前可领阶段大奖；无可领返回 null
  claimCodexStage() {
    const s = this.codexNextStage();
    if (!s) return null;
    this.codexClaimed = s.n;
    const r = s.reward || {};
    if (r.coins) this.coins += r.coins;
    if (r.energy) this.energy = Math.min(this.maxEnergy, this.energy + r.energy);
    if (r.master) this._masterSkin = true;
    return s;
  }

  // 连胜金币倍率：1x→2x→3x→5x（4 连胜封顶 5x）
  streakMultiplier() {
    const ws = this.winStreak || 0;
    if (ws >= 4) return 5;
    if (ws >= 3) return 3;
    if (ws >= 2) return 2;
    return 1;
  }

  unlockCollection(tierIndex, level) {
    const item = this.collection.find(c => c.tierIndex === tierIndex && c.level === level);
    if (item) item.unlocked = true;
  }

  placeOnPlatform(index, beyblade) {
    if (index < 0 || index > 2) return false;
    const invIdx = this.inventory.indexOf(beyblade);
    if (invIdx < 0) return false;
    if (this.platformSlots[index]) {
      this.inventory.push(this.platformSlots[index]);
    }
    this.platformSlots[index] = beyblade;
    beyblade._placeT = Date.now();  // 放入弹跳时间戳（render.drawPlatform 读它做落地 pop 动画）
    this.inventory.splice(invIdx, 1);
    return true;
  }

  takeFromPlatform(index) {
    const bb = this.platformSlots[index];
    if (!bb) return false;
    this.inventory.push(bb);
    this.platformSlots[index] = null;
    return true;
  }

  tryMerge() {
    const slots = this.platformSlots;
    for (let i = 0; i < slots.length; i++) {
      for (let j = i + 1; j < slots.length; j++) {
        const a = slots[i];
        const b = slots[j];
        if (a && b && a.canMergeWith(b)) {
          const merged = a.merge(b);   // P0-3：传入另一只，产物继承父母词条并集（见 Beyblade.merge）
          slots[i] = merged;
          slots[j] = null;
          // 合成结果只留在合成台 slots[i]，不推入 inventory（避免双重引用）
          this.unlockCollection(merged.tierIndex, merged.level);
          this.coins += merged.power;
          this.recordDailyTask('merge'); // 每日挑战：合成任务
          this.addExp(20);               // 大师等级：合成 +20 经验
          // 批次D·彩蛋（play-design v1）：累计合成计数（隐藏传说触发条件）
          this.mergeCount++;
          reportMerge(merged.tierIndex); // 零成本埋点：合成漏斗（产物稀有度维度 1-5）
          return merged;
        }
      }
    }
    return null;
  }

  getFilteredInventory() {
    if (this.filterTier < 0) return this.inventory;
    return this.inventory.filter(bb => bb.tierIndex === this.filterTier);
  }

  // 出售二次确认：打开确认弹窗（不直接出售，等玩家确认）
  openSellConfirm(beyblade) {
    if (!beyblade) return false;
    const gain = Math.max(1, Math.floor(beyblade.power * 0.1));
    this.sellConfirm = { beyblade, gain };
    return true;
  }

  // 确认出售：执行真正的出售逻辑
  confirmSell() {
    if (!this.sellConfirm) return 0;
    const { beyblade } = this.sellConfirm;
    const gain = this.sell(beyblade);
    this.sellConfirm = null;
    return gain;
  }

  // 取消出售：关闭确认弹窗，不出售
  cancelSell() {
    this.sellConfirm = null;
  }

  sell(beyblade) {
    const idx = this.inventory.indexOf(beyblade);
    if (idx < 0) return false;
    const gain = Math.max(1, Math.floor(beyblade.power * 0.1));
    this.coins += gain;
    this.inventory.splice(idx, 1);
    return gain;
  }

  rechargeEnergy(dt) {
    this.energy = Math.min(this.maxEnergy, this.energy + dt * 2);  // 回复放慢(6→2/s)：失败后回能慢，逼看广告复活
  }

  // 出战陀螺选择：优先用户持久选中的 battleBbId → 合成台中央格 → 战力最高（兜底，向后兼容）
  selectBattleBeyblade() {
    if (this.battleBbId) {
      const sel = this._findBbById(this.battleBbId);
      if (sel) return sel;
      this.battleBbId = null; // 选中陀螺已被出售/合并 → 清除过期选择，回落兜底
    }
    const center = this.platformSlots[1];
    if (center) return center;
    let best = null;
    for (const bb of this.inventory) {
      if (!best || bb.power > best.power) best = bb;
    }
    return best;
  }

  // 按唯一 id 在背包 + 合成台三槽中查找陀螺（id 由 Beyblade 构造生成并随存档持久化）
  _findBbById(id) {
    if (id == null) return null;
    for (const bb of this.inventory) if (bb.id === id) return bb;
    if (this.platformSlots) for (const s of this.platformSlots) if (s && s.id === id) return s;
    return null;
  }

  // 设定/清除出战陀螺（持久化 battleBbId）
  setBattleBeyblade(bb) {
    this.battleBbId = bb ? bb.id : null;
    if (typeof this.save === 'function') { try { this.save(); } catch (e) {} }
  }

  // =====================================================
  // 批次C·对战深度（play-design v1）：羁绊共鸣 / 品质被动 / 策略预判
  // =====================================================

  // 羁绊系统：背包中同元素陀螺 ≥3 件 → 元素共鸣（出战全属性 +10%）
  // ⚠️ 方案B（2026-09-13 元素绑定品质）后，「同元素」与「同品质」完全等价 ——
  //    元素↔品质是一一映射（麒麟=土/青龙=木/玄武=水/朱雀=火/白虎=金），故本函数逻辑无需改动，
  //    但语义已变为「集齐 3 只同档位」。副作用：最低档（麒麟，40%）最易凑齐，共鸣触发率上升。
  bondResonance() {
    const counts = [0, 0, 0, 0, 0];
    const add = (bb) => { if (bb && typeof bb.elementIdx === 'number') counts[bb.elementIdx]++; };
    for (const bb of this.inventory) add(bb);
    // 合成台（platformSlots）上的陀螺已移出背包，仍属玩家持有，需计入元素羁绊
    if (this.platformSlots) for (const bb of this.platformSlots) add(bb);
    const max = Math.max(...counts);
    const elIdx = counts.indexOf(max);
    return { active: max >= 3, elementIdx: elIdx, count: max, bonus: 0.1 };
  }

  // 品质 Lv5 专属被动：土=转速+5% / 木=生命强化 / 水=概率双倍 / 火=攻击强化 / 金=开局极速
  // 注：这五个词正是**按档位顺序**写的（档0土/档1木/档2水/档3火/档4金），方案B 把元素绑到品质后，
  //      被动名与元素名终于完全一致（此前档0名叫"土·普通"却可能带火属性，被动写"土"就对不上）。
  qualityPassive(bb) {
    if (!bb || bb.level < 5) return null;
    const list = [
      { type: 'spin',   desc: '土·转速 +5%' },
      { type: 'wood',   desc: '木·生命强化' },
      { type: 'double', desc: '水·概率双倍得分' },
      { type: 'fire',   desc: '火·攻击强化' },
      { type: 'start',  desc: '金·开局极速' }
    ];
    return { type: list[bb.tierIndex].type, desc: list[bb.tierIndex].desc, tierIndex: bb.tierIndex };
  }

  // 注：旧 rollEnemyElement()（返回 0..4 的随机元素）已删除 —— 敌方元素现在直接取 randomBeyblade 的
  //     elementIdx（f(品质,等级)，见 spintop.js 的 enemyBb.elementIdx），
  //     随机元素会与"品质环"自相矛盾；且该函数全工程无调用点（死代码）。
  // =====================================================
  // 批次D·收尾（play-design v1）：隐藏传说彩蛋 / 对战掉落宝箱 / 好友助力
  // =====================================================

  // 彩蛋·隐藏传说：累计合成 50/100/200 次触发「流星陀螺」掉落（限 3 次）
  checkHiddenEgg() {
    if (this.hiddenDrops >= 3) return null;
    const next = (this.hiddenDrops + 1) * 50;
    if (this.mergeCount < next) return null;
    this.hiddenDrops++;
    const egg = new Beyblade(4, 5);   // 传说 Lv5 特殊外观（流星）
    egg.traits = rollTraits(1);        // P0-3
    egg.hidden = true;                 // 图鉴特殊槽位标记
    if (this.inventory.length < INVENTORY_HARD_CAP) {
      this.inventory.push(egg);
      this.unlockCollection(egg.tierIndex, egg.level);
    } else {
      this.coins += Math.max(1, Math.floor(egg.power * 0.1));
    }
    return { count: this.hiddenDrops, next: (this.hiddenDrops + 1) * 50, bb: egg };
  }
  hiddenEggNext() {
    if (this.hiddenDrops >= 3) return null;
    return (this.hiddenDrops + 1) * 50;
  }

  // 对战掉落宝箱：胜利概率掉「竞技宝箱」（看广告开 / 直接开）
  dropBattleChest(quality) {
    this.battleChest = { quality: Math.max(0, Math.min(2, quality)), count: (this.battleChest ? this.battleChest.count : 0) + 1 };
    return this.battleChest;
  }
  openBattleChest(useAd, force) {
    if (!this.battleChest) return null;
    if (!useAd && !force) {
      const today = this._todayKey();
      if (this.chestOpenDate === today) return null; // 每日仅 1 次直接开
      this.chestOpenDate = today;
    }
    const q = this.battleChest.quality;
    this.battleChest.count -= 1;
    if (this.battleChest.count <= 0) this.battleChest = null;
    // 开箱奖励：金币/能量/随机品质陀螺（高连击宝箱保底稀有）
    const roll = Math.random();
    let reward;
    if (roll < 0.45) {
      const coins = 80 + q * 80;
      this.coins += coins;
      reward = { type: 'coins', value: coins, name: '+' + coins + ' 金币' };
    } else if (roll < 0.75) {
      const en = 20 + q * 20;
      this.energy = Math.min(this.maxEnergy, this.energy + en);
      reward = { type: 'energy', value: en, name: '+' + en + ' 能量' };
    } else {
      const tierIdx = Math.min(3, (q >= 1 ? 1 : 0) + Math.floor(Math.random() * 2));
      const bb = new Beyblade(tierIdx, 1);
      bb.traits = rollTraits(1);   // P0-3
      if (this.inventory.length < INVENTORY_HARD_CAP) {
        this.inventory.push(bb);
        this.unlockCollection(bb.tierIndex, bb.level);
      } else { this.coins += Math.max(1, Math.floor(bb.power * 0.1)); }
      reward = { type: 'beyblade', tierIndex: tierIdx, name: bb.tier.name + '陀螺' };
    }
    return { quality: q, reward };
  }
  // 青铜宝箱「开启」门控：当日是否还有 1 次免费开启名额（与 openBattleChest 的每日限制同源）。
  // 用户诉求（2026-08-31）：首次开启免费、之后每次需看广告开 → 以「每日首次」为免费名额。
  isChestFreeOpenAvailable() {
    return this.chestOpenDate !== this._todayKey();
  }

  // 好友助力：分享回跳领助力能量（每日 5 次）
  canClaimBoost() {
    const today = this._todayKey();
    if (this.boostDate !== today) { this.boostDate = today; this.boostCount = 0; }
    return this.boostCount < 5;
  }
  claimBoost() {
    if (!this.canClaimBoost()) return false;
    this.boostCount++;
    this.energy = Math.min(this.maxEnergy, this.energy + 15);
    return true;
  }

  // =====================================================
  // P0-2 战绩上云 + P0-3 金币洗词条（2026-10-31）
  // =====================================================

  /**
   * 每局胜利记分：更新历史最高分 + 当周连胜峰值，并节流同步到微信用户云存储
   * （开放数据域好友榜数据源）。由 spintop._settle 胜利分支调用（合作关不调）。
   * P1-7：同时记录纪录局的关卡号（ghostStage）——影子战按该关卡复刻难度。
   * @returns {number} 更新后的历史最高分
   */
  noteBattleScore(score, stage) {
    const s = Math.max(0, Math.floor(score || 0));
    if (s > (this.highScore || 0)) {
      this.highScore = s;
      if (stage) this.ghostStage = Math.max(1, Math.min(999, Math.floor(stage)));
    }
    // 当周连胜峰值：周 key 变化即重置（周一 0 点换周，与竞技场周结算同口径）
    const wk = this._weekKey();
    if (this.streakWeek !== wk) { this.streakWeek = wk; this.streakWeekMax = 0; }
    this.streakWeekMax = Math.max(this.streakWeekMax || 0, this.winStreak || 0);
    try { syncLeaderboard(this); } catch (e) {}   // 节流见 leaderboard.SYNC_MIN_MS
    return this.highScore;
  }

  // =====================================================
  // P1-5 激斗周末（抄咸鱼之王「囤积-爆发」骨架）：
  //   平日攒竞技积分 → 周末 BOSS 关积分 ×2 冲段位 + 限时商店（金币周期性大出口）。
  //   商店限购按周 key 记账，周一 0 点随 _checkWeekShopReset 清零。
  // =====================================================
  /** 周末商店商品表（真源；改价格/限购只动这里） */
  static weekShopItems() {
    return [
      { key: 'energy', name: '能量大包',   desc: '能量 +100',         cost: 800,  limit: 3, color: '#00e676' },
      { key: 'coupon', name: '玄武保底券', desc: '下一抽必出玄武',    cost: 1200, limit: 1, color: '#42a5f5' },
      { key: 'legend', name: '白虎图纸',   desc: '直接获得白虎 Lv1',  cost: 5000, limit: 1, color: '#ffd54f' }
    ];
  }

  _checkWeekShopReset() {
    const k = this._weekKey();
    if (this.weekShopWeek !== k) {
      this.weekShopWeek = k;
      this.weekShopBought = { energy: 0, coupon: 0, legend: 0 };
    }
  }

  /** 周末商店面板数据（ weekend: 是否周末中；remainDays: 周末剩余/距周末天数） */
  weekendShopMeta() {
    this._checkWeekShopReset();
    const act = this.activityInfo();
    const bought = this.weekShopBought || {};
    const n = new Date();
    const idx = (n.getDay() + 6) % 7;      // 周一=0 ... 周日=6
    const daysToSat = (5 - idx + 7) % 7;   // 距下周六
    return {
      weekend: !!act.weekendDouble,
      remainDays: act.weekendDouble ? Math.max(1, 7 - idx) : daysToSat,
      items: GameState.weekShopItems().map(it => Object.assign({}, it, { bought: bought[it.key] || 0 }))
    };
  }

  /**
   * 购买周末商店商品。
   * @returns {{ok:true,item,effect}|{error:'nonweekend'|'limit'|'coins'|'unknown'}}
   */
  buyWeekShopItem(key) {
    this._checkWeekShopReset();
    const it = GameState.weekShopItems().find(i => i.key === key);
    if (!it) return { error: 'unknown' };
    if (!(this.activityInfo && this.activityInfo().weekendDouble)) return { error: 'nonweekend' };
    const bought = this.weekShopBought || (this.weekShopBought = { energy: 0, coupon: 0, legend: 0 });
    if ((bought[key] || 0) >= it.limit) return { error: 'limit' };
    if ((this.coins || 0) < it.cost) return { error: 'coins' };
    this.coins -= it.cost;
    bought[key] = (bought[key] || 0) + 1;
    let effect = '';
    if (key === 'energy') {
      this.energy = Math.min(this.maxEnergy, this.energy + 100);
      effect = '能量 +100';
    } else if (key === 'coupon') {
      // 玄武保底券：置 9 = 下一抽必出玄武（与大师等级里程碑同款技巧，_rollWithPity 先 +1 再判 >=10）
      if (this.pityEpic < 9) this.pityEpic = 9;
      effect = '下一抽必出玄武';
    } else if (key === 'legend') {
      const bb = new Beyblade(4, 1);
      bb.traits = rollTraits(1);
      if (this.inventory.length < INVENTORY_HARD_CAP) {
        this.inventory.push(bb);
        this.unlockCollection(4, 1);
      } else {
        this.coins += Math.max(1, Math.floor(bb.power * 0.1));
      }
      effect = '白虎 Lv1 入队';
    }
    if (typeof this.save === 'function') { try { this.save(true); } catch (e) {} }
    return { ok: true, item: it, effect: effect };
  }

  /** 洗词条价格：rerollBase + rerollStep × 该陀螺已洗次数（单只递增，防无脑连洗）。
   *  P1-5：激斗周末半价（爆发期的金币出口放大器；activityInfo 可被测试 stub）。 */
  rerollTraitsCost(bb) {
    const cfg = (typeof CONFIG !== 'undefined' && CONFIG.trait) || {};
    const base = (cfg.rerollBase || 300) + (cfg.rerollStep || 150) * Math.max(0, (bb && bb.rerolls) || 0);
    try {
      if (this.activityInfo && this.activityInfo().weekendDouble) return Math.floor(base * 0.5);
    } catch (e) {}
    return base;
  }

  /**
   * 金币洗词条（P0-3 金币硬出口）：把该陀螺词条重掷为「同等数量」的全新随机词条。
   * 金币不足返回 null（调用方负责 toast）；成功返回 { traits, names, cost } 并立即强制存档。
   */
  rerollTraits(bb) {
    if (!bb) return null;
    const cost = this.rerollTraitsCost(bb);
    if ((this.coins || 0) < cost) return null;
    this.coins -= cost;
    bb.rerolls = (bb.rerolls || 0) + 1;
    const cfg = (typeof CONFIG !== 'undefined' && CONFIG.trait) || {};
    const maxT = cfg.maxTraits || 2;
    const n = Math.max(1, Math.min(maxT, (Array.isArray(bb.traits) && bb.traits.length) ? bb.traits.length : 1));
    bb.traits = rollTraits(n);
    if (typeof this.save === 'function') { try { this.save(true); } catch (e) {} }
    return {
      traits: bb.traits,
      cost: cost,
      names: (bb.traits || []).map(t => ((traitById(t.id) || {}).name) || t.id)
    };
  }

  canShare() {
    const today = this._todayKey();
    if (this.shareDate !== today) { this.shareDate = today; this.shareCount = 0; }
    return this.shareCount < 3;
  }

  doShare() {
    if (!this.canShare()) return false;
    this.shareCount++;
    reportShare();                 // 零成本埋点：分享漏斗
    this.energy = Math.min(this.maxEnergy, this.energy + 20);
    this.grantBonusTickets(2, 'share');   // P1-6：分享加发 2 张挑战券
    // D1 留客钩子（2026-11-20）：分享奖励升级——旧奖励只有 +2 券（券每日免费 5 张，边际价值≈0，
    // 后台两周分享仅 3 次），加发 1 张免费抽卡券（最硬通货），把"分享"从可有可无变成值得点。
    this.freeDraws = Math.min(3, (this.freeDraws || 0) + 1);
    return true;
  }

  canRefill() {
    const today = this._todayKey();
    if (this.refillDate !== today) { this.refillDate = today; this.refillCount = 0; }
    return this.refillCount < 3;
  }

  freeRefill() {
    if (!this.canRefill()) return false;
    this.refillCount++;
    this.energy = this.maxEnergy;
    return true;
  }

  advanceTutorial() {
    if (this.tutorialStep < 2) this.tutorialStep++;
    else { this.tutorialStep = 2; this.tutorialDone = true; }
  }

  canWatchAdEnergy() {
    const today = this._todayKey();
    if (this.adEnergyDate !== today) { this.adEnergyDate = today; this.adEnergyCount = 0; }
    return this.adEnergyCount < 5 && this.energy < this.maxEnergy;
  }

  watchAdEnergy() {
    if (!this.canWatchAdEnergy()) return false;
    this.adEnergyCount++;
    reportAdWatch();               // 零成本埋点：激励视频看完漏斗
    this.energy = Math.min(this.maxEnergy, this.energy + 60);
    return true;
  }

  // 抽卡激励广告：每日上限 + 降级判断（业务层频控；按钮由玩家主动点击，无平台最小间隔）
  canShowDrawInterstitial() {
    const today = this._todayKey();
    if (this.interAdDate !== today) { this.interAdDate = today; this.interAdCount = 0; }
    return this.interAdCount < DRAW_INTERSTITIAL_DAILY_CAP && !this.interAdBroken;
  }

  // 实际展示一次插屏后调用：计每日次数；成功展示清除降级标志
  markDrawInterstitialShown() {
    this.interAdCount++;
    this.interAdBroken = false;
  }

  /**
   * 首页插屏门控（纯判定，便于测试）：首日/首次启动不弹 + 每日上限 2 次。
   * 弹点在结算页「返回首页」之后（main.js battle_back 分支触发），非启动即弹（2026-11-08 迁移）。
   * 规则：① 首次启动记录安装日，当天不弹；② 安装日!==今天才放开；③ 当日已弹达上限则不弹。
   * 注意：会就地记录 installDate（首次调用副作用），并滚动每日计数日期。
   */
  canShowHomeInterstitial() {
    const today = this._todayKey();
    if (!this.homeInterInstallDate) { this.homeInterInstallDate = today; return false; } // 首次启动：记录安装日，当天不弹
    if (this.homeInterInstallDate === today) return false;                             // 安装当天都不弹
    if (this.homeInterAdDate !== today) { this.homeInterAdDate = today; this.homeInterAdCount = 0; }
    return this.homeInterAdCount < HOME_INTERSTITIAL_DAILY_CAP;
  }

  // 进首页插屏实际展示一次后调用：计当日次数
  markHomeInterstitialShown() {
    this.homeInterAdCount++;
  }

  /**
   * 抽卡激励广告调度：判定本次抽卡后是否应安排广告，以及用哪个广告位（纯规则，便于测试）。
   * 节奏（按累计抽数 drawsSinceAd）：
   *   - 第3/6/9抽必弹，分别对应独立广告位 draw3/draw6/draw9；
   *   - 超过9抽按模循环复用（12→draw6、15→draw3、18→draw9…）；
   *   - 逢2的倍数（且非3的倍数）随机弹 rand2 位（概率 0.5）。
   * 命中后：main.js 把 key 记到 game._drawRewardKey，收卡时 _dismissDrawCard 自动 Rewarded.show（隐藏式、无按钮）。
   * 注意：仅判"规则层"（每日上限 + 抽数节奏 + 随机）；并发/重试由 ads.js 的 Rewarded 守卫（entry._busy）。
   * @returns {string|null} 广告位 key（draw3/draw6/draw9/rand2）或 null（本次不弹）
   */
  shouldScheduleDrawInterstitial() {
    if (!this.canShowDrawInterstitial()) return null; // 当日已达上限 / 降级中
    const n = this.drawsSinceAd;
    if (n > 0 && n % 9 === 0) return 'draw9';       // 第9抽（及18/27…）必弹 → draw9
    if (n > 0 && n % 6 === 0) return 'draw6';       // 第6抽（及12/24…）必弹 → draw6
    if (n > 0 && n % 3 === 0) return 'draw3';       // 第3抽（及15/21…）必弹 → draw3
    if (n > 0 && n % 2 === 0 && Math.random() < 0.5) return 'rand2'; // 逢2的倍数随机 → rand2
    return null;
  }

  canSign() {
    const today = this._todayKey();
    if (this.signDate !== today) {
      const yesterday = this._dayKeyOffset(-1);
      if (this.signDate !== yesterday) {
        // 断签：连续签到清零（记录旧值供补签恢复）
        this._streakBeforeReset = this.signStreak;
        this.signDay = 0;
        this.signStreak = 0;
      }
      this.signDate = today;
      this.signClaimed = false;
    }
    return !this.signClaimed;
  }

  // 签到升级版（play-design v1）：连续满 7 天进入双倍日（奖励 ×2），断签清零
  get signBonus() { return this.signStreak >= 7; }

  // 启动期「是否应自动弹出签到面板」的纯判定（无副作用，可测试）。
  // ⚠️ 不调用 canSign()：canSign 会改写 signDate/signClaimed 做日期滚动，
  //    若在此处调用会把状态提前推进；本方法只读取已存字段做展示决策。
  // 判定逻辑：今日尚未签领（signDate 非今日，或今日 signClaimed 仍为假）即视为可弹；
  //          同时若有回归礼包弹窗（offlineOpen）则让位，避免两个浮层叠加。
  autoSignAvailable() {
    if (this.offlineOpen) return false;
    const today = this._todayKey();
    const dueToday = (this.signDate !== today) || !this.signClaimed;
    return dueToday;
  }

  checkIn() {
    if (!this.canSign()) return null;
    this.signClaimed = true;
    const day = (this.signDay % 7) + 1;
    this.signDay = this.signDay >= 7 ? 1 : this.signDay + 1;
    this.signStreak += 1;
    const r = SIGN_REWARDS[day - 1];
    const mult = this.signBonus ? 2 : 1;
    const coins = (r.coins || 0) * mult;
    const energy = (r.energy || 0) * mult;
    const freeDraw = (r.freeDraw || 0) * (this.signBonus ? 2 : 1);   // 双倍日：券也翻倍（封顶在 freeDraws 上限内）
    this.freeDraws = Math.min(3, (this.freeDraws || 0) + freeDraw);  // 持有上限 3 张，防囤积
    this.coins += coins;
    this.energy = Math.min(this.maxEnergy, this.energy + energy);
    // 第 7 天大奖：白虎陀螺 + 白虎保底券（保底计数清零 → 下一抽必白虎）
    let coupon = false;
    if (day === 7 && this.pityLegend < 29) { this.pityLegend = 29; coupon = true; }
    let drop = null;
    if (r.beyblade) {
      drop = new Beyblade(r.beyblade.tierIndex, r.beyblade.level);
      drop.traits = rollTraits(1);   // P0-3
      if (this.inventory.length < INVENTORY_HARD_CAP) {
        this.inventory.push(drop);
      } else {
        this.coins += Math.max(1, Math.floor(drop.power * 0.1));
      }
      this.unlockCollection(drop.tierIndex, drop.level);
    }
    return { day, coins, energy, freeDraw, beyblade: drop, bonus: this.signBonus, coupon };
  }

  /**
   * 消耗一张免费抽卡券（签到/分享发放）。
   * @returns {boolean} true=已扣 1 张（调用方走 draw(useCoins, free) 免费路径）；false=无券。
   */
  consumeFreeDraw() {
    if ((this.freeDraws || 0) <= 0) return false;
    this.freeDraws--;
    return true;
  }

  // 断签补签（看广告）：昨日未签且今日未用补签 → 恢复连续签到，每日限 1 次
  canMakeupSign() {
    if (this.signClaimed) return false;
    const today = this._todayKey();
    const yesterday = this._dayKeyOffset(-1);
    if (this.signDate === yesterday) return false; // 昨天已签无需补
    if (this.signMakeupDate === today) return false; // 今日已用过
    if (this.signStreak > 0) return false;           // 未断签无需补
    return this._streakBeforeReset > 0;              // 有可恢复的连续记录
  }

  makeupSign() {
    if (!this.canMakeupSign()) return false;
    this.signMakeupDate = this._todayKey();
    this.signStreak = this._streakBeforeReset; // 恢复连续天数
    this._streakBeforeReset = 0;
    return true;
  }

  // =====================================================
  // 限时活动（play-design v1）：周末双倍金币 / 节日限定掉落
  // =====================================================
  activityInfo() {
    const n = new Date();
    const dow = n.getDay(); // 0=周日 6=周六
    const weekend = (dow === 0 || dow === 6);
    const m = n.getMonth() + 1, d = n.getDate();
    // 公历节日窗口：国庆(10.1-10.7) / 元旦(1.1-1.3) / 春节前后(1.15-2.15) / 中秋(9.10-9.22)
    const festival =
      (m === 10 && d >= 1 && d <= 7) || (m === 1 && d >= 1 && d <= 3) ||
      (m === 1 && d >= 15 && d <= 31) || (m === 2 && d <= 15) ||
      (m === 9 && d >= 10 && d <= 22);
    return {
      weekend: weekend,
      festival: festival,
      weekendDouble: weekend,
      festivalName: festival ? (m === 9 ? '中秋限定' : (m === 1 || m === 2 ? '新春限定' : '国庆限定')) : ''
    };
  }

  // =====================================================
  // 离线回归奖励（play-design v1）：离线 ≥6h 领礼包（能量回满+金币），≥24h 升级大礼包
  // =====================================================
  checkReturn() {
    const now = Date.now();
    this.offlineMs = Math.max(0, now - (this.lastSeen || now));
    if (this.offlineRewardDate === this._todayKey()) return null;
    if (this.offlineMs >= 6 * 3600 * 1000) {
      this._pendingReturn = this.offlineMs >= 24 * 3600 * 1000 ? 'grand' : 'normal';
      this.offlineOpen = true;
      return this._pendingReturn;
    }
    return null;
  }

  claimReturn() {
    if (!this._pendingReturn) return null;
    const grand = this._pendingReturn === 'grand';
    const coins = grand ? 800 : 300;
    this.coins += coins;
    this.energy = this.maxEnergy;
    let coupon = false;
    // 「白虎保底券」= 下一抽必出白虎。_rollWithPity 是先 +1 再判 >=30，
    // 所以置 29 才等价于「下一抽触发」；置 0 反而要再攒 30 抽，与券的语义相反。
    if (grand && this.pityLegend < 29) { this.pityLegend = 29; coupon = true; }
    this.offlineRewardDate = this._todayKey();
    this.offlineOpen = false;
    this._pendingReturn = null;
    return { grand, coins, coupon };
  }

  codexTotal() { return this.collection ? this.collection.length : 0; }

  save(force) {
    const now = Date.now();
    if (!force) {
      // 节流兜底（极端频繁调用）：【先判时间再算签名】——2s 内直接跳过，
      // 避免每帧白跑 _stateSig() 的 collection 循环 + 拼大字符串（主线程 CPU 优化，直击云测 Android CPU 超标）
      if (now - this.lastSave < 2000) return;
    }
    const sig = this._stateSig();
    if (!force) {
      // 状态无变化直接跳过：省 CPU / 省 GC（P2）
      if (sig === this._lastSaveSig) return;
    }
    this._lastSaveSig = sig;
    this.lastSave = now;
    this.lastSeen = now; // 记录活跃时间戳（离线回归奖励用）
    try {
      if (this.inventory.length > INVENTORY_HARD_CAP) {
        this.inventory.splice(INVENTORY_HARD_CAP).forEach(bb => {
          this.coins += Math.max(1, Math.floor(bb.power * 0.1));
        });
      }
      const data = {
        schema: SCHEMA_VERSION,
        savedAt: now,
        coins: this.coins,
        energy: this.energy,
        maxEnergy: this.maxEnergy,
        // P0-3 词条随存档持久化（只存 id 数组；rerolls 次数驱动洗词条涨价）
        inventory: this.inventory.map(bb => ({
          tierIndex: bb.tierIndex, level: bb.level, id: bb.id,
          traits: (Array.isArray(bb.traits) ? bb.traits.map(t => t && t.id).filter(Boolean) : []),
          rerolls: bb.rerolls || 0
        })),
        platform: this.platformSlots.map(s => (s ? {
          tierIndex: s.tierIndex, level: s.level, id: s.id,
          traits: (Array.isArray(s.traits) ? s.traits.map(t => t && t.id).filter(Boolean) : []),
          rerolls: s.rerolls || 0
        } : null)),
        collection: this.collection,
        filterTier: this.filterTier,
        shareDate: this.shareDate,
        shareCount: this.shareCount,
        refillDate: this.refillDate,
        refillCount: this.refillCount,
        winStreak: this.winStreak,
        coopStage: this.coopStage,
        coopWins: this.coopWins,
        pityEpic: this.pityEpic,
        pityLegend: this.pityLegend,
        dailyDate: this.dailyDate,
        dailyTasks: this.dailyTasks,
        dailyActive: this.dailyActive,
        dailyChestClaimed: this.dailyChestClaimed,
        arenaPts: this.arenaPts,
        arenaWeek: this.arenaWeek,
        arenaBest: this.arenaBest,
        arenaClaimedWeek: this.arenaClaimedWeek,
        exp: this.exp,
        level: this.level,
        codexClaimed: this.codexClaimed,
        _masterSkin: this._masterSkin ? 1 : 0,
        tutorialDone: this.tutorialDone,
        tutorialStep: this.tutorialStep,
        obDone: this.obDone ? 1 : 0,
        obTries: this.obTries,
        adEnergyDate: this.adEnergyDate,
        adEnergyCount: this.adEnergyCount,
        drawsSinceAd: this.drawsSinceAd,
        interAdDate: this.interAdDate,
        interAdCount: this.interAdCount,
        battleTutShown: this.battleTutShown ? 1 : 0,
        battleBbId: this.battleBbId,
        battleSelectHinted: this.battleSelectHinted ? 1 : 0,
        resultDoubleDate: this.resultDoubleDate,
        resultDoubleCount: this.resultDoubleCount,
        interAdBroken: this.interAdBroken,
        homeInterInstallDate: this.homeInterInstallDate,
        homeInterAdDate: this.homeInterAdDate,
        homeInterAdCount: this.homeInterAdCount,
        signDate: this.signDate,
        signDay: this.signDay,
        signClaimed: this.signClaimed,
        signStreak: this.signStreak,
        signMakeupDate: this.signMakeupDate,
        lastSeen: this.lastSeen,
        offlineRewardDate: this.offlineRewardDate,
        freeDraws: this.freeDraws,
        mergeCount: this.mergeCount,
        hiddenDrops: this.hiddenDrops,
        battleChest: (this.battleChest ? (this.battleChest.quality + '|' + this.battleChest.count) : ''),
        chestOpenDate: this.chestOpenDate,
        boostDate: this.boostDate,
        boostCount: this.boostCount,
        highScore: this.highScore || 0,
        streakWeek: this.streakWeek || '',
        streakWeekMax: this.streakWeekMax || 0,
        ghostStage: this.ghostStage || 1,
        weekShopWeek: this.weekShopWeek || '',
        weekShopBought: this.weekShopBought || null,
        ticketDate: this.ticketDate || '',
        freeTicketsUsed: this.freeTicketsUsed || 0,
        bonusTickets: this.bonusTickets || 0,
        ticketAdCount: this.ticketAdCount || 0,
        codexNudged: this.codexNudged ? 1 : 0,
        arenaPeakTier: (this.arenaPeakTier == null ? -1 : this.arenaPeakTier),
        arenaMasterGranted: this.arenaMasterGranted ? 1 : 0,
        _traitsMigrated: this._traitsMigrated ? 1 : 0,
        _shareEntryClaimed: !!this._shareEntryClaimed
      };
      const str = JSON.stringify(data);
      if (force || typeof wx === 'undefined' || !wx.setStorage) {
        // 强制（切后台/关键动作）或环境无异步 API → 同步落盘，保证不丢档
        if (typeof wx !== 'undefined' && wx.setStorageSync) wx.setStorageSync(STORAGE_KEY, str);
      } else {
        // 常规每帧保存 → 异步写，不阻塞主线程（改善 P2 主线程阻塞）
        wx.setStorage({ key: STORAGE_KEY, data: str, fail: (e) => { console.warn('[save] async failed:', e && e.message || e); } });
      }
    } catch (e) {
      console.warn('[save] failed:', e && e.message || e);
    }
  }

  /** 持久化状态签名：用于判断「是否真的发生了需要落盘的变化」。仅采集会写入存档的字段。 */
  _stateSig() {
    const col = [];
    for (let i = 0; i < this.collection.length; i++) {
      if (this.collection[i].unlocked) col.push(this.collection[i].tierIndex + '.' + this.collection[i].level);
    }
    const plat = this.platformSlots.map(s => (s ? (s.tierIndex + '.' + s.level) : '_')).join(',');
    return [this.coins, this.energy, this.maxEnergy, this.inventory.length, plat,
      this.filterTier, this.shareDate, this.shareCount, this.refillDate, this.refillCount,
      this.winStreak, this.pityEpic, this.pityLegend, this.tutorialDone ? 1 : 0, this.tutorialStep,       this.adEnergyDate,
      this.obDone ? 1 : 0, this.obTries,
      this.adEnergyCount, this.drawsSinceAd, this.interAdDate, this.interAdCount, this.interAdBroken ? 1 : 0, this.battleTutShown ? 1 : 0,
      this.resultDoubleDate, this.resultDoubleCount,
      this.signDate, this.signDay, this.signClaimed ? 1 : 0,
      this.signStreak, this.signMakeupDate, this.lastSeen, this.offlineRewardDate,
      this.mergeCount, this.hiddenDrops, (this.battleChest ? (this.battleChest.quality + '|' + this.battleChest.count) : ''),
      this.chestOpenDate, this.boostDate, this.boostCount,
      this.highScore || 0, this.streakWeek || '', this.streakWeekMax || 0,
      this.ghostStage || 1, this.weekShopWeek || '',
      (this.weekShopBought ? ((this.weekShopBought.energy || 0) + '.' + (this.weekShopBought.coupon || 0) + '.' + (this.weekShopBought.legend || 0)) : ''),
      this.ticketDate || '', this.freeTicketsUsed || 0, this.bonusTickets || 0, this.ticketAdCount || 0,
      this.codexNudged ? 1 : 0,
      (this.arenaPeakTier == null ? -1 : this.arenaPeakTier), this.arenaMasterGranted ? 1 : 0,
      this._traitsMigrated ? 1 : 0,
      this._shareEntryClaimed ? 1 : 0,
      this.dailyDate, (this.dailyTasks || [0, 0, 0]).join('.'), this.dailyActive, this.dailyChestClaimed ? 1 : 0,
      this.arenaPts, this.arenaWeek, this.arenaBest, this.arenaClaimedWeek,
      this.exp, this.level, this.codexClaimed, this._masterSkin ? 1 : 0,
      this.coopStage, this.coopWins,
      col.join(',')].join('|');
  }

  /** 双人合作通关战绩（只记战绩不发资源）。由 spintop coop 胜利结算调用。 */
  recordCoopWin(stage) {
    this.coopWins++;
    this.coopStage = Math.max(this.coopStage, Number(stage) || 1);
  }

  /** 结算翻倍：当日已看次数（跨天归零）。每日上限由 main 对照 CONFIG.resultDoublePerDay。 */
  resultDoubleCountToday() {
    if (this.resultDoubleDate !== this._todayKey()) { this.resultDoubleDate = this._todayKey(); this.resultDoubleCount = 0; }
    return this.resultDoubleCount;
  }
  markResultDouble() { this.resultDoubleCountToday(); this.resultDoubleCount++; }

  load() {
    if (typeof wx === 'undefined' || !wx.getStorageSync) return;
    try {
      let data = wx.getStorageSync(STORAGE_KEY);
      if (!data) {
        const v1 = wx.getStorageSync('beyblade_master_save_v1');
        if (v1) data = v1;
        else return;
      }
      if (typeof data === 'string') data = JSON.parse(data);
      if (!data || typeof data !== 'object') return;

      // ==========================================================
      // 存档版本管理与数据迁移
      // 基于schema字段判断存档版本，执行对应版本的迁移函数
      // 迁移完成后自动保存为最新版本格式
      // ==========================================================
      const savedSchema = typeof data.schema === 'number' ? data.schema : 1; // 无schema字段视为v1
      if (savedSchema < SCHEMA_VERSION) {
        console.log(`[load] 存档版本 v${savedSchema} → v${SCHEMA_VERSION}，开始迁移...`);
        data = this._migrateSave(data, savedSchema);
        // 迁移完成后，异步保存为最新版本格式
        try {
          const migratedStr = JSON.stringify(data);
          if (typeof wx !== 'undefined' && wx.setStorage) {
            wx.setStorage({ key: STORAGE_KEY, data: migratedStr });
          } else if (typeof wx !== 'undefined' && wx.setStorageSync) {
            wx.setStorageSync(STORAGE_KEY, migratedStr);
          }
        } catch (e) {
          console.warn('[load] 迁移后保存失败:', e && e.message || e);
        }
        console.log(`[load] 迁移完成，已保存为 v${SCHEMA_VERSION} 格式`);
      }

      if (typeof data.maxEnergy === 'number' && data.maxEnergy > 0) {
        this.maxEnergy = Math.min(9999, data.maxEnergy);
      }
      this.coins = Math.max(0, Number(data.coins) || 0);
      this.energy = Math.min(this.maxEnergy, Math.max(0, Number(data.energy) || 0));
      this.filterTier = typeof data.filterTier === 'number' ? data.filterTier : -1;
      this.shareDate = typeof data.shareDate === 'string' ? data.shareDate : '';
      this.shareCount = Math.max(0, Number(data.shareCount) || 0);
      this.refillDate = typeof data.refillDate === 'string' ? data.refillDate : '';
      this.refillCount = Math.max(0, Number(data.refillCount) || 0);
      this.winStreak = Math.max(0, Math.min(50, Number(data.winStreak) || 0));
      this.coopStage = Math.max(0, Math.min(999, Number(data.coopStage) || 0));
      this.coopWins = Math.max(0, Math.min(9999, Number(data.coopWins) || 0));
      this.pityEpic = Math.max(0, Math.min(10, Number(data.pityEpic) || 0));
      this.pityLegend = Math.max(0, Math.min(30, Number(data.pityLegend) || 0));
      this.dailyDate = typeof data.dailyDate === 'string' ? data.dailyDate : '';
      this.dailyTasks = Array.isArray(data.dailyTasks) ? data.dailyTasks.slice(0, 3).map(n => Math.max(0, Math.min(3, Number(n) || 0))) : [0, 0, 0];
      this.dailyActive = Math.max(0, Math.min(100, Number(data.dailyActive) || 0));
      this.dailyChestClaimed = !!data.dailyChestClaimed;
      this.arenaPts = Math.max(0, Number(data.arenaPts) || 0);
      this.arenaWeek = typeof data.arenaWeek === 'string' ? data.arenaWeek : '';
      this.arenaBest = Math.max(0, Number(data.arenaBest) || 0);
      this.arenaClaimedWeek = typeof data.arenaClaimedWeek === 'string' ? data.arenaClaimedWeek : '';
      this.exp = Math.max(0, Number(data.exp) || 0);
      this.level = Math.max(1, Math.min(50, Number(data.level) || 1));
      this.codexClaimed = [0, 5, 10, 15, 20].indexOf(Number(data.codexClaimed)) >= 0 ? Number(data.codexClaimed) : 0;
      this._masterSkin = !!data._masterSkin;
      this.tutorialDone = true; // 新手引导已去除，强制为 true
      this.tutorialStep = 2;
      // 首程引导恢复：老档（level>1，说明早已玩过）直接视为完成，不误触发；
      // obStep 不入存档，按 obDone + inventory 推导（空包→引导抽卡，有货→引导对战）。
      this.obDone = Number(data.obDone) === 1 || this.level > 1;
      this.obTries = Math.max(0, Math.min(3, Number(data.obTries) || 0));
      this.adEnergyDate = typeof data.adEnergyDate === 'string' ? data.adEnergyDate : '';
      this.adEnergyCount = Math.max(0, Number(data.adEnergyCount) || 0);
      this.drawsSinceAd = Math.max(0, Number(data.drawsSinceAd) || 0);
      this.interAdDate = typeof data.interAdDate === 'string' ? data.interAdDate : '';
      this.interAdCount = Math.max(0, Number(data.interAdCount) || 0);
      this.resultDoubleDate = typeof data.resultDoubleDate === 'string' ? data.resultDoubleDate : '';
      this.resultDoubleCount = Math.max(0, Number(data.resultDoubleCount) || 0);
      this.interAdBroken = !!data.interAdBroken;
      this.homeInterInstallDate = typeof data.homeInterInstallDate === 'string' ? data.homeInterInstallDate : '';
      this.homeInterAdDate = typeof data.homeInterAdDate === 'string' ? data.homeInterAdDate : '';
      this.homeInterAdCount = Math.max(0, Number(data.homeInterAdCount) || 0);
      this.battleTutShown = !!data.battleTutShown;
      this.signDate = typeof data.signDate === 'string' ? data.signDate : '';
      this.signDay = Math.max(0, Math.min(14, Number(data.signDay) || 0));
      this.signClaimed = !!data.signClaimed;
      this.signStreak = Math.max(0, Math.min(999, Number(data.signStreak) || 0));
      this.signMakeupDate = typeof data.signMakeupDate === 'string' ? data.signMakeupDate : '';
      this.lastSeen = Number(data.lastSeen) || 0;
      this.offlineRewardDate = typeof data.offlineRewardDate === 'string' ? data.offlineRewardDate : '';
      this.freeDraws = Math.max(0, Math.min(3, Number(data.freeDraws) || 0));   // 老档无此字段 → 0（Number 兜底）
      this.mergeCount = Math.max(0, Number(data.mergeCount) || 0);
      this.hiddenDrops = Math.max(0, Math.min(3, Number(data.hiddenDrops) || 0));
      this.battleChest = null;
      if (data.battleChest) {
        const qc = String(data.battleChest);
        if (qc.indexOf('|') > 0) {
          const parts = qc.split('|');
          this.battleChest = { quality: Math.max(0, Math.min(2, Number(parts[0]) || 0)), count: Math.max(1, Number(parts[1]) || 1) };
        }
      }
      this.chestOpenDate = typeof data.chestOpenDate === 'string' ? data.chestOpenDate : '';
      this.boostDate = typeof data.boostDate === 'string' ? data.boostDate : '';
      this.boostCount = Math.max(0, Number(data.boostCount) || 0);
      // P0-2：历史最高分 / 当周连胜峰值（旧存档无此字段 → 0/''，随下一局胜利自愈）
      this.highScore = Math.max(0, Math.floor(Number(data.highScore) || 0));
      this.streakWeek = typeof data.streakWeek === 'string' ? data.streakWeek : '';
      this.streakWeekMax = Math.max(0, Math.min(999, Math.floor(Number(data.streakWeekMax) || 0)));
      // P1-7 影子战：纪录局关卡号（旧档无此字段 → 1；有 highScore 的老档下局胜利会自然校正）
      this.ghostStage = Math.max(1, Math.min(999, Math.floor(Number(data.ghostStage) || 1)));
      // P1-5 周末商店限购 + P1-6 挑战券（旧档无字段 → 默认值，随日期/周 key 自然重置）
      this.weekShopWeek = typeof data.weekShopWeek === 'string' ? data.weekShopWeek : '';
      this.weekShopBought = null;
      if (data.weekShopBought && typeof data.weekShopBought === 'object') {
        const wb = data.weekShopBought;
        this.weekShopBought = {
          energy: Math.max(0, Math.min(99, Math.floor(Number(wb.energy) || 0))),
          coupon: Math.max(0, Math.min(99, Math.floor(Number(wb.coupon) || 0))),
          legend: Math.max(0, Math.min(99, Math.floor(Number(wb.legend) || 0)))
        };
      }
      this.ticketDate = typeof data.ticketDate === 'string' ? data.ticketDate : '';
      this.freeTicketsUsed = Math.max(0, Math.min(FREE_TICKETS_PER_DAY, Math.floor(Number(data.freeTicketsUsed) || 0)));
      this.bonusTickets = Math.max(0, Math.min(BONUS_TICKET_CAP, Math.floor(Number(data.bonusTickets) || 0)));
      this.ticketAdCount = Math.max(0, Math.min(TICKET_AD_DAILY_CAP, Math.floor(Number(data.ticketAdCount) || 0)));
      // P2-4 图鉴引导 / P2-7 赛季荣耀（旧档无字段 → 默认值）
      this.codexNudged = !!data.codexNudged;
      this.arenaPeakTier = (data.arenaPeakTier == null) ? -1 : Math.max(-1, Math.min(5, Math.floor(Number(data.arenaPeakTier))));
      this.arenaMasterGranted = !!data.arenaMasterGranted;
      this._traitsMigrated = !!data._traitsMigrated;
      this._shareEntryClaimed = !!data._shareEntryClaimed;

      // P0-3 词条清洗：只保留合法 id、去重、封顶 2 条。
      // 旧存档陀螺无 traits 字段 → 补 1 条随机词条（并置 _traitsMigrated，确保首帧存档即持久化，
      // 避免反复重进游戏时词条被反复重掷的观感）。
      this._cleanTraits = (arr) => {
        if (!Array.isArray(arr)) return null;
        const seen = {}; const out = [];
        for (const t of arr) {
          // 存档格式是 id 字符串数组（save 写入 t.id）；也兼容 {id} 对象形态（防御旧手写档）
          const id = (typeof t === 'string') ? t : (t && t.id);
          if (id && traitById(id) && !seen[id] && out.length < 2) { seen[id] = 1; out.push({ id }); }
        }
        return out;
      };
      if (Array.isArray(data.inventory)) {
        this.inventory = data.inventory
          .filter(it => it && typeof it === 'object')
          .map(item => {
            const bb = new Beyblade(
              clamp(item.tierIndex | 0, 0, TIERS.length - 1),
              clamp(item.level | 0, 1, 5)
            );
            if (item && typeof item.id === 'string') bb.id = item.id; // 恢复持久化唯一 id（选择出战依赖）
            const tr = this._cleanTraits(item.traits);
            if (tr) bb.traits = tr;
            else if (!Array.isArray(item.traits)) { bb.traits = rollTraits(1); this._traitsMigrated = true; }
            if (item && typeof item.rerolls === 'number' && item.rerolls > 0) bb.rerolls = Math.min(999, Math.floor(item.rerolls));
            return bb;
          })
          .slice(0, INVENTORY_HARD_CAP);
      }
      // 合成台三槽持久化：放上台的陀螺不再因重启丢失（旧存档无 platform 字段时保持空槽）
      if (Array.isArray(data.platform)) {
        this.platformSlots = data.platform.slice(0, 3).map(item => {
          if (!item || typeof item !== 'object') return null;
          const bb = new Beyblade(
            clamp(item.tierIndex | 0, 0, TIERS.length - 1),
            clamp(item.level | 0, 1, 5)
          );
          if (typeof item.id === 'string') bb.id = item.id;
          const tr = this._cleanTraits(item.traits);
          if (tr) bb.traits = tr;
          else if (!Array.isArray(item.traits)) { bb.traits = rollTraits(1); this._traitsMigrated = true; }
          if (typeof item.rerolls === 'number' && item.rerolls > 0) bb.rerolls = Math.min(999, Math.floor(item.rerolls));
          return bb;
        });
        while (this.platformSlots.length < 3) this.platformSlots.push(null);
        this.platformSlots.length = 3;
      }
      if (Array.isArray(data.collection)) {
        for (const saved of data.collection) {
          if (!saved || typeof saved !== 'object') continue;
          const t = clamp(saved.tierIndex | 0, 0, TIERS.length - 1);
          const l = clamp(saved.level | 0, 1, 5);
          const item = this.collection.find(c => c.tierIndex === t && c.level === l);
          if (item) item.unlocked = !!saved.unlocked;
        }
      }
      // 首程引导 obStep 推导必须在 inventory 恢复之后（依赖背包是否为空）
      this.obStep = this.obDone ? 0 : (this.inventory.length === 0 ? 1 : 2);
      // 出战陀螺持久选择：旧存档（无 battleBbId 字段）自然回落为 null → selectBattleBeyblade 走战力最高兜底
      this.battleBbId = (typeof data.battleBbId === 'string') ? data.battleBbId : null;
      // 「已选择 XX」toast 是否已弹过：老存档无此字段 → false → 首次点选仍给一次引导，之后永久静默
      this.battleSelectHinted = !!data.battleSelectHinted;
    } catch (e) {
      console.warn('[load] failed, starting fresh:', e && e.message || e);
    }
  }

  /**
   * 存档数据迁移：将旧版本存档迁移到最新版本格式
   * @param {Object} data - 旧版本存档数据
   * @param {number} fromVersion - 源版本号
   * @returns {Object} 迁移后的存档数据
   */
  _migrateSave(data, fromVersion) {
    let migrated = Object.assign({}, data);

    // v1 → v2：添加新增字段，设置默认值
    if (fromVersion < 2) {
      // v2新增字段：签到系统、离线奖励、合成计数等
      if (typeof migrated.signDate !== 'string') migrated.signDate = '';
      if (typeof migrated.signDay !== 'number') migrated.signDay = 0;
      if (typeof migrated.signClaimed !== 'boolean') migrated.signClaimed = false;
      if (typeof migrated.signStreak !== 'number') migrated.signStreak = 0;
      if (typeof migrated.signMakeupDate !== 'string') migrated.signMakeupDate = '';
      if (typeof migrated.lastSeen !== 'number') migrated.lastSeen = 0;
      if (typeof migrated.offlineRewardDate !== 'string') migrated.offlineRewardDate = '';
      if (typeof migrated.mergeCount !== 'number') migrated.mergeCount = 0;
      if (typeof migrated.hiddenDrops !== 'number') migrated.hiddenDrops = 0;
      if (typeof migrated.battleChest !== 'string') migrated.battleChest = '';
      if (typeof migrated.chestOpenDate !== 'string') migrated.chestOpenDate = '';
      if (typeof migrated.boostDate !== 'string') migrated.boostDate = '';
      if (typeof migrated.boostCount !== 'number') migrated.boostCount = 0;
      // 旧版本地模拟的假好友最高分字段已随 P0-2 开放数据域真榜下线，不再迁移/写入。
      // v2新增：双人合作战绩（纯战绩，可选字段，无则不存默认 0）
      if (typeof migrated.coopStage !== 'number') migrated.coopStage = 0;
      if (typeof migrated.coopWins !== 'number') migrated.coopWins = 0;
      if (typeof migrated.resultDoubleDate !== 'string') migrated.resultDoubleDate = '';
      if (typeof migrated.resultDoubleCount !== 'number') migrated.resultDoubleCount = 0;
      if (typeof migrated._shareEntryClaimed !== 'boolean') migrated._shareEntryClaimed = false;
      // v2新增：经验和等级系统
      if (typeof migrated.exp !== 'number') migrated.exp = 0;
      if (typeof migrated.level !== 'number') migrated.level = 1;
      if (typeof migrated.codexClaimed !== 'number') migrated.codexClaimed = 0;
      if (typeof migrated._masterSkin !== 'boolean') migrated._masterSkin = false;
      // v2新增：竞技场系统
      if (typeof migrated.arenaPts !== 'number') migrated.arenaPts = 0;
      if (typeof migrated.arenaWeek !== 'string') migrated.arenaWeek = '';
      if (typeof migrated.arenaBest !== 'number') migrated.arenaBest = 0;
      if (typeof migrated.arenaClaimedWeek !== 'string') migrated.arenaClaimedWeek = '';
      // v2新增：每日任务系统
      if (typeof migrated.dailyDate !== 'string') migrated.dailyDate = '';
      if (!Array.isArray(migrated.dailyTasks)) migrated.dailyTasks = [0, 0, 0];
      if (typeof migrated.dailyActive !== 'number') migrated.dailyActive = 0;
      if (typeof migrated.dailyChestClaimed !== 'boolean') migrated.dailyChestClaimed = false;
      // v2新增：广告能量系统
      if (typeof migrated.adEnergyDate !== 'string') migrated.adEnergyDate = '';
      if (typeof migrated.adEnergyCount !== 'number') migrated.adEnergyCount = 0;
      // v2新增：抽卡隐藏插屏广告（原"看广告免费抽"按钮已合并移除）
      if (typeof migrated.drawsSinceAd !== 'number') migrated.drawsSinceAd = 0;
      if (typeof migrated.interAdDate !== 'string') migrated.interAdDate = '';
      if (typeof migrated.interAdCount !== 'number') migrated.interAdCount = 0;
      if (typeof migrated.interAdBroken !== 'boolean') migrated.interAdBroken = false;
      if (typeof migrated.homeInterInstallDate !== 'string') migrated.homeInterInstallDate = '';
      if (typeof migrated.homeInterAdDate !== 'string') migrated.homeInterAdDate = '';
      if (typeof migrated.homeInterAdCount !== 'number') migrated.homeInterAdCount = 0;
      if (typeof migrated.battleTutShown !== 'boolean') migrated.battleTutShown = false;
      // v2新增：合成台三槽
      if (!Array.isArray(migrated.platform)) migrated.platform = [null, null, null];
      // v1的tierIndex范围是0-3（4品质），v2是0-4（5品质），需要映射
      // 注意：这里不做强制映射，因为v1的陀螺数据可能已经是正确的
      // 如果后续版本有品质系统变更，需要在这里添加映射逻辑
    }

    // 未来版本迁移可以在这里添加
    // if (fromVersion < 3) { ... }

    // 更新schema版本为当前版本
    migrated.schema = SCHEMA_VERSION;
    migrated.savedAt = Date.now();

    return migrated;
  }
}

module.exports = { GameState, TIERS, SIGN_REWARDS, COIN_DRAW_COST };
