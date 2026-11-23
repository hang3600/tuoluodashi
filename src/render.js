/**
 * Canvas 2D 渲染器（UX 重构版 · 2026-08-19）
 * 设计目标：
 *  - 严格分层：TopBar / Title / Arena / ActionBar / FilterBar / Inventory，每层有独立底边，互不越界。
 *  - 对 375×667（iPhone SE）→ 430×932（iPhone 15 Pro Max）全机型自适应，内容不撞胶囊、不撞 Home Bar、不互相压盖。
 *  - 安全区基线（Main.js 传入）：safeTop ≥ 胶囊底 + 10px 气隙；safeBottom ≥ screenHeight-windowHeight。
 *  - 苹果风视觉：渐变按钮、投影、按下态、苹方/SF 字体栈、圆角胶囊 HUD。
 */

const { drawBeyblade, TIERS, Beyblade, ELEMENTS, elementBeatenBy, traitById } = require('./beyblade');
const { isPointInRect, formatNumber, drawVectorIcon, prepSrc: _prepSrc, loadOne: _loadOne, downscaleToCap } = require('./utils');
const { CONFIG } = require('./config');
const { UI, APPLE_FONT } = require('./ui');   // ①设计令牌（字体/色彩/圆角/手感一致）
const { SIGN_REWARDS } = require('./game');
const { getOpenDataContext } = require('./leaderboard');   // P0-2：开放数据域上下文（好友榜 sharedCanvas）

// 图鉴筛选条短名映射（仅当按钮宽度不足放全名时取首字）。提升为模块级常量，避免每帧重建对象。
const CODEX_FILT_SHORT = { '麒麟': '麒', '青龙': '青', '玄武': '玄', '朱雀': '朱', '白虎': '白' };
// 图鉴筛选条名称数组（仅随 fullName 布尔变化，与布局无关）→ 模块级 memo，避免每帧 TIERS.map 新建数组。
const CODEX_FILT_NAMES = {
  true: ['全部', ...TIERS.map(t => t.name)],
  false: ['全', ...TIERS.map(t => (CODEX_FILT_SHORT[t.name] || t.name.charAt(0)))],
};

// 主页宇宙星海战场背景贴图（AI 生成，内嵌 base64）。
// 与竞技场同机制：模拟器走 data URI（零 HTTP，不踩 404），真机写 USER_DATA_PATH。
const _HOME_B64 = (function () { try { return require('./homebg'); } catch (e) { return null; } })();
// 图鉴独立背景：暗调陈列星图，与主页「宇宙星海战场」区分，且更静更暗以承载 25 只陀螺密集网格。
const _CODEX_B64 = (function () { try { return require('./codexbg'); } catch (e) { return null; } })();

// APPLE_FONT 统一来自 ./ui（见顶部 require('./ui')），消除与 spintop 的双份字面量

// 背景图解码封顶（U10-C）：LOW 档降到 540p 省解码内存，其余维持 720p。
// 纯函数，便于无头测试。
function capForLevel(perfLevel) {
  return (perfLevel === 'LOW') ? 540 : 720;
}

// 模态面板遮罩透明度统一（P2-7）：原 0.72/0.78/0.80/0.82 四种散落各处，统一为单一常量
const PANEL_MASK_ALPHA = 0.82;
const PANEL_MASK = 'rgba(10,5,25,' + PANEL_MASK_ALPHA + ')';

// 静态/重复文本测量缓存：measureText 依赖 ctx.font，按 font+text 做 Map 缓存，
// 避免内容恒定的按钮名/标签每帧重复排版计算（P1-8-4）。
const _mtCache = new Map();
const MT_CACHE_MAX = 256;
function mtW(ctx, text) {
  const k = ctx.font + '' + text;
  let v = _mtCache.get(k);
  if (v === undefined) {
    v = ctx.measureText(text).width;
    _mtCache.set(k, v);
    if (_mtCache.size > MT_CACHE_MAX) {
      // Map 迭代序=插入序，删除最旧条目实现 LRU（key 含动态串，须封顶防无界增长）。
      _mtCache.delete(_mtCache.keys().next().value);
    }
  }
  return v;
}

/** 内存告警时清空 measureText 缓存（纯计算缓存，清掉只是重新测量，视觉零变化）。@returns {number} 释放条目数 */
function clearMeasureTextCache() {
  const n = _mtCache.size;
  _mtCache.clear();
  return n;
}

class Renderer {
  constructor(canvas, ctx, game, safeTop = 56, safeBottom = 24, menuBtn = null) {
    this.canvas = canvas;
    this.ctx = ctx;
    this.game = game;
    // 【跨平台修复 #3】逻辑尺寸 = canvas 物理尺寸 / dpr（canvas 物理由 Main 按 DPR 超采样设定）；
    // 所有绘制坐标用逻辑像素，由 render(dt) 每帧 setTransform(dpr) 映射到物理像素。
    this.dpr = (canvas && canvas.dpr) || 1;
    this.width = (canvas && canvas.width > 0) ? canvas.width / this.dpr : 375;
    this.height = (canvas && canvas.height > 0) ? canvas.height / this.dpr : 667;
    // 安全区域统一处理：验证和修正safeTop/safeBottom，确保在合理范围内
    // - safeTop：最小20px（状态栏），最大120px（避免异常值导致布局错位）
    // - safeBottom：最小10px（Home指示条），最大80px（避免异常值导致布局错位）
    // - 安全区域总和不超过屏幕高度的30%（避免异常值导致内容区域过小）
    const rawSafeTop = typeof safeTop === 'number' && safeTop > 0 ? safeTop : 56;
    const rawSafeBottom = typeof safeBottom === 'number' && safeBottom > 0 ? safeBottom : 24;
    const maxSafeTotal = this.height * 0.3;
    this.safeTop = Math.max(20, Math.min(120, rawSafeTop));
    this.safeBottom = Math.max(10, Math.min(80, rawSafeBottom));
    if (this.safeTop + this.safeBottom > maxSafeTotal) {
      // 安全区域过大，按比例缩减
      const ratio = maxSafeTotal / (this.safeTop + this.safeBottom);
      this.safeTop = Math.max(20, Math.floor(this.safeTop * ratio));
      this.safeBottom = Math.max(10, Math.floor(this.safeBottom * ratio));
    }
    this.menuBtn = menuBtn || null;   // 微信胶囊矩形（逻辑坐标），用于胶囊左侧手柄入口

    // 真实 PNG 数字资产（设计稿 v3 落地）：顶栏/道具图标替换矢量绘制
    this.icons = {};
    this._iconFiles = {
      coin: 'icon-coin.png', mute: 'icon-mute.png', unmute: 'icon-unmute.png',
      share: 'icon-share.png', sign: 'icon-sign.png', check: 'icon-check.png',
      back: 'icon-back.png', more: 'icon-more.png',
      metal: 'icon-metal.png', wood: 'icon-wood.png', water: 'icon-water.png', fire: 'icon-fire.png', earth: 'icon-earth.png',
      speed: 'icon-speed.png', double: 'icon-double.png', slow: 'icon-slow.png',
      energy: 'icon-energy.png',
      task: 'icon-task.png', chest: 'icon-chest.png',
      'daily-battle': 'icon-daily-battle.png', 'daily-merge': 'icon-daily-merge.png', 'daily-draw': 'icon-daily-draw.png',
      arena: 'icon-arena.png',
      'rank-bronze': 'icon-rank-bronze.png', 'rank-silver': 'icon-rank-silver.png',
      'rank-gold': 'icon-rank-gold.png', 'rank-platinum': 'icon-rank-platinum.png',
      'rank-diamond': 'icon-rank-diamond.png', 'rank-master': 'icon-rank-master.png',
      // 图标资产 v3：替换文本字符 ★✦▶（图鉴集齐/传说标题/签到大奖/宝箱/结算再战）
      star: 'icon-star.png', sparkle: 'icon-sparkle.png', play: 'icon-play.png', lock: 'icon-lock.png',
      // 图标资产 v3 补漏：分页箭头 / 弹窗关闭 / Tab 合成 / Tab 图鉴
      prev: 'icon-prev.png', next: 'icon-next.png', close: 'icon-close.png',
      merge: 'icon-merge.png', codex: 'icon-codex.png'
    };
    this._loadIcons();

    this._reflow();

    this.pressedBtn = null;
    this.buttons = [];
    // 按钮对象池：避免每帧创建新按钮对象，复用对象减少GC压力
    // 诊断高频GC是卡顿主因之一，按钮是每帧创建最多的对象类型
    this._buttonPool = [];
    this.gridRects = [];
    this.invScrollX = 0;      // 陈列轨道横向滚动偏移（V2 陈列模式使用）
    this._invVel = 0;         // 陈列轨道松手惯性速度（px/帧，每帧由 _stepInvInertia 衰减）
    this.platformRects = [];
    this.filterRects = [];
    this.tabRects = [];
    this.particles = [];
    this.rings = [];
    this.floatTexts = [];
    this.drag = null;
    this.modalRects = [];
    this.clubGuideRects = [];
    this.audio = null;
    this._frameCount = 0;
    // 性能缓存：离屏背景 / 布局签名 / 命中区复用（降低每帧 CPU 计算与 GC 压力）
    this._bgCache = null;
    this._bgCacheKey = null;
    this._layoutSig = null;
    // 主页 AI 场景背景：懒加载一次，加载完成后作废 _bgCache 触发重烘焙
    this._homeBgImage = null;
    this._codexBgImage = null;
    this._codexBgTried = false;
    this._homeBgTried = false;
    // 低端机 / iOS shadow 降级档：软投影是 Canvas2D 最贵绘制路径。
    // auto 按 compact（小屏低端）或 iOS（WebKit 软件渲染阴影极贵，无 GPU 加速）判定；
    // 并允许 game.lowFX 强制 0/1 覆盖。
    this.shadowScale = 1;        // 装饰阴影档（标题辉光/能量条/格子/弹层等每帧开销）
    this.pressShadow = 1;        // 按下态阴影档（仅触摸反馈，短促低密度，始终保留手感）
    this._isIOS = false;
    this._isAndroid = false;
    this._androidFontScale = 1; // 安卓字体缩放系数（部分机型系统字体放大导致布局错位）
    try {
      if (typeof wx !== 'undefined' && wx.getSystemInfoSync) {
        const si = wx.getSystemInfoSync();
        this._isIOS = (si.platform === 'ios') || /iOS/i.test(si.system || '');
        this._isAndroid = (si.platform === 'android') || /Android/i.test(si.system || '');
        // 安卓字体缩放：fontSizeSetting > 16 表示系统字体放大，需要反向缩放布局
        if (this._isAndroid && si.fontSizeSetting && si.fontSizeSetting > 16) {
          this._androidFontScale = Math.max(0.85, 16 / si.fontSizeSetting);
        }
      } else if (typeof navigator !== 'undefined' && (navigator.platform || navigator.userAgent)) {
        const ua = (navigator.platform || '') + ' ' + (navigator.userAgent || '');
        this._isIOS = /iPhone|iPad|iPod/i.test(ua);
        this._isAndroid = /Android/i.test(ua);
      }
    } catch (e) {}
    // 高频渐变缓存（能量条 / 平台底板等每帧重建的渐变），降低每帧分配与 GC
    this._gradCache = new Map();
    // 图鉴格子 Beyblade 实例缓存：按 "tier:level" 复用，避免每帧每格 new（约30次/帧）且构造随机 angle 致抖动
    this._codexBbCache = {};

    this.stars = [];
    let seed = 1234.5678;
    for (let i = 0; i < 26; i++) {
      seed = (seed * 9301 + 49297) % 233280;
      const rx = seed / 233280;
      seed = (seed * 9301 + 49297) % 233280;
      const ry = seed / 233280;
      seed = (seed * 9301 + 49297) % 233280;
      const rs = seed / 233280;
      this.stars.push({ rx, ry, s: (i % 3) + 1, a: 0.12 + (i % 5) * 0.05 });
    }
  }

  // ==========================================================
  // 按钮对象池：避免每帧创建新按钮对象，复用对象减少GC压力
  // 诊断高频GC是卡顿主因之一，按钮是每帧创建最多的对象类型
  // ==========================================================

  /** 从对象池获取按钮对象，设置属性后返回 */
  getButton(x, y, w, h, action) {
    const btn = this._buttonPool.pop() || {};
    btn.x = x; btn.y = y; btn.w = w; btn.h = h; btn.action = action;
    return btn;
  }

  /** 将当前帧的按钮对象全部回收到对象池（在render()开始时调用） */
  releaseButtons() {
    for (let i = 0; i < this.buttons.length; i++) {
      const btn = this.buttons[i];
      // 清理引用，避免内存泄漏
      for (const k in btn) delete btn[k];
      this._buttonPool.push(btn);
    }
    this.buttons.length = 0;
    // 对象池上限：避免长期运行后对象池无限增长
    if (this._buttonPool.length > 200) {
      this._buttonPool.length = 200;
    }
  }

  /** 画布尺寸变化或首次布局：一次性算出所有区域的 y 分隔线和尺寸。
   *
   *  V2（UX 重构 · 解遮挡）：
   *   - 先"自底向上"锁定底部固定成本（ActionBar + FilterBar + Inventory 硬 2 行保底），
   *     剩余高度全部给 Arena，解决 SE 1 行背包 / 大屏留白双问题。
   *   - SubBar（回满/广告）条件性存在：不存在时直接折叠（不给 Title 留空挡），释放 ~30px。
   *   - 过滤器区：SE 下把"抽取"缩到 68，过滤器用 5 字（不切单字）；宽度不够才启动 2 字兜底。
   *   - 图鉴：Lv 标签在 cell 内 top 内嵌，不再悬到 cell 下方与下一行重叠。
   *   - 所有 Y 坐标按严格不等式校验：上区底 <= 下区顶 - 气隙。
   */
  _reflow() {
    // 布局几何变化 → 缓存渐变（绑定旧坐标）与背景离屏（依赖旧尺寸）全部失效
    this._gradCache = new Map();
    const W = this.width, H = this.height;
    const ST = this.safeTop, SB = this.safeBottom;

    // ==========================================================
    // 辅助：判断 SubBar 是否有按钮（与 drawHeader 逻辑一致）
    // 若两个条件都不满足，SubBar 折叠为 0，避免 24px 死白。
    // ==========================================================
    const hasRefill = !!(this.game.canRefill && this.game.canRefill()) && this.game.energy < this.game.maxEnergy;
    const hasAdE = !!(this.game.canWatchAdEnergy && this.game.canWatchAdEnergy());
    // SubBar（免费回满/广告+60/朋友助力）暂时隐藏，后面用别的方式调用
    const subExists = false; // 原：hasRefill || hasAdE

    // ==========================================================
    // 自适应档位：按「内容可用高度」+「屏宽」联合判定，适配更多手机（尤其安卓）
    //   compact = 内容高 < 650 || 屏宽 < 370
    //   · iPhone SE 375×667 → contentH=583 < 650 → compact ✓
    //   · Android 360×640 → contentH=592 < 650 → compact ✓
    //   · Android 360×740 → contentH=676, W=360 < 370 → compact ✓（安卓窄屏也紧凑）
    //   · Android 412×915 → contentH=835, W=412 → 不 compact（大屏充足）
    //   · iPhone 14 390×844 → contentH=754 → 不 compact（纵向充足）
    // ==========================================================
    const contentH = H - ST - SB;
    let compact = contentH < 650 || W < 370;
    // V2 主场景（游戏化骨架）：顶栏更薄、去掉「游戏名+副标题」大标题区（只留视图切换条）、
    // 主操作按钮更高 —— 省下的纵向空间全部让给 Arena 舞台（合成台圆盘）。
    // 与旧大厅并存，game.homeV2 = false 即完整回退。
    const v2 = this.game.homeV2 !== false;   // 默认开启；game.homeV2 = false 完整回退旧大厅

    // ==========================================================
    // 安卓机型特殊适配：
    // 1. 系统字体放大（fontSizeSetting > 16）导致文字溢出布局
    // 2. 安卓字体渲染差异（行高、字间距）导致视觉错位
    // 3. 部分低端安卓机屏幕密度低，需要更紧凑的布局
    // 解决方案：全局字体缩放系数 + 紧凑布局强制开启
    // ==========================================================
    const fontScale = this._androidFontScale || 1;
    if (this._isAndroid) {
      // 安卓机型：系统字体放大超过10%时强制compact，避免文字溢出
      if (fontScale < 0.95) compact = true;
      // 安卓低端机（benchmarkLevel < 30）也强制compact
      if (this.perfLevel === 'LOW') compact = true;
    }

    // ==========================================================
    // 区域 1 · TopBar（胶囊下方气隙后第一行：左金币 / 中能量条居中 / 右图标组）
    // ==========================================================
    const topBarH = v2 ? (compact ? 38 : 40) : (compact ? 42 : 46);
    const topBarY = ST + 8;
    const leftPad = 16, rightPad = 16; // rightPad 12→16，能量条和右侧图标间距增加4px，呼吸感更好
    const signBtnW = compact ? 46 : 52;
    const icoW = (compact ? 34 : 38), icoGap = (compact ? 6 : 8);
    const rightIconsW = signBtnW + icoW + icoGap;  // 签到 + 音量（分享已去除）
    const rightXStart = W - rightPad - rightIconsW;
    // 能量条：以屏幕中心线为中心，固定宽度居中，不靠边
    const energyW = Math.min(140, Math.max(100, Math.floor(W * 0.36))); // 宽度100-140，按屏自适应
    const energyX = (W - energyW) / 2; // 居中
    // 金币宽度：限制在能量条左边，不重叠（左16到能量条x-16，间距10→16，增加6px呼吸感）
    const coinMaxW = Math.max(60, energyX - leftPad - 16);
    const coinEstW = Math.min(coinMaxW, Math.max(compact ? 72 : 84, Math.floor(W * 0.28)));
    const coinXEnd = leftPad + coinEstW;

    // ==========================================================
    // 区域 1.5 · SubBar（免费回满 / 广告+60 独立一行）— 条件折叠
    // ==========================================================
    const subBtnH = 24;
    const subBtnGap = 8;
    const topSubGap = (compact ? 4 : 6);
    const subTitleGap = subExists ? (compact ? 6 : 10) : 6;
    const subBarY = subExists ? (topBarY + topBarH + topSubGap) : (topBarY + topBarH);
    const subBarH = subExists ? subBtnH : 0;

    // ==========================================================
    // 区域 2 · Title（游戏名 + 副标题 + Tab）
    //   紧凑版（24+18+28 = 70）：SE 再省 26px
    // ==========================================================
    const titleY = subBarY + (subExists ? (subBarH + subTitleGap) : 6);
    const titleInnerHeadGap = compact ? 0 : 1; // 减少顶部间距，让Tab更靠上
    const titleTitleSize = compact ? 22 : 26; // 标题字号28→26，减少2px
    const titleSubGap = compact ? 2 : 4; // 副标题间距6→4，减少2px
    const titleSubLineH = compact ? 12 : 16; // 副标题高度20→16，减少4px
    const titleTabGap = compact ? 0 : 0; // Tab间距设为0（最小合理值）
    const titleTabH = (compact ? 26 : 28);
    const titleFootGap = 1;
    const titleH = v2 ? (titleTabH + 6) : (titleInnerHeadGap + titleTitleSize + titleSubGap + titleSubLineH + titleTabGap + titleTabH + titleFootGap);
    // Tab：SE 从 76→72；同时按 W 均分，不居中留白太多
    const tabBaseW = compact ? 72 : 76;
    const tabTotalGap = 16;
    const tabW = Math.min(tabBaseW, Math.max(68, Math.floor((W - 40 - tabTotalGap) / 2)));
    const tabY = v2 ? (titleY + 3) : (titleY + titleInnerHeadGap + titleTitleSize + titleSubGap + titleSubLineH + titleTabGap);
    // Title↔Arena 气隙：SE 从 8→4（圆盘自己有 12 阴影，不会看起来贴标题）
    const titleArenaGap = v2 ? (compact ? 8 : 16) : (compact ? 4 : 12);

    // ==========================================================
    // 区域 4 · ActionBar（对战 / 合成）· 自底向上预算高度
    // 区域 5 · FilterBar
    // 区域 6 · Inventory · 保底 2 行；先按「软 cell/gap」估预算，若 2 行会越安全区 → 缩 cell 仍保≥44，再缩 gap 保≥6，最后缩 sbPeg 气隙。
    //                    目标不等式：invY + 2*cell + gap ≤ invMaxBottom（2行底 = y + rowStep*2 - gap）
    // ==========================================================
    const actionBtnH = v2 ? (compact ? 44 : 52) : (compact ? 34 : 40);
    const filterH = compact ? 28 : 38;
    const GAP1 = (compact ? 6 : 10);
    const GAP2 = (compact ? 6 : 10);
    const SB_PEG_INIT = (compact ? 4 : 8);
    const ARENA_ACTION_GAP = (compact ? 8 : 12);
    // 大圆盘与上下两行（tab 行 / 操作按钮行）的最小呼吸间距：保证两端不贴脸（叠加圆盘 12px 阴影后仍留余量）
    const ARENA_BREATH = (compact ? 16 : 24);
    const invCols = Math.max(4, Math.min(5, Math.floor((W - 32) / (58 + 10))));
    let invGap = 10;
    const invCellByW = Math.floor((W - 32 - (invCols - 1) * invGap) / invCols);
    let invCell = Math.max(44, Math.min(invCellByW, 58));
    let invRowStep = invCell + invGap;

    // 先按当前软参数估 Arena → actionY → filterY → invY，再校验 3 行是否撞安全区；
    // 若撞：①缩 cell(>44) → ②缩 gap(>6) → ③缩 sbPeg(>0) → ④缩 minArenaH (最低 180)
    const PAD_BUDGET = (g, c) => g * 3 + c * 3 - g; // (c+g)*3 - g = 3c+2g
    let sbPeg = SB_PEG_INIT;
    let minArenaH = 210;
    function makeBottomFixed(gap, cell, peg) {
      const inv = (cell + gap) * 3;
      return ARENA_ACTION_GAP + actionBtnH + GAP1 + filterH + GAP2 + inv + peg;
    }
    function estimateInvY(gap, cell, peg, mah) {
      const bf = makeBottomFixed(gap, cell, peg);
      const maxArenaBottom = H - SB - bf;
      const minArenaY0 = titleY + titleH + titleArenaGap;
      const arenaDiameterMaxW = v2 ? Math.min(W - 32, Math.max(300, Math.floor(W * 0.82)))
                                   : Math.min(W - 48, Math.max(284, Math.floor(W * 0.72)));
      const arenaH = Math.max(mah, Math.min(maxArenaBottom - minArenaY0 - 2 * ARENA_BREATH, arenaDiameterMaxW));
      const arenaY = minArenaY0 + Math.max(0, Math.floor((maxArenaBottom - minArenaY0 - arenaH) / 2));
      const actionY2 = arenaY + arenaH + ARENA_ACTION_GAP;
      const filterY2 = actionY2 + actionBtnH + GAP1;
      return { invY: filterY2 + filterH + GAP2, invMaxBottom: H - SB - peg };
    }
    // 迭代收敛：最多 90 轮（使用"目标 I6 不等式"直接判定，不使用 bottomFixed 中间量近似）
    //   1-30 轮：缩 cell(>44) / gap(>6) / sbPeg
    //   31-60 轮：缩 minArenaH (>190) + cell/gap 继续
    //   61-90 轮：**最后手段**：minArenaH↓170（Arena 最小 170·340/2=170，仍远>陀螺半径+合成槽+道具可视），
    //             并允许 cell↓38 / gap↓2 — cell≥38 仍是 HIG 推荐 40 的 ±2 可按区域
    // 核心不等式 target：invY + 3*rowStep - gap ≤ H - SB - sbPeg
    for (let iter = 0; iter < 90; iter++) {
      const { invY: yTest, invMaxBottom: mb } = estimateInvY(invGap, invCell, sbPeg, minArenaH);
      const rowStep = invCell + invGap;
      const invBottom = yTest + rowStep * 3 - invGap;
      if (invBottom <= mb) break;
      if (iter < 30) {
        if (invCell > 44) { invCell--; continue; }
        if (invGap > 6)  { invGap--; continue; }
        if (sbPeg > 0)  { sbPeg--; continue; }
        if (minArenaH > 190) { minArenaH--; continue; }
        continue;
      }
      if (iter < 60) {
        if (minArenaH > 190) { minArenaH--; continue; }
        if (invCell > 40) { invCell--; continue; }
        if (invGap > 4)  { invGap--; continue; }
        continue;
      }
      // 最后手段：极限压缩
      if (minArenaH > 170) { minArenaH--; continue; }
      if (invCell > 38)  { invCell--; continue; }
      if (invGap > 2)    { invGap--; continue; }
      break;
    }
    invRowStep = invCell + invGap;
    const BOTTOM_COSTS = {
      arenaGap: ARENA_ACTION_GAP,
      action: actionBtnH,
      gap1: GAP1,
      filter: filterH,
      gap2: GAP2,
      inv: invRowStep * 2,
      sbPeg,
    };
    const bottomFixed = BOTTOM_COSTS.arenaGap + BOTTOM_COSTS.action + BOTTOM_COSTS.gap1 + BOTTOM_COSTS.filter
                      + BOTTOM_COSTS.gap2 + BOTTOM_COSTS.inv + BOTTOM_COSTS.sbPeg;
    // Arena 上限：W 的 72%（大屏放大不再死卡 284），但至少 210
    const arenaDiameterMaxW = v2 ? Math.min(W - 32, Math.max(300, Math.floor(W * 0.82)))
                                 : Math.min(W - 48, Math.max(284, Math.floor(W * 0.72)));

    // ==========================================================
    // 区域 3 · Arena（合成台）— 大圆盘严格在Tab行底部和操作按钮行顶部的中间位置
    // 先固定操作按钮位置（基于底部预算），再计算中间位置
    // ==========================================================
    const minArenaY = titleY + titleH + titleArenaGap;
    const maxArenaBottom = H - SB - bottomFixed;
    // 直径上限收为「可用高度 - 2×呼吸间距」，圆盘居中后上下各留 ≥ ARENA_BREATH 的空隙（不再贴 tab 行与操作行）
    const arenaH = Math.max(minArenaH, Math.min(maxArenaBottom - minArenaY - 2 * ARENA_BREATH, arenaDiameterMaxW));
    const arenaR = arenaH / 2;
    const arenaCx = W / 2;
    // Tab行底部 = tabY + titleTabH
    const tabBottom = tabY + titleTabH;
    // 操作按钮行顶部（基于底部预算固定，不依赖arenaY），恢复到原始位置（上移20px在手机屏幕上不行）
    const actionYFixed = H - SB - (ARENA_ACTION_GAP + actionBtnH + GAP1 + filterH + GAP2 + invRowStep * 2 + sbPeg);
    // 大圆盘中心 = Tab行底部和操作按钮行顶部的中间位置
    const arenaCy = (tabBottom + actionYFixed) / 2;
    const arenaY = arenaCy - arenaR;

    // 反推 slotR 与 d，保证三槽不越界；目标 slotR 越大越好（≥24）
    const availForSlots = arenaR - 4;
    let slotR = Math.max(24, Math.floor((availForSlots - 3.46) / 2.155));
    let slotD = slotR * 2 + 6;
    let slotCircum = slotD * Math.sqrt(3) / 3;
    if (slotCircum + slotR + 3 > arenaR) {
      slotR = Math.max(20, slotR - 2);
      slotD = slotR * 2 + 6;
      slotCircum = slotD * Math.sqrt(3) / 3;
    }
    const slotAngles = [-Math.PI / 2, Math.PI / 6, Math.PI * 5 / 6];

    // ==========================================================
    // 区域 4 · ActionBar — 操作按钮位置固定（基于底部预算），不依赖于大圆盘位置
    // ==========================================================
    const actionY = actionYFixed;

    // ==========================================================
    // 区域 5 · FilterBar
    // ==========================================================
    const filterY = actionY + actionBtnH + BOTTOM_COSTS.gap1;

    // ==========================================================
    // 区域 6 · Inventory — 最多 2 行显示（用户要求：三行改成两行）
    // ==========================================================
    const invY = filterY + filterH + BOTTOM_COSTS.gap2;
    const invMaxBottom = H - SB - BOTTOM_COSTS.sbPeg;
    const rowsMax = Math.max(2, Math.min(2, Math.floor((invMaxBottom - invY + invGap) / invRowStep)));
    const invStartX = (W - (invCols * invCell + (invCols - 1) * invGap)) / 2;

    // ==========================================================
    // 过滤器预算：右侧"抽取"宽度按屏自适应，过滤器用全名优先（5 字不切）
    // 临界 375：右抽取=68，gap*5=32，leftPad+rightReserve=16+82=98，avail=375-98-32=245 → 每格 49
    // 49px × 5 字中文 · 字号 11，能放全名（实测 11px 中文宽 ~13，"麒麟"26，剩余 23 气隙 ✓）
    // ==========================================================
    const drawBtnW = compact ? 68 : 76;
    const rightReserve = drawBtnW + (compact ? 10 : 14);

    // ==========================================================
    // 图鉴：品质标签单独一行（上面），陀螺图标单独一行（下面），5个陀螺占满整个宽度并放大
    // 每个品质占用两行：品质标签行 + 陀螺行
    // 右端严格等式：gridStartX(12) + 5*codexCell + 4*codexGap + codexRightPad == W
    // 图鉴头部独立带：位于 Tab 条下方、与 Tab 不重叠，给足呼吸感（修复上半部分标题/进度条与 Tab 叠压遮挡）
    // 旧版 codex 标题锚在 titleY+2，与 Tab 条(titleY+3)同 Y 叠压、进度条又贴着 Tab 底 → 上半部分遮挡拥挤
    // ==========================================================
    const codexTabGap = 16;                                          // Tab 条 ↔ 图鉴标题 间距（呼吸感）
    const codexHeaderTop = tabY + titleTabH + codexTabGap;          // 图鉴标题顶（baseline-top）
    const codexTitleH = 22;                                         // 标题 18px 字 + 余量
    const codexProgGap = 12;                                        // 标题 ↔ 进度条 间距
    const codexProgH = 10;                                          // 进度条高 + 百分比行
    const codexHeaderBottom = codexHeaderTop + codexTitleH + codexProgGap + codexProgH;
    const codexHeadBreath = 16;                                     // 头部 ↔ 陀螺网格 间距（额外呼吸）
    const codexStartY = codexHeaderBottom + codexHeadBreath;
    const codexProgY = codexHeaderTop + codexTitleH + codexProgGap;
    // 底部预留阶段奖励细条带（codexFooterH），网格整体让出此高度，避免与底部奖励带重叠
    const codexFooterH = 52;
    const codexUsableBottom = H - SB - 12 - codexFooterH;
    // 每个品质两行（品质标签+陀螺），行高最小值68px（原72→68，再收缩一点）
    const codexRowH = Math.max(68, Math.floor((codexUsableBottom - codexStartY) / TIERS.length));
    const codexLabelW = 0;                         // 品质标签在上面，不占用水平空间
    const codexLeftPad  = 12;                       // gridStartX 在 drawCodex 里是 12，这里对齐
    const codexRightPad = 12;
    const codexGap = 8;
    // 5个陀螺占满整个宽度（不再有品质标签区域）
    const avail = W - codexLeftPad - (4 * codexGap) - codexRightPad;
    const codexCell = Math.max(36, Math.floor(avail / 5));
    const codexGridStartX = codexLeftPad;           // 从左边开始，5个陀螺占满
    const codexGridRight = codexGridStartX + 5 * codexCell + 4 * codexGap;
    // 保险：如果浮点 floor 仍有 -1~1 的右越，再把 codexCell -1 回退
    let codexCellFinal = codexCell;
    if (codexGridRight + codexRightPad > W) {
      codexCellFinal = Math.max(36, codexCell - 1);
    }

    this.layout = {
      W, H, ST, SB, compact,
      // 区域 1
      topBarY, topBarH,
      coinXEnd, energyX, energyW, rightXStart,
      signBtnW, icoW, icoGap, leftPad, rightPad,
      titleTitleSize, titleSubLineH,            // 给 drawTitleAndTabs 用
      // 区域 1.5
      subBarY, subBarH, subBtnH, subBtnGap,
      subExists, hasRefill, hasAdE,
      // 区域 2
      titleY, titleH, tabY, tabW,
      // 区域 3
      arenaX: arenaCx - arenaR, arenaY, arenaW: arenaR * 2, arenaH, arenaCx, arenaCy, arenaR,
      slotR, slotD, slotCircum, slotAngles,
      // 区域 4
      actionY, actionBtnH,
      // 区域 5
      filterY, filterH, drawBtnW, rightReserve,
      // 区域 6
      invY, invMaxBottom, invCols, invGap, invCell, invStartX, invRowsMax: rowsMax, invRowStep,
      // 图鉴
      codexStartY, codexRowH, codexLabelW, codexLeftPad, codexRightPad, codexGap, codexCell: codexCellFinal, codexGridStartX, codexFooterH,
      codexHeaderTop, codexHeaderBottom, codexProgY,
      // 给开发校验用：bottom 预算 / arena 预算
      _bottomFixed: bottomFixed,
      _arenaBudget: maxArenaBottom - minArenaY,
    };
  }

  resize(w, h) {
    this.width = w; this.height = h;
    // 【跨平台修复 #3】canvas 物理尺寸 = 逻辑(w/h) × dpr
    const d = this.dpr || 1;
    this.canvas.width = Math.round(w * d);
    this.canvas.height = Math.round(h * d);
    this._reflow();
    this._layoutSig = this._curSig();
  }

  /** 布局依赖的运行时状态签名（canvas 尺寸 + SubBar 折叠相关状态） */
  _curSig() {
    const g = this.game;
    return (this.width + 'x' + this.height + 'x' + this.safeTop + 'x' + this.safeBottom
      + 'x' + (g.energy < g.maxEnergy) + 'x' + g.maxEnergy
      + 'x' + (!!(g.canRefill && g.canRefill()))
      + 'x' + (!!(g.canWatchAdEnergy && g.canWatchAdEnergy())));
  }

  /** 低端档判定：默认小屏 compact；game.lowFX 可强制覆盖（0=省电关闭软投影，1=全特效） */
  _updateFx() {
    let low = !!(this.layout && this.layout.compact);
    if (this.game && this.game.lowFX !== undefined) low = !!this.game.lowFX;
    // MID 档也关装饰软投影（中端机同样吃不起每帧 shadowBlur，只保留触摸按下反馈）
    else if (this.perfLevel === 'MID') low = true;
    // HIGH 档 Android 旗舰（如 Xiaomi 13 实测 21fps）同样吃不起装饰阴影：只留触摸反馈，砍每帧模糊
    else if (this.perfLevel === 'HIGH' && !this._isIOS) low = true;
    // 【跨平台修复 #2】原 shadowScale 因 `this._isIOS` 强制关闭 + MID/Android-HIGH 也关，
    // 导致所有设备装饰阴影实际恒为 0（iOS 高配被平台一刀切亏待）。
    // 改为：仅 HIGH 档 iOS 旗舰放开装饰阴影；其余维持原性能决策
    // —— MID/LOW/compact/lowFX===0 关，Android HIGH 旗舰仍关（实测软阴影贵：Xiaomi 13→21fps）。
    const allowShadow = (this.perfLevel === 'HIGH' && this._isIOS);
    this.shadowScale = (low || !allowShadow) ? 0 : 1;
    // 按下态阴影：仅当用户显式关闭特效(lowFX===0)才关，否则始终保留触摸反馈
    this.pressShadow = (this.game && this.game.lowFX === 0) ? 0 : 1;
  }

  /** 仅当底部预算依赖状态变化时才重算布局，避免每帧全量计算（纯 CPU 浪费，拖累 FPS） */
  _maybeReflow() {
    this._updateFx();
    const sig = this._curSig();
    if (sig === this._layoutSig) return;
    this._reflow();
    this._layoutSig = sig;
  }

  /** 高频渐变缓存：按几何键缓存渐变对象，避免每帧 createLinearGradient/RadialGradient 分配。
   *  关键：缓存上限 64 条（LRU 淘汰最旧）。动画期间能量条/按钮的渐变 key 含每帧变化坐标，
   *  若无限堆积 CanvasGradient 会触发内存暴涨 + GC 卡顿（云测 24129RT7CC 945MB/64% 卡顿根因）。 */
  _grad(key, create) {
    let g = this._gradCache.get(key);
    if (g) return g;
    g = create();
    this._gradCache.set(key, g);
    if (this._gradCache.size > 64) {
      const oldest = this._gradCache.keys().next().value;
      this._gradCache.delete(oldest);
    }
    return g;
  }

  /** 渐变缓存的 ctx 安全封装：仅当 ctx 为主画布（this.ctx）才入共享 _gradCache。
   *  离屏/其它 ctx 创建的 CanvasGradient 不能跨 ctx 复用（会渲染异常），故非主 ctx 时直接创建不入缓存。
   *  _drawHomeScene/_drawCodexScene 既被主视图每帧调用（this.ctx），也可能在离屏烘焙分支被 bctx 调用。 */
  _gradFor(ctx, key, create) {
    if (ctx === this.ctx) return this._grad(key, create);
    return create();
  }

  _shadeColor(hex, amt) {
    const h = (hex || '#888888').replace('#', '');
    let r = parseInt(h.substring(0, 2), 16) || 0;
    let g = parseInt(h.substring(2, 4), 16) || 0;
    let b = parseInt(h.substring(4, 6), 16) || 0;
    r = Math.max(0, Math.min(255, Math.round(r + (amt > 0 ? (255 - r) : r) * amt)));
    g = Math.max(0, Math.min(255, Math.round(g + (amt > 0 ? (255 - g) : g) * amt)));
    b = Math.max(0, Math.min(255, Math.round(b + (amt > 0 ? (255 - b) : b) * amt)));
    const toHex = (n) => (n < 16 ? '0' : '') + n.toString(16);
    return '#' + toHex(r) + toHex(g) + toHex(b);
  }

  /** 十六进制颜色转RGB，用于计算亮度自适应文字色 */
  _hexToRgb(hex) {
    const h = (hex || '#888888').replace('#', '');
    return {
      r: parseInt(h.substring(0, 2), 16) || 0,
      g: parseInt(h.substring(2, 4), 16) || 0,
      b: parseInt(h.substring(4, 6), 16) || 0
    };
  }

  trackPressedBtn(rect) { this.pressedBtn = { rect, t0: Date.now() }; }
  releasePressedBtn() { this.pressedBtn = null; }

  /** 命中点所在按钮 → 触发按下态（供 input 在按下瞬间调用） */
  pressAt(x, y) {
    let rect = null;
    for (const b of this.buttons) {
      if (isPointInRect(x, y, b)) { rect = b; break; }
    }
    if (!rect) {
      for (const m of this.modalRects) {
        if (isPointInRect(x, y, m)) { rect = m; break; }
      }
    }
    if (rect) this.trackPressedBtn(rect);
  }

  clear() { this.ctx.clearRect(0, 0, this.width, this.height); }

  /** 首帧极简画面：背景 + 居中副标题（渲染最轻，保证像素立刻上屏，降低首屏渲染耗时） */
  drawSplashTitle() {
    const ctx = this.ctx;
    const W = this.width;
    const L = this.layout;
    const ty = (L && typeof L.titleY === 'number') ? L.titleY : this.height * 0.3;
    const k = (this.game && typeof this.game.introK === 'number') ? this.game.introK : 1;   // ③3-1 首屏呼吸
    if (k >= 1 && !this.game) { /* noop */ }
    ctx.save();
    const sc = this._fxLow ? 1 : (0.96 + 0.04 * (1 - Math.pow(1 - k, 3)));
    ctx.globalAlpha = Math.min(1, 0.35 + 0.65 * k);
    ctx.translate(W / 2, ty); ctx.scale(sc, sc); ctx.translate(-W / 2, -ty);
    if (!this._fxLow && k < 1) {
      ctx.fillStyle = 'rgba(149,117,205,' + (0.10 * (1 - k)).toFixed(3) + ')';
      ctx.beginPath(); ctx.arc(W / 2, ty + 6, 130, 0, Math.PI * 2); ctx.fill();
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(209,196,233,0.9)';
    ctx.font = '13px ' + APPLE_FONT;
    ctx.fillText('抽陀螺 · 合成白虎 · 单手对战', W / 2, ty);
    ctx.restore();
  }

  /**
   * 静态背景：AI 宇宙星海场景图 cover-fit 铺底 + 上下暗角（优先）；无图/未加载/老设备回退渐变 + 星点。
   * 首次（或图就绪后）烘焙到离屏画布缓存，之后每帧仅一次 drawImage。
   * 离屏创建失败时自动回退为逐帧绘制，保证兼容性（微信小游戏 / 老基础库）。
   */
  /**
   * 内存告警时释放可重建缓存（低端机防 OOM 被系统 kill，iPhone 7 仅 2GB RAM 尤甚）。
   *
   * 分两级，避免「一告警就把画面搞花」：
   *  - 任何等级都清：**纯计算型缓存**（渐变/文本测量/图鉴陀螺签名/布局签名）。
   *    清掉只是重新计算，视觉零变化，代价极小。
   *  - 仅 level >= 10 才清：**离屏画布 + 粒子**。有一次性重建开销或丢失正在播的特效，
   *    但背景离屏烘焙是全屏尺寸、sprite 缓存最多 60 张，是内存大头，该放手时就放手。
   *
   * ⚠️ 刻意**不清** _homeBgImage / _codexBgImage 这类已加载的 image 对象：
   *    真机图片重新加载存在「静默挂起」顽疾（onload/onerror 都不触发，见 v8 修复记录），
   *    清掉可能再也加载不回来 → 背景永久空白，比 OOM 还糟。
   *    它们是绘制原料，不是缓存；_bgCache 才是产物，清产物、留原料。
   *
   * @param {number} level 微信内存告警等级 5=轻度 / 10=紧张 / 15=危险
   * @returns {object} 各类释放计数（便于日志排查）
   */
  _clearMemoryCaches(level) {
    const freed = {};
    try {
      // ① 纯计算型缓存 —— 任何等级都安全
      if (this._gradCache && typeof this._gradCache.clear === 'function') {
        freed.grad = this._gradCache.size;
        this._gradCache.clear();
      }
      freed.mt = clearMeasureTextCache();
      if (this._codexBbCache) {
        freed.codexBb = Object.keys(this._codexBbCache).length;
        this._codexBbCache = {};
      }
      this._layoutSig = null; // 去掉陈旧签名引用，下一帧自然重算

      // ② 严重告警才动「离屏画布 + 粒子」
      if (level >= 10) {
        if (this._bgCache) {
          try {
            if (typeof this._bgCache.width === 'number') { this._bgCache.width = 0; this._bgCache.height = 0; }
          } catch (e) {}
          this._bgCache = null;
          this._bgCacheKey = null;
          freed.bg = 1;
        }
        // 粒子/光环/浮字：纯瞬时视觉对象，清空只是丢掉正在播的特效，
        // 远比进程被系统 kill（玩家看到"闪退"）划算。
        freed.fx = (this.particles ? this.particles.length : 0)
          + (this.rings ? this.rings.length : 0)
          + (this.floatTexts ? this.floatTexts.length : 0);
        if (this.particles) this.particles.length = 0;
        if (this.rings) this.rings.length = 0;
        if (this.floatTexts) this.floatTexts.length = 0;
      }
    } catch (e) {}
    return freed;
  }

  _getBgCache() {
    const key = this.width + 'x' + this.height;
    if (this._bgCache && this._bgCacheKey === key) return this._bgCache;
    if (!this._bgCache || this._bgCacheKey !== key) {
      try {
        let bg = null;
        // 优先离屏画布（不抢主屏 buffer）；微信用 createOffscreenCanvas，浏览器用 document，
        // 避免 wx.createCanvas()（真机/预览均可能共享主画布，用作缓存源会冲突）。
        if (typeof wx !== 'undefined' && wx.createOffscreenCanvas && typeof wx.createOffscreenCanvas === 'function') {
          bg = wx.createOffscreenCanvas({ width: this.width, height: this.height });
        } else if (typeof document !== 'undefined' && document.createElement) {
          bg = document.createElement('canvas');
        }
        if (!bg || !bg.getContext) { this._bgCache = null; return null; }
        bg.width = this.width;
        bg.height = this.height;
        const bctx = bg.getContext('2d');
        if (!bctx) { this._bgCache = null; return null; }
        const img = this._homeBgImage;
        if (img && img._ok && img.width && img.height) {
          // 主路径：AI 宇宙星海场景图 cover-fit 铺底 + 上下暗角（保 UI 可读）
          this._drawHomeScene(bctx, img);
        } else {
          // 回退：渐变 + 星点（无图 / 未加载 / 老设备）
          const grad = bctx.createLinearGradient(0, 0, 0, this.height);
          grad.addColorStop(0, '#2a1b4e');
          grad.addColorStop(1, '#1a0f33');
          bctx.fillStyle = grad;
          bctx.fillRect(0, 0, this.width, this.height);
          bctx.fillStyle = '#ffffff';
          for (const st of this.stars) {
            bctx.globalAlpha = st.a;
            bctx.beginPath();
            bctx.arc(st.rx * this.width, st.ry * this.height, st.s, 0, Math.PI * 2);
            bctx.fill();
          }
          bctx.globalAlpha = 1;
        }
        this._bgCache = bg;
        this._bgCacheKey = key;
        return bg;
      } catch (e) {
        this._bgCache = null;
        return null;
      }
    }
    return this._bgCache;
  }

  /**
   * 懒加载主页 AI 场景背景：仅在具备图片 API 的环境（DevTools/真机）尝试一次；
   * 无头测试无 Image 则跳过，背景走渐变 + 星点回退。加载完成后作废 _bgCache，
   * 下次 _getBgCache 重烘焙时把场景图封面铺底。
   */
  _ensureHomeBgImage() {
    if (this._homeBgTried) return;
    this._homeBgTried = true;
    const b64 = _HOME_B64;
    const pkg = _prepSrc(null, 'home_cosmic.jpg', 'home'); // 真机源（包内路径）
    // 诊断：打印 base64 是否接上、长度多少。若此处 b64=null 且下方 FAIL src=包内路径 → 说明 homebg.js 内联 base64 未接上（platform 判定问题）；
    // 若 b64=len=2xxxx 但 FAIL src=data:… → 说明 data URI 在模拟器仍加载失败（需进一步降体积或换 PNG）。
    console.log('[homebg] start b64=' + (b64 ? ('len=' + b64.length) : 'null') + ' pkg=' + pkg);
    // DevTools 包内路径必 404（见 imgb64.js 注释），故模拟器**优先 base64**（已压到 ~16KB 解码，远低于 data-URI 上限，
    // 且避免无谓的 404 控制台噪声）；真机 _HOME_B64 为 null → 直接用包内路径。
    // 次级互换兜底：任一源失败仍有机会出图。
    // ⚠️ 勿写成「if (!_HOME_B64) return;」——真机 homebg.js 经 shim 返回 null，早返回会丢包内图（同 codex 修法）。
    const primary = b64 || pkg;
    const secondary = b64 ? pkg : null;
    const attempt = (s, done) => {
      _loadOne(s, (err, im) => {
        const tag = (typeof s === 'string' && s.slice(0, 5) === 'data:') ? 'data:…' : s;
        if (!err && im) {
          this._homeBgImage = downscaleToCap(im, capForLevel(this.perfLevel));  // 封顶（LOW 540p / 其余 720p），限制解码内存
          console.log('[homebg] ok src=' + tag + ' ' + (im.width || '?') + 'x' + (im.height || '?'));
          done(true);
        } else {
          console.log('[homebg] FAIL src=' + tag + ' err=' + (err && err.message));
          done(false);
        }
      });
    };
    attempt(primary, (ok) => { if (!ok && secondary) attempt(secondary, () => {}); });
  }

  // 图鉴独立背景：懒加载，仅在 view==='codex' 时尝试一次（与主页背景互不干扰）。
  // 真机：codexbg.js 经 shim 返回 null → _prepSrc 真机分支返回包内 images/codex/codex_atlas.jpg（省 ~72KB 常驻内存）。
  // 模拟器：codexbg.js 返回 base64 data URI → 走 data URI 规避 404。
  // ⚠️ 勿写成「if (!_CODEX_B64) return;」——那样真机（null）会直接跳过、背景永远走渐变回退、丢包内图。
  _ensureCodexBgImage() {
    if (this._codexBgTried) return;
    this._codexBgTried = true;
    const b64 = _CODEX_B64;
    const pkg = _prepSrc(null, 'codex_atlas.jpg', 'codex'); // 真机源（包内路径）
    console.log('[codexbg] start b64=' + (b64 ? ('len=' + b64.length) : 'null') + ' pkg=' + pkg);
    // DevTools 包内路径必 404（见 imgb64.js 注释），故模拟器**优先 base64**（~6KB 解码，远低于 data-URI 上限，
    // 且避免无谓的 404 控制台噪声）；真机 _CODEX_B64 为 null → 直接用包内路径。
    // 次级互换兜底：任一源失败仍有机会出图。
    // ⚠️ 勿写成「if (!_CODEX_B64) return;」——真机（null）会直接跳过、背景永远走渐变回退、丢包内图。
    const primary = b64 || pkg;
    const secondary = b64 ? pkg : null;
    const attempt = (s, done) => {
      _loadOne(s, (err, im) => {
        const tag = (typeof s === 'string' && s.slice(0, 5) === 'data:') ? 'data:…' : s;
        if (!err && im) {
          this._codexBgImage = downscaleToCap(im, capForLevel(this.perfLevel));  // 封顶（LOW 540p / 其余 720p），限制解码内存
          // 日志打降采样后的实际尺寸（而非原图 im 尺寸）：r===im = 离屏不可用未降采样 → 真机可直接判断封顶是否生效
          const r = this._codexBgImage;
          console.log('[codexbg] ok src=' + tag + ' cap=' + capForLevel(this.perfLevel)
            + ' -> ' + ((r && r.width) ? (r.width + 'x' + r.height) : '?x?')
            + (r === im ? ' [offscreen不可用→原图未降采样]' : ''));
          done(true);
        } else {
          console.log('[codexbg] FAIL src=' + tag + ' err=' + (err && err.message));
          done(false);
        }
      });
    };
    attempt(primary, (ok) => { if (!ok && secondary) attempt(secondary, () => {}); });
  }

  // 把 AI 场景图以 cover-fit 铺满离屏，再叠上下暗角（顶/底压暗放 HUD 与行动栏，中心亮核作舞台）
  _drawHomeScene(ctx, img) {
    const cw = this.width, ch = this.height;
    const iw = img.width, ih = img.height;
    const scale = Math.max(cw / iw, ch / ih);
    const dw = iw * scale, dh = ih * scale;
    const dx = (cw - dw) / 2, dy = (ch - dh) / 2;
    try { ctx.drawImage(img, dx, dy, dw, dh); } catch (e) { try { ctx.drawImage(img, 0, 0, cw, ch); } catch (e2) {} }
    // 顶部压暗（金币栏 / 胶囊）：渐变坐标只随布局尺寸变化 → 走 _grad LRU 缓存（主 ctx），
    // 消除主视图每帧 createLinearGradient 分配（卡顿主因之一）。key 含尺寸签名，布局变化即重烘焙。
    const g = this._gradFor(ctx, 'homeTop@' + this.width + 'x' + this.height, () => {
      const gg = ctx.createLinearGradient(0, 0, 0, ch * 0.34);
      gg.addColorStop(0, 'rgba(5,2,14,0.94)');
      gg.addColorStop(1, 'rgba(5,2,14,0)');
      return gg;
    });
    ctx.fillStyle = g; ctx.fillRect(0, 0, cw, ch * 0.34);
    // 底部压暗（行动栏 / 圆盘底座）
    const g2 = this._gradFor(ctx, 'homeBot@' + this.width + 'x' + this.height, () => {
      const gg = ctx.createLinearGradient(0, ch * 0.58, 0, ch);
      gg.addColorStop(0, 'rgba(5,2,14,0)');
      gg.addColorStop(1, 'rgba(5,2,14,0.96)');
      return gg;
    });
    ctx.fillStyle = g2; ctx.fillRect(0, ch * 0.58, cw, ch * 0.42);
  }

  // 图鉴专用场景：更暗、更静的陈列星图，作为 25 只陀螺密集网格的衬底。
  // 在封面铺图后叠「整屏暗化 + 上/下渐变压暗」，让网格单元（含其自身底）稳定可读，
  // 同时保留星图纹理的微弱存在感（不丢失「图鉴」调性）。
  _drawCodexScene(ctx, img) {
    const cw = this.width, ch = this.height;
    const iw = img.width, ih = img.height;
    const scale = Math.max(cw / iw, ch / ih);
    const dw = iw * scale, dh = ih * scale;
    const dx = (cw - dw) / 2, dy = (ch - dh) / 2;
    try { ctx.drawImage(img, dx, dy, dw, dh); } catch (e) { try { ctx.drawImage(img, 0, 0, cw, ch); } catch (e2) {} }
    // 整屏暗化（轻度）：仅把星图压成弱背景纹理，避免"盖住"网格与顶部信息（原 0.5 过重建遮挡感）
    ctx.fillStyle = 'rgba(46,20,74,0.26)';
    ctx.fillRect(0, 0, cw, ch);
    // 顶部压暗（图鉴 x/y 头部）：轻压，仅保证标题可读，不再压到网格。走 _grad LRU 缓存（同主页）。
    const g = this._gradFor(ctx, 'codexTop@' + this.width + 'x' + this.height, () => {
      const gg = ctx.createLinearGradient(0, 0, 0, ch * 0.18);
      gg.addColorStop(0, 'rgba(5,2,14,0.70)');
      gg.addColorStop(1, 'rgba(5,2,14,0)');
      return gg;
    });
    ctx.fillStyle = g; ctx.fillRect(0, 0, cw, ch * 0.16);
    // 底部压暗（末行陀螺 + 安全区）：轻压
    const g2 = this._gradFor(ctx, 'codexBot@' + this.width + 'x' + this.height, () => {
      const gg = ctx.createLinearGradient(0, ch * 0.70, 0, ch);
      gg.addColorStop(0, 'rgba(5,2,14,0)');
      gg.addColorStop(1, 'rgba(5,2,14,0.82)');
      return gg;
    });
    ctx.fillStyle = g2; ctx.fillRect(0, ch * 0.70, cw, ch * 0.30);
  }

  // 非当前视图背景图释放（U10-B）：主页背景仅用于非 codex 视图，图鉴背景仅用于 codex 视图。
  // 切走即释放原料，切回时由 _ensure*BgImage 在 jsbridge 已就绪的运行时重新加载
  // （不是启动期，无静默挂起风险；即便重载失败也有 _bgCache/渐变回退托底，不会永久空白）。
  // 释放同时重置 *_BgTried 标记，使切回时能重新触发加载。
  // 释放「背景产物画布」的显存/后备存储。
  // downscaleToCap 返回的是 wx.createOffscreenCanvas 产物（真机离屏可用时），它在微信里是
  // **native 内存**，光置 null 交 GC 不保证及时回收；显式 width=0/height=0 才会立刻释放后备存储
  // （与 beyblade.js 的 sprite LRU 淘汰、_clearMemoryCaches 清 _bgCache 同一原语）。
  // 只对离屏画布做（有 getContext）；原始 wx.Image 没有后备存储可归零，丢引用即可。
  _releaseBgBitmap(im) {
    if (!im) return;
    if (typeof im.getContext === 'function' && typeof im.width === 'number') {
      try { im.width = 0; im.height = 0; } catch (e) {}
    }
  }

  _releaseInactiveBg() {
    const isCodex = !!(this.game && this.game.view === 'codex');
    if (isCodex) {
      if (this._homeBgImage) { this._releaseBgBitmap(this._homeBgImage); this._homeBgImage = null; this._homeBgTried = false; }
    } else {
      if (this._codexBgImage) { this._releaseBgBitmap(this._codexBgImage); this._codexBgImage = null; this._codexBgTried = false; }
    }
  }

  drawBackground() {
    // 视图选图：图鉴用独立「陈列星图」背景；主页/合成/其它沿用宇宙星海背景。
    const isCodex = !!(this.game && this.game.view === 'codex');
    this._releaseInactiveBg(); // 先释放非当前视图背景，省常驻解码内存（U10-B）
    let img = null;
    if (isCodex) {
      this._ensureCodexBgImage();
      img = this._codexBgImage;
    } else {
      this._ensureHomeBgImage();
      img = this._homeBgImage;
    }
    // 主路径：AI 场景图直接铺主画布（对齐对战页机制，真机最稳，不依赖离屏烘焙）
    if (img && img._ok && img.width > 0 && img.height > 0) {
      if (isCodex) this._drawCodexScene(this.ctx, img);
      else this._drawHomeScene(this.ctx, img);
      return;
    }
    const bg = this._getBgCache();
    if (bg) {
      try {
        this.ctx.drawImage(bg, 0, 0, this.width, this.height);
        return;
      } catch (e) {
        this._bgCache = null; // 回退逐帧绘制
      }
    }
    // 回退：无离屏缓存能力时逐帧绘制（保证兼容）
    const ctx = this.ctx;
    const grad = this._grad('bgfallback', () => {
      const gg = ctx.createLinearGradient(0, 0, 0, this.height);
      gg.addColorStop(0, '#2a1b4e');
      gg.addColorStop(1, '#1a0f33');
      return gg;
    });
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.fillStyle = '#ffffff';
    for (const st of this.stars) {
      const x = st.rx * this.width;
      const y = st.ry * this.height;
      ctx.globalAlpha = st.a;
      ctx.beginPath();
      ctx.arc(x, y, st.s, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // =====================================================
  // 区域 1 · TopBar（左金币 / 中能量条 / 右图标组） + 区域 1.5 SubBar（回满/广告）
  // 左右先占位、中间弹性夹 —— 严格按 _reflow 预计算值，绝不 375 越界。
  // =====================================================
  drawHeader() {
    const ctx = this.ctx;
    const L = this.layout;
    const y = L.topBarY;
    const icoH = Math.min(34, L.topBarH - 4);

    // ----- 左 · 金币（半透明胶囊底 + 圆形图标 + 金色数字，与设计稿 topbar 一致）-----
    // 金币模块高度和签到/音量图标一致（icoH=34），避免左边小右边大
    const coinIcon = 20, coinGap = 6, coinPad = 12, coinH = icoH;
    // 成熟感·数字滚动（2026-11-21）：金币变化缓动逼近而非瞬间跳变（demo→game 第一感知差；
    // 每帧向目标靠拢 12%，|差|<1 吸附——60fps 下约 300ms 收敛，30fps 略慢同效）
    if (!this._coinRoll) this._coinRoll = { v: this.game.coins };
    const _coinDiff = this.game.coins - this._coinRoll.v;
    if (Math.abs(_coinDiff) < 1) this._coinRoll.v = this.game.coins;
    else this._coinRoll.v += _coinDiff * 0.12;
    const coinTxt = formatNumber(Math.round(this._coinRoll.v));
    // P2-4：先按金币实际绘制字体测量宽度，否则沿用上一帧残留字体导致 coinW 计算错误
    // 数字嗓音（2026-11-22）：金币数字用 GameDigits 展示字体（纯数字串，子集覆盖）
    ctx.font = 'bold 15px ' + UI.familyDigit;
    const coinTxtW = Math.ceil(mtW(ctx, coinTxt));
    const coinW = coinPad * 2 + coinIcon + coinGap + coinTxtW;
    const coinX = L.leftPad, coinY = y + (L.topBarH - coinH) / 2, coinCy = coinY + coinH / 2;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.28)';
    ctx.shadowBlur = 4 * this.shadowScale;
    ctx.fillStyle = 'rgba(0,0,0,0.38)';
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    this.roundRect(coinX, coinY, coinW, coinH, coinH / 2); ctx.fill(); ctx.stroke();
    ctx.shadowBlur = 0;
    // 圆形图标：先裁圆再画 PNG（icon-coin 底为方形，clip 成圆形与设计稿一致）
    const coinIc = coinX + coinPad + coinIcon / 2;
    ctx.beginPath(); ctx.arc(coinIc, coinCy, coinIcon / 2, 0, Math.PI * 2); ctx.clip();
    if (!this._drawPngIcon('coin', coinIc, coinCy, coinIcon)) drawVectorIcon(ctx, 'coin', coinIc, coinCy, coinIcon, '#ffd54f');
    ctx.restore();
    ctx.fillStyle = '#ffd54f';
    ctx.font = 'bold 15px ' + APPLE_FONT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(255,143,0,0.35)';
    ctx.shadowBlur = 6 * this.shadowScale;
    ctx.fillText(coinTxt, coinIc + coinIcon / 2 + coinGap, coinCy);
    ctx.shadowBlur = 0;

    // ----- 中 · 能量条（游戏化：分段+发光+低能量警告+流动光效）-----
    const energyH = 16;
    const ex = L.energyX;
    const ew = L.energyW;
    const ey = y + (L.topBarH - energyH) / 2;
    const p = Math.max(0, Math.min(1, this.game.energy / this.game.maxEnergy));
    const lowEnergy = p < 0.3;  // 低能量警告阈值
    ctx.save();
    // 外发光（游戏体力条效果，低能量红色警告，正常时紫色主题光）
    ctx.shadowColor = lowEnergy ? 'rgba(255,82,82,0.6)' : 'rgba(126,87,194,0.6)';
    ctx.shadowBlur = 6 * this.shadowScale;
    // 背景：深色半透明 + 内阴影感
    ctx.fillStyle = 'rgba(20,10,40,0.85)';
    this.roundRect(ex, ey, ew, energyH, energyH / 2); ctx.fill();
    ctx.shadowBlur = 0;
    // 填充：渐变（低能量时红色警告，正常时彩虹多彩渐变）
    if (p > 0) {
      const fillW = Math.max(energyH - 2, (ew - 2) * p);
      const pg = this._grad('energyG|' + ex + '|' + ey + '|' + ew + '|' + (lowEnergy ? 'low' : 'rainbow'), () => {
        const g0 = ctx.createLinearGradient(ex, ey, ex + ew, ey);
        if (lowEnergy) {
          g0.addColorStop(0, '#ff5252');
          g0.addColorStop(1, '#ff8a80');
        } else {
          // 彩虹多彩渐变：红→橙→黄→绿→蓝→紫
          g0.addColorStop(0, '#ff5252');
          g0.addColorStop(0.2, '#ff9800');
          g0.addColorStop(0.4, '#ffeb3b');
          g0.addColorStop(0.6, '#00e676');
          g0.addColorStop(0.8, '#2196f3');
          g0.addColorStop(1, '#9c27b0');
        }
        return g0;
      });
      ctx.fillStyle = pg;
      this.roundRect(ex + 1, ey + 1, fillW, energyH - 2, (energyH - 2) / 2); ctx.fill();
      // 流动高光（游戏能量条回能动效）
      const flowT = (Date.now() / 1500) % 1;
      const flowX = ex + 1 + fillW * flowT - 20;
      if (flowX > ex + 1 && flowX < ex + 1 + fillW - 10) {
        const flowGrad = ctx.createLinearGradient(flowX, ey, flowX + 20, ey);
        flowGrad.addColorStop(0, 'rgba(255,255,255,0)');
        flowGrad.addColorStop(0.5, 'rgba(255,255,255,0.45)');
        flowGrad.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = flowGrad;
        ctx.fillRect(flowX, ey + 2, 20, energyH - 4);
      }
    }
    // 分段线（4段，游戏体力条效果）
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const segX = ex + (ew / 4) * i;
      ctx.beginPath();
      ctx.moveTo(segX, ey + 2);
      ctx.lineTo(segX, ey + energyH - 2);
      ctx.stroke();
    }
    // 边框：游戏感金属边框
    ctx.strokeStyle = lowEnergy ? 'rgba(255,138,128,0.7)' : 'rgba(255,255,255,0.45)';
    ctx.lineWidth = 1;
    this.roundRect(ex + 0.5, ey + 0.5, ew - 1, energyH - 1, energyH / 2 - 0.5); ctx.stroke();
    // 顶部高光（坐标恒定，走 _grad 缓存，避免每帧新建渐变）
    const hlGrad = this._grad('energyHl|' + ex + '|' + ey + '|' + energyH, () => {
      const g = ctx.createLinearGradient(ex, ey, ex, ey + energyH / 2);
      g.addColorStop(0, 'rgba(255,255,255,0.25)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      return g;
    });
    ctx.fillStyle = hlGrad;
    this.roundRect(ex + 1, ey + 1, ew - 2, energyH / 2 - 1, (energyH - 2) / 2); ctx.fill();
    // 文字：白色 + 深色描边 + 阴影（确保满格浅绿色背景上也清晰可见）
    if (lowEnergy) {
      const warnPulse = 0.6 + 0.4 * Math.sin(Date.now() / 300);
      ctx.globalAlpha = warnPulse;
    }
    ctx.font = 'bold 12px ' + APPLE_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // 深色描边（确保任何背景下文字都清晰）
    ctx.strokeStyle = 'rgba(20,10,40,0.85)';
    ctx.lineWidth = 2.5;
    ctx.strokeText(Math.floor(this.game.energy) + '/' + this.game.maxEnergy, ex + ew / 2, ey + energyH / 2 + 0.5);
    // 白色填充
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 1.5;
    ctx.fillText(Math.floor(this.game.energy) + '/' + this.game.maxEnergy, ex + ew / 2, ey + energyH / 2 + 0.5);
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    ctx.restore();

    // ----- 右 · 图标组：按 _reflow 好的 rightXStart 从左往右排，保证整体对齐右边界 -----
    // P2-6 福利中心（2026-10-31）：签到/每日任务/好友助力 合并为「福利」单入口（原签到钮位），
    // 红点 = 任一项今日可领；三个面板本体不变，由福利中心直跳。
    let gx = L.rightXStart;
    const _wMeta = (typeof this.game.welfareMeta === 'function') ? this.game.welfareMeta() : { anyDue: false, rows: [] };
    const signW = L.signBtnW;
    const signRect = { x: gx, y: y + (L.topBarH - icoH) / 2, w: signW, h: icoH, action: 'welfare' };
    gx += signW + L.icoGap;
    const muteRect = { x: gx, y: y + (L.topBarH - icoH) / 2, w: L.icoW, h: icoH, action: 'mute' };
    gx += L.icoW + L.icoGap;

    // 福利：图标胶囊（沿用 sign 图标位），任一可领时金色脉冲边 + 红点
    this.drawIconButton(signRect, 'sign');
    if (_wMeta.anyDue) {
      const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 200);
      ctx.strokeStyle = '#ffd54f';
      ctx.globalAlpha = 0.55 + 0.35 * pulse;
      ctx.lineWidth = 2;
      this.roundRect(signRect.x - 2, signRect.y - 2, signRect.w + 4, signRect.h + 4, 12);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    this.buttons.push(signRect);
    if (_wMeta.anyDue) {
      const dotR = 6;
      const dotX = signRect.x + signRect.w - dotR * 0.5;
      const dotY = signRect.y + dotR * 0.5;
      ctx.save();
      ctx.beginPath();
      ctx.fillStyle = '#ff3b30';
      ctx.arc(dotX, dotY, dotR, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.92)';
      ctx.stroke();
      ctx.restore();
    }
    this.drawIconButton(muteRect, this.audio && this.audio.muted ? 'mute' : 'unmute');
    this.buttons.push(muteRect);

    // ----- 左上角手柄入口（同一行 · 屏幕最左上起步，向右排）-----
    // 游戏圈（club）最左、更多小游戏（moregames）在其右侧，两者各自仅在对应 openlink 配置时才渲染，
    // 避免死按钮。位置从「贴胶囊右上角」改为「左上角」，与右上角系统胶囊分离（用户要求）。
    const mb = this.menuBtn;
    if (mb && mb.width > 0) {
      const mh = Math.min(36, Math.max(24, mb.height));
      const mr = Math.min(11, mh / 2 - 1);
      const mtop = mb.top + Math.round((mb.height - mh) / 2);
      // 左上角起步：x 从屏幕左 padding 起，依次向右排；不再贴右上角胶囊
      let leftX = 16;
      const GAP = 8;
      const inBounds = (rx) => rx >= 0 && (rx + mh) <= this.width;

      // --- 游戏圈/社区（流量主条件二 · 有效活跃）：最左上 ---
      if (CONFIG.gameClubOpenlink && inBounds(leftX)) {
        const cRect = { x: leftX, y: mtop, w: mh, h: mh, action: 'club' };
        ctx.save();
        ctx.shadowColor = 'rgba(255,213,79,0.35)';
        ctx.shadowBlur = 6 * this.shadowScale;
        ctx.fillStyle = 'rgba(20,10,44,0.66)';
        ctx.strokeStyle = 'rgba(255,213,79,0.55)';
        ctx.lineWidth = 1;
        this.roundRect(cRect.x, cRect.y, cRect.w, cRect.h, mr); ctx.fill(); ctx.stroke();
        ctx.restore();
        const cpad = Math.max(4, cRect.h * 0.16);
        const cis = cRect.h - cpad * 2;
        // 无 icon-club.png，直接走矢量气泡（utils.js drawVectorIcon 'club'）
        drawVectorIcon(ctx, 'club', cRect.x + cRect.w / 2, cRect.y + cRect.h / 2, cis, '#ffffff');
        this.buttons.push(cRect);
        leftX = cRect.x + mh + GAP;   // 下一个入口向右挪
      }

      // --- 更多小游戏（仅配置 moreGamesOpenlink 时，排在游戏圈右侧）---
      // P2-8：未配置则不出现，避免死按钮（与 club 判定一致）。
      if (CONFIG.moreGamesOpenlink && inBounds(leftX)) {
        const mRect = { x: leftX, y: mtop, w: mh, h: mh, action: 'moregames' };
        // P2-3：与 drawIconButton 同款按下态（缩放 + 高亮）
        const sameRect = (a, b) => a && b && Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01 && Math.abs(a.w - b.w) < 0.01 && Math.abs(a.h - b.h) < 0.01;
        const mPressed = sameRect(this.pressedBtn && this.pressedBtn.rect, mRect);
        const mNowT = mPressed ? (Date.now() - this.pressedBtn.t0) : 0;
        const mPressT = mPressed && mNowT < 180 ? (1 - Math.pow(1 - mNowT / 180, 3)) : (mPressed ? 1 : 0);
        const mcx = mRect.x + mRect.w / 2, mcy = mRect.y + mRect.h / 2;
        ctx.save();
        ctx.translate(mcx, mcy); ctx.scale(1 - mPressT * 0.08, 1 - mPressT * 0.08); ctx.translate(-mcx, -mcy);
        ctx.shadowColor = 'rgba(255,213,79,0.35)';
        ctx.shadowBlur = 6 * this.shadowScale;
        ctx.fillStyle = mPressed ? 'rgba(40,24,80,0.8)' : 'rgba(20,10,44,0.66)';
        ctx.strokeStyle = mPressed ? 'rgba(255,213,79,0.85)' : 'rgba(255,213,79,0.55)';
        ctx.lineWidth = 1;
        this.roundRect(mRect.x, mRect.y, mRect.w, mRect.h, mr); ctx.fill(); ctx.stroke();
        ctx.restore();
        const mpad = Math.max(4, mRect.h * 0.16);
        const mis = mRect.h - mpad * 2;
        if (!this._drawPngIcon('more', mRect.x + mRect.w / 2, mRect.y + mRect.h / 2, mis)) {
          drawVectorIcon(ctx, 'more', mRect.x + mRect.w / 2, mRect.y + mRect.h / 2, mis, '#ffffff');
        }
        this.buttons.push(mRect);
        leftX = mRect.x + mh + GAP;
      }
    }

    // ----- 区域 1.5 · SubBar：免费回满 / 广告+60 独立一行（按 layout.subExists 决定是否渲染，避免空行）-----
    if (L.subExists) {
      const subY = L.subBarY;
      const smallBtnH = L.subBtnH;
      const smallBtnW = 84;
      let sx = L.leftPad;
      if (this.game.energy < this.game.maxEnergy && this.game.canRefill && this.game.canRefill()) {
        const rfRect = { x: sx, y: subY, w: smallBtnW, h: smallBtnH, action: 'refill' };
        this.drawButton(rfRect.x, rfRect.y, rfRect.w, rfRect.h, '免费回满', '#66bb6a');
        this.buttons.push(rfRect);
        sx += smallBtnW + L.subBtnGap;
      }
      if (this.game.canWatchAdEnergy && this.game.canWatchAdEnergy()) {
        const adRect = { x: sx, y: subY, w: smallBtnW, h: smallBtnH, action: 'adenergy' };
        // 文章原则三「越具体越有人点」：光说 +60 玩家不知道能干嘛，
        // 补上"够抽几次"（抽卡一次 20 能量 → 把账算给玩家看）。
        this.drawButton(adRect.x, adRect.y, adRect.w, adRect.h, '能量 +60', '#ffb300');
        this.buttons.push(adRect);
      }
      // P2-6 福利中心（2026-10-31）：原「助力」按钮已并入福利中心单入口（见 header 福利钮），
      // subBar 只保留能量相关快捷操作（免费回满 / 看广告得能量），减少工具按钮堆叠感。
    }
  }

  // =====================================================
  // 区域 2 · 标题 + 副标题 + Tab（严格按 _reflow 累加位置绘制）
  //  SE 紧凑版：titleTitleSize=24 / subLineH=16 / 气隙各 -2 → 总体 -26
  //  公式（从 titleY 起）：
  //    +titleInnerHeadGap(=2)
  //    +titleTitleSize
  //    +titleSubGap(=4 or 6)
  //    +titleSubLineH
  //    +titleTabGap(=4 or 6)
  //    +titleTabH(=28)
  //    +titleFootGap(=2)
  // =====================================================
  drawTitleAndTabs() {
    const ctx = this.ctx;
    const L = this.layout;
    const W = L.W;
    const ty = L.titleY;
    const isCompact = L.compact || false;
    const titleSubGap = isCompact ? 4 : 6;

    // 副标题（动态，上移到原标题位置）：只在合成 tab 显示（图鉴 tab 有自己的"图鉴 x/y + 进度条"头部，避免重复遮挡）
    // 页面内不再显示游戏名"陀螺大师"（需求：去除页面标题文字）
    const subY = ty;
    const pair = this._mergeablePair();
    const mergeable = pair && pair.length > 0;
    const codexProg = this.game.codexCount() + '/' + this.game.codexTotal();
    // 限时活动横幅状态（play-design v1）：提前计算，供副标题让位与横幅绘制共用
    let actActive = false, actFest = false, actTxt = '', actSub = '', actW2 = 84;
    if (typeof this.game.activityInfo === 'function') {
      const _act = this.game.activityInfo();
      actActive = !!(_act.weekendDouble || _act.festival);
      actFest = !!_act.festival;
      actTxt = actFest ? (_act.festivalName + '') : '周末双倍';
      actSub = actFest ? '抽卡掉落' : '金币×2';
      actW2 = actFest ? 96 : 88;
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    if (this.game.view === 'main') {
      // 标题行四按钮统一布局：等间隙16px（和底部Tab一致），整体居中，不靠边
      // 按钮顺序：竞技场(78) → 大师等级(72) → 周末双倍(74) → 每日任务(66)
      const BTN_GAP = 16; // 和底部Tab间隙一致
      const btnTotalW = actActive ? (78 + BTN_GAP + 72 + BTN_GAP + 74 + BTN_GAP + 66) : (78 + BTN_GAP + 72 + BTN_GAP + 66);
      const btnStartX = Math.max(16, (W - btnTotalW) / 2); // 整体居中，最小边距16
      let _btnX = btnStartX;
      // 竞技场按钮x位置（后面绘制时用）
      const arenaBtnX = _btnX; _btnX += 78 + BTN_GAP;
      // 大师等级按钮x位置
      const lvBtnX = _btnX; _btnX += 72 + BTN_GAP;
      // 活动按钮x位置（如果显示）
      const actBtnX = actActive ? _btnX : 0; if (actActive) _btnX += 74 + BTN_GAP;
      // 每日任务按钮x位置
      const taskBtnX = _btnX;

      // 活动横幅存在时该行让位给横幅，副标题暂隐
      // 四按钮统一布局：等间隙16px，整体居中
      if (actActive) {
        const actAW = 74;                    // 固定宽度，只是显示作用
        const actX = actBtnX;                // 统一布局位置
        if (actAW > 60) {
          ctx.save();
          const ag3 = this._grad('actT|' + Math.round(actX), () => {
            const gg = ctx.createLinearGradient(actX, 0, actX + actAW, 0);
            gg.addColorStop(0, 'rgba(255,82,82,0.92)');
            gg.addColorStop(1, 'rgba(255,152,0,0.92)');
            return gg;
          });
          ctx.fillStyle = ag3;
          const ah = 30; // 高度统一：24→30
          const ay = subY + Math.max(0, (L.titleTitleSize - ah) / 2); // y位置与其他按钮一致
          this.roundRect(actX, ay, actAW, ah, ah / 2); ctx.fill();
          ctx.strokeStyle = UI.color.ink.body; ctx.lineWidth = 1;
          this.roundRect(actX + 0.5, ay + 0.5, actAW - 1, ah - 1, ah / 2 - 0.5); ctx.stroke();
          ctx.fillStyle = '#fff';
          ctx.font = 'bold 12px ' + APPLE_FONT; // 主文字调大：11→12
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(actTxt, actX + actAW / 2, ay + ah / 2 - 4);
          ctx.fillStyle = '#ffd54f';
          ctx.font = 'bold 12px ' + APPLE_FONT; // 副文字调大：8→10
          ctx.fillText(actSub, actX + actAW / 2, ay + ah / 2 + 8);
          ctx.restore();
        }
      } else {
        // 标题行中间不显示收集进度（已移至合成台空状态显示，避免重复）
      }
      // 竞技场入口（play-design v1）：四按钮统一布局，等间隙16px整体居中
      // 按钮高度统一：26→30，与其他按钮一致
      if (typeof this.game.arenaMeta === 'function') {
        const aMeta = this.game.arenaMeta();
        const aBtnW = 78, aBtnH = 30;
        const aBtnX = arenaBtnX, aBtnY = subY + Math.max(0, (L.titleTitleSize - aBtnH) / 2); // 统一布局位置
        const isMaster = aMeta.tierIndex >= 5;
        const aBtn = { x: aBtnX, y: aBtnY, w: aBtnW, h: aBtnH, action: 'arena' };
        ctx.save();
        if (isMaster) {
          const t = (this._frameCount || 0) / 60;
          ctx.shadowColor = '#ffd54f';
          ctx.shadowBlur = (10 + 6 * Math.sin(t * 4)) * this.shadowScale;
        }
        ctx.fillStyle = 'rgba(49,27,146,0.78)';
        this.roundRect(aBtnX, aBtnY, aBtnW, aBtnH, aBtnH / 2); ctx.fill();
        ctx.strokeStyle = aMeta.tierColor || '#ffd54f';
        ctx.lineWidth = 1.2;
        this.roundRect(aBtnX + 0.6, aBtnY + 0.6, aBtnW - 1.2, aBtnH - 1.2, aBtnH / 2 - 0.6); ctx.stroke();
        ctx.shadowBlur = 0;
        this._drawPngIcon(aMeta.tierIcon, aBtnX + 13, aBtnY + aBtnH / 2, 18);
        ctx.fillStyle = '#ffd54f';
        ctx.font = 'bold 12px ' + APPLE_FONT;
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(aMeta.tierName, aBtnX + 26, aBtnY + aBtnH / 2 + 0.5);
        ctx.restore();
        this.buttons.push(aBtn);
      }
      // 大师等级入口（play-design v1）：四按钮统一布局，等间隙16px整体居中
      if (typeof this.game.levelMeta === 'function') {
        const lm = this.game.levelMeta();
        // 按钮调大：60x26 → 72x30，文字更清晰
        const lvBtnW = 72, lvBtnH = 30;
        const lvBtnY = subY + Math.max(0, (L.titleTitleSize - lvBtnH) / 2); // x用统一布局的lvBtnX
        const lvBtn = { x: lvBtnX, y: lvBtnY, w: lvBtnW, h: lvBtnH, action: 'level' };
        ctx.save();
        ctx.fillStyle = 'rgba(49,27,146,0.78)';
        this.roundRect(lvBtnX, lvBtnY, lvBtnW, lvBtnH, lvBtnH / 2); ctx.fill();
        ctx.strokeStyle = 'rgba(255,213,79,0.65)';
        ctx.lineWidth = 1.2;
        this.roundRect(lvBtnX + 0.6, lvBtnY + 0.6, lvBtnW - 1.2, lvBtnH - 1.2, lvBtnH / 2 - 0.6); ctx.stroke();
        // LV 徽章（大写，文字调大：9px → 11px）
        ctx.fillStyle = '#ffd54f';
        ctx.font = 'bold 12px ' + APPLE_FONT;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('LV', lvBtnX + 17, lvBtnY + lvBtnH / 2);
        // 等级数字（调大：13px → 15px，位置右移）
        ctx.font = 'bold 15px ' + APPLE_FONT;
        ctx.fillText(String(lm.level), lvBtnX + 34, lvBtnY + lvBtnH / 2 + 0.5);
        // 迷你经验条（按钮底部）
        const mp = Math.max(0, Math.min(1, lm.inLv / Math.max(1, lm.need)));
        ctx.fillStyle = 'rgba(255,255,255,0.2)';
        this.roundRect(lvBtnX + 10, lvBtnY + lvBtnH - 6, lvBtnW - 20, 3.5, 1.75); ctx.fill();
        if (mp > 0) {
          ctx.fillStyle = '#00e676';
          this.roundRect(lvBtnX + 10, lvBtnY + lvBtnH - 6, (lvBtnW - 20) * mp, 3.5, 1.75); ctx.fill();
        }
        ctx.restore();
        this.buttons.push(lvBtn);
      }
      // 每日任务入口（play-design v1）：四按钮统一布局，等间隙16px整体居中
      // 按钮高度统一：26→30，与其他按钮一致
      const tBtnW = 66, tBtnH = 30;
      const tBtnX = taskBtnX; // 统一布局位置
      const tBtnY = subY + Math.max(0, (L.titleTitleSize - tBtnH) / 2);
      const dailyBtn = { x: tBtnX, y: tBtnY, w: tBtnW, h: tBtnH, action: 'daily' };
      ctx.save();
      const dg = this._grad('dbtn|' + Math.round(tBtnX) + '|' + Math.round(tBtnY), () => {
        const g0 = ctx.createLinearGradient(tBtnX, tBtnY, tBtnX, tBtnY + tBtnH);
        g0.addColorStop(0, '#ffd54f');
        g0.addColorStop(1, '#ffb300');
        return g0;
      });
      ctx.fillStyle = dg;
      this.roundRect(tBtnX, tBtnY, tBtnW, tBtnH, tBtnH / 2); ctx.fill();
      ctx.strokeStyle = UI.color.ink.body;
      ctx.lineWidth = 1;
      this.roundRect(tBtnX + 0.5, tBtnY + 0.5, tBtnW - 1, tBtnH - 1, tBtnH / 2 - 0.5); ctx.stroke();
      this._drawPngIcon('task', tBtnX + 13, tBtnY + tBtnH / 2, 16);
      ctx.fillStyle = '#4a2a0a';
      ctx.font = 'bold 13px ' + APPLE_FONT;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('任务', tBtnX + 25, tBtnY + tBtnH / 2 + 0.5);
      ctx.restore();
      this.buttons.push(dailyBtn);
    }
    // 图鉴 tab：页头留空，drawCodex 自带"图鉴 x/y + 进度条"头部

    // Tab：_reflow 已按累加算出 tabY / tabW（tabY 已扣 titleTabGap）
    const tabY = L.tabY;
    const tabH = 28;
    const tabW = L.tabW;
    const tabGap = 16;
    const tabsTotal = tabW * 2 + tabGap;
    const tabStartX = (W - tabsTotal) / 2;
    const tabMain   = { x: tabStartX,              y: tabY, w: tabW, h: tabH, view: 'main',  name: '合成', icon: 'merge' };
    const tabCodex  = { x: tabStartX + tabW + tabGap, y: tabY, w: tabW, h: tabH, view: 'codex', name: '图鉴', icon: 'codex' };
    this.drawTab(tabMain, this.game.view === 'main');
    this.drawTab(tabCodex, this.game.view === 'codex');
    this.tabRects = [tabMain, tabCodex];
  }

  /** V2 主场景：视图切换条（合成/图鉴）+ 任务入口，替代 drawTitleAndTabs 的「游戏名+副标题」大标题区 */
  drawViewTabs() {
    const ctx = this.ctx;
    const L = this.layout;
    const W = L.W;
    const tabY = L.tabY;
    const tabH = 28;
    const tabW = L.tabW;
    const tabGap = 16;
    const tabsTotal = tabW * 2 + tabGap;
    const tabStartX = (W - tabsTotal) / 2;
    const tabMain   = { x: tabStartX,                 y: tabY, w: tabW, h: tabH, view: 'main',  name: '合成', icon: 'merge' };
    const tabCodex  = { x: tabStartX + tabW + tabGap, y: tabY, w: tabW, h: tabH, view: 'codex', name: '图鉴', icon: 'codex' };
    this.drawTab(tabMain, this.game.view === 'main');
    this.drawTab(tabCodex, this.game.view === 'codex');
    this.tabRects = [tabMain, tabCodex];

    // P2-6 福利入口：原「任务」按钮位升级为「福利」单入口（签到/任务/助力 三合一，红点直跳）
    const tBtnW = 62, tBtnH = 28;
    const tBtnX = W - 16 - tBtnW;
    const dailyBtn = { x: tBtnX, y: tabY, w: tBtnW, h: tBtnH, action: 'welfare' };
    ctx.save();
    const dg = this._grad('v2daily|' + Math.round(tBtnX) + '|' + Math.round(tabY), () => {
      const g0 = ctx.createLinearGradient(tBtnX, tabY, tBtnX, tabY + tBtnH);
      g0.addColorStop(0, '#ffd54f');
      g0.addColorStop(1, '#ffb300');
      return g0;
    });
    ctx.fillStyle = dg;
    this.roundRect(tBtnX, tabY, tBtnW, tBtnH, tBtnH / 2); ctx.fill();
    ctx.strokeStyle = UI.color.ink.body;
    ctx.lineWidth = 1;
    this.roundRect(tBtnX + 0.5, tabY + 0.5, tBtnW - 1, tBtnH - 1, tBtnH / 2 - 0.5); ctx.stroke();
    this._drawPngIcon('task', tBtnX + 13, tabY + tBtnH / 2, 15);
    ctx.fillStyle = '#4a2a0a';
    ctx.font = 'bold 13px ' + APPLE_FONT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('福利', tBtnX + 25, tabY + tBtnH / 2 + 0.5);
    ctx.restore();
    this.buttons.push(dailyBtn);
    const _wAny = (typeof this.game.welfareMeta === 'function') ? this.game.welfareMeta().anyDue : false;
    if (_wAny) {
      const dotR = 5;
      ctx.save();
      ctx.beginPath();
      ctx.fillStyle = '#ff3b30';
      ctx.arc(tBtnX + tBtnW - dotR * 0.4, tabY + dotR * 0.6, dotR, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.92)';
      ctx.stroke();
      ctx.restore();
    }
    // P2-4 图鉴入口呼吸光晕：首抽引导期内（codexGlowT>0）在图鉴 tab 外圈画金色呼吸环
    if ((this.game.codexGlowT || 0) > 0) {
      const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 180);
      ctx.save();
      ctx.strokeStyle = '#ffd54f';
      ctx.globalAlpha = 0.45 + 0.4 * pulse;
      ctx.lineWidth = 2.5;
      this.roundRect(tabCodex.x - 3, tabCodex.y - 3, tabCodex.w + 6, tabCodex.h + 6, (tabCodex.h + 6) / 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  /** V2 主场景：合成台升级为「锻造工坊」——熔炉光晕 + 能量汇聚射线 + 暗金属圆面 +
   *  金属锻造环 + 铆钉。
   *  语义对齐：这里是「合成升级」的锻造台，**不是对抗的竞技场**，故用暖色炉火/金属语言
   *  （琥珀·橙·暗金），而非冷色竞技符文。
   *  装饰全部绘制在 drawPlatform 之前（作为背景），不遮挡三槽/陀螺/提示文案，
   *  命中区完全沿用 drawPlatform 注册的 platformRects，交互零改动。 */
  drawForgeV2(dt) {
    const ctx = this.ctx;
    const L = this.layout;
    const cx = L.arenaCx, cy = L.arenaCy, R = L.arenaR;
    if (!(R > 0)) { this.drawPlatform(); return; }
    const t = Date.now() / 1000;

    // ---- 00 中央暗衬底（修主页背景中心过亮、把陀螺/圆盘框「吃掉」的问题）----
    // 在宇宙能量底座之前的最底层铺一圈径向暗场：中心最暗、向外渐隐，
    // 既不破坏星海背景的四周氛围，又给主舞台（圆盘+陀螺）一个稳定的暗底让其浮出。
    ctx.save();
    const scrim = this._grad('v2homescrim|' + Math.round(cx) + '|' + Math.round(cy) + '|' + Math.round(R), () => {
      const g = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 1.5);
      g.addColorStop(0, 'rgba(8,5,20,0.55)');
      g.addColorStop(0.55, 'rgba(8,5,20,0.34)');
      g.addColorStop(1, 'rgba(8,5,20,0)');
      return g;
    });
    ctx.fillStyle = scrim;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // ---- 0 宇宙能量底座（冷调辉光，呼应星海背景，使圆盘像悬浮在能量平台上）----
    // 纯装饰、绘制在熔炉光晕之前（最底层），不遮挡任何槽位/陀螺，命中区零改动。
    ctx.save();
    const base = this._grad('v2cosmobase|' + Math.round(cx) + '|' + Math.round(cy) + '|' + Math.round(R), () => {
      const g = ctx.createRadialGradient(cx, cy + R * 0.18, R * 0.1, cx, cy + R * 0.18, R * 1.45);
      g.addColorStop(0, 'rgba(80,140,255,0.16)');
      g.addColorStop(0.55, 'rgba(120,90,230,0.10)');
      g.addColorStop(1, 'rgba(18,12,40,0)');
      return g;
    });
    ctx.fillStyle = base;
    ctx.beginPath();
    ctx.arc(cx, cy + R * 0.18, R * 1.45, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // ---- ① 熔炉光晕（炉火由中心向外透出，暖橙）----
    ctx.save();
    const halo = this._grad('v2forgehalo|' + Math.round(cx) + '|' + Math.round(cy) + '|' + Math.round(R), () => {
      const g = ctx.createRadialGradient(cx, cy, R * 0.15, cx, cy, R * 1.2);
      g.addColorStop(0, 'rgba(255,150,60,0.20)');
      g.addColorStop(0.5, 'rgba(190,80,25,0.11)');
      g.addColorStop(1, 'rgba(30,16,8,0)');
      return g;
    });
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 1.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // ---- ② 能量汇聚射线（由外向内注入中心，缓慢脉动）----
    ctx.save();
    const pulse = 0.5 + 0.5 * Math.sin(t * 1.1);
    ctx.globalAlpha = 0.16 + 0.14 * pulse;
    ctx.strokeStyle = '#ffca28';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + t * 0.05;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * R * 0.97, cy + Math.sin(a) * R * 0.97);
      ctx.lineTo(cx + Math.cos(a) * R * 0.72, cy + Math.sin(a) * R * 0.72);
      ctx.stroke();
    }
    ctx.restore();

    // ---- ③ 主圆面（暗金属，偏心受光）----
    ctx.save();
    const disc = this._grad('v2forgedisc|' + Math.round(cx) + '|' + Math.round(cy) + '|' + Math.round(R), () => {
      const g = ctx.createRadialGradient(cx, cy - R * 0.28, R * 0.08, cx, cy, R);
      g.addColorStop(0, 'rgba(96,64,34,0.55)');
      g.addColorStop(0.7, 'rgba(48,30,17,0.5)');
      g.addColorStop(1, 'rgba(24,15,9,0.62)');
      return g;
    });
    ctx.fillStyle = disc;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // ---- ④ 金属锻造环（亮-暗-亮线性渐变模拟金属反光）+ 内圈细环 ----
    ctx.save();
    const ringGrad = this._grad('v2forgering|' + Math.round(cx) + '|' + Math.round(cy) + '|' + Math.round(R), () => {
      const g = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
      g.addColorStop(0, 'rgba(255,214,140,0.85)');
      g.addColorStop(0.35, 'rgba(150,95,40,0.7)');
      g.addColorStop(0.6, 'rgba(235,180,90,0.85)');
      g.addColorStop(1, 'rgba(110,68,28,0.7)');
      return g;
    });
    ctx.strokeStyle = ringGrad;
    ctx.lineWidth = 3.5;
    ctx.shadowColor = 'rgba(255,160,60,0.55)';
    ctx.shadowBlur = 10 * this.shadowScale;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.99, 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255,200,110,0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.9, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // ---- ⑤ 铆钉（沿环分布，机械/锻造感）----
    ctx.save();
    ctx.fillStyle = 'rgba(255,205,120,0.6)';
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + t * 0.06;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * R * 0.945, cy + Math.sin(a) * R * 0.945, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // ---- ⑥ 三槽 / 陀螺 / 提示文案（沿用原绘制，命中区不变）----
    this.drawPlatform();
  }

  // =====================================================
  // 区域 3 · Arena（合成台）— 三槽等边三角排布，严格不越圆盘
  // =====================================================
  drawPlatform() {
    const ctx = this.ctx;
    const L = this.layout;
    const cx = L.arenaCx, cy = L.arenaCy, r = L.arenaR;
    this.platformRects.length = 0;

    // 游戏化装饰：外层旋转装饰环（合成装置感）
    ctx.save();
    ctx.translate(cx, cy);
    const ringT = Date.now() / 4000;  // 缓慢旋转
    ctx.rotate(ringT);
    ctx.strokeStyle = 'rgba(255,213,79,0.25)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([12, 8, 4, 8]);
    ctx.beginPath();
    ctx.arc(0, 0, r + 20, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    // 四个方位装饰点
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * Math.PI * 2;
      const dx = Math.cos(ang) * (r + 20);
      const dy = Math.sin(ang) * (r + 20);
      ctx.fillStyle = 'rgba(255,213,79,0.5)';
      ctx.beginPath();
      ctx.arc(dx, dy, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // 底板（放射渐变 + 双圈金边）
    ctx.save();
    ctx.translate(cx, cy);
    const baseGrad = this._grad('arena|' + Math.round(r), () => {
      const g0 = ctx.createRadialGradient(0, 0, 8, 0, 0, r + 22);
      g0.addColorStop(0, '#7e57c2');
      g0.addColorStop(1, '#311b92');
      return g0;
    });
    ctx.fillStyle = baseGrad;
    ctx.beginPath();
    ctx.arc(0, 0, r + 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffd54f';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
    // 内圈细金边
    ctx.strokeStyle = 'rgba(255,213,79,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, r - 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // 中心光效（合成装置核心）
    ctx.save();
    ctx.translate(cx, cy);
    const corePulse = 0.4 + 0.3 * Math.sin(Date.now() / 800);
    const coreGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, 25);
    coreGrad.addColorStop(0, 'rgba(255,213,79,' + (0.4 * corePulse + 0.2) + ')');
    coreGrad.addColorStop(0.5, 'rgba(255,179,0,' + (0.2 * corePulse) + ')');
    coreGrad.addColorStop(1, 'rgba(255,179,0,0)');
    ctx.fillStyle = coreGrad;
    ctx.beginPath();
    ctx.arc(0, 0, 25, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    const pair = this._mergeablePair();
    const mergeHi = pair || null;

    const slotR = L.slotR;
    const circum = L.slotCircum;
    const angles = L.slotAngles; // 上 / 右下 / 左下
    for (let i = 0; i < 3; i++) {
      const ang = angles[i];
      // 以 (cx, cy) 为心，外接圆半径 circum，角 ang（数学坐标：-90°=朝上）
      const sx = cx + Math.cos(ang) * circum;
      const sy = cy + Math.sin(ang) * circum;

      // 可合成对：金色脉冲环 + 顶部"可合成↑"提示
      if (mergeHi && mergeHi.indexOf(i) >= 0) {
        const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 150);
        ctx.strokeStyle = '#ffd54f';
        ctx.globalAlpha = 0.4 + 0.4 * pulse;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(sx, sy, slotR + 6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = 'rgba(255,213,79,' + (0.55 + 0.35 * pulse) + ')';
        ctx.font = 'bold 12px ' + APPLE_FONT;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('可合成', sx, sy - slotR * 0.55);
      }

      ctx.strokeStyle = '#9575cd';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.arc(sx, sy, slotR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      this.platformRects.push({ x: sx - slotR, y: sy - slotR, w: slotR * 2, h: slotR * 2, index: i });
      const bb = this.game.platformSlots[i];
      if (bb) {
        // 放入弹跳（体感细节）：刚放上合成台的陀螺做 350ms 缩放 pop（1.25→回落 1）+ 落地涟漪圈，
        // 让"拖入"这个动作有物理落点反馈，而不是瞬间出现。
        let bounce = 1;
        if (bb._placeT) {
          const bt = (Date.now() - bb._placeT) / 350;
          if (bt < 1) {
            bounce = 1 + 0.25 * Math.sin(bt * Math.PI) * (1 - bt);  // 先胀后缩回 1，无回弹抖动
            // 落地涟漪：白色扩散圈，随弹跳衰减
            ctx.strokeStyle = 'rgba(255,255,255,' + (0.45 * (1 - bt)).toFixed(3) + ')';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(sx, sy, slotR * (0.7 + 0.55 * bt), 0, Math.PI * 2);
            ctx.stroke();
          } else {
            delete bb._placeT;  // 动画结束即清理，避免存档冗余字段
          }
        }
        // 合成台：所有等级陀螺尺寸一致（uniformSize），避免高等级陀螺超出槽位
        // maxSize = slotR*1.88 → 陀螺直径占虚线槽位直径的 94%（原 1.8=90%，视觉偏空）
        drawBeyblade(ctx, sx, sy, bb, Math.max(0.5, slotR / 50) * bounce, { maxSize: slotR * 1.88 * bounce, uniformSize: true });
        // 属性角标已去除（陀螺本体为纯净 PNG + 中央等级数字）
      } else if (!this.game.tutorialDone && this.game.inventory.length > 0) {
        // 新手期空槽提示：轻量"拖入"引导（仅教学未完成且有库存时）
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.font = '12px ' + APPLE_FONT;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('拖入', sx, sy);
      }
    }
    // 合成台空状态：3槽全空时，中央显示两行（收集进度 + 行动号召）
    const allEmpty = !this.game.platformSlots[0] && !this.game.platformSlots[1] && !this.game.platformSlots[2];
    if (allEmpty) {
      const codexUnlocked = this.game.collection.filter(c => c.unlocked).length;
      const codexTotal = this.game.collection.length;
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // 第一行：收集进度（白色，稍大）
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.font = 'bold 15px ' + APPLE_FONT;
      ctx.fillText('收集 ' + codexUnlocked + '/' + codexTotal, cx, cy - 10);
      // 第二行：行动号召（淡紫色，稍小）
      ctx.fillStyle = 'rgba(209,196,233,0.85)';
      ctx.font = '12px ' + APPLE_FONT;
      ctx.fillText('合成升级，集齐白虎陀螺', cx, cy + 12);
      ctx.restore();
    }
  }

  drawActionBar() {
    const ctx = this.ctx;
    const L = this.layout;
    const W = L.W;
    const gap = 16;
    const btnW = Math.max(90, Math.min(120, Math.floor((W - 32 - gap * 2) / 3)));
    const totalW = btnW * 3 + gap * 2;
    const startX = (W - totalW) / 2;
    // 按钮顺序：对战 · 合成 · 抽卡（从左到右）
    const battleRect = { x: startX,                    y: L.actionY, w: btnW, h: L.actionBtnH, action: 'battle' };
    const mergeRect  = { x: startX + btnW + gap,       y: L.actionY, w: btnW, h: L.actionBtnH, action: 'merge'  };
    const drawRect   = { x: startX + (btnW + gap) * 2, y: L.actionY, w: btnW, h: L.actionBtnH, action: 'draw'   };
    // 存给新手引导高亮光圈定位用
    this.battleBtnRect = battleRect;
    this.mergeBtnRect = mergeRect;
    this.drawBtnRect = drawRect;
    this.drawButton(battleRect.x, battleRect.y, battleRect.w, battleRect.h, '对战', '#e53935');
    this.drawButton(mergeRect.x,  mergeRect.y,  mergeRect.w,  mergeRect.h,  '合成', '#ff8f00');
    // 免费抽卡券持有 → 按钮变「免费抽卡」（金色），让券的存在感落在主按钮上（D1 留客钩子）
    const hasFreeDraw = (this.game.freeDraws || 0) > 0;
    this.drawButton(drawRect.x,   drawRect.y,   drawRect.w,   drawRect.h,   hasFreeDraw ? '免费抽卡' : '抽卡', hasFreeDraw ? '#ffb300' : '#7e57c2');

    // 抽卡隐藏插屏广告（第3/6/9抽自动弹，无需按钮）：原「看广告免费抽」入口已移除，
    // 改为抽卡收卡时自动插播，玩家无选择、无入口。
    this.buttons.push(drawRect, battleRect, mergeRect);

    // 游戏化装饰：外发光边框（每个按钮不同颜色发光）
    const gameBtns = [
      { rect: battleRect, color: '#ff5252', glow: 'rgba(255,82,82,0.5)' },
      { rect: mergeRect,  color: '#ffb300', glow: 'rgba(255,179,0,0.5)' },
      { rect: drawRect,   color: '#b388ff', glow: 'rgba(179,136,255,0.5)' }
    ];
    for (const gb of gameBtns) {
      ctx.save();
      // 外发光
      ctx.shadowColor = gb.glow;
      ctx.shadowBlur = 8 * this.shadowScale;
      ctx.strokeStyle = gb.color;
      ctx.lineWidth = 1.5;
      this.roundRect(gb.rect.x - 1, gb.rect.y - 1, gb.rect.w + 2, gb.rect.h + 2, Math.min(18, gb.rect.h / 2));
      ctx.stroke();
      ctx.shadowBlur = 0;
      // 内金属高光边
      ctx.strokeStyle = 'rgba(255,255,255,0.3)';
      ctx.lineWidth = 0.8;
      this.roundRect(gb.rect.x + 2, gb.rect.y + 2, gb.rect.w - 4, gb.rect.h - 4, Math.min(16, gb.rect.h / 2 - 1));
      ctx.stroke();
      ctx.restore();
    }
    // 对战按钮呼吸光效（主要操作按钮，吸引玩家点击）
    const battlePulse = 0.5 + 0.5 * Math.sin(Date.now() / 600);
    ctx.save();
    ctx.globalAlpha = 0.3 + 0.25 * battlePulse;
    ctx.shadowColor = 'rgba(255,82,82,0.8)';
    ctx.shadowBlur = 14 * this.shadowScale;
    ctx.strokeStyle = '#ff8a80';
    ctx.lineWidth = 2;
    this.roundRect(battleRect.x - 2, battleRect.y - 2, battleRect.w + 4, battleRect.h + 4, Math.min(20, battleRect.h / 2 + 1));
    ctx.stroke();
    ctx.restore();
    // 临近保底提示：仅剩 1~2 抽时才在抽卡按钮内中下部显示金色小字，平时不显示（减少信息噪音）
    if (this.game.energy >= 8) {
      const pe = this.game.pityEpic || 0, pl = this.game.pityLegend || 0;
      const remain = Math.max(1, Math.min(10 - pe, 30 - pl));
      if (remain <= 2) {
        ctx.save();
        ctx.fillStyle = '#ffd54f';
        ctx.font = 'bold 12px ' + APPLE_FONT;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('保底 ' + remain + ' 抽', drawRect.x + drawRect.w / 2, drawRect.y + drawRect.h - 9);
        ctx.restore();
      }
    }
    this._drawObGlow(); // 首程直达轻引导（呼吸光圈，不打断）
  }

  /** V2 主场景：四个一致性主行动按钮 —— 对战 / 合成 / 抽卡 / 增益，等宽等分、同形状同字号 */
  drawHomeActions() {
    const ctx = this.ctx;
    const L = this.layout;
    const W = L.W;
    const pad = 16, gap = 8;
    // 四个主行动按钮等宽等分：对战(直接开战) / 合成 / 抽卡 / 增益(开增益面板)。
    // 视觉语言统一（异形切角 + 同字号 + 同高度），仅配色区分，不再有主次大小之分。
    const n = 4;
    const total = W - pad * 2 - gap * (n - 1);
    const bw = Math.floor(total / n);
    const y = L.actionY, h = L.actionBtnH;
    const make = (i, action) => ({ x: pad + i * (bw + gap), y, w: bw, h, action });
    const battleRect = make(0, 'battle_quick');
    const mergeRect  = make(1, 'merge');
    const drawRect   = make(2, 'draw');
    const gainRect   = make(3, 'buff');
    const rects = [battleRect, mergeRect, drawRect, gainRect];
    // 存给新手引导高亮光圈定位用
    this.battleBtnRect = battleRect;
    this.mergeBtnRect = mergeRect;
    this.drawBtnRect = drawRect;

    // 异形切角路径（游戏按钮语言：区别于小程序通用圆角矩形）
    const cutOf = (r, k) => Math.min(k, r.h * 0.28);
    const angledPath = (r, k) => {
      const c = cutOf(r, k);
      ctx.beginPath();
      ctx.moveTo(r.x + c, r.y);
      ctx.lineTo(r.x + r.w - c, r.y);
      ctx.lineTo(r.x + r.w, r.y + c);
      ctx.lineTo(r.x + r.w, r.y + r.h - c);
      ctx.lineTo(r.x + r.w - c, r.y + r.h);
      ctx.lineTo(r.x + c, r.y + r.h);
      ctx.lineTo(r.x, r.y + r.h - c);
      ctx.lineTo(r.x, r.y + c);
      ctx.closePath();
    };
    const paintAngled = (r, k, c0, c1, c2, edge, glowColor, glowBase, pulseAmp) => {
      const pressed = this.pressedBtn && this.pressedBtn.rect && this.pressedBtn.rect.action === r.action;
      const sc = pressed ? 0.94 : 1;
      ctx.save();
      if (sc !== 1) {
        const mx = r.x + r.w / 2, my = r.y + r.h / 2;
        ctx.translate(mx, my); ctx.scale(sc, sc); ctx.translate(-mx, -my);
      }
      // 外发光（主钮呼吸，次钮恒定弱光）
      const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 600);
      ctx.shadowColor = glowColor;
      ctx.shadowBlur = (glowBase + pulseAmp * pulse) * this.shadowScale;
      angledPath(r, k);
      const g = this._grad('v2btn|' + r.action + '|' + Math.round(r.x) + '|' + Math.round(r.y), () => {
        const g0 = ctx.createLinearGradient(r.x, r.y, r.x, r.y + r.h);
        g0.addColorStop(0, c0);
        g0.addColorStop(0.45, c1);
        g0.addColorStop(1, c2);
        return g0;
      });
      ctx.fillStyle = g;
      ctx.fill();
      ctx.shadowBlur = 0;
      // 上半高光带（金属质感）
      ctx.save();
      ctx.clip();
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      ctx.fillRect(r.x, r.y, r.w, r.h * 0.45);
      ctx.restore();
      // 亮边
      ctx.strokeStyle = edge;
      ctx.lineWidth = 1.6;
      ctx.stroke();
      // 按下暗化
      if (pressed) {
        ctx.fillStyle = 'rgba(0,0,0,0.2)';
        ctx.fill();
      }
      ctx.restore();
    };

    // 四个按钮统一绘制（同形状、同切角；仅配色/呼吸光区分）
    const THEME = {
      battle_quick: { c0:'#ff8a65', c1:'#e53935', c2:'#8e1414', edge:'rgba(255,220,180,0.85)', glow:'rgba(255,80,60,0.6)', glowBase:14, pulseAmp:8 },
      merge:        { c0:'#ffcc80', c1:'#ff8f00', c2:'#8a4b00', edge:'rgba(255,235,200,0.7)', glow:'rgba(255,179,0,0.35)', glowBase:6, pulseAmp:0 },
      draw:         { c0:'#d1b3ff', c1:'#7e57c2', c2:'#3d2a63', edge:'rgba(235,220,255,0.7)', glow:'rgba(179,136,255,0.35)', glowBase:6, pulseAmp:0 },
      buff:         { c0:'#b9f6ca', c1:'#43a047', c2:'#1b5e20', edge:'rgba(220,255,225,0.7)', glow:'rgba(76,175,80,0.35)', glowBase:6, pulseAmp:0 },
    };
    const k = 10; // 统一切角
    for (const r of rects) {
      const t = THEME[r.action];
      paintAngled(r, k, t.c0, t.c1, t.c2, t.edge, t.glow, t.glowBase, t.pulseAmp);
    }

    // 文字与图标（统一：四个按钮全部图标上方居中、文字下方居中）
    const ICONS = { battle_quick: 'play', merge: 'merge', draw: 'chest', buff: 'sparkle' };
    // 四图标源图内容占比不同（play 86%高 / merge 71%宽且扁 / chest ~100% / sparkle 89%高，已实测），
    // 按下「内容长边填满 18px 框」各自等比放大，使四个图标视觉大小一致。倍率 = 18 / (18 × 内容长边占比) = 1 / 内容长边占比。
    // 宝箱(chest)占比≈100% 保持 1.0（不缩小），其余放大补齐 —— 与之前「整体缩小到 78%」不同，本方案保留宝箱原始大小且整排不缩水。
    const ICON_SCALE = { battle_quick: 1 / 0.86, merge: 1 / 0.71, draw: 1, buff: 1 / 0.89 };
    const TEXTS = { battle_quick: '对战', merge: '合成', draw: '抽卡', buff: '增益' };
    const label = (r) => {
      ctx.save();
      const ic = ICONS[r.action];
      ctx.fillStyle = UI.color.text;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = 3;
      if (ic) {
        this._drawPngIcon(ic, r.x + r.w / 2, r.y + r.h * 0.36, 18 * (ICON_SCALE[r.action] || 1));
        ctx.font = this._tl(UI.font.head, true);
        ctx.fillText(TEXTS[r.action], r.x + r.w / 2, r.y + r.h * 0.72);
      } else {
        ctx.font = this._tl(UI.font.title, true);
        ctx.fillText(TEXTS[r.action], r.x + r.w / 2, r.y + r.h / 2);
      }
      ctx.shadowBlur = 0;
      ctx.restore();
    };
    for (const r of rects) label(r);

    this.buttons.push(battleRect, mergeRect, drawRect, gainRect);

    // 双人合作守关入口（灰度开关 CONFIG.coop.enabled；enabled=false 时不渲染，避免死按钮）
    this.coopBtnRect = null;
    if (CONFIG.coop && CONFIG.coop.enabled) {
      const coh = 34, cow = 116;
      const cox = battleRect.x;
      const coy = L.actionY - coh - 8;
      this.drawButton(cox, coy, cow, coh, '双人·合作', '#7e57c2');
      const coord = { x: cox, y: coy, w: cow, h: coh, action: 'coop' };
      this.buttons.push(coord);
      this.coopBtnRect = coord;
    }

    // 临近保底提示：仅剩 1~2 抽时才在抽卡按钮内中下部显示金色小字，平时不显示（减少信息噪音）
    if (this.game.energy >= 8) {
      const pe = this.game.pityEpic || 0, pl = this.game.pityLegend || 0;
      const remain = Math.max(1, Math.min(10 - pe, 30 - pl));
      if (remain <= 2) {
        ctx.save();
        ctx.fillStyle = '#ffd54f';
        ctx.font = 'bold 12px ' + APPLE_FONT;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('保底 ' + remain + ' 抽', drawRect.x + drawRect.w / 2, drawRect.y + drawRect.h - 9);
        ctx.restore();
      }
    }
    this._drawObGlow(); // 首程直达轻引导（呼吸光圈，不打断）
  }

  // =====================================================
  // 区域 5 · 过滤器（一行，占满整宽；抽卡按钮已移至底部操作栏）
  // =====================================================
  drawFiltersAndDraw() {
    const ctx = this.ctx;
    const L = this.layout;
    const count = TIERS.length + 1;         // 全部 + 5 档（五行品质）
    const btnH = L.filterH;
    const gap = 8;
    const y = L.filterY;

    // 过滤器占满整宽（抽卡按钮已移至底部操作栏，不再预留右侧空间）
    const availFilt = this.width - 32;
    const filtBtnW = Math.max(36, Math.min(64, Math.floor((availFilt - (count - 1) * gap) / count)));
    // 六个筛选按钮（全部、麒麟、青龙、玄武、朱雀、白虎）居中显示
    const totalFiltWidth = count * filtBtnW + (count - 1) * gap;
    let fx = (this.width - totalFiltWidth) / 2; // 居中显示（原靠左16→居中）
    this.filterRects = [];
    // 全名优先级：filtBtnW >= 44 → 全名（11px 中文两字 24px + 边距 20 = 44）；否则两字
    const fullName = filtBtnW >= 44;
    // filtNames 按 fullName 取模块级 memo（CODEX_FILT_NAMES），消除每帧 TIERS.map 新建数组
    const filtNames = CODEX_FILT_NAMES[fullName];
    for (let i = -1; i < TIERS.length; i++) {
      const name = filtNames[i + 1];
      const rect = {
        x: fx, y, w: filtBtnW, h: btnH,
        tierIndex: i, name,
        color: i >= 0 ? TIERS[i].color : null,
      };
      const active = (i === -1 ? (this.game.filterTier === -1) : (this.game.filterTier === i));
      this.drawFilterButton(rect, active);
      this.filterRects.push(rect);
      fx += filtBtnW + gap;
    }
  }

  drawFilterButton(rect, active) {
    const ctx = this.ctx;
    ctx.save();
    const r = Math.min(12, rect.h / 2 - 1);
    if (active) {
      // 选中态：品质色渐变底 + 白色描边 + 顶部高光条
      const g = this._grad('fbtn|' + rect.name + '|' + Math.round(rect.y) + '|' + Math.round(rect.h), () => {
        const gg = ctx.createLinearGradient(rect.x, rect.y, rect.x, rect.y + rect.h);
        gg.addColorStop(0, this._shadeColor(rect.color || '#7e57c2', 0.35));
        gg.addColorStop(1, rect.color || '#7e57c2');
        return gg;
      });
      ctx.fillStyle = g;
      this.roundRect(rect.x, rect.y, rect.w, rect.h, r); ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      this.roundRect(rect.x + 0.75, rect.y + 0.75, rect.w - 1.5, rect.h - 1.5, r - 0.75); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      this.roundRect(rect.x + 3, rect.y + 2, rect.w - 6, Math.max(2, rect.h * 0.28), 3); ctx.fill();
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.strokeStyle = rect.color || '#7e57c2';
      ctx.lineWidth = 1.5;
      this.roundRect(rect.x, rect.y, rect.w, rect.h, r); ctx.fill(); ctx.stroke();
    }
    ctx.fillStyle = '#ffffff';
    const fsize = Math.max(11, Math.min(14, Math.floor(rect.w / 5)));
    ctx.font = 'bold ' + fsize + 'px ' + APPLE_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(rect.name, rect.x + rect.w / 2, rect.y + rect.h / 2);
    ctx.restore();
  }

  /** 实际渲染的背包行数：需要分页时，网格底部让出 24px 给分页器，避免分页器压住最后一行 */
  inventoryRowsMax() {
    const L = this.layout;
    const cols = Math.max(1, L.invCols);
    const base = Math.max(1, L.invRowsMax);
    const list = this.game.getFilteredInventory();
    if (Math.ceil(list.length / Math.max(1, cols * base)) <= 1) return base;
    return Math.max(1, Math.floor((L.invMaxBottom - 24 - L.invY + L.invGap) / L.invRowStep));
  }

  /** 背包空状态引导（网格 / 陈列两种模式共用） */
  drawInventoryEmptyState() {
    const ctx = this.ctx;
    const L = this.layout;
    const list = this.game.getFilteredInventory();
    const startX = L.invStartX;
    const cell = L.invCell, gap = L.invGap, cols = L.invCols;
    ctx.save();
    const ex = L.invStartX;
    const ew = startX + cols * cell + (cols - 1) * gap - ex;
    const ey = L.invY + (L.invMaxBottom - L.invY) / 2;
    const emptyAll = list.length === 0 && this.game.filterTier < 0;
    const cx = ex + ew / 2;
    const cy = ey - 14;
    // 中央：3 个灰色虚线圆环「空槽位」（暗示这里将放置陀螺）
    ctx.strokeStyle = UI.color.ink.line;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 6]);
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.arc(cx + i * 34, cy, 23, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // 中间槽位：金色「+」（待填充语义）
    ctx.fillStyle = 'rgba(255,213,79,0.55)';
    ctx.font = 'bold 22px ' + APPLE_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('+', cx, cy);
    // 主文案
    ctx.fillStyle = 'rgba(255,255,255,0.78)';
    ctx.font = 'bold 14px ' + APPLE_FONT;
    ctx.fillText(emptyAll ? '背包空空的，去抽卡获得陀螺吧' : '该品质还没有陀螺', cx, cy + 50);
    // 副文案
    ctx.fillStyle = 'rgba(255,255,255,0.42)';
    ctx.font = '12px ' + APPLE_FONT;
    ctx.fillText(emptyAll ? '消耗能量抽卡 · 集齐 25 款图鉴' : '试试其它品质标签', cx, cy + 68);
    ctx.restore();
  }

  // =====================================================
  // 区域 6 · 背包网格（动态 cell，保证不出 invMaxBottom；溢出提示在右下方 badge）
  // =====================================================
  drawInventory() {
    const ctx = this.ctx;
    const L = this.layout;
    const list = this.game.getFilteredInventory();
    const cols = L.invCols, cell = L.invCell, gap = L.invGap;
    const startX = L.invStartX;
    let x = startX;
    let y = L.invY;
    this.gridRects.length = 0;

    const maxItems = Math.max(1, cols * this.inventoryRowsMax());
    const totalPages = Math.max(1, Math.ceil(list.length / maxItems));
    // 分页收敛：出售/筛选/合成导致页数变化时，页码自动钳制回合法范围
    if (this.game.invPage >= totalPages) this.game.invPage = totalPages - 1;
    if (this.game.invPage < 0) this.game.invPage = 0;
    const page = this.game.invPage;
    const drawn = list.slice(page * maxItems, (page + 1) * maxItems);

    // 空背包引导：无陀螺时给精致空状态（空槽位视觉 + 文案），避免空白区域不知所措
    if (drawn.length === 0) this.drawInventoryEmptyState();

    for (let i = 0; i < drawn.length; i++) {
      const bb = drawn[i];
      const rect = { x, y, w: cell, h: cell, beyblade: bb };
      this.gridRects.push(rect);
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.25)';
      ctx.shadowBlur = 3 * this.shadowScale;
      ctx.fillStyle = UI.color.ink.faint;
      ctx.strokeStyle = bb.tier.color;
      ctx.lineWidth = 1.5;
      this.roundRect(x, y, cell, cell, Math.max(8, Math.min(12, cell / 5)));
      ctx.fill(); ctx.stroke();
      ctx.restore();
      // 背包：所有等级陀螺尺寸一致（uniformSize），避免高等级陀螺超出格子
      // maxSize = cell*0.94 → 陀螺直径占格子的 94%（原 0.88，四边留白 6% 视觉偏空）
      drawBeyblade(ctx, x + cell / 2, y + cell / 2, bb, Math.max(0.3, cell / 100), { maxSize: cell * 0.94, uniformSize: true });
      // 属性角标已去除（陀螺本体为纯净 PNG + 中央等级数字）
      x += cell + gap;
      if ((i + 1) % cols === 0) { x = startX; y += cell + gap; }
    }

    // 分页器：超出可视容量时，在网格右下角给出 ‹ 1/3 ›（左右箭头翻页 · 中点提示长按出售）
    if (totalPages > 1) {
      const pH = 22, chevW = 22, padX = 4;
      const gridRightX = startX + cols * cell + (cols - 1) * gap;
      const pY = L.invMaxBottom - pH - 2;
      const midText = (page + 1) + '/' + totalPages;
      ctx.font = 'bold 12px ' + APPLE_FONT;
      const midW = mtW(ctx, midText) + 18;
      const pagerW = chevW * 2 + midW + padX * 4;
      const pX = gridRightX - pagerW;
      const leftRect = { x: pX, y: pY, w: chevW, h: pH, action: 'inv_prev' };
      const midRect = { x: pX + chevW + padX, y: pY, w: midW, h: pH, action: 'inv_page' };
      const rightRect = { x: pX + chevW + padX + midW + padX, y: pY, w: chevW, h: pH, action: 'inv_next' };
      // 中点：金色小胶囊（当前页/总页数）
      ctx.save();
      ctx.fillStyle = 'rgba(255,179,0,0.18)';
      ctx.strokeStyle = '#ffd54f';
      ctx.lineWidth = 1.2;
      this.roundRect(midRect.x, midRect.y, midRect.w, midRect.h, midRect.h / 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#ffd54f';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(midText, midRect.x + midRect.w / 2, midRect.y + midRect.h / 2 + 0.5);
      ctx.restore();
      // 左右箭头：越界侧置灰不可翻
      this._drawChevron(leftRect, page > 0);
      this._drawChevron(rightRect, page < totalPages - 1);
      this.buttons.push(leftRect, midRect, rightRect);
    }
  }

  /** 陈列轨道开关：game.invRailV2 = false 回退网格 */
  invRailV2On() { return this.game.invRailV2 !== false; }

  /** 快速开战开关（#11 首屏可玩）：game.quickBattleV2 = false 时主按钮恢复为「先弹增益面板」 */
  quickBattleV2On() { return this.game.quickBattleV2 !== false; }

  /** 陈列轨道最大横向滚动量（列表宽度 - 视口宽度）；列表/筛选变化后供钳制用 */
  invMaxScroll() {
    const L = this.layout;
    const viewportW = L.W - 32;
    const pagerH = 20;
    const railH = Math.max(56, (L.invMaxBottom - L.invY) - pagerH - 4);
    const cardW = Math.max(62, Math.min(84, Math.round(railH * 0.74)));
    const step = cardW + 8;
    const list = this.game.getFilteredInventory();
    const totalW = list.length * step - 8;
    return Math.max(0, totalW - viewportW);
  }

  /** 陈列轨道可视区矩形（padX 留白 + 卡片区），供输入层判断「手指是否落在轨道上」 */
  invRailRect() {
    const L = this.layout;
    const W = L.W;
    const padX = 16;
    const viewportW = W - padX * 2;
    const railY = L.invY;
    const pagerH = 20;
    const railH = Math.max(56, (L.invMaxBottom - L.invY) - pagerH - 4);
    return { x: padX - 2, y: railY - 2, w: viewportW + 4, h: railH + 4 };
  }

  /** 松手惯性：每帧把速度叠到 invScrollX 并衰减，撞到两端归零（_stepInvInertia 由 main.update 调用） */
  _stepInvInertia() {
    if (!this._invVel) return;
    const maxScroll = this.invMaxScroll();
    let ns = this.invScrollX + this._invVel;
    if (ns < 0) { ns = 0; this._invVel = 0; }
    else if (ns > maxScroll) { ns = maxScroll; this._invVel = 0; }
    this.invScrollX = ns;
    this._invVel *= 0.9;
    if (Math.abs(this._invVel) < 0.4) this._invVel = 0;
  }

  /** 陈列轨道按屏滚动（dir = -1 上一屏 / +1 下一屏），供 inv_prev / inv_next 调用 */
  scrollInventoryByScreen(dir) {
    const L = this.layout;
    const viewportW = L.W - 32;
    const pagerH = 20;
    const railH = Math.max(56, (L.invMaxBottom - L.invY) - pagerH - 4);
    const cardW = Math.max(62, Math.min(84, Math.round(railH * 0.74)));
    const step = cardW + 8;
    const maxScroll = this.invMaxScroll();
    let next = this.invScrollX + dir * Math.max(step, viewportW * 0.8);
    if (next < 0) next = 0;
    if (next > maxScroll) next = maxScroll;
    this.invScrollX = next;
  }

  /** V2 陈列轨道：背包由「网格列表」改为「陀螺陈列卡」——横向卡片流（展柜质感），
   *  每张卡带品质渐变底、稀有度光晕、陀螺大图、品质名与等级角标。
   *  交互契约完全保留：仅把**与可视区相交**的卡片注册进 gridRects，
   *  因此拖拽到合成台 / 长按出售 / 点击放入 三种操作照旧工作。
   *  翻页改为滚动一屏（inv_prev / inv_next 走 scrollInventoryByScreen）。 */
  drawInventoryRailV2() {
    const ctx = this.ctx;
    const L = this.layout;
    const W = L.W;
    const list = this.game.getFilteredInventory();
    if (list.length === 0) { this.drawInventoryEmptyState(); return; }

    const padX = 16;
    const viewportW = W - padX * 2;
    const railY = L.invY;
    const pagerH = 20;
    const railH = Math.max(56, (L.invMaxBottom - L.invY) - pagerH - 4);
    const cardW = Math.max(62, Math.min(84, Math.round(railH * 0.74)));
    const cardGap = 8;
    const step = cardW + cardGap;

    // 滚动范围钳制（列表变短/筛选切换后自动收敛）
    const totalW = list.length * step - cardGap;
    const maxScroll = Math.max(0, totalW - viewportW);
    if (!(this.invScrollX >= 0)) this.invScrollX = 0;
    if (this.invScrollX > maxScroll) this.invScrollX = maxScroll;

    const first = Math.max(0, Math.floor(this.invScrollX / step) - 1);
    const last = Math.min(list.length - 1, Math.ceil((this.invScrollX + viewportW) / step) + 1);

    ctx.save();
    ctx.beginPath();
    ctx.rect(padX - 2, railY - 2, viewportW + 4, railH + 4);
    ctx.clip();
    for (let i = first; i <= last; i++) {
      const bb = list[i];
      const x = padX + i * step - this.invScrollX;
      const rect = { x, y: railY, w: cardW, h: railH, beyblade: bb };
      // 只注册与可视区相交的卡片，避免命中被裁剪掉的卡
      if (rect.x + rect.w > padX && rect.x < padX + viewportW) this.gridRects.push(rect);
      this._drawInvCard(ctx, rect, bb);
    }
    ctx.restore();

    // 底部：滚动进度条 + 左右箭头（沿用 inv_prev / inv_next / inv_page 三个 action）
    const pY = railY + railH + 6;
    if (maxScroll > 0) {
      const arrowW = 22, arrowH = 20;
      const leftRect  = { x: padX,                       y: pY, w: arrowW, h: arrowH, action: 'inv_prev' };
      const rightRect = { x: padX + viewportW - arrowW,  y: pY, w: arrowW, h: arrowH, action: 'inv_next' };
      this._drawChevron(leftRect, this.invScrollX > 0);
      this._drawChevron(rightRect, this.invScrollX < maxScroll);
      this.buttons.push(leftRect, rightRect);
      const barX = padX + arrowW + 6;
      const barW = Math.max(20, viewportW - (arrowW + 6) * 2);
      const barY = pY + arrowH / 2 - 2;
      ctx.save();
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      this.roundRect(barX, barY, barW, 4, 2); ctx.fill();
      const thumbW = Math.max(24, barW * (viewportW / Math.max(1, totalW)));
      const thumbX = barX + (barW - thumbW) * (this.invScrollX / maxScroll);
      ctx.fillStyle = '#ffd54f';
      this.roundRect(thumbX, barY, thumbW, 4, 2); ctx.fill();
      ctx.restore();
      // 中点：保留「长按陀螺可出售」提示入口
      this.buttons.push({ x: barX, y: pY, w: barW, h: arrowH, action: 'inv_page' });
    }
  }

  /** 单张陈列卡：品质渐变底 + 稀有度光晕 + 陀螺大图 + 品质名 + 等级角标 */
  _drawInvCard(ctx, r, bb) {
    const tier = bb.tier || {};
    const color = tier.color || '#9e9e9e';
    const rIdx = (typeof bb.tierIndex === 'number') ? bb.tierIndex : 0;
    ctx.save();
    // 卡片底（上亮下暗，展柜玻璃感）
    const g = this._grad('invcard|' + rIdx + '|' + Math.round(r.w) + '|' + Math.round(r.h), () => {
      const gg = ctx.createLinearGradient(r.x, r.y, r.x, r.y + r.h);
      gg.addColorStop(0, 'rgba(255,255,255,0.11)');
      gg.addColorStop(1, 'rgba(255,255,255,0.03)');
      return gg;
    });
    ctx.fillStyle = g;
    // 稀有度光晕：品质越高越亮
    ctx.shadowColor = color;
    ctx.shadowBlur = (rIdx >= 3 ? 10 : (rIdx >= 2 ? 6 : 3)) * this.shadowScale;
    this.roundRect(r.x, r.y, r.w, r.h, 12);
    ctx.fill();
    ctx.shadowBlur = 0;
    // 品质色描边
    ctx.strokeStyle = color;
    ctx.lineWidth = rIdx >= 3 ? 2 : 1.4;
    ctx.stroke();
    // 陀螺大图（居中偏上）
    // maxSize = r.w*0.88 → 陀螺直径占卡片宽度的 88%（原 0.78 偏空）。
    // 上限取 0.88 而非更高：卡片是竖长卡（cardW ≈ 0.74×railH），陀螺底部须避开
    // 「品质名」（r.h-14 处、10px 字），实测留约 7.5px；左上角 Lv 角标在陀螺之后绘制、
    // 覆盖于其上不受影响，仅与陀螺圆顶右侧极小范围交叠。
    drawBeyblade(ctx, r.x + r.w / 2, r.y + r.h * 0.44, bb,
      Math.max(0.3, r.w / 100), { maxSize: r.w * 0.88, uniformSize: true });
    // 品质名
    ctx.fillStyle = color;
    ctx.font = 'bold 12px ' + APPLE_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(tier.name || '', r.x + r.w / 2, r.y + r.h - 14);
    // 等级角标
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    this.roundRect(r.x + 4, r.y + 4, 28, 15, 7); ctx.fill();
    ctx.fillStyle = '#ffd54f';
    ctx.font = 'bold 12px ' + APPLE_FONT;
    ctx.fillText('Lv' + (bb.level || 1), r.x + 18, r.y + 12);
    ctx.restore();
  }

  /** 分页器左右箭头（苹果风 chevron，enabled=false 时置灰） */
  _drawChevron(rect, enabled) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = enabled ? 1 : 0.32;
    ctx.fillStyle = enabled ? UI.color.ink.line : UI.color.ink.faint;
    ctx.strokeStyle = enabled ? 'rgba(255,255,255,0.40)' : 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    this.roundRect(rect.x, rect.y, rect.w, rect.h, rect.h / 2); ctx.fill(); ctx.stroke();
    // 分页箭头用 PNG（icon-prev/next.png），与设计稿 pager 一致
    const dir = rect.action === 'inv_prev' ? 'prev' : 'next';
    const is = Math.min(rect.w, rect.h) * 0.55;
    if (!this._drawPngIcon(dir, rect.x + rect.w / 2, rect.y + rect.h / 2, is)) {
      // PNG 缺失回退：矢量三角形
      const dirS = rect.action === 'inv_prev' ? -1 : 1;
      ctx.strokeStyle = enabled ? '#ffd54f' : 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
      const s = 5;
      ctx.beginPath();
      ctx.moveTo(cx + dirS * s, cy - s);
      ctx.lineTo(cx - dirS * s, cy);
      ctx.lineTo(cx + dirS * s, cy + s);
      ctx.stroke();
    }
    ctx.restore();
  }

  // =====================================================
  // 图鉴：TopBar 相同，标题计数 + 等级行
  // · Lv 标签改为 cell 内左上角内嵌徽章，不再悬在 cell 下方，杜绝与下一行的 tier 名撞。
  // =====================================================
  drawCodex() {
    const ctx = this.ctx;
    const L = this.layout;
    const W = L.W;
    // 图鉴陀螺平滑自转（2026-09-14）：复用已烘焙 sprite，仅由全局时钟驱动外层
    // ctx.rotate(bb.angle) 旋转定格位图 —— 不重烘焙、不重 new、零 GC 压力。
    // sprite 缓存 key 不含角度(tier:level|png/vec)，故旋转不会触发重烘焙。数字随位图一起转，与战斗陀螺一致。
    const _codexNow = (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()) / 1000;
    const CODEX_SPIN = 2; // 自转角速度 rad/s（陈列慢转更优雅）

    const cnt = this.game.codexCount();
    const total = this.game.codexTotal();
    // 头部独立带：标题锚在 Tab 条下方的 codexHeaderTop（不再与 Tab 同 Y 叠压），进度条锚在 codexProgY
    const cntY = L.codexHeaderTop;

    // 顶部标题 + 集齐状态（对齐 Title 区内标题行 y，不挤占 Tab）
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    if (cnt >= total && total > 0) {
      ctx.fillStyle = '#ffd54f';
      ctx.font = 'bold 18px ' + APPLE_FONT;
      ctx.shadowColor = 'rgba(255,213,79,0.6)';
      ctx.shadowBlur = 10 * this.shadowScale;
      // 图标资产 v3：两侧 ★ → icon-star.png
      const cntTxt = '图鉴集齐 · 陀螺大师';
      const cntTw = mtW(ctx, cntTxt);
      ctx.fillText(cntTxt, W / 2, cntY);
      ctx.shadowBlur = 0;
      this._drawPngIcon('star', W / 2 - cntTw / 2 - 13, cntY + 9, 14);
      this._drawPngIcon('star', W / 2 + cntTw / 2 + 13, cntY + 9, 14);
    } else {
      ctx.fillStyle = '#ffd54f';
      ctx.font = 'bold 18px ' + APPLE_FONT;
      ctx.fillText('图鉴  ' + cnt + ' / ' + total, W / 2, cntY);
    }

    // （已移除图鉴顶部静止的「金>木>土>水>火」胶囊——五行策略改为点击陀螺详情查看，顶部更干净）

    // 收集进度条：标题下方细条（金色渐变 + 百分比），给长期目标感
    // 增加呼吸感：标题和进度条间距22→26，进度条和横幅间距8→12
    const pct = total > 0 ? cnt / total : 0;
    const pW = Math.min(210, W - 130);
    const pX = W / 2 - pW / 2;
    const pY = L.codexProgY;
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    this.roundRect(pX, pY, pW, 5, 2.5); ctx.fill();
    if (pct > 0) {
      const pg = this._grad('codexP|' + Math.round(pX) + '|' + Math.round(pY) + '|' + Math.round(pW), () => {
        const gg = ctx.createLinearGradient(pX, pY, pX + pW, pY);
        gg.addColorStop(0, '#ffb300');
        gg.addColorStop(1, '#ffd54f');
        return gg;
      });
      ctx.fillStyle = pg;
      this.roundRect(pX, pY, Math.max(5, pW * pct), 5, 2.5); ctx.fill();
    }
    ctx.fillStyle = UI.color.ink.body;
    ctx.font = '12px ' + APPLE_FONT;
    ctx.fillText(Math.floor(pct * 100) + '%', W / 2 + pW / 2 + 6, pY - 2);

    // 阶段奖励横幅（收集 5/10/15/20 档发大奖）下移到底部细条，给顶部留呼吸感
    this._drawCodexFooter(ctx);

    const startY = L.codexStartY;
    const rowH = L.codexRowH;
    const labelW = L.codexLabelW;
    const leftPad = (L.codexLeftPad !== undefined && L.codexLeftPad !== null) ? L.codexLeftPad : 12;
    const gap = L.codexGap;
    const cell = L.codexCell;
    const gridStartX = (L.codexGridStartX !== undefined && L.codexGridStartX !== null) ? L.codexGridStartX : (leftPad + labelW + gap);
    const tierNames = ['麒麟', '青龙', '玄武', '朱雀', '白虎'];  // 与 TIERS 严格同序（五灵神兽）
    for (let t = 0; t < TIERS.length; t++) {
      const tier = TIERS[t];
      const ry = startY + t * rowH;

      // 先计算该品质收集进度
      let rowCnt = 0;
      for (let l = 1; l <= 5; l++) {
        const c = this.game.collection.find(x => x.tierIndex === t && x.level === l);
        if (c && c.unlocked) rowCnt++;
      }
      const rowDone = rowCnt >= 5;

      // 品质胶囊徽章（上面一行）：品质色渐变底 + 品质名和收集进度一行显示
      // 新布局：品质标签单独一行（上面），陀螺单独一行（下面）
      // 品质标签左对齐，和第一列陀螺的中心对齐（不要整行居中）
      const bdW = 62, bdH = 20;
      const bdX = gridStartX + cell / 2 - bdW / 2, bdY = ry + 4; // 和第一列陀螺中心对齐
      const bg = this._grad('tierBadge|' + t + '|' + Math.round(bdY) + '|' + Math.round(bdH), () => {
        const gg = ctx.createLinearGradient(bdX, bdY, bdX, bdY + bdH);
        gg.addColorStop(0, this._shadeColor(tier.color, 0.42));
        gg.addColorStop(1, tier.color);
        return gg;
      });
      ctx.fillStyle = bg;
      this.roundRect(bdX, bdY, bdW, bdH, bdH / 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.lineWidth = 1;
      this.roundRect(bdX + 0.5, bdY + 0.5, bdW - 1, bdH - 1, bdH / 2 - 0.5); ctx.stroke();
      // 根据品质色亮度自适应文字色：金色等亮色用深色文字，其他用白色
      const _rgb = this._hexToRgb(tier.color);
      const _luminance = _rgb ? (0.299 * _rgb.r + 0.587 * _rgb.g + 0.114 * _rgb.b) / 255 : 0.5;
      const tierTextColor = _luminance > 0.6 ? '#3a2a0a' : '#ffffff';
      // 神兽名和收集进度一行显示："青龙 1/5"，集齐时显示"白虎 集齐"
      const badgeText = rowDone ? (tierNames[t] + ' 集齐') : (tierNames[t] + ' ' + rowCnt + '/5');
      ctx.fillStyle = tierTextColor;
      ctx.font = 'bold 12px ' + APPLE_FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // 文字描边确保在任何背景上都可见
      ctx.strokeStyle = _luminance > 0.6 ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 2;
      ctx.strokeText(badgeText, bdX + bdW / 2, bdY + bdH / 2 + 0.5);
      ctx.fillText(badgeText, bdX + bdW / 2, bdY + bdH / 2 + 0.5);

      // 陀螺区域（下面一行）：5个陀螺占满整个宽度，放大到最大尺寸
      const topY = ry + 28; // 品质标签下面，留4px间距
      const topH = rowH - 32; // 陀螺区域高度（扣除品质标签20px + 上下间距）
      const topCell = Math.min(cell, topH); // 陀螺大小取水平cell和垂直空间的最小值
      const topCyy = topY + topH / 2; // 陀螺垂直居中

      for (let l = 1; l <= 5; l++) {
        const c = this.game.collection.find(x => x.tierIndex === t && x.level === l);
        const ccx = gridStartX + (l - 1) * (cell + gap) + cell / 2;
        const cyy = topCyy; // 陀螺垂直居中
        const unlocked = !!(c && c.unlocked);
        // 已解锁卡片：透明背景 + 细边框，陀螺本体清晰可见，旋转时有动感
        // 未解锁卡片：深灰背景 + 灰色边框 + 锁图标，明显弱化
        if (unlocked) {
          // 透明背景（不填充），只保留细边框，让陀螺本体成为视觉焦点
          ctx.strokeStyle = 'rgba(255,255,255,0.18)';
          ctx.lineWidth = 1;
          this.roundRect(ccx - topCell / 2 + 0.5, cyy - topCell / 2 + 0.5, topCell - 1, topCell - 1, Math.max(6, Math.min(10, topCell / 6)));
          ctx.stroke();
        } else {
          // 未解锁：深灰背景 + 灰色细边框
          ctx.fillStyle = 'rgba(255,255,255,0.025)';
          this.roundRect(ccx - topCell / 2, cyy - topCell / 2, topCell, topCell, Math.max(6, Math.min(10, topCell / 6)));
          ctx.fill();
          ctx.strokeStyle = 'rgba(255,255,255,0.10)';
          ctx.lineWidth = 1;
          this.roundRect(ccx - topCell / 2 + 0.5, cyy - topCell / 2 + 0.5, topCell - 1, topCell - 1, Math.max(6, Math.min(10, topCell / 6)));
          ctx.stroke();
        }
        if (unlocked) {
          // 图鉴格子按 t:l 缓存 Beyblade 实例：原每帧每格 new Beyblade（约30次/帧），且构造随机 angle 致角度抖动；
          // drawBeyblade 仅读 bb（tierIndex/level/angle/radius），从不 mutate → 复用安全，角度稳定。
          const _ck = t + ':' + l;
          const bb = this._codexBbCache[_ck] || (this._codexBbCache[_ck] = new Beyblade(t, l));
          // 平滑自转：每帧按全局时钟刷新角度（相位按 t:l 错开，更生动）；sprite 已烘焙、不重烘焙
          bb.angle = _codexNow * CODEX_SPIN + (t * 5 + l) * 0.5;
          // 陀螺图标在方块容器以内，所有等级尺寸一致（uniformSize）
          // 绘制大小按 radius*2*scale 计算（和对战页面一致），scale和maxSize调整到合适大小
          // maxSize = topCell*0.94 → 陀螺直径占格子的 94%（原 0.88，四边留白 6% 视觉偏空）
          drawBeyblade(ctx, ccx, cyy, bb, Math.max(0.3, topCell / 100), { maxSize: topCell * 0.94, uniformSize: true });
        } else {
          // 图标资产 v3：图鉴未解锁 ? → icon-lock.png（更暗更灰）
          ctx.globalAlpha = 0.4;
          this._drawPngIcon('lock', ccx, cyy, Math.max(18, topCell * 0.45));
          ctx.globalAlpha = 1;
        }
        // 等级数字已在陀螺本体中央显示（beyblade.js sprite），无需额外 Lv 徽章
      }
    }
  }

  // 图鉴阶段奖励：从顶部下移到底部细条（解放顶部、给网格更多呼吸感）。
  // 复用游戏进度数据（codexNextStage / codexStages / codexClaimed），领取逻辑不变（action='codex_claim'）。
  _drawCodexFooter(ctx) {
    if (typeof this.game.codexNextStage !== 'function') return;
    const L = this.layout;
    const W = L.W, H = L.H, SB = L.SB;
    const fh = L.codexFooterH || 52;
    const bandTop = H - SB - fh;          // 底部带顶（网格已让出此空间）
    const bX = 14, bW = W - 28, bH = 34;
    const bY = bandTop + (fh - bH) / 2;

    const cnt = this.game.codexCount();
    const total = this.game.codexTotal();
    const claimed = this.game.codexClaimed || 0;
    const next = this.game.codexNextStage();
    const stages = this.game.codexStages();

    ctx.save();
    if (next) {
      // 有可领阶段：金色可领横幅（底部细条）
      const bg2 = this._grad('codexFtr|' + Math.round(bX) + '|' + Math.round(bY), () => {
        const gg = ctx.createLinearGradient(bX, bY, bX + bW, bY);
        gg.addColorStop(0, 'rgba(255,213,79,0.22)');
        gg.addColorStop(1, 'rgba(255,152,0,0.18)');
        return gg;
      });
      ctx.fillStyle = bg2;
      this.roundRect(bX, bY, bW, bH, bH / 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,213,79,0.7)'; ctx.lineWidth = 1.2;
      this.roundRect(bX + 0.6, bY + 0.6, bW - 1.2, bH - 1.2, bH / 2 - 0.6); ctx.stroke();
      ctx.fillStyle = '#ffd54f';
      ctx.font = 'bold 12px ' + APPLE_FONT;
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText('收集 ' + cnt + '/' + total + ' · 可领「' + next.title + '」大奖', bX + 14, bY + bH / 2 + 0.5);
      // 领取按钮
      const ckW = 60, ckH = 26;
      const ck = { x: bX + bW - ckW - 8, y: bY + (bH - ckH) / 2, w: ckW, h: ckH, action: 'codex_claim' };
      this.drawButton(ck.x, ck.y, ck.w, ck.h, '领取', '#ffb300');
      this.buttons.push(ck);
    } else {
      // 已领完 / 未达：进度提示条
      const doneAll = claimed >= 20;
      ctx.fillStyle = UI.color.ink.faint;
      this.roundRect(bX, bY, bW, bH, bH / 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.14)'; ctx.lineWidth = 1;
      this.roundRect(bX + 0.5, bY + 0.5, bW - 1, bH - 1, bH / 2); ctx.stroke();
      ctx.fillStyle = doneAll ? '#ffd54f' : UI.color.ink.body;
      ctx.font = 'bold 12px ' + APPLE_FONT;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      if (doneAll) {
        ctx.fillText('全图鉴·大师 限定皮肤已解锁', W / 2, bY + bH / 2);
      } else {
        const ns = stages.find(s => s.n > claimed);
        ctx.fillText('已领 ' + claimed + ' 档 · 收集 ' + (ns ? ns.n : total) + '/' + total + ' 解锁「' + (ns ? ns.title : '-') + '」', W / 2, bY + bH / 2);
      }
    }
    ctx.restore();
  }

  _mergeablePair() {
    const s = this.game.platformSlots;
    for (let i = 0; i < 3; i++) {
      for (let j = i + 1; j < 3; j++) {
        if (s[i] && s[j] && s[i].canMergeWith(s[j])) return [i, j];
      }
    }
    return null;
  }

  // =====================================================
  // 控件渲染 · 按钮 / 图标 / Tab
  // =====================================================
  // ①统一文本助手：px 字号 → 字体串（可加粗），对齐设计令牌字号台阶
  _tl(px, weight) { return (weight ? 'bold ' : '') + px + 'px ' + APPLE_FONT; }

  drawButton(x, y, w, h, text, color) {
    const ctx = this.ctx;
    const radius = Math.min(18, h / 2 - 1);
    const sameRect = (a, b) => a && b && Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01 && Math.abs(a.w - b.w) < 0.01 && Math.abs(a.h - b.h) < 0.01;
    const pressed = sameRect(this.pressedBtn && this.pressedBtn.rect, { x, y, w, h });
    const nowT = pressed ? (Date.now() - this.pressedBtn.t0) : 0;
    const pressT = pressed && nowT < 180 ? (1 - Math.pow(1 - nowT / 180, 3)) : (pressed ? 1 : 0);
    const inset = pressT * 1.2;

    ctx.save();
    ctx.translate(x + w / 2, y + h / 2);
    const _ps = 1 - pressT * (1 - UI.motion.pressScale);   // ①按压手感统一（UI.motion.pressScale）
    ctx.scale(_ps, _ps);
    ctx.translate(-(x + w / 2), -(y + h / 2));

    ctx.shadowColor = 'rgba(0,0,0,0.30)';
    // 静止装饰阴影走 shadowScale（iOS/低配关闭），按下反馈走 pressShadow（始终保留手感）
    ctx.shadowBlur = (6 * this.shadowScale) + (pressT * 8 * this.pressShadow);
    ctx.shadowOffsetY = (2 * this.shadowScale) + (pressT * 1.5 * this.pressShadow);

    const g = this._grad('btn|' + color + '|' + Math.round(y) + '|' + Math.round(h) + '|' + Math.round(inset), () => {
      const gg = ctx.createLinearGradient(0, y + inset, 0, y + h - inset);
      gg.addColorStop(0, this._shadeColor(color, 0.18));
      gg.addColorStop(0.5, color);
      gg.addColorStop(1, this._shadeColor(color, -0.18));
      return gg;
    });
    ctx.fillStyle = g;
    this.roundRect(x + inset, y + inset, w - inset * 2, h - inset * 2, radius);
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.strokeStyle = pressed ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.35)';
    ctx.lineWidth = pressed ? 2 : 1;
    this.roundRect(x + inset + 0.5, y + inset + 0.5, w - inset * 2 - 1, h - inset * 2 - 1, radius);
    ctx.stroke();

    ctx.globalAlpha = 0.22;
    ctx.fillStyle = '#ffffff';
    this.roundRect(x + inset + 1.5, y + inset + 1.5, w - inset * 2 - 3, (h - inset * 2) * 0.48, Math.max(4, radius - 1));
    ctx.fill();
    ctx.globalAlpha = 1;

    ctx.fillStyle = '#ffffff';
    const fsize = Math.max(12, Math.min(16, Math.floor(w / 6.5)));
    ctx.font = 'bold ' + fsize + 'px ' + APPLE_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    // 文字阴影属装饰，按住时本就为 0；静止态在无阴影档位（iOS/低配）关闭
    ctx.shadowBlur = (pressed ? 0 : (1.5 * this.shadowScale));
    ctx.shadowOffsetY = (pressed ? 0 : (0.5 * this.shadowScale));
    ctx.fillText(text, x + w / 2, y + h / 2 + 0.5);
    ctx.shadowBlur = 0;
    ctx.restore();
  }

  // 预加载真实 PNG 图标（微信小游戏 wx.createImage / 浏览器 new Image）
  _loadIcons() {
    try {
      const mkImg = (typeof wx !== 'undefined' && wx.createImage) ? wx.createImage : (typeof Image !== 'undefined' ? function () { return new Image(); } : null);
      if (!mkImg) return;
      // base64 内嵌优先（真机 dataURI onload 不可靠 → 改由 utils.prepSrc 写 USER_DATA_PATH 文件再加载）
      let I_B64 = null;
      try { I_B64 = require('./assets').icons; } catch (e) {}

      // ==========================================================
      // 图片按需加载：首屏关键资源优先加载，其余延迟加载
      // 首屏关键图标：金币、签到、音量、能量、合成、图鉴、更多游戏
      // 延迟加载图标：品质图标、道具图标、元素图标等（首屏不需要）
      // ==========================================================
      const CRITICAL_ICONS = ['coin', 'sign', 'mute', 'unmute', 'energy', 'merge', 'codex', 'more', 'back', 'close'];
      const self = this;

      // ==========================================================
      // 资源加载降级方案：
      // 1. 图片加载失败时标记 _failed，最多重试3次
      // 2. 图片加载超时处理（5秒超时）
      // 3. 资源加载状态统计
      // 4. 加载失败时回退到矢量绘制
      // ==========================================================
      const MAX_RETRY = 3; // 最大重试次数
      const LOAD_TIMEOUT = 5000; // 加载超时（毫秒）
      if (!self._loadStats) {
        self._loadStats = { total: 0, loaded: 0, failed: 0, retries: 0 };
      }

      // 加载单个图标（含重试和超时）
      function loadIcon(k, retryCount = 0) {
        if (self.icons[k] && (self.icons[k]._loading || self.icons[k]._ok)) return;
        // 已失败且达到最大重试次数，不再重试
        if (self.icons[k] && self.icons[k]._failed && retryCount >= MAX_RETRY) return;

        self._loadStats.total++;
        const img = mkImg();
        img._loading = true;
        img._retryCount = retryCount;
        let timeoutId = null;

        const cleanup = () => {
          if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
        };

        img.onload = (function (im) {
          return function () {
            cleanup();
            im._ok = true;
            im._loading = false;
            im._failed = false;
            self._loadStats.loaded++;
            if (retryCount > 0) self._loadStats.retries++;
          };
        })(img);

        img.onerror = function () {
          cleanup();
          img._loading = false;
          img._failed = true;
          self._loadStats.failed++;
          // 重试机制：失败后延迟1秒重试
          if (retryCount < MAX_RETRY) {
            console.warn(`[资源加载] ${k} 加载失败，第${retryCount + 1}次重试...`);
            setTimeout(() => {
              self.icons[k] = null; // 清除失败的图片对象
              loadIcon(k, retryCount + 1);
            }, 1000);
          } else {
            console.error(`[资源加载] ${k} 加载失败，已达到最大重试次数(${MAX_RETRY})，回退矢量绘制`);
          }
        };

        // 加载超时处理
        timeoutId = setTimeout(() => {
          if (img._loading && !img._ok) {
            console.warn(`[资源加载] ${k} 加载超时(${LOAD_TIMEOUT}ms)，触发onerror`);
            if (typeof img.abort === 'function') {
              try { img.abort(); } catch (e) {}
            }
            img.onerror(); // 触发错误处理，进入重试逻辑
          }
        }, LOAD_TIMEOUT);

        img.src = _prepSrc(I_B64 && I_B64[k], self._iconFiles[k], 'icons');
        self.icons[k] = img;
      }

      // 首屏关键图标立即加载
      for (const k of CRITICAL_ICONS) {
        if (this._iconFiles[k]) loadIcon(k);
      }

      // 其余图标延迟加载（启动后3秒，空闲时加载）
      const deferredIcons = [];
      for (const k in this._iconFiles) {
        if (CRITICAL_ICONS.indexOf(k) < 0) deferredIcons.push(k);
      }
      if (deferredIcons.length > 0) {
        let idx = 0;
        const loadNext = function () {
          if (idx >= deferredIcons.length) return;
          loadIcon(deferredIcons[idx]);
          idx++;
          // 每100ms加载一个，避免阻塞主线程
          setTimeout(loadNext, 100);
        };
        setTimeout(loadNext, 3000); // 启动后3秒开始延迟加载
      }
    } catch (e) { /* PNG 缺失时回退矢量绘制 */ }
  }

  // 用 PNG 绘制图标（居中，含 padding）；图片未就绪回退矢量
  // 按需加载：如果图标未加载且未在加载中，触发加载（首屏后延迟加载的图标）
  _drawPngIcon(iconType, cx, cy, size) {
    const img = this.icons[iconType];
    if (img && img._ok && img.width > 0) {
      this.ctx.drawImage(img, cx - size / 2, cy - size / 2, size, size);
      return true;
    }
    // 图标未加载：触发加载（如果不在加载中），下一帧应该能显示
    if (!img && this._iconFiles[iconType]) {
      try {
        const mkImg = (typeof wx !== 'undefined' && wx.createImage) ? wx.createImage : (typeof Image !== 'undefined' ? function () { return new Image(); } : null);
        if (mkImg) {
          const newImg = mkImg();
          newImg._loading = true;
          newImg.onload = function () { newImg._ok = true; newImg._loading = false; };
          newImg.onerror = function () { newImg._loading = false; };
          let I_B64 = null;
          try { I_B64 = require('./assets').icons; } catch (e) {}
          // 真机 dataURI onload 不可靠 → 改由 utils.prepSrc 写 USER_DATA_PATH 文件再加载
          newImg.src = _prepSrc(I_B64 && I_B64[iconType], this._iconFiles[iconType], 'icons');
          this.icons[iconType] = newImg;
        }
      } catch (e) {}
    }
    return false;
  }

  drawIconButton(rect, iconType) {
    const ctx = this.ctx;
    // 容器样式和金币模块一致：半透明背景 + 浅色边框 + 大圆角（③3-3 描边统一取 UI.icon，保证全按钮一致）
    const radius = rect.h / 2;
    const sameRect = (a, b) => a && b && Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01 && Math.abs(a.w - b.w) < 0.01 && Math.abs(a.h - b.h) < 0.01;
    const pressed = sameRect(this.pressedBtn && this.pressedBtn.rect, rect);
    const nowT = pressed ? (Date.now() - this.pressedBtn.t0) : 0;
    const pressT = pressed && nowT < 180 ? (1 - Math.pow(1 - nowT / 180, 3)) : (pressed ? 1 : 0);
    ctx.save();
    const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
    ctx.translate(cx, cy);
    ctx.scale(1 - pressT * 0.08, 1 - pressT * 0.08);
    ctx.translate(-cx, -cy);
    ctx.fillStyle = pressed ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.38)';
    ctx.strokeStyle = pressed ? UI.color.ink.body : UI.icon.stroke;   // ③3-3 统一描边（令牌）
    ctx.lineWidth = UI.icon.weight;   // ③3-3 统一描边粗细
    this.roundRect(rect.x, rect.y, rect.w, rect.h, radius); ctx.fill(); ctx.stroke();
    const pad = Math.max(4, rect.h * 0.16);
    const is = Math.min(rect.w, rect.h) - pad * 2;
    if (!this._drawPngIcon(iconType, rect.x + rect.w / 2, rect.y + rect.h / 2, is)) {
      drawVectorIcon(ctx, iconType, rect.x + rect.w / 2, rect.y + rect.h / 2, Math.min(rect.w, rect.h) * 0.72, UI.icon.glyph);
    }
    ctx.restore();
  }

  // =====================================================
  // 模态面板外壳工具（P2 一致性重构）：遮罩/入场/面板底/关闭X 统一抽离
  // —— 消除 8+ 处面板外壳复制粘贴（P2-5），并一并处安全区/按下态/遮罩透明度（P2-1/2/7）
  // =====================================================

  // 面板纵向安全区避让（P2-1）：矮屏不顶到刘海/胶囊，也不超出底部安全区
  _panelCenterY(bh) {
    const h = this.height;
    const topMin = this.safeTop + 8;
    const botMax = h - bh - this.safeBottom - 8;
    let by = (h - bh) / 2;
    by = Math.max(topMin, by);
    // 仅当面板能在安全区内完整放下时才限制底部；
    // 极端矮屏（面板高于可用高度）则保持贴顶，优先避免撞顶部胶囊/状态栏，允许底部溢出。
    if (botMax > topMin) by = Math.min(by, botMax);
    return by;
  }

  // 统一遮罩 + 入场缓动（缩放 0.84→1.0、淡入 0.4→1.0，默认 0.28s 时长），返回 ease/scale。
  // 复用于全部 10 个面板（含连战浮层 P2-6），调用方负责在面板末尾 ctx.restore() 配对。
  beginPanelAnim(t, dur, scaleFrom) {
    const ctx = this.ctx, w = this.width, h = this.height;
    ctx.fillStyle = PANEL_MASK; ctx.fillRect(0, 0, w, h);
    const k = Math.min(1, (t || 0) / (dur || 0.26));
    // ②C1 统一缓动：轻 overshoot（≈3%）的原生 App 弹出感，10 面板共用此缝生效
    const c1 = 1.03, c3 = c1 + 1;
    const ease = 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2);
    const sFrom = scaleFrom != null ? scaleFrom : 0.84;
    const scale = sFrom + (1 - sFrom) * ease;
    ctx.save();
    ctx.globalAlpha = Math.min(1, 0.4 + 0.6 * ease);
    ctx.translate(w / 2, h / 2);
    ctx.scale(scale, scale);
    ctx.translate(-w / 2, -h / 2);
    return { ease, scale };
  }

  // 面板底（玻璃渐变 + 金边 + 顶部高光），颜色可覆盖（出售红 / 连战青）。
  // ── 细节打磨：背景漂浮微粒 ──
  _bgParticles = null;
  _drawBgParticles(dt) {
    if (!this._bgParticles) {
      this._bgParticles = [];
      for (let i = 0; i < 16; i++) {
        this._bgParticles.push({
          rx: Math.random(), ry: Math.random(),
          s: 0.8 + Math.random() * 1.4,
          speed: 0.006 + Math.random() * 0.012,
          a: 0.08 + Math.random() * 0.15,
          tw: Math.random() * Math.PI * 2
        });
      }
    }
    const ctx = this.ctx;
    const now = Date.now() / 1000;
    ctx.save();
    for (const pt of this._bgParticles) {
      pt.ry -= pt.speed * dt;
      if (pt.ry < -0.02) pt.ry = 1.02;
      const tw = 0.5 + 0.5 * Math.sin(now * 1.2 + pt.tw);
      ctx.globalAlpha = pt.a * tw;
      ctx.fillStyle = '#c4b5fd';
      ctx.beginPath();
      ctx.arc(pt.rx * this.width, pt.ry * this.height, pt.s, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // ── 签名动画：合成「出炉」三拍（花叔范式 02 签名物件 · 2026-11-22）──
  // 三拍节奏：①「出炉！」大字砸入（0.1~0.4s）→ ②火花迸溅（0.25s 一次性触发）
  // → ③新旧对比淡入（0.45~1.5s）。只出现在合成完成这一件事上（签名物件纪律）。
  _drawMergeReveal() {
    const mr = this.game.mergeReveal;
    if (!mr || mr.t > 1.5) return;
    const ctx = this.ctx, w = this.width, h = this.height;
    const alpha = mr.t < 0.15 ? mr.t / 0.15 : (mr.t > 1.2 ? Math.max(0, (1.5 - mr.t) / 0.3) : 1);
    const cy = h * 0.42;
    const gap = 100;
    // Beat 2 · 火花迸溅（一次性：出炉瞬间铁砧敲下的火星）
    if (mr.t >= 0.25 && !mr._sparked) {
      mr._sparked = true;
      this.addParticles(w / 2 + gap, cy, '#ffd54f', 18);
      this.addParticles(w / 2 + gap, cy, '#ffffff', 8);
    }
    ctx.save();
    // 半透明底
    ctx.globalAlpha = alpha * 0.55;
    ctx.fillStyle = '#0a0620';
    ctx.fillRect(0, cy - 95, w, 190);
    ctx.globalAlpha = alpha;
    // Beat 1 ·「出炉！」大字砸入（easeOutBack 0.5→1 弹性）
    const _ob = Math.max(0, Math.min(1, (mr.t - 0.1) / 0.3));
    const _c1 = 1.70158;
    const _ease = 1 + (_c1 + 1) * Math.pow(_ob - 1, 3) + _c1 * Math.pow(_ob - 1, 2);
    if (_ob > 0) {
      ctx.save();
      ctx.translate(w / 2, cy - 82);
      ctx.scale(0.5 + 0.5 * _ease, 0.5 + 0.5 * _ease);
      ctx.font = 'bold 30px ' + APPLE_FONT;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 5;
      ctx.strokeStyle = '#4a2c00';
      ctx.strokeText('出炉！', 0, 0);
      ctx.fillStyle = '#ffd54f';
      ctx.shadowColor = '#ffd54f';
      ctx.shadowBlur = this._fxLow ? 0 : 16;
      ctx.fillText('出炉！', 0, 0);
      ctx.restore();
    }
    // Beat 3 · 新旧对比淡入（0.45 起淡入，让出炉先立住）
    const cmpAlpha = Math.max(0, Math.min(1, (mr.t - 0.45) / 0.25)) * alpha;
    ctx.globalAlpha = cmpAlpha;
    // 旧等级（左）+ 新等级（右）
    const oldBb = new Beyblade(mr.tierIndex, Math.max(1, mr.oldLevel));
    const newBb = new Beyblade(mr.tierIndex, mr.newLevel);
    drawBeyblade(ctx, w / 2 - gap, cy, oldBb, 1.3, { uniformSize: true });
    drawBeyblade(ctx, w / 2 + gap, cy, newBb, 1.3, { uniformSize: true });
    // 箭头 + 标签
    ctx.fillStyle = '#ffd54f';
    ctx.font = 'bold 24px ' + APPLE_FONT;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('→', w / 2, cy);
    ctx.font = 'bold 13px ' + APPLE_FONT;
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillText('Lv' + mr.oldLevel, w / 2 - gap, cy + 55);
    ctx.fillStyle = '#ffd54f';
    ctx.fillText('Lv' + mr.newLevel, w / 2 + gap, cy + 55);
    ctx.textBaseline = 'alphabetic';
    ctx.restore();
  }

  drawPanelBody(opts) {
    const ctx = this.ctx;
    const { bx, by, bw, bh, key, bgFrom, bgTo, border } = opts;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 22 * this.shadowScale;
    ctx.shadowOffsetY = 5 * this.shadowScale;
    const pg = this._grad(key + '|' + Math.round(bx) + '|' + Math.round(by) + '|' + Math.round(bh), () => {
      const gg = ctx.createLinearGradient(bx, by, bx, by + bh);
      gg.addColorStop(0, bgFrom || 'rgba(126,87,194,0.98)');
      gg.addColorStop(1, bgTo || 'rgba(49,27,146,0.98)');
      return gg;
    });
    ctx.fillStyle = pg;
    this.roundRect(bx, by, bw, bh, 20); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.restore();
    ctx.strokeStyle = border || '#ffd54f'; ctx.lineWidth = 2;
    this.roundRect(bx + 1, by + 1, bw - 2, bh - 2, 20); ctx.stroke();
    // 细节打磨：面板顶部装饰宝石扣（品质金色菱形扣在边框上）
    // 注：用 path.fill() 而非 fillRect——mock ctx 的 fillRect 追踪不干扰遮罩检测
    { const _gc = bx + bw / 2, _hw = 4;
      ctx.save(); ctx.translate(_gc, by); ctx.rotate(Math.PI / 4);
      ctx.beginPath();
      ctx.moveTo(-_hw, -_hw); ctx.lineTo(_hw, -_hw);
      ctx.lineTo(_hw, _hw); ctx.lineTo(-_hw, _hw);
      ctx.closePath();
      ctx.fillStyle = border || '#ffd54f';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore(); }
    const hl = this._gradFor(ctx, 'btnhl|' + (bx + 12) + '|' + by + '|' + (bx + 12) + '|' + (by + 14), () => {
      const g = ctx.createLinearGradient(bx + 12, by, bx + 12, by + 14);
      g.addColorStop(0, 'rgba(255,255,255,0.5)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      return g;
    });
    ctx.fillStyle = hl;
    this.roundRect(bx + 12, by, bw - 24, 14, 7); ctx.fill();
  }

  // 关闭 X（统一圆形胶囊 + icon-close.png，带按下态，P2-2）：点击率最高的面板控件此前零反馈
  drawCloseX(action, bx, by, bw) {
    const ctx = this.ctx;
    const close = { x: bx + bw - 38, y: by + 18, w: 26, h: 26, action };
    const sameRect = (a, b) => a && b && Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01 && Math.abs(a.w - b.w) < 0.01 && Math.abs(a.h - b.h) < 0.01;
    const pressed = sameRect(this.pressedBtn && this.pressedBtn.rect, close);
    const nowT = pressed ? (Date.now() - this.pressedBtn.t0) : 0;
    const pressT = pressed && nowT < 180 ? (1 - Math.pow(1 - nowT / 180, 3)) : (pressed ? 1 : 0);
    const cx = close.x + close.w / 2, cy = close.y + close.h / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1 - pressT * 0.08, 1 - pressT * 0.08);
    ctx.translate(-cx, -cy);
    ctx.fillStyle = pressed ? 'rgba(255,255,255,0.30)' : 'rgba(255,255,255,0.14)';
    ctx.beginPath(); ctx.arc(cx, cy, close.w / 2, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1.5;
    if (!this._drawPngIcon('close', cx, cy, close.w - 8)) {
      ctx.beginPath();
      ctx.moveTo(close.x + 8, close.y + 8); ctx.lineTo(close.x + 18, close.y + 18);
      ctx.moveTo(close.x + 18, close.y + 8); ctx.lineTo(close.x + 8, close.y + 18);
      ctx.stroke();
    }
    ctx.restore();
    this.modalRects.push(close);
  }

  drawTab(rect, active) {
    const ctx = this.ctx;
    const radius = Math.min(14, rect.h / 2 - 1);
    ctx.shadowColor = active ? 'rgba(255,213,79,0.40)' : 'rgba(0,0,0,0.20)';
    ctx.shadowBlur = (active ? 10 : 3) * this.shadowScale;
    ctx.shadowOffsetY = 1 * this.shadowScale;
    ctx.fillStyle = active ? '#ffd54f' : 'rgba(255,255,255,0.08)';
    ctx.strokeStyle = active ? '#fff3c4' : 'rgba(255,255,255,0.30)';
    ctx.lineWidth = active ? 1.5 : 1;
    this.roundRect(rect.x, rect.y, rect.w, rect.h, radius);
    ctx.fill(); ctx.stroke();
    ctx.shadowBlur = 0;
    // 图标 + 文字（图标在左，保持整体居中）
    const icoColor = active ? '#1a0f33' : '#ffffff';
    ctx.font = 'bold 14px ' + APPLE_FONT;
    const hasIcon = !!rect.icon;
    const iconS = 13, gap = 4;
    const tw = mtW(ctx, rect.name);
    const totalW = (hasIcon ? iconS + gap : 0) + tw;
    const startX = rect.x + rect.w / 2 - totalW / 2;
    if (hasIcon) {
      const icoCx = startX + iconS / 2, icoCy = rect.y + rect.h / 2;
      if (rect.icon === 'merge') {
        // 合成：icon-merge.png（双交叠金色圆环，合并语义）；缺失时回退矢量圆环
        if (!this._drawPngIcon('merge', icoCx, icoCy, iconS + 4)) {
          ctx.strokeStyle = icoColor;
          ctx.lineWidth = 1.8;
          ctx.beginPath(); ctx.arc(icoCx - 3.5, icoCy, 5, 0, Math.PI * 2); ctx.stroke();
          ctx.beginPath(); ctx.arc(icoCx + 3.5, icoCy, 5, 0, Math.PI * 2); ctx.stroke();
        }
      } else if (rect.icon === 'codex') {
        // 图鉴：icon-codex.png（金色小陀螺）；缺失时回退矢量陀螺
        if (!this._drawPngIcon('codex', icoCx, icoCy, iconS + 4)) {
          drawBeyblade(ctx, icoCx, icoCy, this._codexBbCache['0:1'] || (this._codexBbCache['0:1'] = new Beyblade(0, 1)), 0.42);
        }
      }
    }
    ctx.fillStyle = active ? '#1a0f33' : '#ffffff';
    ctx.font = 'bold 14px ' + APPLE_FONT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(rect.name, startX + (hasIcon ? iconS + gap : 0), rect.y + rect.h / 2);
  }

  drawDrag() {
    if (!this.drag) return;
    drawBeyblade(this.ctx, this.drag.x, this.drag.y, this.drag.beyblade, 1.1);
  }

  drawSpintopBattle(dt) {
    const b = this.game.battle;
    if (!b) return;
    b._fxLow = this.shadowScale === 0; // 同步低端档：关闭对战陀螺软光晕
    // 把当前按下的按钮 action 透传给战斗，使结算页自绘按钮也能呈现"按下态"
    b._pressedAction = (this.pressedBtn && this.pressedBtn.rect && this.pressedBtn.rect.action) || null;
    const rects = b.draw(this.ctx);
    if (rects && rects.length) for (let i = 0; i < rects.length; i++) this.buttons.push(rects[i]);
  }

  addFloatText(x, y, text, color = '#ffd54f') {
    this.floatTexts.push({ x, y, text, color, life: 1.0, maxLife: 1.0 });
  }
  drawFloatTexts(dt) {
    const ctx = this.ctx;
    for (let i = this.floatTexts.length - 1; i >= 0; i--) {
      const f = this.floatTexts[i];
      if (!this._debugFreezeFx) { f.life -= dt; f.y -= dt * UI.motion.floatRise; }   // ②2-1 飘字节奏统一
      if (f.life <= 0) { this.floatTexts.splice(i, 1); continue; }
      ctx.globalAlpha = Math.max(0, f.life / f.maxLife);
      ctx.fillStyle = f.color;
      ctx.font = 'bold 16px ' + APPLE_FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(f.text, f.x, f.y);
    }
    ctx.globalAlpha = 1;
  }

  /**
   * 首程直达轻引导（2026-09-04）：呼吸光圈 + 按钮上方短文案。
   * 与旧 drawTutorial（全屏遮罩+引导卡）完全不同——不打断、不挡操作、不弹窗。
   * 仅主页且 obStep>0 时绘制；obDone 后永远不画。
   */
  _drawObGlow() {
    const g = this.game;
    if (!g || g.obDone || !g.obStep || g.mode !== 'main') return;
    if (g.view !== 'main' && g.view !== 'home') return; // 图鉴等子视图不画
    const target = g.obStep === 1 ? this.drawBtnRect : this.battleBtnRect;
    if (!target) return;
    const ctx = this.ctx;
    const t = Date.now() / 600;
    const pulse = 0.5 + 0.5 * Math.sin(t * Math.PI * 2);
    // 呼吸光圈 + 外扩扩散环（画法沿用旧 drawTutorial 的目标高亮，去掉遮罩与卡片）
    ctx.strokeStyle = '#ffd54f';
    ctx.globalAlpha = 0.55 + 0.4 * pulse;
    ctx.lineWidth = 2.5;
    const ex = 6 + pulse * 3;
    this.roundRect(target.x - ex, target.y - ex, target.w + ex * 2, target.h + ex * 2, Math.min(16, target.h / 2 + ex));
    ctx.stroke();
    ctx.globalAlpha = Math.max(0, 0.5 - pulse * 0.5);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(target.x + target.w / 2, target.y + target.h / 2, 10 + pulse * 26, 0, Math.PI * 2);
    ctx.stroke();
    // 按钮上方短文案（脉动浮现，不遮按钮）
    ctx.globalAlpha = 0.65 + 0.35 * pulse;
    ctx.fillStyle = '#ffd54f';
    ctx.font = 'bold 13px ' + APPLE_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(g.obStep === 1 ? '先抽一只陀螺 ↓' : '陀螺到手，去对战！', target.x + target.w / 2, target.y - ex - 4);
    ctx.globalAlpha = 1;
  }

  drawTutorial() {
    if (this.game.tutorialDone) return;
    const ctx = this.ctx;
    const w = this.width, h = this.height;
    const step = Math.min(this.game.tutorialStep, 2);
    const t = Date.now() / 600;

    // 半透明遮罩（P2-7：统一 PANEL_MASK，与全部模态面板一致）
    ctx.fillStyle = PANEL_MASK;
    ctx.fillRect(0, 0, w, h);

    // ---- 目标按钮：呼吸光圈 + 外扩扩散环 ----
    const target = step === 0 ? this.drawBtnRect : (step === 1 ? this.mergeBtnRect : this.battleBtnRect);
    if (target) {
      const cx = target.x + target.w / 2, cy = target.y + target.h / 2;
      const pulse = 0.5 + 0.5 * Math.sin(t * Math.PI * 2);
      ctx.strokeStyle = '#ffd54f';
      ctx.globalAlpha = 0.55 + 0.4 * pulse;
      ctx.lineWidth = 2.5;
      const ex = 6 + pulse * 3;
      this.roundRect(target.x - ex, target.y - ex, target.w + ex * 2, target.h + ex * 2, Math.min(16, target.h / 2 + ex));
      ctx.stroke();
      ctx.globalAlpha = Math.max(0, 0.5 - pulse * 0.5);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(cx, cy, 10 + pulse * 26, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // ---- 苹果风引导卡（玻璃半透明 + 金边 + 顶部高亮白）----
    const bw = Math.min(320, w - 32);
    const bh = 152;
    const bx = (w - bw) / 2;
    const by = Math.max(this.safeTop + 8, h * 0.24);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.4)';
    ctx.shadowBlur = 18 * this.shadowScale;
    ctx.shadowOffsetY = 4 * this.shadowScale;
    const bg = this._grad('tut|' + Math.round(bx) + '|' + Math.round(by) + '|' + Math.round(bh), () => {
      const gg = ctx.createLinearGradient(bx, by, bx, by + bh);
      gg.addColorStop(0, UI.color.ink.line);
      gg.addColorStop(1, UI.color.ink.faint);
      return gg;
    });
    ctx.fillStyle = bg;
    this.roundRect(bx, by, bw, bh, 18); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,213,79,0.9)';
    ctx.lineWidth = 1.5;
    this.roundRect(bx + 0.75, by + 0.75, bw - 1.5, bh - 1.5, 18); ctx.stroke();
    const hl = this._grad('tuthl|' + Math.round(bx), () => {
      const gg = ctx.createLinearGradient(bx + 10, by, bx + 10, by + 12);
      gg.addColorStop(0, UI.color.ink.body);
      gg.addColorStop(1, 'rgba(255,255,255,0)');
      return gg;
    });
    ctx.fillStyle = hl;
    this.roundRect(bx + 10, by, bw - 20, 12, 6); ctx.fill();

    // ---- 步骤图标（① ② ③ 金色圆徽）----
    const icoR = 14;
    const icoX = bx + 26, icoY = by + 36;
    ctx.fillStyle = '#ffd54f';
    ctx.beginPath(); ctx.arc(icoX, icoY, icoR, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#3a1d5e';
    ctx.font = 'bold 15px ' + APPLE_FONT;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(step + 1), icoX, icoY + 1);

    // ---- 标题 + 两行说明 ----
    const titles = ['抽卡得陀螺', '合成升级', '开始对战'];
    const tips = [
      '点右下「抽卡」消耗能量\n获得陀螺，集齐图鉴',
      '把相同陀螺拖进合成台\n点「合成」升级更高等级',
      '点「对战」用陀螺挑战对手\n赢取金币，冲击连胜'
    ];
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 17px ' + APPLE_FONT;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(titles[step], icoX + icoR + 12, icoY);
    ctx.font = '13px ' + APPLE_FONT;
    ctx.fillStyle = UI.color.ink.bright;
    const lines = tips[step].split('\n');
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], bx + 24, by + 66 + i * 20);
    }

    // ---- 跳过按钮（右上角，可点击跳过引导）----
    const skipW = 56, skipH = 28;
    const skip = { x: bx + bw - skipW - 10, y: by + 10, w: skipW, h: skipH, action: 'tutorial_skip' };
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    this.roundRect(skip.x, skip.y, skip.w, skip.h, 14); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 1;
    this.roundRect(skip.x + 0.5, skip.y + 0.5, skip.w - 1, skip.h - 1, 14); ctx.stroke();
    ctx.fillStyle = UI.color.ink.bright;
    ctx.font = '12px ' + APPLE_FONT;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('跳过', skip.x + skip.w / 2, skip.y + skip.h / 2 + 1);
    this.modalRects.push(skip);

    // ---- 指向目标的手势三角箭头（呼吸下落）----
    const ay = by + bh + 12 + Math.sin(t * Math.PI * 2) * 5;
    ctx.fillStyle = '#ffd54f';
    ctx.globalAlpha = 0.72 + 0.28 * Math.sin(t * Math.PI * 2);
    ctx.beginPath();
    ctx.moveTo(w / 2, ay + 12);
    ctx.lineTo(w / 2 - 9, ay - 4);
    ctx.lineTo(w / 2 + 9, ay - 4);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;

    // ---- 步骤进度点 ----
    const dotsY = by + bh - 16;
    for (let i = 0; i < 3; i++) {
      const dx = w / 2 + (i - 1) * 16;
      ctx.beginPath();
      ctx.arc(dx, dotsY, i === step ? 4 : 3, 0, Math.PI * 2);
      ctx.fillStyle = i === step ? '#ffd54f' : 'rgba(255,255,255,0.3)';
      ctx.fill();
    }
  }

  /** 抽卡仪式感动画：卡牌翻开 → 品质光束 → 陀螺展示 → 收入背包 */
  drawDrawCard() {
    const ctx = this.ctx, w = this.width, h = this.height;
    const dc = this.game.drawCard;
    if (!dc) return;
    const bb = dc.bb;
    const tier = bb.tier;
    const t = dc.t;
    const isLegend = bb.tierIndex >= 4;

    ctx.fillStyle = PANEL_MASK;
    ctx.fillRect(0, 0, w, h);

    // 传说：金色放射光束（t>=0.35 开始，持续扩散）
    // 性能：原本每帧建 12 个渐变（出货瞬间最卡）。改为整体旋转画布 t*0.6，
    // 使 12 条光束角度变为常量 (i*2π/n)，渐变按索引 i 走 _grad 缓存，首帧后零分配。
    if (isLegend && t >= 0.35) {
      ctx.save();
      ctx.translate(w / 2, h * 0.42);
      ctx.rotate(t * 0.6);
      const n = 12, rr = Math.min(w, h) * 0.45;
      for (let i = 0; i < n; i++) {
        const a = (Math.PI * 2 / n) * i;
        const grd = this._grad('legendBeam_' + i, () => {
          const g = ctx.createLinearGradient(0, 0, Math.cos(a) * rr, Math.sin(a) * rr);
          g.addColorStop(0, 'rgba(255,213,79,0)');
          g.addColorStop(0.7, 'rgba(255,213,79,0.35)');
          g.addColorStop(1, 'rgba(255,213,79,0)');
          return g;
        });
        ctx.strokeStyle = grd;
        ctx.lineWidth = 22;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
        ctx.stroke();
      }
      ctx.restore();
    }

    const cw = Math.min(230, w - 60), ch = Math.min(300, h * 0.52);
    const cx = w / 2, cy = h * 0.42;

    // 翻转进度：0-0.35 收窄（卡背），0.35-0.7 展开（卡面）
    let sx = 1, face = false;
    if (t < 0.35) {
      sx = 1 - (t / 0.35) * 0.85;
    } else if (t < 0.7) {
      sx = 0.15 + ((t - 0.35) / 0.35) * 0.85;
      face = true;
    } else {
      sx = 1;
      face = true;
    }
    const revealDone = t >= 0.7;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(Math.max(0.06, sx), 1);

    const g = this._grad('card|' + Math.round(ch) + '|' + (isLegend ? 1 : 0), () => {
      const gg = ctx.createLinearGradient(0, -ch / 2, 0, ch / 2);
      gg.addColorStop(0, isLegend ? '#5b3a1a' : '#4a2e82');
      gg.addColorStop(1, '#1f1233');
      return gg;
    });
    ctx.fillStyle = g;
    this.roundRect(-cw / 2, -ch / 2, cw, ch, 18); ctx.fill();
    ctx.strokeStyle = face ? tier.color : '#9575cd';
    ctx.lineWidth = face ? 3 : 2;
    if (face) {
      // 出货后品质色外发光呼吸（稀有以上更有"出货"质感）
      ctx.shadowColor = tier.color;
      ctx.shadowBlur = (12 + 6 * Math.sin(Date.now() / 180)) * this.shadowScale;
    }
    this.roundRect(-cw / 2 + 1, -ch / 2 + 1, cw - 2, ch - 2, 18); ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (!face) {
      // 卡背
      ctx.fillStyle = '#ffd54f';
      ctx.font = 'bold 30px ' + APPLE_FONT;
      // 图标资产 v3：卡背星芒 ✦ → icon-sparkle.png
      this._drawPngIcon('sparkle', 0, -22, 34);
      ctx.fillStyle = UI.color.ink.bright;
      ctx.font = 'bold 18px ' + APPLE_FONT;
      ctx.fillText('陀螺抽卡', 0, 28);
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.font = '12px ' + APPLE_FONT;
      ctx.fillText('即将揭晓…', 0, 56);
    } else {
      // 卡面：旋转陀螺 + 品质 + Lv
      ctx.save();
      ctx.rotate(t * 3);
      drawBeyblade(ctx, 0, -ch * 0.20, bb, Math.min(1.7, cw / 110));
      ctx.restore();
      ctx.fillStyle = tier.color;
      ctx.font = 'bold 20px ' + APPLE_FONT;
      if (isLegend) {
        // 图标资产 v3：★ 白虎陀螺 ★ → icon-star.png 两侧徽章
        const lTxt = '白虎陀螺';
        const lTw = mtW(ctx, lTxt);
        ctx.fillText(lTxt, 0, ch * 0.30);
        this._drawPngIcon('star', -lTw / 2 - 17, ch * 0.30, 15);
        this._drawPngIcon('star', lTw / 2 + 17, ch * 0.30, 15);
      } else {
        ctx.fillText(tier.name + '陀螺', 0, ch * 0.30);
      }
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 13px ' + APPLE_FONT;
      ctx.fillText('Lv' + bb.level + ' · 战力 ' + bb.power, 0, ch * 0.30 + 26);
    }
    ctx.restore();

    // 出货光效：reveal 瞬间品质色爆闪环 + 星尘粒子（仅触发一次）
    if (revealDone && !dc._fxDone) {
      dc._fxDone = true;
      this.addRing(cx, cy, tier.color);
      this.addParticles(cx, cy - 16, tier.color, isLegend ? 38 : 24);
      this.addParticles(cx, cy, '#ffffff', isLegend ? 16 : 9);
      if (isLegend) {
        // 传说专属：全屏金色粒子雨（多点爆开模拟金色星尘雨）+ 震屏
        for (let i = 0; i < 9; i++) {
          this.addParticles(Math.random() * w, Math.random() * h * 0.4, (i % 2) ? '#ffd54f' : '#ffb300', 6);
        }
        this.addRing(cx, cy, '#ffd54f');
        this.addParticles(cx, cy - 44, '#ffd54f', 28);
        this.shake(10, 0.5);
      }
    }

    // 确认按钮（翻转完成后出现）
    if (revealDone) {
      const btnW = 180, btnH = 44;
      const closeY = cy + ch / 2 + 34;
      const btn = { x: cx - btnW / 2, y: closeY, w: btnW, h: btnH, action: 'draw_close' };
      this.drawButton(btn.x, btn.y, btn.w, btn.h, '收入背包', isLegend ? '#ff9800' : '#2196f3');
      this.modalRects.push(btn);
      // 抽卡激励广告（draw3/6/9/rand 命中时）改为「收卡即自动弹激励视频」（隐藏式、无按钮），见 main.js _dismissDrawCard。
    }
  }

  // 出售二次确认弹窗（防止误触出售陀螺）
  drawSellConfirm() {
    const ctx = this.ctx, w = this.width, h = this.height;
    const sc = this.game.sellConfirm;
    if (!sc) return;
    this.beginPanelAnim(this.game.sellT || 0, 0.2, 0.85);
    const bw = Math.min(300, w - 60), bh = 260;
    const bx = (w - bw) / 2, by = this._panelCenterY(bh);
    this.drawPanelBody({ bx, by, bw, bh, key: 'sellC', bgFrom: 'rgba(74,20,40,0.98)', bgTo: 'rgba(40,10,30,0.98)' });

    // 标题
    ctx.fillStyle = '#ff8a80';
    ctx.font = 'bold 20px ' + APPLE_FONT;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('确认出售', w / 2, by + 36);
    // 警告副标题
    ctx.fillStyle = UI.color.ink.body;
    ctx.font = '12px ' + APPLE_FONT;
    ctx.fillText('出售后陀螺将消失，无法恢复', w / 2, by + 58);

    // 陀螺预览
    const bb = sc.beyblade;
    const topY = by + 100;
    drawBeyblade(ctx, w / 2, topY, bb, 0.9);
    // 陀螺品质名
    ctx.fillStyle = bb.tier.color;
    ctx.font = 'bold 13px ' + APPLE_FONT;
    ctx.fillText(bb.tier.name + ' Lv.' + bb.level, w / 2, topY + 42);

    // 出售金币
    ctx.fillStyle = '#ffd54f';
    ctx.font = 'bold 16px ' + APPLE_FONT;
    if (!this._drawPngIcon('coin', w / 2 - 30, by + bh - 68, 16)) {
      drawVectorIcon(ctx, 'coin', w / 2 - 30, by + bh - 68, 16, '#ffd54f');
    }
    ctx.fillText('+' + sc.gain + ' 金币', w / 2 + 10, by + bh - 68);

    // 按钮：取消 / 确认出售
    const btnW = (bw - 48) / 2, btnH = 40;
    const btnY = by + bh - 52;
    const cancelBtn = { x: bx + 16, y: btnY, w: btnW, h: btnH, action: 'sell_cancel' };
    const confirmBtn = { x: bx + bw - 16 - btnW, y: btnY, w: btnW, h: btnH, action: 'sell_confirm' };
    this.drawButton(cancelBtn.x, cancelBtn.y, cancelBtn.w, cancelBtn.h, '取消', '#757575');
    this.drawButton(confirmBtn.x, confirmBtn.y, confirmBtn.w, confirmBtn.h, '确认出售', '#e53935');
    this.modalRects.push(cancelBtn, confirmBtn);
    ctx.restore();
  }

  drawSignin() {
    const ctx = this.ctx, w = this.width, h = this.height;
    this.beginPanelAnim(this.game.signT || 0);
    const bw = Math.min(340, w - 40), bh = 372;
    const bx = (w - bw) / 2, by = this._panelCenterY(bh);

    this.drawPanelBody({ bx, by, bw, bh, key: 'sign' });
    this.drawCloseX('sign_close', bx, by, bw);

    // 标题 + 连续天数
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 20px ' + APPLE_FONT;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('每日签到', w / 2, by + 34);
    ctx.fillStyle = this.game.signBonus ? '#ffd54f' : 'rgba(255,213,79,0.9)';
    ctx.font = 'bold 13px ' + APPLE_FONT;
    // 签到升级版（play-design v1）：连续满 7 天进入双倍日
    // 图标资产 v3：双倍日尾部 ★ → icon-star.png
    const streakTxt = '连续 ' + (this.game.signStreak || 0) + ' 天' + (this.game.signBonus ? ' · 双倍日进行中' : ' · 七日循环');
    ctx.fillText(streakTxt, w / 2, by + 58);
    if (this.game.signBonus) {
      const stw = mtW(ctx, streakTxt);
      this._drawPngIcon('star', w / 2 + stw / 2 + 10, by + 58, 11);
    }

    // 7 天奖励格子（4 + 3 排）
    const cellW = 60, cellH = 62, gap = 8;
    const rowY0 = by + 84, rowY1 = by + 150;
    const positions = [];
    for (let d = 1; d <= 7; d++) {
      const idx = d - 1, col = idx % 4, row = Math.floor(idx / 4);
      const count = row === 0 ? 4 : 3;
      const rowW = count * cellW + (count - 1) * gap;
      const rowX = (w - rowW) / 2;
      positions.push({ x: rowX + col * (cellW + gap), y: row === 0 ? rowY0 : rowY1 });
    }
    const todayDay = (this.game.signDay % 7) + 1;
    const claimed = this.game.signClaimed;
    const t = Date.now() / 300;
    for (let d = 1; d <= 7; d++) {
      const p = positions[d - 1];
      const r = SIGN_REWARDS[d - 1];
      const signed = d <= this.game.signDay;
      const isToday = !claimed && d === todayDay;
      const isLegend = d === 7;

      // 底：大奖金色渐变 / 今日呼吸 / 已签微金 / 默认
      if (isLegend) {
        const lg = this._grad('signl|' + Math.round(p.x) + '|' + Math.round(p.y) + '|' + Math.round(cellH), () => {
          const gg = ctx.createLinearGradient(p.x, p.y, p.x, p.y + cellH);
          gg.addColorStop(0, 'rgba(255,193,7,0.42)');
          gg.addColorStop(1, 'rgba(255,152,0,0.18)');
          return gg;
        });
        ctx.fillStyle = lg;
      } else if (signed) {
        ctx.fillStyle = 'rgba(255,213,79,0.16)';
      } else if (isToday) {
        ctx.fillStyle = 'rgba(255,213,79,0.22)';
      } else {
        ctx.fillStyle = UI.color.ink.faint;
      }
      this.roundRect(p.x, p.y, cellW, cellH, 12); ctx.fill();

      // 边：今日金色呼吸环
      ctx.lineWidth = isToday ? 2.5 : 1.5;
      if (isToday) {
        ctx.strokeStyle = '#ffd54f';
        ctx.globalAlpha = 0.7 + 0.3 * Math.sin(t * Math.PI * 2);
      } else {
        ctx.strokeStyle = isLegend ? '#ffb300' : (signed ? '#ffd54f' : 'rgba(255,255,255,0.22)');
        ctx.globalAlpha = 1;
      }
      this.roundRect(p.x + 0.75, p.y + 0.75, cellW - 1.5, cellH - 1.5, 12); ctx.stroke();
      ctx.globalAlpha = 1;

      // 第N天 + 奖励
      ctx.fillStyle = '#fff'; ctx.font = 'bold 12px ' + APPLE_FONT;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('第' + d + '天', p.x + cellW / 2, p.y + 14);
      ctx.fillStyle = '#ffd54f'; ctx.font = 'bold 12px ' + APPLE_FONT;
      const rewardType = r.beyblade ? 'beyblade' : (r.freeDraw ? 'freeDraw' : (r.coins ? 'coin' : 'bolt'));
      const rewardVal = r.beyblade ? '' : (r.freeDraw ? '抽卡×' + r.freeDraw : (r.coins ? '+' + r.coins : '+' + r.energy));
      if (rewardType === 'beyblade') {
        ctx.fillText('白虎陀螺', p.x + cellW / 2, p.y + 34);
        // 签到升级版：第 7 天大奖附白虎保底券
        ctx.fillStyle = 'rgba(255,213,79,0.9)';
        ctx.font = 'bold 8px ' + APPLE_FONT;
        ctx.fillText('保底券', p.x + cellW / 2, p.y + 56);
        ctx.fillStyle = '#ffd54f';
      } else if (rewardType === 'freeDraw') {
        // 免费抽卡券格（第2/4/6天 · D1 留客钩子）：券形图标 + 「抽卡×N」
        const icoS = 13;
        const icoX = p.x + cellW / 2 - (icoS + mtW(ctx, rewardVal)) / 2;
        if (!this._drawPngIcon('drawcard', icoX + icoS / 2, p.y + 34, icoS)) {
          drawVectorIcon(ctx, 'coin', icoX + icoS / 2, p.y + 34, icoS, '#ffd54f');
        }
        ctx.textAlign = 'left';
        ctx.fillText(rewardVal, icoX + icoS + 2, p.y + 34);
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(255,213,79,0.9)';
        ctx.font = 'bold 8px ' + APPLE_FONT;
        ctx.fillText('免费券', p.x + cellW / 2, p.y + 56);
        ctx.fillStyle = '#ffd54f';
      } else {
        const icoS = 12;
        const icoX = p.x + cellW / 2 - (icoS + mtW(ctx, rewardVal)) / 2;
        // 奖励图标：coin→金币 PNG / bolt→能量 PNG
        const rwKey = rewardType === 'bolt' ? 'energy' : 'coin';
        if (!this._drawPngIcon(rwKey, icoX + icoS / 2, p.y + 34, icoS)) {
          drawVectorIcon(ctx, rewardType, icoX + icoS / 2, p.y + 34, icoS, '#ffd54f');
        }
        ctx.textAlign = 'left';
        ctx.fillText(rewardVal, icoX + icoS + 2, p.y + 34);
        ctx.textAlign = 'center';
      }
      // 状态：已签 ✓ / 今日可领 / 未解锁 / 大奖角标
      if (isLegend) {
        ctx.fillStyle = '#ffd54f'; ctx.font = 'bold 12px ' + APPLE_FONT;
        // 图标资产 v3：★大奖 → icon-star + 大奖
        ctx.fillText('大奖', p.x + cellW / 2 + 8, p.y + 50);
        this._drawPngIcon('star', p.x + cellW / 2 - 15, p.y + 50, 13);
      } else if (signed) {
        if (!this._drawPngIcon('check', p.x + cellW / 2, p.y + 50, 14)) drawVectorIcon(ctx, 'check', p.x + cellW / 2, p.y + 50, 14, '#00e676');
      }
      else if (isToday) { ctx.fillStyle = '#ffd54f'; ctx.font = '12px ' + APPLE_FONT; ctx.fillText('可领', p.x + cellW / 2, p.y + 50); }
      else { ctx.fillStyle = 'rgba(255,255,255,0.40)'; ctx.font = '12px ' + APPLE_FONT; ctx.fillText('未解锁', p.x + cellW / 2, p.y + 50); }
    }

    // 明日预告行
    const tomorrowDay = (todayDay % 7) + 1;
    const tr = SIGN_REWARDS[tomorrowDay - 1];
    const prevY = by + 224, prevH = 30;
    ctx.fillStyle = UI.color.ink.faint;
    this.roundRect(bx + 16, prevY, bw - 32, prevH, 15); ctx.fill();
    ctx.strokeStyle = 'rgba(255,213,79,0.35)'; ctx.lineWidth = 1;
    this.roundRect(bx + 16.5, prevY + 0.5, bw - 33, prevH - 1, 15); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = '12px ' + APPLE_FONT;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText('明日 · 第' + tomorrowDay + '天', bx + 30, prevY + prevH / 2);
    ctx.fillStyle = '#ffd54f'; ctx.font = 'bold 12px ' + APPLE_FONT;
    ctx.textAlign = 'right';
    // 图标资产 v3：★ 白虎陀螺+保底券 → 去 ★ 前缀，文本前补 icon-star
    const previewTxt = tr.beyblade ? '白虎陀螺+保底券'
      : (tr.freeDraw ? '免费抽卡券 ×' + tr.freeDraw + (tr.energy ? ' +能量' + tr.energy : '')
        : (tr.coins ? '+' + tr.coins + ' 金币' : '+' + tr.energy + ' 能量'));
    ctx.fillText(previewTxt, bx + bw - 30, prevY + prevH / 2);
    if (tr.beyblade) {
      const ptw = mtW(ctx, previewTxt);
      this._drawPngIcon('star', bx + bw - 30 - ptw - 15, prevY + prevH / 2, 12);
    }

    // 断签补签按钮（签到升级版：看广告补签，保持连续签到）
    const canMakeup = (typeof this.game.canMakeupSign === 'function') && this.game.canMakeupSign();
    if (canMakeup) {
      const mkW = 92, mkH = 26;
      const mkRect = { x: (w - mkW) / 2, y: prevY + prevH + 8, w: mkW, h: mkH, action: 'sign_makeup' };
      this.drawButton(mkRect.x, mkRect.y, mkRect.w, mkRect.h, '补签昨天', '#9575cd');
      this.modalRects.push(mkRect);
    }

    // 领取按钮
    const btnW = 150, btnH = 42;
    const btnRect = { x: (w - btnW) / 2, y: by + bh - 54, w: btnW, h: btnH, action: claimed ? 'sign_close' : 'sign_claim' };
    this.drawButton(btnRect.x, btnRect.y, btnRect.w, btnRect.h, claimed ? '今日已领取' : '领取奖励', claimed ? '#7e57c2' : '#ffb300');
    this.modalRects.push(btnRect);
    ctx.restore();
  }

  // =====================================================
  // 每日挑战面板（play-design v1）：3 个日常任务 + 活跃度 + 当日宝箱
  // =====================================================
  drawDailyPanel() {
    const ctx = this.ctx, w = this.width, h = this.height;
    if (typeof this.game._checkDailyReset === 'function') this.game._checkDailyReset();
    const meta = this.game.dailyTasksMeta();
    const active = Math.max(0, Math.min(100, this.game.dailyActive || 0));
    const chestClaimed = !!this.game.dailyChestClaimed;
    const chestReady = active >= 100 && !chestClaimed;

    this.beginPanelAnim(this.game.dailyT || 0);
    const bw = Math.min(340, w - 40), bh = 430;
    const bx = (w - bw) / 2, by = this._panelCenterY(bh);

    this.drawPanelBody({ bx, by, bw, bh, key: 'daily' });
    this.drawCloseX('daily_close', bx, by, bw);

    // 标题 + 副标题
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 20px ' + APPLE_FONT;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('每日挑战', w / 2, by + 34);
    ctx.fillStyle = 'rgba(209,196,233,0.92)';
    ctx.font = '12px ' + APPLE_FONT;
    ctx.fillText('对战 3 局 · 合成 3 次 · 抽卡 3 次', w / 2, by + 58);

    // 3 个任务行
    const rowX = bx + 16, rowW = bw - 32, rowH = 50, rowGap = 9;
    let ry = by + 76;
    for (let i = 0; i < meta.length; i++) {
      const m = meta[i];
      const done = m.cur >= m.goal;
      // 行底
      ctx.fillStyle = done ? 'rgba(255,213,79,0.12)' : UI.color.ink.faint;
      this.roundRect(rowX, ry, rowW, rowH, 12); ctx.fill();
      ctx.strokeStyle = done ? 'rgba(255,213,79,0.5)' : UI.color.ink.line;
      ctx.lineWidth = 1;
      this.roundRect(rowX + 0.5, ry + 0.5, rowW - 1, rowH - 1, 12); ctx.stroke();
      // 图标
      if (!this._drawPngIcon(m.icon, rowX + 24, ry + rowH / 2, 27)) {
        drawVectorIcon(ctx, m.key === 'battle' ? 'clash' : (m.key === 'merge' ? 'merge' : 'draw'), rowX + 24, ry + rowH / 2, 22, '#ffd54f');
      }
      // 名称
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 13px ' + APPLE_FONT;
      ctx.textAlign = 'left';
      ctx.fillText(m.name + ' 任务', rowX + 44, ry + rowH / 2 - 8);
      // 进度条
      const barW = rowW - 44 - 78, barX = rowX + 44, barY = ry + rowH / 2 + 6;
      const barH = 6;
      ctx.fillStyle = 'rgba(255,255,255,0.14)';
      this.roundRect(barX, barY, barW, barH, barH / 2); ctx.fill();
      const p = Math.min(1, m.cur / m.goal);
      if (p > 0) {
        const bg2 = this._grad('dbar|' + i + '|' + Math.round(barX), () => {
          const gg = ctx.createLinearGradient(barX, barY, barX + barW, barY);
          gg.addColorStop(0, '#ffd54f');
          gg.addColorStop(1, '#ff9800');
          return gg;
        });
        ctx.fillStyle = bg2;
        this.roundRect(barX, barY, Math.max(6, barW * p), barH, barH / 2); ctx.fill();
      }
      ctx.fillStyle = done ? '#ffd54f' : 'rgba(255,255,255,0.75)';
      ctx.font = 'bold 12px ' + APPLE_FONT;
      ctx.fillText(m.cur + '/' + m.goal, barX + barW + 6, ry + rowH / 2 + 6);
      // 完成态 / 活跃度标签（右侧）
      if (done) {
        if (!this._drawPngIcon('check', rowX + rowW - 22, ry + rowH / 2, 18)) drawVectorIcon(ctx, 'check', rowX + rowW - 22, ry + rowH / 2, 18, '#00e676');
      } else {
        ctx.fillStyle = '#ffd54f';
        ctx.font = 'bold 12px ' + APPLE_FONT;
        ctx.textAlign = 'right';
        ctx.fillText('+' + m.active + ' 活跃', rowX + rowW - 12, ry + rowH / 2);
        ctx.textAlign = 'left';
      }
      ry += rowH + rowGap;
    }

    // 活跃度区
    const ay = ry + 2;
    ctx.fillStyle = UI.color.ink.faint;
    this.roundRect(rowX, ay, rowW, 56, 12); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 12px ' + APPLE_FONT;
    ctx.textAlign = 'left';
    ctx.fillText('今日活跃', rowX + 16, ay + 18);
    ctx.fillStyle = '#ffd54f';
    ctx.textAlign = 'right';
    ctx.fillText(active + ' / 100', rowX + rowW - 16, ay + 18);
    // 活跃度进度条
    const aBarX = rowX + 16, aBarW = rowW - 32, aBarY = ay + 32, aBarH = 10;
    ctx.fillStyle = UI.color.ink.line;
    this.roundRect(aBarX, aBarY, aBarW, aBarH, aBarH / 2); ctx.fill();
    if (active > 0) {
      const ag = this._grad('dact|' + Math.round(aBarX), () => {
        const gg = ctx.createLinearGradient(aBarX, aBarY, aBarX + aBarW, aBarY);
        gg.addColorStop(0, '#ffd54f');
        gg.addColorStop(1, '#ff9100');
        return gg;
      });
      ctx.fillStyle = ag;
      this.roundRect(aBarX, aBarY, Math.max(10, aBarW * active / 100), aBarH, aBarH / 2); ctx.fill();
    }
    ctx.strokeStyle = 'rgba(255,213,79,0.4)'; ctx.lineWidth = 1;
    this.roundRect(aBarX + 0.5, aBarY + 0.5, aBarW - 1, aBarH - 1, aBarH / 2); ctx.stroke();

    // 当日宝箱
    const chestY = ay + 68;
    ctx.fillStyle = UI.color.ink.faint;
    this.roundRect(rowX, chestY, rowW, 62, 12); ctx.fill();
    ctx.strokeStyle = chestReady ? 'rgba(255,213,79,0.7)' : UI.color.ink.line;
    ctx.lineWidth = 1.5;
    this.roundRect(rowX + 0.75, chestY + 0.75, rowW - 1.5, 62 - 1.5, 12); ctx.stroke();
    // 宝箱图标
    const chestIco = 40;
    if (!this._drawPngIcon('chest', rowX + 34, chestY + 31, chestIco)) drawVectorIcon(ctx, 'chest', rowX + 34, chestY + 31, 30, chestReady ? '#ffd54f' : '#9e9e9e');
    // 状态文字
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 12px ' + APPLE_FONT;
    ctx.textAlign = 'left';
    ctx.fillText(chestClaimed ? '今日宝箱已领取' : (chestReady ? '宝箱可开启！' : '活跃满 100 开启当日宝箱'), rowX + 62, chestY + 20);
    ctx.fillStyle = UI.color.ink.body;
    ctx.font = '12px ' + APPLE_FONT;
    ctx.fillText(chestClaimed ? '明日 5:00 刷新' : '随机 金币 / 能量 / 稀有陀螺', rowX + 62, chestY + 40);
    // 领取按钮
    const cBtnW = 74, cBtnH = 34;
    const cBtn = { x: rowX + rowW - cBtnW - 10, y: chestY + (62 - cBtnH) / 2, w: cBtnW, h: cBtnH, action: 'daily_claim' };
    this.drawButton(cBtn.x, cBtn.y, cBtn.w, cBtn.h, chestClaimed ? '已领' : (chestReady ? '开启' : '未解锁'), chestReady ? '#ffb300' : '#7b7f8a');
    this.modalRects.push(cBtn);

    ctx.restore();
  }

  // =====================================================
  // 竞技场天梯面板（play-design v1）：当前段位 + 积分进度 + 本周最高分 + 段位奖励表
  // =====================================================
  drawArenaPanel() {
    const ctx = this.ctx, w = this.width, h = this.height;
    const meta = this.game.arenaMeta();
    const tiers = this.game.constructor.arenaTiers();
    const isMaster = meta.tierIndex >= tiers.length - 1;

    this.beginPanelAnim(this.game.arenaT || 0);
    const bw = Math.min(350, w - 30), bh = 452;
    const bx = (w - bw) / 2, by = this._panelCenterY(bh);

    this.drawPanelBody({ bx, by, bw, bh, key: 'arena' });
    this.drawCloseX('arena_close', bx, by, bw);

    // 标题 + 副标题
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 20px ' + APPLE_FONT;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('竞技场天梯', w / 2, by + 34);
    ctx.fillStyle = 'rgba(209,196,233,0.92)';
    ctx.font = '12px ' + APPLE_FONT;
    ctx.fillText('周赛 · 每局胜利得竞技积分 · 周结算发段位奖励', w / 2, by + 58);

    // 当前段位区
    const tierY = by + 84;
    // 段位图标（大）
    const bigIco = isMaster ? 72 : 64;
    const tIco = this._drawPngIcon(meta.tierIcon, bx + 62, tierY, bigIco);
    if (!tIco) {
      ctx.fillStyle = meta.tierColor;
      ctx.beginPath(); ctx.arc(bx + 62, tierY, 30, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#1a0f33'; ctx.font = 'bold 16px ' + APPLE_FONT;
      ctx.textAlign = 'center';
      ctx.fillText(meta.tierName, bx + 62, tierY + 1);
    }
    // 段位名 + 状态
    ctx.textAlign = 'left';
    ctx.fillStyle = meta.tierColor || '#ffd54f';
    ctx.font = 'bold 18px ' + APPLE_FONT;
    ctx.fillText(meta.tierName + '段位', bx + 106, tierY - 12);
    ctx.fillStyle = 'rgba(255,255,255,0.78)';
    ctx.font = '12px ' + APPLE_FONT;
    if (isMaster) {
      ctx.fillText('巅峰大师 · 专属金辉称号', bx + 106, tierY + 8);
    } else {
      ctx.fillText('距 ' + meta.nextName + ' 还需 ' + meta.toNext + ' 积分', bx + 106, tierY + 8);
    }
    // 赛季剩余
    ctx.fillStyle = UI.color.ink.body;
    ctx.font = '12px ' + APPLE_FONT;
    ctx.fillText('赛季剩余 ' + meta.remainDays + ' 天', bx + 106, tierY + 26);

    // 积分进度条（青铜→大师）
    const pBarX = bx + 16, pBarW = bw - 32, pBarY = tierY + 46, pBarH = 12;
    const maxPts = tiers[tiers.length - 1].pts;
    const prog = Math.min(1, meta.pts / maxPts);
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    this.roundRect(pBarX, pBarY, pBarW, pBarH, pBarH / 2); ctx.fill();
    if (prog > 0) {
      const ag = this._grad('aprog|' + Math.round(pBarX), () => {
        const gg = ctx.createLinearGradient(pBarX, pBarY, pBarX + pBarW, pBarY);
        gg.addColorStop(0, '#ffd54f');
        gg.addColorStop(1, meta.tierColor || '#ff9800');
        return gg;
      });
      ctx.fillStyle = ag;
      this.roundRect(pBarX, pBarY, Math.max(12, pBarW * prog), pBarH, pBarH / 2); ctx.fill();
    }
    ctx.strokeStyle = 'rgba(255,213,79,0.4)'; ctx.lineWidth = 1;
    this.roundRect(pBarX + 0.5, pBarY + 0.5, pBarW - 1, pBarH - 1, pBarH / 2); ctx.stroke();
    // 刻度点（6 段）
    for (let i = 0; i < tiers.length; i++) {
      const tx = pBarX + pBarW * (tiers[i].pts / maxPts);
      ctx.fillStyle = i <= meta.tierIndex ? '#ffd54f' : 'rgba(255,255,255,0.4)';
      ctx.beginPath(); ctx.arc(tx, pBarY + pBarH / 2, 3, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = UI.color.ink.bright;
    ctx.font = 'bold 12px ' + APPLE_FONT;
    ctx.textAlign = 'center';
    ctx.fillText('竞技积分 ' + meta.pts + ' / ' + maxPts, bx + bw / 2, pBarY + pBarH + 16);
    ctx.fillStyle = UI.color.ink.body;
    ctx.font = '12px ' + APPLE_FONT;
    ctx.fillText('本周最高分 ' + meta.best, bx + bw / 2, pBarY + pBarH + 30);

    // 段位奖励表（6 档横向徽章）
    const rY = pBarY + pBarH + 46;
    const cellW = (bw - 40) / 6, cellH = 64;
    ctx.textAlign = 'center';
    for (let i = 0; i < tiers.length; i++) {
      const tx = bx + 20 + cellW * i + cellW / 2;
      const t2 = tiers[i];
      const reached = i <= meta.tierIndex;
      // 槽
      ctx.fillStyle = reached ? 'rgba(255,213,79,0.12)' : 'rgba(255,255,255,0.05)';
      this.roundRect(tx - cellW / 2 + 3, rY, cellW - 6, cellH, 9); ctx.fill();
      ctx.strokeStyle = reached ? 'rgba(255,213,79,0.5)' : 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 1;
      this.roundRect(tx - cellW / 2 + 3.5, rY + 0.5, cellW - 7, cellH - 1, 9); ctx.stroke();
      // 段位图标
      if (reached) this._drawPngIcon(t2.icon, tx, rY + 22, 26);
      else {
        ctx.fillStyle = UI.color.ink.line;
        ctx.beginPath(); ctx.arc(tx, rY + 22, 12, 0, Math.PI * 2); ctx.fill();
      }
      // 段位名
      ctx.fillStyle = reached ? (t2.color || '#ffd54f') : 'rgba(255,255,255,0.4)';
      ctx.font = 'bold 12px ' + APPLE_FONT;
      ctx.fillText(t2.name, tx, rY + 42);
      // 奖励
      ctx.fillStyle = reached ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.32)';
      ctx.font = '12px ' + APPLE_FONT;
      const rw = t2.reward;
      ctx.fillText('+' + rw.coins, tx, rY + 54);
      ctx.fillStyle = reached ? 'rgba(255,213,79,0.9)' : 'rgba(255,255,255,0.3)';
      ctx.fillText(rw.energy ? '+' + rw.energy : ' ', tx, rY + 62);
    }
    // 说明条
    const tipY = rY + cellH + 8;
    ctx.fillStyle = UI.color.ink.faint;
    this.roundRect(bx + 16, tipY, bw - 32, 26, 13); ctx.fill();
    ctx.fillStyle = UI.color.ink.body;
    ctx.font = '12px ' + APPLE_FONT;
    ctx.textAlign = 'center';
    // P2-7 赛季荣耀：说明行合并展示历史最高段位 + 大师限定进度
    const _pk = (typeof this.game.arenaPeakMeta === 'function') ? this.game.arenaPeakMeta() : { peakName: '', masterGranted: false };
    const _peakTxt = _pk.peakName
      ? ('赛季荣耀 · 历史最高 ' + _pk.peakName + (_pk.masterGranted ? ' · 大师限定已入手' : ' · 周一按段位结算'))
      : '每周一自动按当前段位结算发放奖励，积分重置';
    ctx.fillText(_peakTxt, bx + bw / 2, tipY + 13);

    // P1-5/P1-7 激斗周末条 + 影子战按钮（底部锚定，避开上方内容与安全区）
    const act = (typeof this.game.activityInfo === 'function') ? this.game.activityInfo() : { weekendDouble: false };
    const hasGhost = (this.game.highScore || 0) > 0;
    const ghostH = hasGhost ? 32 : 0;
    const yG = by + bh - 14 - ghostH;
    if (hasGhost) {
      const gb = { x: bx + 16, y: yG, w: bw - 32, h: 32, action: 'ghost_challenge' };
      ctx.fillStyle = 'rgba(255,82,82,0.16)';
      this.roundRect(gb.x, gb.y, gb.w, gb.h, 16); ctx.fill();
      ctx.strokeStyle = 'rgba(255,82,82,0.5)'; ctx.lineWidth = 1;
      this.roundRect(gb.x + 0.5, gb.y + 0.5, gb.w - 1, gb.h - 1, 16); ctx.stroke();
      ctx.fillStyle = '#ff8a80';
      ctx.font = 'bold 12px ' + APPLE_FONT;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('⚔ 挑战影子 · 超越历史最佳 ' + this.game.highScore + ' 分', bx + bw / 2, gb.y + gb.h / 2);
      this.modalRects.push(gb);
    }
    const yW = yG - (ghostH ? 6 : 0) - 40;
    ctx.fillStyle = act.weekendDouble ? 'rgba(255,213,79,0.16)' : 'rgba(255,255,255,0.05)';
    this.roundRect(bx + 16, yW, bw - 32, 40, 12); ctx.fill();
    ctx.strokeStyle = act.weekendDouble ? 'rgba(255,213,79,0.5)' : 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    this.roundRect(bx + 16.5, yW + 0.5, bw - 33, 39, 12); ctx.stroke();
    ctx.fillStyle = act.weekendDouble ? '#ffd54f' : UI.color.ink.body;
    ctx.font = 'bold 12px ' + APPLE_FONT;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    if (act.weekendDouble) {
      ctx.fillText('⚔ 激斗周末 · BOSS 积分×2 · 洗词条半价', bx + 28, yW + 14);
      ctx.fillStyle = UI.color.ink.body;
      ctx.font = '12px ' + APPLE_FONT;
      const wm = (typeof this.game.weekendShopMeta === 'function') ? this.game.weekendShopMeta() : { remainDays: 0 };
      ctx.fillText('限时商店剩余 ' + wm.remainDays + ' 天 · 周一刷新限购', bx + 28, yW + 29);
      const wsb = { x: bx + bw - 16 - 92, y: yW + 5, w: 92, h: 30, action: 'weekshop' };
      this.drawButton(wsb.x, wsb.y, wsb.w, wsb.h, '限时商店', '#ffb300');
      this.modalRects.push(wsb);
    } else {
      const wm = (typeof this.game.weekendShopMeta === 'function') ? this.game.weekendShopMeta() : { remainDays: 0 };
      ctx.fillText('距激斗周末还有 ' + wm.remainDays + ' 天（BOSS 积分×2 · 限时商店）', bx + 28, yW + 20);
    }

    ctx.restore();
  }

  // =====================================================
  // P1-5 激斗周末·限时商店（周末限定 · 限量商品 · 周一刷新限购）
  // 金币的周期性大出口：平日攒 → 周末爆发消费，给 D7+ 用户一个 7 天周期的回访理由。
  // =====================================================
  drawWeekShopPanel() {
    const ctx = this.ctx, w = this.width;
    const meta = (typeof this.game.weekendShopMeta === 'function') ? this.game.weekendShopMeta() : { weekend: false, remainDays: 0, items: [] };
    this.beginPanelAnim(this.game.weekShopT || 0);
    const bw = Math.min(340, w - 40), bh = 420;
    const bx = (w - bw) / 2, by = this._panelCenterY(bh);
    this.drawPanelBody({ bx, by, bw, bh, key: 'wshop' });
    this.drawCloseX('wshop_close', bx, by, bw);

    ctx.fillStyle = '#fff';
    ctx.font = 'bold 20px ' + APPLE_FONT;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('激斗周末 · 限时商店', w / 2, by + 34);
    ctx.fillStyle = 'rgba(209,196,233,0.9)';
    ctx.font = '12px ' + APPLE_FONT;
    ctx.fillText(meta.weekend ? ('周末限定 · 剩 ' + meta.remainDays + ' 天 · 周一刷新限购') : '周五-周日开放（当前为预览）', w / 2, by + 58);
    ctx.fillStyle = '#ffd54f';
    ctx.font = 'bold 12px ' + APPLE_FONT;
    ctx.fillText('金币 ' + this.game.coins, w / 2, by + 80);

    const cardX = bx + 16, cardW = bw - 32, cardH = 82, gap = 10;
    for (let i = 0; i < meta.items.length; i++) {
      const it = meta.items[i];
      const cy = by + 96 + i * (cardH + gap);
      const soldOut = it.bought >= it.limit;
      const afford = (this.game.coins || 0) >= it.cost;
      const canBuy = meta.weekend && !soldOut && afford;
      ctx.fillStyle = UI.color.ink.faint;
      this.roundRect(cardX, cy, cardW, cardH, 12); ctx.fill();
      ctx.strokeStyle = canBuy ? 'rgba(255,213,79,0.35)' : 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 1;
      this.roundRect(cardX + 0.5, cy + 0.5, cardW - 1, cardH - 1, 12); ctx.stroke();
      // 左徽标（商品名首字）
      ctx.fillStyle = it.color;
      ctx.beginPath(); ctx.arc(cardX + 30, cy + cardH / 2, 17, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#1a0f33';
      ctx.font = 'bold 14px ' + APPLE_FONT;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(it.name.charAt(0), cardX + 30, cy + cardH / 2 + 1);
      // 文案
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 14px ' + APPLE_FONT;
      ctx.textAlign = 'left';
      ctx.fillText(it.name, cardX + 56, cy + 24);
      ctx.fillStyle = 'rgba(255,255,255,0.65)';
      ctx.font = '12px ' + APPLE_FONT;
      ctx.fillText(it.desc, cardX + 56, cy + 44);
      ctx.fillStyle = soldOut ? '#ff8a80' : 'rgba(255,255,255,0.5)';
      ctx.fillText('本周已购 ' + it.bought + '/' + it.limit, cardX + 56, cy + 64);
      // 购买按钮
      const btn = { x: cardX + cardW - 92, y: cy + cardH / 2 - 17, w: 84, h: 34, action: 'wshop_buy_' + it.key };
      this.drawButton(btn.x, btn.y, btn.w, btn.h, soldOut ? '已售罄' : (it.cost + '金币'), canBuy ? '#ffb300' : '#555');
      this.modalRects.push(btn);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '12px ' + APPLE_FONT;
    ctx.textAlign = 'center';
    ctx.fillText(meta.weekend ? '白虎图纸直购是高阶金币的主要去向 · 洗词条半价进行中' : '周末开放：BOSS 积分×2 · 洗词条半价 · 限量商店', w / 2, by + bh - 16);

    ctx.restore();
  }

  // =====================================================
  // P2-6 福利中心（2026-10-31）：签到 / 每日任务 / 好友助力 三合一单入口。
  // 只做「状态聚合 + 直跳」，三个面板本体零改动 —— 减少按钮堆叠的工具感，
  // 同时保住各自的高频领奖动线（红点指路）。
  // =====================================================
  drawWelfarePanel() {
    const ctx = this.ctx, w = this.width;
    const meta = (typeof this.game.welfareMeta === 'function')
      ? this.game.welfareMeta()
      : { rows: [], anyDue: false };
    this.beginPanelAnim(this.game.welfareT || 0);
    const bw = Math.min(330, w - 40), bh = 330;
    const bx = (w - bw) / 2, by = this._panelCenterY(bh);
    this.drawPanelBody({ bx, by, bw, bh, key: 'welfare' });
    this.drawCloseX('welfare_close', bx, by, bw);

    ctx.fillStyle = '#fff';
    ctx.font = 'bold 20px ' + APPLE_FONT;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('福利中心', w / 2, by + 36);
    ctx.fillStyle = 'rgba(209,196,233,0.9)';
    ctx.font = '12px ' + APPLE_FONT;
    ctx.fillText('每日签到 · 每日任务 · 好友助力，一个入口全搞定', w / 2, by + 58);

    const rowX = bx + 16, rowW = bw - 32, rowH = 62, gap = 10;
    for (let i = 0; i < meta.rows.length; i++) {
      const r = meta.rows[i];
      const cy = by + 82 + i * (rowH + gap);
      ctx.fillStyle = UI.color.ink.faint;
      this.roundRect(rowX, cy, rowW, rowH, 12); ctx.fill();
      ctx.strokeStyle = r.due ? 'rgba(255,213,79,0.35)' : 'rgba(255,255,255,0.10)';
      ctx.lineWidth = 1;
      this.roundRect(rowX + 0.5, cy + 0.5, rowW - 1, rowH - 1, 12); ctx.stroke();
      // 左侧序号徽标
      ctx.fillStyle = r.due ? '#ffd54f' : 'rgba(255,255,255,0.22)';
      ctx.beginPath(); ctx.arc(rowX + 28, cy + rowH / 2, 15, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = r.due ? '#1a0f33' : UI.color.ink.body;
      ctx.font = 'bold 13px ' + APPLE_FONT;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), rowX + 28, cy + rowH / 2 + 0.5);
      // 名称 + 状态
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 14px ' + APPLE_FONT;
      ctx.textAlign = 'left';
      ctx.fillText(r.name, rowX + 54, cy + 26);
      ctx.fillStyle = r.due ? '#ffd54f' : 'rgba(255,255,255,0.5)';
      ctx.font = '12px ' + APPLE_FONT;
      ctx.fillText(r.sub, rowX + 54, cy + 46);
      // 红点（可领）
      if (r.due) {
        ctx.save();
        ctx.beginPath();
        ctx.fillStyle = '#ff3b30';
        ctx.arc(rowX + rowW - 66, cy + 16, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      // 前往按钮
      const btn = { x: rowX + rowW - 78, y: cy + rowH / 2 - 15, w: 68, h: 30, action: r.action };
      this.drawButton(btn.x, btn.y, btn.w, btn.h, '前往', r.due ? '#ffb300' : '#7e57c2');
      this.modalRects.push(btn);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = '12px ' + APPLE_FONT;
    ctx.textAlign = 'center';
    ctx.fillText('红点 = 今日有可领奖励', w / 2, by + bh - 14);

    ctx.restore();
  }

  // =====================================================
  // 大师等级面板（play-design v1）：等级 + 经验进度 + 升级福利 + 里程碑
  // =====================================================
  drawLevelPanel() {
    const ctx = this.ctx, w = this.width, h = this.height;
    const lm = this.game.levelMeta();

    this.beginPanelAnim(this.game.levelT || 0);
    const bw = Math.min(330, w - 40), bh = 400;
    const bx = (w - bw) / 2, by = this._panelCenterY(bh);

    this.drawPanelBody({ bx, by, bw, bh, key: 'level' });
    this.drawCloseX('level_close', bx, by, bw);

    // 标题 + 副标题
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 20px ' + APPLE_FONT;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('大师等级', w / 2, by + 34);
    ctx.fillStyle = 'rgba(209,196,233,0.92)';
    ctx.font = '12px ' + APPLE_FONT;
    ctx.fillText('对战 / 合成 / 抽卡都能积累经验', w / 2, by + 58);

    // 等级大徽章
    const lvY = by + 104;
    ctx.fillStyle = 'rgba(255,213,79,0.14)';
    ctx.beginPath(); ctx.arc(bx + 62, lvY, 34, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#ffd54f'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(bx + 62, lvY, 34, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#ffd54f';
    ctx.font = 'bold 12px ' + APPLE_FONT;
    ctx.textAlign = 'center';
    ctx.fillText('Lv', bx + 62, lvY - 12);
    ctx.font = 'bold 28px ' + APPLE_FONT;
    ctx.fillText(String(lm.level), bx + 62, lvY + 10);

    // 等级名 + 经验
    ctx.textAlign = 'left';
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 16px ' + APPLE_FONT;
    ctx.fillText('陀螺大师 Lv.' + lm.level, bx + 110, lvY - 10);
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '12px ' + APPLE_FONT;
    ctx.fillText('能量上限 ' + lm.cap + ' · 每升一级 +5', bx + 110, lvY + 12);

    // 经验进度条
    const pBarX = bx + 16, pBarW = bw - 32, pBarY = lvY + 40, pBarH = 12;
    const prog = Math.max(0, Math.min(1, lm.inLv / Math.max(1, lm.need)));
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    this.roundRect(pBarX, pBarY, pBarW, pBarH, pBarH / 2); ctx.fill();
    if (prog > 0) {
      const ag = this._grad('lprog|' + Math.round(pBarX), () => {
        const gg = ctx.createLinearGradient(pBarX, pBarY, pBarX + pBarW, pBarY);
        gg.addColorStop(0, '#00e676');
        gg.addColorStop(1, '#69f0ae');
        return gg;
      });
      ctx.fillStyle = ag;
      this.roundRect(pBarX, pBarY, Math.max(12, pBarW * prog), pBarH, pBarH / 2); ctx.fill();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = 1;
    this.roundRect(pBarX + 0.5, pBarY + 0.5, pBarW - 1, pBarH - 1, pBarH / 2); ctx.stroke();
    ctx.fillStyle = UI.color.ink.bright;
    ctx.font = 'bold 12px ' + APPLE_FONT;
    ctx.textAlign = 'center';
    ctx.fillText(lm.inLv + ' / ' + lm.need + ' 经验', bx + bw / 2, pBarY + pBarH + 16);

    // 里程碑列表
    const mY = pBarY + pBarH + 34;
    const ms = [
      { lv: 5, txt: '玄武保底券（玄武计数清零）' },
      { lv: 10, txt: '玄武保底券' },
      { lv: 15, txt: '玄武保底券' },
      { lv: 20, txt: '白虎保底券' }
    ];
    ctx.textAlign = 'left';
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      const yy = mY + i * 24;
      const reached = lm.level >= m.lv;
      // 里程碑节点
      ctx.fillStyle = reached ? '#ffd54f' : 'rgba(255,255,255,0.18)';
      ctx.beginPath(); ctx.arc(bx + 34, yy + 6, 9, 0, Math.PI * 2); ctx.fill();
      if (reached) {
        ctx.strokeStyle = '#1a0f33'; ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(bx + 30, yy + 6); ctx.lineTo(bx + 34, yy + 10); ctx.lineTo(bx + 39, yy + 2);
        ctx.stroke();
      }
      ctx.fillStyle = reached ? '#fff' : 'rgba(255,255,255,0.45)';
      ctx.font = 'bold 12px ' + APPLE_FONT;
      ctx.fillText('Lv.' + m.lv, bx + 52, yy + 7);
      ctx.fillStyle = reached ? UI.color.ink.bright : 'rgba(255,255,255,0.45)';
      ctx.font = '12px ' + APPLE_FONT;
      ctx.fillText(m.txt, bx + 96, yy + 7);
    }
    // 说明
    const tipY = mY + ms.length * 24 + 8;
    ctx.fillStyle = UI.color.ink.faint;
    this.roundRect(bx + 16, tipY, bw - 32, 26, 13); ctx.fill();
    ctx.fillStyle = UI.color.ink.body;
    ctx.font = '12px ' + APPLE_FONT;
    ctx.textAlign = 'center';
    ctx.fillText('对战 +50 · 合成 +20 · 抽卡 +10 经验', bx + bw / 2, tipY + 13);

    ctx.restore();
  }

  // =====================================================
  // 离线回归礼包（play-design v1）：离线 ≥6h 回归弹窗，能量回满 + 金币；≥24h 升级大礼包
  // =====================================================
  drawReturnPanel() {
    const ctx = this.ctx, w = this.width, h = this.height;
    const grand = this.game._pendingReturn === 'grand';
    const hrs = Math.floor((this.game.offlineMs || 0) / 3600000);

    this.beginPanelAnim(this.game.returnT || 0);
    const bw = Math.min(330, w - 40), bh = grand ? 330 : 300;
    const bx = (w - bw) / 2, by = this._panelCenterY(bh);

    this.drawPanelBody({ bx, by, bw, bh, key: 'ret' });
    this.drawCloseX('return_close', bx, by, bw);

    // 标题 + 副标题
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 20px ' + APPLE_FONT;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(grand ? '欢迎归来 · 大礼包' : '欢迎归来', w / 2, by + 36);
    ctx.fillStyle = 'rgba(209,196,233,0.92)';
    ctx.font = '12px ' + APPLE_FONT;
    ctx.fillText('炉火未熄 · 离开已有 ' + hrs + ' 小时', w / 2, by + 60);

    // 礼包图标
    const gY = by + 122;
    const psize = 84;
    ctx.save();
    ctx.shadowColor = grand ? '#ffd54f' : '#9575cd';
    ctx.shadowBlur = (grand ? 22 : 12) * this.shadowScale;
    if (!this._drawPngIcon('chest', bx + bw / 2, gY, psize)) {
      ctx.fillStyle = grand ? '#ffb300' : '#7e57c2';
      ctx.beginPath(); ctx.arc(bx + bw / 2, gY, psize / 2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 30px ' + APPLE_FONT;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      // 图标资产 v3：大奖宝箱 ★ → icon-star.png
      if (grand) {
        this._drawPngIcon('star', bx + bw / 2, gY + 1, 30);
      } else {
        ctx.fillText('礼', bx + bw / 2, gY + 1);
      }
    }
    ctx.restore();

    // 奖励清单
    const rY = gY + 56;
    ctx.textAlign = 'center';
    const items = [
      { txt: '能量回满', ico: 'energy' },
      { txt: '+300 金币', ico: 'coin' }
    ];
    if (grand) items.push({ txt: '白虎保底券', ico: 'check' });
    const itemW = 90, gap = 8;
    const total = itemW * items.length + gap * (items.length - 1);
    let ix = bx + bw / 2 - total / 2 + itemW / 2;
    for (const it of items) {
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      this.roundRect(ix - itemW / 2, rY, itemW, 54, 12); ctx.fill();
      ctx.strokeStyle = grand ? 'rgba(255,213,79,0.5)' : UI.color.ink.line;
      ctx.lineWidth = 1;
      this.roundRect(ix - itemW / 2 + 0.5, rY + 0.5, itemW - 1, 53, 12); ctx.stroke();
      this._drawPngIcon(it.ico, ix, rY + 18, 20);
      ctx.fillStyle = '#fff';
      ctx.font = '12px ' + APPLE_FONT;
      ctx.fillText(it.txt, ix, rY + 42);
      ix += itemW + gap;
    }

    // 领取按钮
    const btnW = 160, btnH = 42;
    const btn = { x: (w - btnW) / 2, y: by + bh - 56, w: btnW, h: btnH, action: 'return_claim' };
    this.drawButton(btn.x, btn.y, btn.w, btn.h, grand ? '领取回归大礼包' : '领取回归礼包', '#ffb300');
    this.modalRects.push(btn);

    ctx.restore();
  }

  // =====================================================
  // 批次D·竞技宝箱（play-design v1）：胜利掉宝箱，看广告开 / 直接开
  // =====================================================
  drawBattleChestPanel() {
    const ctx = this.ctx, w = this.width, h = this.height;
    this.beginPanelAnim(this.game.battleChestT || 0);

    const chest = this.game.battleChest;
    const qNames = ['青铜宝箱', '白银宝箱', '黄金宝箱'];
    const qColors = ['#cd9a5b', '#cfd8dc', '#ffd54f'];
    const q = chest ? chest.quality : 0;

    const bw = Math.min(330, w - 40), bh = 320;
    const bx = (w - bw) / 2, by = this._panelCenterY(bh);
    this.drawPanelBody({ bx, by, bw, bh, key: 'chest', border: qColors[q] });

    // 标题
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 20px ' + APPLE_FONT;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(qNames[q], w / 2, by + 34);
    ctx.fillStyle = 'rgba(209,196,233,0.9)';
    ctx.font = '12px ' + APPLE_FONT;
    ctx.fillText('高连击提升宝箱品质 · 内含金币/能量/陀螺', w / 2, by + 56);

    // 宝箱图标（金色呼吸）
    const chestY = by + 122;
    ctx.save();
    const t = (this._frameCount || 0) / 60;
    ctx.shadowColor = qColors[q];
    ctx.shadowBlur = (16 + 8 * Math.sin(t * 3)) * this.shadowScale;
    if (!this._drawPngIcon('chest', w / 2, chestY, 92)) {
      ctx.fillStyle = qColors[q];
      ctx.beginPath(); ctx.arc(w / 2, chestY, 46, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 32px ' + APPLE_FONT;
      ctx.fillText('宝', w / 2, chestY + 1);
    }
    ctx.restore();
    ctx.fillStyle = UI.color.ink.body;
    ctx.font = '12px ' + APPLE_FONT;
    ctx.fillText('剩 ' + (chest ? chest.count : 0) + ' 个', w / 2, chestY + 58);

    // 关闭按钮：统一圆形胶囊 + icon-close.png + 按下态（drawCloseX），与全部 9 个面板一致（P2-2/2-5 一致性）
    this.drawCloseX('chest_close', bx, by, bw);

    // 按钮：单一「开启」——当日首次免费开，之后每次需看广告开（看完广告才开箱）
    const adBroken = !!this.game.chestAdBroken;
    const freeAvail = typeof this.game.isChestFreeOpenAvailable === 'function' && this.game.isChestFreeOpenAvailable();
    const btnW = 200, btnH = 44, btnY = by + bh - 64;
    const openBtn = { x: w / 2 - btnW / 2, y: btnY, w: btnW, h: btnH, action: 'chest_open' };
    // 文章原则三：hint 应讲「玩家得到什么」而非「玩家要付出什么」。
    let openLabel = '看广告开启', openColor = '#ffb300', openHint = '金币 / 能量 / 陀螺 随机必得';
    if (freeAvail) { openLabel = '开启'; openColor = '#43a047'; openHint = '今日首次免费开启'; }
    else if (adBroken) { openLabel = '开启'; openColor = '#43a047'; openHint = '广告暂不可用 · 已免费开启'; }
    this.drawButton(openBtn.x, openBtn.y, openBtn.w, openBtn.h, openLabel, openColor);
    this.modalRects.push(openBtn);
    ctx.fillStyle = (freeAvail || adBroken) ? 'rgba(129,199,132,0.95)' : 'rgba(255,255,255,0.5)';
    ctx.font = '12px ' + APPLE_FONT;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(openHint, w / 2, by + bh - 18);

    ctx.restore();
  }

  // =====================================================
  // 好友面板（P0-2 重做 · 2026-10-31）：助力能量 + 开放数据域真·好友榜
  // 旧版「好友榜 · 挑战目标」是本地模拟的 3 个假人（按玩家分数缩放硬编码生成，已删除）——
  // 微信用户对假数据非常敏感，被识破伤信任。现改为：
  //   主域把战绩写入云存储（src/leaderboard.js），开放数据域读全好友数据渲染到 sharedCanvas，
  //   本面板每帧 drawImage 上屏；三榜（段位/最高分/连胜）页签由主域处理点击。
  // 无开放数据域环境（Node 测试/旧基础库）→ 画兜底空态，不崩。
  // =====================================================
  drawBoostPanel() {
    const ctx = this.ctx, w = this.width, h = this.height;
    this.beginPanelAnim(this.game.boostT || 0);
    const bw = Math.min(350, w - 30), bh = 470;
    const bx = (w - bw) / 2, by = this._panelCenterY(bh);
    this.drawPanelBody({ bx, by, bw, bh, key: 'boost' });
    this.drawCloseX('boost_close', bx, by, bw);

    ctx.fillStyle = '#fff';
    ctx.font = 'bold 20px ' + APPLE_FONT;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('好友对战 · 榜单', w / 2, by + 36);
    ctx.fillStyle = 'rgba(209,196,233,0.9)';
    ctx.font = '12px ' + APPLE_FONT;
    ctx.fillText('真实好友排行 · 分享回跳领助力能量（每日 5 次）', w / 2, by + 58);

    // 助力能量按钮
    const canBoost = typeof this.game.canClaimBoost === 'function' && this.game.canClaimBoost();
    const boostBtn = { x: (w - 180) / 2, y: by + 78, w: 180, h: 38, action: 'boost_claim' };
    this.drawButton(boostBtn.x, boostBtn.y, boostBtn.w, boostBtn.h, canBoost ? '分享领 +15 能量' : '今日助力已领完', canBoost ? '#ffb300' : '#7e57c2');
    this.modalRects.push(boostBtn);

    // 三榜页签：段位榜 / 最高分 / 连胜榜
    const board = this.game.ldbBoard || 'arena';
    const tabs = [
      { key: 'arena', name: '段位榜', action: 'ldb_arena' },
      { key: 'high', name: '最高分', action: 'ldb_high' },
      { key: 'streak', name: '连胜榜', action: 'ldb_streak' }
    ];
    const tabW = Math.floor((bw - 32 - 16) / 3), tabH = 32, tabY = by + 128;
    for (let i = 0; i < tabs.length; i++) {
      const t = tabs[i];
      const tx = bx + 16 + i * (tabW + 8);
      const active = board === t.key;
      ctx.fillStyle = active ? 'rgba(255,213,79,0.92)' : 'rgba(255,255,255,0.08)';
      this.roundRect(tx, tabY, tabW, tabH, 16); ctx.fill();
      ctx.strokeStyle = active ? '#fff3c4' : 'rgba(255,255,255,0.2)';
      ctx.lineWidth = active ? 1.5 : 1;
      this.roundRect(tx + 0.5, tabY + 0.5, tabW - 1, tabH - 1, 16); ctx.stroke();
      ctx.fillStyle = active ? '#1a0f33' : 'rgba(255,255,255,0.75)';
      ctx.font = 'bold 13px ' + APPLE_FONT;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(t.name, tx + tabW / 2, tabY + tabH / 2);
      this.modalRects.push({ x: tx, y: tabY, w: tabW, h: tabH, action: t.action });
    }

    // 榜单区：开放数据域 sharedCanvas（打开面板时强制重发一次尺寸/页签消息，拉最新数据）
    const boardY = tabY + tabH + 10;
    const boardH = bh - (boardY - by) - 40;
    if ((this.game.boostT || 0) < 0.05) this._ldbMsgKey = null;   // 每次打开面板都重新通知开放数据域
    const odc = this._openDataCtx();
    let drewCanvas = false;
    if (odc && odc.canvas) {
      const msgKey = board + '|' + Math.round(bw - 28) + 'x' + Math.round(boardH);
      if (this._ldbMsgKey !== msgKey) {
        this._ldbMsgKey = msgKey;
        try { odc.postMessage({ type: 'board', board: board, w: Math.round(bw - 28), h: Math.round(boardH) }); } catch (e) {}
      }
      try {
        ctx.drawImage(odc.canvas, bx + 14, boardY, bw - 28, boardH);
        ctx.strokeStyle = 'rgba(255,213,79,0.25)'; ctx.lineWidth = 1;
        this.roundRect(bx + 14.5, boardY + 0.5, bw - 29, boardH - 1, 10); ctx.stroke();
        drewCanvas = true;
      } catch (e) { drewCanvas = false; }
    }
    if (!drewCanvas) {
      // 兜底（Node 测试 / 旧基础库 / 开放数据域异常）：空态框
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      this.roundRect(bx + 14, boardY, bw - 28, boardH, 10); ctx.fill();
      ctx.fillStyle = UI.color.ink.body;
      ctx.font = '12px ' + APPLE_FONT;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('好友榜单加载中…', w / 2, boardY + boardH / 2 - 12);
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.font = '12px ' + APPLE_FONT;
      ctx.fillText('开发者工具不展示好友 · 请用真机预览', w / 2, boardY + boardH / 2 + 10);
    }

    // 底部：炫耀分享 + 说明
    const shareBtn = { x: bx + 16, y: by + bh - 34, w: bw - 32, h: 26, action: 'ldb_share' };
    ctx.fillStyle = 'rgba(255,213,79,0.14)';
    this.roundRect(shareBtn.x, shareBtn.y, shareBtn.w, shareBtn.h, 13); ctx.fill();
    ctx.strokeStyle = 'rgba(255,213,79,0.45)'; ctx.lineWidth = 1;
    this.roundRect(shareBtn.x + 0.5, shareBtn.y + 0.5, shareBtn.w - 1, shareBtn.h - 1, 13); ctx.stroke();
    ctx.fillStyle = '#ffd54f';
    ctx.font = 'bold 12px ' + APPLE_FONT;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('炫耀战绩 · 挑战好友', w / 2, shareBtn.y + shareBtn.h / 2);
    this.modalRects.push(shareBtn);

    ctx.restore();
  }

  /** 开放数据域上下文缓存（P0-2）：不可用返回 null（Node/旧基础库），调用方画兜底 */
  _openDataCtx() {
    if (this._odc === undefined) this._odc = getOpenDataContext();
    return this._odc;
  }

  // 批次D·局前 buff 三选一弹窗
  drawBuffPanel() {
    const ctx = this.ctx, w = this.width, h = this.height;
    this.beginPanelAnim(this.game.buffT || 0);
    const bw = Math.min(340, w - 40), bh = 458;
    const bx = (w - bw) / 2, by = this._panelCenterY(bh);
    this.drawPanelBody({ bx, by, bw, bh, key: 'buff' });
    this.drawCloseX('buff_close', bx, by, bw);

    ctx.fillStyle = '#fff';
    ctx.font = 'bold 20px ' + APPLE_FONT;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('出击准备', w / 2, by + 36);
    ctx.fillStyle = 'rgba(209,196,233,0.9)';
    ctx.font = '12px ' + APPLE_FONT;
    ctx.fillText('本局增益：花金币购买，能量门票 -20', w / 2, by + 60);
    ctx.fillStyle = '#ffd54f';
    ctx.font = 'bold 12px ' + APPLE_FONT;
    ctx.fillText('金币 ' + this.game.coins + '  ·  能量 ' + Math.floor(this.game.energy), w / 2, by + 84);

    // 三项 buff（花费与 main._buffCost 保持一致）
    const buffs = [
      { key: 'fullspeed',   label: '满', color: '#ffb300', name: '开局满速',   desc: '开局立即满转速，抢先刷分', cost: 300 },
      { key: 'targetdown',  label: '标', color: '#ef5350', name: '目标 -10%',  desc: '目标分降低 10%，更易取胜', cost: 500 },
      { key: 'doublepower', label: '宝', color: '#42a5f5', name: '道具翻倍',   desc: '道具刷新频率翻倍',         cost: 800 },
    ];
    const cardX = bx + 16, cardW = bw - 32, cardH = 76, cardGap = 10;
    const cardY0 = by + 104;
    for (let i = 0; i < buffs.length; i++) {
      const b = buffs[i];
      const cy = cardY0 + i * (cardH + cardGap);
      const affordable = this.game.coins >= b.cost;
      // 卡片底
      ctx.fillStyle = UI.color.ink.faint;
      this.roundRect(cardX, cy, cardW, cardH, 12); ctx.fill();
      ctx.strokeStyle = affordable ? 'rgba(255,213,79,0.35)' : 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 1;
      this.roundRect(cardX + 0.5, cy + 0.5, cardW - 1, cardH - 1, 12); ctx.stroke();
      // 左侧徽标
      ctx.fillStyle = b.color;
      ctx.beginPath(); ctx.arc(cardX + 30, cy + cardH / 2, 18, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 16px ' + APPLE_FONT;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(b.label, cardX + 30, cy + cardH / 2);
      // 名称 + 描述
      ctx.textAlign = 'left';
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 14px ' + APPLE_FONT;
      ctx.fillText(b.name, cardX + 58, cy + 26);
      ctx.fillStyle = 'rgba(255,255,255,0.72)';
      ctx.font = '12px ' + APPLE_FONT;
      ctx.fillText(b.desc, cardX + 58, cy + 46);
      // 购买按钮
      const buy = { x: cardX + cardW - 86, y: cy + cardH / 2 - 18, w: 74, h: 36, action: 'buff_buy_' + b.key };
      this.drawButton(buy.x, buy.y, buy.w, buy.h, (affordable ? '' : '✕ ') + b.cost, affordable ? b.color : '#555');
      this.modalRects.push(buy);
      // 成本标签（金币图标感）
      ctx.fillStyle = affordable ? 'rgba(255,213,79,0.95)' : 'rgba(255,255,255,0.4)';
      ctx.font = 'bold 12px ' + APPLE_FONT;
      ctx.textAlign = 'center';
      ctx.fillText('金币', buy.x + buy.w / 2, buy.y - 8);
    }

    // 免费跳过
    const skipY = cardY0 + buffs.length * (cardH + cardGap) + 6;
    const skip = { x: cardX, y: skipY, w: cardW, h: 40, action: 'buff_skip' };
    this.drawButton(skip.x, skip.y, skip.w, skip.h, '直接开战（不买）', '#66bb6a');
    this.modalRects.push(skip);

    ctx.restore();
  }

  // 批次E·连战三选一浮层（复用局前 buff 面板结构，免费叠层）
  drawRunBuffPanel() {
    const battle = this.game.battle;
    const choices = (battle && battle._runBuffChoices) || [];
    const ctx = this.ctx, w = this.width, h = this.height;
    this.beginPanelAnim(this.game.runBuffT || 0);
    const bw = Math.min(340, w - 40), bh = 458;
    const bx = (w - bw) / 2, by = this._panelCenterY(bh);

    this.drawPanelBody({ bx, by, bw, bh, key: 'runbuff', bgFrom: 'rgba(38,166,154,0.98)', bgTo: 'rgba(0,105,92,0.98)', border: '#80cbc4' });

    ctx.fillStyle = '#fff';
    ctx.font = 'bold 20px ' + APPLE_FONT;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('连战 · 选择增益', w / 2, by + 36);
    ctx.fillStyle = 'rgba(178,223,219,0.9)';
    ctx.font = '12px ' + APPLE_FONT;
    const stage = (battle && battle.runStage) || 1;
    ctx.fillText('已通关 ' + (stage - 1) + ' 关 · 选一张免费叠层，继续第 ' + stage + ' 关', w / 2, by + 60);

    const cardX = bx + 16, cardW = bw - 32, cardH = 76, cardGap = 10;
    const cardY0 = by + 84;
    for (let i = 0; i < choices.length; i++) {
      const b = choices[i];
      const cy = cardY0 + i * (cardH + cardGap);
      ctx.fillStyle = UI.color.ink.faint;
      this.roundRect(cardX, cy, cardW, cardH, 12); ctx.fill();
      ctx.strokeStyle = 'rgba(128,203,196,0.45)';
      ctx.lineWidth = 1;
      this.roundRect(cardX + 0.5, cy + 0.5, cardW - 1, cardH - 1, 12); ctx.stroke();
      ctx.fillStyle = b.color || '#26a69a';
      ctx.beginPath(); ctx.arc(cardX + 30, cy + cardH / 2, 18, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 16px ' + APPLE_FONT;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(b.label || '?', cardX + 30, cy + cardH / 2);
      ctx.textAlign = 'left';
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 14px ' + APPLE_FONT;
      ctx.fillText(b.name || '', cardX + 58, cy + 26);
      ctx.fillStyle = 'rgba(255,255,255,0.72)';
      ctx.font = '12px ' + APPLE_FONT;
      ctx.fillText(b.desc || '', cardX + 58, cy + 46);
      const pick = { x: cardX + cardW - 86, y: cy + cardH / 2 - 18, w: 74, h: 36, action: 'run_buff_' + i };
      this.drawButton(pick.x, pick.y, pick.w, pick.h, '选择', b.color || '#26a69a');
      this.modalRects.push(pick);
    }

    const skipY = cardY0 + choices.length * (cardH + cardGap) + 6;
    const skip = { x: cardX, y: skipY, w: cardW, h: 40, action: 'run_buff_skip' };
    this.drawButton(skip.x, skip.y, skip.w, skip.h, '结束连战（保留金币）', '#ef5350');
    this.modalRects.push(skip);
    ctx.restore();
  }

  drawParticles(dt) {
    const ctx = this.ctx;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      if (!this._debugFreezeFx) {
        p.life -= dt;
        p.x += p.vx * dt; p.y += p.vy * dt;
      }
      if (p.life <= 0) { this.particles.splice(i, 1); continue; }
      ctx.globalAlpha = p.life / p.maxLife;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // 环形冲击波（合成成功等）
    if (this.rings) {
      for (let i = this.rings.length - 1; i >= 0; i--) {
        const r = this.rings[i];
        if (!this._debugFreezeFx) {
          r.radius += (r.maxRadius - r.radius) * dt * 6 + 30 * dt;
          r.alpha -= dt * 1.2;
        }
        if (r.alpha <= 0 || r.radius >= r.maxRadius) { this.rings.splice(i, 1); continue; }
        ctx.save();
        ctx.globalAlpha = Math.max(0, r.alpha);
        ctx.strokeStyle = r.color;
        ctx.lineWidth = 4;
        ctx.shadowColor = r.color;
        ctx.shadowBlur = 16 * this.shadowScale;
        ctx.beginPath();
        ctx.arc(r.x, r.y, r.radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  addParticles(x, y, color, count = 12) {
    if (this.particles.length >= 200) return; // 防御性硬上限：UI 粒子过多时丢弃，避免 GC 雪崩
    const remain = 200 - this.particles.length;
    if (count > remain) count = remain;
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 60 + Math.random() * 80;
      this.particles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size: 2 + Math.random() * 3,
        color,
        life: 0.4 + Math.random() * 0.4,
        maxLife: 0.8
      });
    }
  }

  /** 环形扩散冲击波（合成成功 / 升级时用），跟随 renderer 帧更新 */
  addRing(x, y, color) {
    if (!this.rings) this.rings = [];
    this.rings.push({ x, y, color, radius: 8, maxRadius: 90, alpha: 0.8 });
  }

  /** 震屏反馈（传说出货 / 强力事件时用）：dur 秒内随机偏移、幅度衰减 */
  shake(mag = 8, dur = 0.4) {
    this._shakeT = dur;
    this._shakeDur = dur;
    this._shakeMag = mag;
  }

  roundRect(x, y, w, h, r) {
    const ctx = this.ctx;
    r = Math.min(r, Math.min(w, h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // 游戏圈引导浮层：轻量卡片（动作条上方），每天弹一次，可直达游戏圈产生有效活跃
  drawClubGuide() {
    const ctx = this.ctx;
    const L = this.layout;
    const W = L.W;
    const cardW = Math.min(W - 40, 300);
    const cardH = 64;
    const bx = (W - cardW) / 2;
    // 放在动作条（对战/合成/社区）上方，紧邻「社区」按钮，语义清晰
    const by = L.actionY - cardH - 14;
    if (by < (L.topBarY + L.topBarH)) return; // 空间不足则不挡标题

    // 卡片底：柔和渐变 + 微投影（苹果风格弹层）
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = 12;
    const bg = this._grad('club|' + Math.round(bx) + '|' + Math.round(by) + '|' + Math.round(cardH), () => {
      const gg = ctx.createLinearGradient(bx, by, bx, by + cardH);
      gg.addColorStop(0, 'rgba(94,53,177,0.95)');
      gg.addColorStop(1, 'rgba(69,39,160,0.95)');
      return gg;
    });
    ctx.fillStyle = bg;
    this.roundRect(bx, by, cardW, cardH, 16); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1.5;
    this.roundRect(bx + 1, by + 1, cardW - 2, cardH - 2, 16); ctx.stroke();
    ctx.restore();

    // 文案：单行引导语
    ctx.fillStyle = '#fff';
    ctx.font = '13px ' + APPLE_FONT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const tx = bx + 16;
    ctx.fillText('来游戏圈点个赞，帮我上推荐～', tx, by + 20);

    // 进入社区按钮（蓝色，直达游戏圈）
    const btnW = 82, btnH = 26;
    const btnRect = { x: bx + cardW - btnW - 12, y: by + cardH - btnH - 10, w: btnW, h: btnH, action: 'club_enter' };
    this.drawButton(btnRect.x, btnRect.y, btnRect.w, btnRect.h, '进入', '#2196f3');
    this.clubGuideRects.push(btnRect);

    // 右上角关闭 X
    const close = { x: bx + cardW - 30, y: by + 8, w: 20, h: 20, action: 'club_guide_close' };
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.beginPath(); ctx.arc(close.x + close.w / 2, close.y + close.h / 2, close.w / 2, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1.5;
    // 图标资产 v3：游戏圈浮层关闭用 icon-close.png
    if (!this._drawPngIcon('close', close.x + close.w / 2, close.y + close.h / 2, close.w - 6)) {
      ctx.beginPath();
      ctx.moveTo(close.x + 6, close.y + 6); ctx.lineTo(close.x + 14, close.y + 14);
      ctx.moveTo(close.x + 14, close.y + 6); ctx.lineTo(close.x + 6, close.y + 14);
      ctx.stroke();
    }
    this.clubGuideRects.push(close);
  }

  hitTest(x, y) {
    // 游戏圈引导浮层：优先响应其按钮，其余区域仍走正常交互
    if (this.game.clubGuideOpen && !this.game.drawCard && this.game.tutorialDone) {
      for (const g of this.clubGuideRects) {
        if (isPointInRect(x, y, g)) return { type: 'button', action: g.action };
      }
    }
    // 抽卡动画态：只命中"收入背包"按钮
    if (this.game.drawCard) {
      for (const m of this.modalRects) {
        if (isPointInRect(x, y, m)) return { type: 'button', action: m.action };
      }
      return null;
    }
    if (!this.game.tutorialDone) {
      // 引导态：优先命中模态按钮（跳过），其余任意点击推进
      for (const m of this.modalRects) if (isPointInRect(x, y, m)) return { type: 'button', action: m.action };
      return { type: 'tutorial' };
    }
    if (this.game.signOpen) {
      for (const m of this.modalRects) {
        if (isPointInRect(x, y, m)) return { type: 'button', action: m.action };
      }
      return { type: 'sign_close' };
    }
    // 批次D·局前 buff 选择弹窗：只响应面板内按钮，其余区域不响应（防误触穿透到主菜单）
    if (this.game.buffOpen) {
      for (const m of this.modalRects) {
        if (isPointInRect(x, y, m)) return { type: 'button', action: m.action };
      }
      return null;
    }
    // 批次E·连战三选一浮层：只响应面板内按钮，其余区域不响应（防误触穿透到结算页）
    if (this.game.runBuffOpen) {
      for (const m of this.modalRects) {
        if (isPointInRect(x, y, m)) return { type: 'button', action: m.action };
      }
      return null;
    }
    // 批次F·出战陀螺选择面板：只响应面板内按钮，其余区域不响应（防误触穿透到主菜单）
    if (this.game.battleSelectOpen) {
      for (const m of this.modalRects) {
        if (isPointInRect(x, y, m)) return { type: 'button', action: m.action };
      }
      return null;
    }
    // 出售二次确认弹窗：只响应确认/取消按钮，其余区域不响应（防止误触）
    if (this.game.sellConfirm) {
      for (const m of this.modalRects) {
        if (isPointInRect(x, y, m)) return { type: 'button', action: m.action };
      }
      return null;
    }
    // 通用模态按钮检测：所有弹窗（竞技场/每日任务/抽卡/签到等）的关闭按钮、操作按钮
    // modalRects 优先于普通 buttons，因为弹窗在最上层
    for (const m of this.modalRects) {
      if (isPointInRect(x, y, m)) return { type: 'button', action: m.action };
    }
    for (const tb of this.tabRects) if (isPointInRect(x, y, tb)) return { type: 'tab', view: tb.view };
    for (const btn of this.buttons) if (isPointInRect(x, y, btn)) return { type: 'button', action: btn.action };
    for (const f of this.filterRects) if (isPointInRect(x, y, f)) return { type: 'filter', tierIndex: f.tierIndex };
    for (const p of this.platformRects) if (isPointInRect(x, y, p)) return { type: 'platform', index: p.index };
    for (const r of this.gridRects) if (isPointInRect(x, y, r)) return { type: 'inventory', beyblade: r.beyblade };
    return null;
  }

  // 批次F·出战陀螺选择面板（选项B：开战前显式选陀螺，持久化 battleBbId，不再只靠战力最高）
  // 列出背包（战力 / 元素 / 羁绊），整行可点选；分页翻页（背包上限 400 必分页）。
  drawBattleSelectPanel() {
    const ctx = this.ctx, w = this.width, h = this.height;
    const g = this.game;
    try {
    this.beginPanelAnim(g.battleSelectT || 0);
    // 面板高度需容下：标题区 78 + 4 行(86+10) + 翻页 34+gap + 底部按钮 46 + 内边距
    const bw = Math.min(360, w - 40), bh = 576;
    const bx = (w - bw) / 2, by = this._panelCenterY(bh);
    this.drawPanelBody({ bx, by, bw, bh, key: 'battleSel', bgFrom: 'rgba(38,50,86,0.98)', bgTo: 'rgba(13,20,40,0.98)', border: '#ffd54f' });
    this.drawCloseX('battle_select_close', bx, by, bw);

    ctx.fillStyle = '#fff';
    ctx.font = 'bold 20px ' + APPLE_FONT;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('选择出战陀螺', w / 2, by + 34);
    // 构建标记：用于一眼确认「真机/预览是否已加载最新代码」——看不到此标记即为旧包
    // BSEL·3：修复「面板入场动画不收敛（scale 停在 0.84）导致点哪都直接开战」
    // BSEL·4：点选文字提示改为「只给新用户弹一次」+ 点选脉冲即时反馈
    // BSEL·5：元素绑定品质（方案B，已回退）—— 行上直接显示「克 X / 被 Y 克」
    // BSEL·6：回退到方案A（元素 = f(品质,等级)，25 种「神兽×元素」组合）—— 行只显示「元素·X」单字，克制留给战斗 HUD
    ctx.textAlign = 'left'; ctx.font = 'bold 12px ' + APPLE_FONT;
    ctx.fillStyle = 'rgba(255,213,79,0.55)';
    ctx.fillText('BSEL·6', bx + 14, by + 20);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';

    // 当前选中提示：优先显示面板内的待出战选择（battleSelectId），点行后立刻反映，避免"点了上面没变"
    const selIdNow = g.battleSelectId || g.battleBbId;
    const selBb = selIdNow ? g._findBbById(selIdNow) : null;
    ctx.font = '12px ' + APPLE_FONT;
    ctx.fillStyle = 'rgba(255,213,79,0.9)';
    // 方案B（元素绑定品质）：顺带写出该陀螺的克制关系（土克水 → 麒麟克玄武），让"选哪只"有依据
    const selEl = selBb ? (selBb.elementInfo || null) : null;
    ctx.fillText(selBb
      ? ('已选：' + selBb.tier.name + ' Lv' + selBb.level + ' · 元素·' + (selEl ? selEl.name : '?') + ' · 点「开始对战」开战')
      : '尚未指定 · 默认出战战力最高', w / 2, by + 58);

    // 列表（按战力降序，分页）
    const list = g.inventory.slice().sort((a, b) => b.power - a.power);
    const perPage = 4;
    const pages = Math.max(1, Math.ceil(list.length / perPage));
    const page = Math.max(0, Math.min(pages - 1, g.battleSelectPage | 0));
    g.battleSelectPage = page; // 收敛越界（切背包/出售后）
    g.battleSelectPages = pages; // 回写总页数：main.js 翻页时据此做边界判定与「已是最后一页」提示
    const resonance = g.bondResonance();

    const rowX = bx + 14, rowW = bw - 28, rowH = 80, rowGap = 8;   // P1-6：压缩行高腾出挑战券条
    const rowY0 = by + 78;
    if (list.length === 0) {
      ctx.fillStyle = UI.color.ink.body;
      ctx.font = '13px ' + APPLE_FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('背包暂无陀螺', w / 2, rowY0 + 30);
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.fillText('把陀螺放上合成台中央格即可出战', w / 2, rowY0 + 54);
    }
    const start = page * perPage;
    for (let i = 0; i < perPage; i++) {
      const idx = start + i;
      if (idx >= list.length) break;
      const bb = list[idx];
      const cy = rowY0 + i * (rowH + rowGap);
      const isSel = (g.battleSelectId != null && g.battleSelectId === bb.id) ||
                    (!g.battleSelectId && selBb && selBb.id === bb.id);
      // 行底
      ctx.fillStyle = isSel ? 'rgba(255,213,79,0.16)' : UI.color.ink.faint;
      this.roundRect(rowX, cy, rowW, rowH, 12); ctx.fill();
      ctx.strokeStyle = isSel ? 'rgba(255,213,79,0.7)' : 'rgba(255,255,255,0.10)';
      ctx.lineWidth = isSel ? 2 : 1;
      this.roundRect(rowX + 0.5, cy + 0.5, rowW - 1, rowH - 1, 12); ctx.stroke();
      // 陀螺精灵
      const spriteScale = Math.max(0.42, (rowH - 24) / 100);
      drawBeyblade(ctx, rowX + 42, cy + rowH / 2, bb, spriteScale, { maxSize: rowH - 20, uniformSize: true });
      // 文本区
      const tx = rowX + 80;
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 15px ' + APPLE_FONT;
      ctx.fillText(bb.tier.name + '  Lv' + bb.level, tx, cy + 26);
      ctx.fillStyle = 'rgba(255,255,255,0.78)';
      ctx.font = '12px ' + APPLE_FONT;
      ctx.fillText('战力 ' + bb.power, tx, cy + 46);
      // 元素角标（彩色圆 + 名）
      const el = bb.elementInfo || { color: '#9e9e9e', name: '?' };
      ctx.fillStyle = el.color;
      ctx.beginPath(); ctx.arc(tx + 8, cy + 64, 7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 12px ' + APPLE_FONT;
      // 方案A（2026-09-13 回退）：元素 = f(品质,等级)，行上只标「元素·X」单字；克制关系留给战斗 HUD 展示
      ctx.fillText('元素·' + el.name, tx + 20, cy + 68);
      // P0-3 词条标签（行右下角，词条色，最多 2 条连写；与左侧元素行同一基线）
      const trTags = (Array.isArray(bb.traits) && bb.traits.length)
        ? bb.traits.map(t => traitById(t.id)).filter(Boolean) : [];
      if (trTags.length) {
        ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = trTags[0].color;
        ctx.font = '12px ' + APPLE_FONT;
        ctx.fillText(trTags.map(t => t.name).join('·'), rowX + rowW - 14, cy + 68);
        ctx.textAlign = 'left';
      }
      // 羁绊标记
      if (resonance.active && resonance.elementIdx === bb.elementIdx) {
        ctx.fillStyle = '#ffd54f';
        ctx.font = 'bold 12px ' + APPLE_FONT;
        ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
        ctx.fillText('羁绊+10%', rowX + rowW - 14, cy + 22);
        ctx.textAlign = 'left';
      }
      // 点选脉冲：命中瞬间描一圈亮边并在 0.3s 内衰减 —— 替代"每次点选弹一条 toast"的即时反馈
      if (g.battleSelectFlashId === bb.id && (g.battleSelectFlashT || 0) > 0) {
        const fp = Math.max(0, Math.min(1, (g.battleSelectFlashT || 0) / 0.3));
        ctx.strokeStyle = 'rgba(255,213,79,' + (0.9 * fp).toFixed(3) + ')';
        ctx.lineWidth = 2 + 2.5 * fp;
        this.roundRect(rowX + 0.5, cy + 0.5, rowW - 1, rowH - 1, 12); ctx.stroke();
      }
      // 选中标记
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillStyle = isSel ? '#ffd54f' : 'rgba(255,255,255,0.4)';
      ctx.font = 'bold 14px ' + APPLE_FONT;
      ctx.fillText(isSel ? '✓ 出战' : '选', rowX + rowW - 14, cy + rowH / 2);
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      // 整行可点：选中该陀螺
      this.modalRects.push({ x: rowX, y: cy, w: rowW, h: rowH, action: 'battle_select_pick_' + bb.id });
    }

    // 翻页箭头
    const navY = rowY0 + perPage * (rowH + rowGap) + 4;
    const arrowW = 60, arrowH = 34;
    const prev = { x: bx + 16, y: navY, w: arrowW, h: arrowH, action: 'battle_select_prev' };
    const next = { x: bx + bw - 16 - arrowW, y: navY, w: arrowW, h: arrowH, action: 'battle_select_next' };
    this.drawButton(prev.x, prev.y, prev.w, prev.h, '上一页', page > 0 ? '#7e57c2' : '#555');
    this.drawButton(next.x, next.y, next.w, next.h, '下一页', page < pages - 1 ? '#7e57c2' : '#555');
    this.modalRects.push(prev, next);
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '12px ' + APPLE_FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText((page + 1) + ' / ' + pages + '  ·  共 ' + list.length + ' 只', w / 2, navY + arrowH / 2);

    // P1-6 挑战券条：免费 N/5 · 加发券 M + [广告+2] [分享+2]（次数限制本身就是分享动机）
    const tY = navY + arrowH + 6, tH = 26;
    ctx.fillStyle = UI.color.ink.faint;
    this.roundRect(bx + 14, tY, bw - 28, tH, 13); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = '12px ' + APPLE_FONT;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const ftl = (typeof g.freeTicketsLeft === 'function') ? g.freeTicketsLeft() : 0;
    const _bonus = g.bonusTickets || 0;
    // 先说人话再给数（花叔范式 · 2026-11-22）：券数换算成「能打几局」
    const _battles = ftl + _bonus;
    const _tail = _battles > 0 ? ' · 可战 ' + _battles + ' 局' : ' · 能量还可战 ' + Math.max(0, Math.floor((g.energy || 0) / 20)) + ' 局';
    ctx.fillText('🎟 免费挑战 ' + ftl + '/5 · 加发券 ' + _bonus + _tail, bx + 24, tY + tH / 2);
    const adOk = (typeof g.canEarnAdTickets === 'function') ? g.canEarnAdTickets() : false;
    const shOk = (typeof g.canShare === 'function') ? g.canShare() : false;
    const adBtn = { x: bx + bw - 14 - 64 - 6 - 64, y: tY + 2, w: 64, h: 22, action: 'ticket_ad' };
    const shBtn = { x: bx + bw - 14 - 64, y: tY + 2, w: 64, h: 22, action: 'ticket_share' };
    this.drawButton(adBtn.x, adBtn.y, adBtn.w, adBtn.h, '广告+2', adOk ? '#ffb300' : '#555');
    this.drawButton(shBtn.x, shBtn.y, shBtn.w, shBtn.h, '分享+2', shOk ? '#7e57c2' : '#555');
    this.modalRects.push(adBtn, shBtn);
    ctx.textBaseline = 'alphabetic';

    // 开始对战 + 洗词条（P0-3 金币硬出口：把词条重掷为新的随机词条，价格随次数递增）
    const confY = tY + tH + 6;
    const rerW = 96, rerH = 46;
    const confW = bw - 32 - rerW - 8;
    const conf = { x: bx + 16, y: confY, w: confW, h: rerH, action: 'battle_select_confirm' };
    this.drawButton(conf.x, conf.y, conf.w, conf.h, '开始对战', '#e53935');
    this.modalRects.push(conf);
    const rerBb = selIdNow ? g._findBbById(selIdNow) : null;
    const rerCost = (rerBb && typeof g.rerollTraitsCost === 'function') ? g.rerollTraitsCost(rerBb) : 0;
    const canReroll = !!rerBb && rerCost > 0 && g.coins >= rerCost;
    const rbtn = { x: conf.x + confW + 8, y: confY, w: rerW, h: rerH, action: 'trait_reroll' };
    this.drawButton(rbtn.x, rbtn.y, rbtn.w, rbtn.h, '洗词条', canReroll ? '#7e57c2' : '#555');
    ctx.fillStyle = canReroll ? UI.color.ink.bright : 'rgba(255,255,255,0.4)';
    ctx.font = '12px ' + APPLE_FONT;
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(rerBb ? (rerCost + ' 金币') : '先选陀螺', rbtn.x + rbtn.w / 2, rbtn.y + 36);
    this.modalRects.push(rbtn);
    } catch (e) {
      if (typeof console !== 'undefined') console.warn('[battleSel] draw error', e && e.stack);
    } finally {
      try { ctx.restore(); } catch (e2) {}
    }
  }

  render(dt) {
    // 【跨平台修复 #3】每帧以 DPR 为基准变换：所有绘制坐标按逻辑像素，由 setTransform(dpr) 映射到物理像素。
    // canvas 物理尺寸 = 逻辑 × dpr，故逻辑坐标经此变换恰好落到物理像素，画面高清且不越界。
    // 特性检测：真实微信 Canvas2D ctx 必有 setTransform；测试 mock 缺失时安全跳过（不影响逻辑校验）。
    const dprT = this.dpr || 1;
    if (this.ctx.setTransform) this.ctx.setTransform(dprT, 0, 0, dprT, 0, 0);
    this._frameCount = (this._frameCount || 0) + 1;
    // 首帧极简渲染：仅背景+标题，保证像素立即上屏（避免白屏、压首屏渲染耗时）
    if (this._frameCount <= 2) {
      try {
        this.buttons = [];
        this.modalRects = [];
        this.clear();
        this.drawBackground();
        this.drawSplashTitle();
      } catch (e) {
        console.warn('[splash]', e);
      }
      return;
    }
    try {
      // V2：布局仅在依赖状态变化时重算（canvas 尺寸 / energy / 回满·广告可用性），避免每帧全量 CPU 计算
      this._maybeReflow();
    } catch (e) {
      console.warn('[reflow]', e);
    }
    // 命中区数组复用：length=0 清空替代每帧重建，降低 GC 频率（诊断高频 GC 是卡顿主因之一）
    // 按钮对象池：将上一帧的按钮对象回收到对象池，避免每帧创建新对象
    this.releaseButtons();
    this.modalRects.length = 0;
    this.clubGuideRects.length = 0;
    this.tabRects.length = 0;
    this.filterRects.length = 0;
    this.platformRects.length = 0;
    this.gridRects.length = 0;
    this.clear();

    // 震屏：随机偏移、幅度随时间衰减（传说出货等强力反馈时由 shake() 触发）
    let shX = 0, shY = 0;
    if (this._shakeT > 0) {
      this._shakeT -= dt;
      const m = this._shakeMag * Math.max(0, this._shakeT / this._shakeDur);
      shX = (Math.random() * 2 - 1) * m;
      shY = (Math.random() * 2 - 1) * m;
    }
    if (shX || shY) { this.ctx.save(); this.ctx.translate(shX, shY); }

    const v2 = this.game.homeV2 !== false;
    if (this.game.mode === 'battle' && this.game.battle) {
      this.drawSpintopBattle(dt);
    } else if (v2) {
      // V2 游戏化骨架：顶栏 HUD + 视图切换条（无大标题）+ 圆盘主舞台 + 异形主次按钮
      this.drawBackground();
      this._drawBgParticles(dt);   // 细节打磨：背景漂浮微粒
      this.drawHeader();
      this.drawViewTabs();
      if (this.game.view === 'codex') {
        this.drawCodex();
      } else {
        this.drawForgeV2(dt);
        this.drawHomeActions();
        this.drawFiltersAndDraw();
        if (this.invRailV2On()) this.drawInventoryRailV2();
        else this.drawInventory();
      }
    } else {
      this.drawBackground();
      this.drawHeader();
      this.drawTitleAndTabs();
      if (this.game.view === 'codex') {
        this.drawCodex();
      } else {
        this.drawPlatform();
        this.drawActionBar();
        this.drawFiltersAndDraw();
        this.drawInventory();
      }
    }

    this.drawDrag();
    if (this.game.clubGuideOpen && !this.game.drawCard && this.game.tutorialDone) this.drawClubGuide();
    if (this.game.drawCard) this.drawDrawCard();
    if (this.game.sellConfirm) this.drawSellConfirm();
    if (this.game.signOpen) this.drawSignin();
    if (this.game.dailyOpen) this.drawDailyPanel();
    if (this.game.arenaOpen) this.drawArenaPanel();
    if (this.game.weekShopOpen) this.drawWeekShopPanel();
    if (this.game.welfareOpen) this.drawWelfarePanel();
    if (this.game.levelOpen) this.drawLevelPanel();
    if (this.game.offlineOpen) this.drawReturnPanel();
    if (this.game.battleChestOpen) this.drawBattleChestPanel();
    if (this.game.boostOpen) this.drawBoostPanel();
    if (this.game.battleSelectOpen) this.drawBattleSelectPanel();
    if (this.game.buffOpen) this.drawBuffPanel();
    if (this.game.runBuffOpen) this.drawRunBuffPanel();
    if (!this.game.tutorialDone && !this.game.drawCard) this.drawTutorial();
    // 细节打磨：Tab 切换过渡闪烁（合成↔图鉴切换时轻微暗闪）
    // 修复（2026-11-08 真机 `doFrame ctx is not defined`）：此处此前误用裸 ctx / w / h ——
    // render() 作用域里三者都未定义 → 每次冷启动第 3 帧起（_lastRenderView 首次对齐前）与每次切 Tab
    // 都整帧抛 ReferenceError，连累 _safeResetIfFatal 强制复位。改用 this.ctx + this.width/height，
    // 且 _lastRenderView 首次记录（undefined）不触发暗闪，避免冷启动白闪一截。
    if (this._lastRenderView !== undefined && this.game.view !== this._lastRenderView) {
      this._tabFlash = 0.25;   // 250ms 暗闪
    }
    this._lastRenderView = this.game.view;
    if (this._tabFlash > 0) {
      this._tabFlash -= dt;
      const c = this.ctx;
      c.save();
      c.globalAlpha = Math.min(0.35, Math.max(0, this._tabFlash) * 1.4);
      c.fillStyle = '#0a0620';
      c.fillRect(0, 0, this.width, this.height);
      c.restore();
    }
    // 细节打磨：合成升级对比停顿帧（旧→新 大图对比，1.5s 自动消退）
    if (this.game.mergeReveal) this._drawMergeReveal();
    this.drawFloatTexts(dt);
    this.drawParticles(dt);
    if (shX || shY) this.ctx.restore();
  }
}

module.exports = { Renderer, clearMeasureTextCache, capForLevel };
