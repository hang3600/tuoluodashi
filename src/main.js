/**
 * 主循环与场景调度（打磨版）
 * - 全链路 try-catch 防崩
 * - 刘海屏/胶囊按钮安全区
 * - 变现护栏：广告位占位直接拦截不发奖
 * - 分享卡片 imageUrl 指向 images/share-card.jpg
 */

const { GameState, COIN_DRAW_COST } = require('./game');
const { Renderer } = require('./render');
const { InputHandler } = require('./input');
const { Sfx } = require('./audio');
// P2 注入优化（2026-11-01）：ads（25KB）/subscribe 非首帧必需 → 懒 require。
// 模块在 loop 首帧空闲（frame≥2）才加载（ensureAds/ensureSub）——最早可展示的广告
// 本就在 3s 后（预加载错峰 3s/5.5s/8s + 插屏 12s），无收益损失；削减启动注入期的
// JS 解析量（云测 Xiaomi 13 注入 423ms）。
let Rewarded = null, Interstitial = null;
function ensureAds() {
  if (!Rewarded) {
    const m = require('./ads');
    Rewarded = m.Rewarded;
    Interstitial = m.Interstitial;
  }
}
let Subscribe = null;
function ensureSub() {
  if (!Subscribe) Subscribe = require('./subscribe').Subscribe;
}
const { CONFIG } = require('./config');
const { UI } = require('./ui');   // ②2-1 触感/飘字节奏令牌
const { reportBoot, reportBattleDefeat, reportAdWatch, reportFunnelBoot, reportFunnelFirstBattle, reportFunnelD1Return } = require('./analytics'); // 零成本埋点：冷启动 / 战败 / 广告看完（P2 修复：此前抽卡位 adWatch 从未上报）+ 生死漏斗（P0-1）
// error-handler 用防御式加载：若开发者工具未将其扫进模块图（常见于外部工具新增文件后未重编译），
// 直接用空兜底，保证启动不崩；重新编译后自动加载真实实现。
let ErrorHandler;
try {
  ErrorHandler = require('./error-handler').ErrorHandler;
} catch (e) {
  ErrorHandler = { init() {}, capture() {} };
  console.warn('[boot] error-handler 未加载，已用空兜底；建议开发者工具点「清缓存并重新编译」', e && e.message);
}

class Main {
  constructor(canvas, ctx, sysInfo) {
    this.canvas = canvas;
    this.ctx = ctx;

    // 刘海屏 / 胶囊按钮安全区：严格在微信胶囊按钮下方 + 预留分隔空
    // - getMenuButtonBoundingClientRect 为权威来源（真机/开发者工具都会返回真正的胶囊矩形）
    // - statusBarHeight 作为兜底。
    // - safeBottom：新设备 Home 指示条 34px，小屏 24px，通过 screenHeight-windowHeight 算更准。
    let safeTop = 56;
    let safeBottom = 24;
    let menuBtn = null;
    try {
      if (typeof wx !== 'undefined') {
        if (wx.getMenuButtonBoundingClientRect) {
          const btn = wx.getMenuButtonBoundingClientRect();
          if (btn && typeof btn.top === 'number' && typeof btn.height === 'number' && btn.top > 0) {
            safeTop = Math.max(safeTop, btn.top + btn.height + 10); // 胶囊底 + 10px 气隙
            // 保存胶囊矩形（用于绘制「胶囊左侧手柄入口 · 更多小游戏」）
            menuBtn = { left: btn.left, top: btn.top, width: btn.width, height: btn.height };
          }
        }
        // 底部：若 screenHeight/windowHeight 差异存在，差值就是 iOS Home 指示条/安卓导航栏
        const sw = sysInfo && sysInfo.screenWidth;
        const sh = sysInfo && sysInfo.screenHeight;
        const wh = sysInfo && sysInfo.windowHeight;
        if (sw && sh && wh && canvas && (sh / sw) > 1.95) safeBottom = Math.max(safeBottom, 34);
        if (sw && sh && wh && sh > wh) safeBottom = Math.max(safeBottom, sh - wh);
      }
    } catch (e) {}
    if (sysInfo && typeof sysInfo.statusBarHeight === 'number' && sysInfo.statusBarHeight > 0) {
      safeTop = Math.max(safeTop, sysInfo.statusBarHeight + 18);
    }
    this._safeTopRaw = safeTop;    // 物理像素原始值，renderScale 确定后统一缩放
    this._safeBottomRaw = safeBottom;
    this._menuBtnRaw = menuBtn;    // 物理像素胶囊矩形，renderScale 后统一缩放
    this.safeTop = safeTop;
    this.safeBottom = safeBottom;

    // ============================================================
    // 设备性能档（启动时一次性判定，低端机直接降画质，不等运行时掉帧再救）
    // benchmarkLevel: 微信基础库 2.13+ 官方性能分（0-100），不可用回退内存/机型规则
    // LOW(<30) → 低画质：关装饰阴影+按下降影、战斗 30fps、粒子减半
    // MID(30-60) → 中画质：全特效、动态 60fps、粒子上限 140
    // HIGH(>60) → 高画质：全特效 + 60fps
    // ============================================================
    let perfLevel = 'MID';
    try {
      // 优先用构造传入的 sysInfo（与后续 safeTop/DPR 同源，避免重复 getSystemInfoSync）
      const si = (sysInfo && typeof sysInfo.benchmarkLevel === 'number') ? sysInfo
                : (typeof wx !== 'undefined' && wx.getSystemInfoSync ? wx.getSystemInfoSync() : null);
      if (si) {
        let bl = (typeof si.benchmarkLevel === 'number') ? si.benchmarkLevel : -1;
        // 【跨平台修复 #1】iOS 平台微信 benchmarkLevel 普遍虚低（同档实测渲染能力优于 Android），
        // 统一阈值会把 iPhone 中端误判为 MID → 对战被强制 30fps（main.js:987），明显比同档安卓卡、画质还降级。
        // 补偿偏移让 iOS 分档回归真实能力（仅影响分档，不动画质/阴影逻辑；LOW 档阈值 30 不变）。
        // 偏移量取 25：iPhone 中端(benchmark≈40)补后≈65→HIGH，对战 45fps；老 iOS(benchmark≈15)补后≈40→MID 仍保守。
        const isIOS = /ios/i.test(si.system || '') || si.platform === 'ios';
        if (bl >= 0 && isIOS) bl = bl + 25;
        if (bl < 0 && typeof si.model === 'string') {
          // 兜底：旧基础库无 benchmarkLevel，用内存/机型粗判
          const m = si.model.toLowerCase();
          if (si.deviceMemory && si.deviceMemory <= 2) bl = 20;
          else if (/(redmi note|redmi [0-9]|vivo y|vivo u|oppo a|huawei enjoy|honor play|honor x[0-9]|xiaomi [0-9]a)/.test(m)) bl = 25;
          else if (si.deviceMemory && si.deviceMemory <= 4) bl = 40;
          else bl = 70;
        }
        if (bl >= 0) {
          if (bl < 30) perfLevel = 'LOW';
          else if (bl <= 60) perfLevel = 'MID';
          else perfLevel = 'HIGH';
        }
      }
    } catch (e) {}
    this.perfLevel = perfLevel;

    // 数字嗓音字体（花叔范式「字体就是声音」· 2026-11-22）：Rajdhani 数字子集 1.7KB woff2，
    // loadFontFace 全局注册 'GameDigits'；LOW 档跳过（省一次字体内存映射，自动回退系统字）。
    if (perfLevel !== 'LOW') {
      try { require('./fontdigits').loadDigitFont(); } catch (e) {}
    }

    // LOW 档低分辨率渲染：Canvas 2D 软渲染成本与像素量成正比（荣耀Play5T 11fps / P20 22fps 卡 P0）。
    // 启动时一次性把 canvas 降到低分辨率，微信自动拉伸全屏；
    // 所有逻辑坐标用 canvas.width/height 自动适配。注：微信 touch 事件坐标本身是逻辑像素，input 不再反缩放（见 input.js _normalize）。
    // 仅在启动分档时定死，运行时降档不降分辨率（避免动态改 canvas 尺寸闪屏）。
    // LOW 内细分：bl<15 最差机（荣耀Play5T/Helio G25）0.55 倍（-70%），
    // bl 15-25 入门机 0.65 倍（-58%），其余 LOW 0.75 倍（-44%）。
    // ============================================================
    // ============================================================
    // 【跨平台修复 #3】canvas DPR 超采样（iOS/Android 清晰度统一）
    // 屏幕逻辑像素 = canvas 初始尺寸（game.js 已设为 windowWidth × fullH），作为布局基准恒定不变。
    // 非 LOW 档启用 DPR 超采样：canvas 物理尺寸 = 逻辑 × dpr（封顶 1.5，压内存峰值/纹理上限，兼顾清晰度）；
    // 所有绘制坐标保持逻辑像素，由主循环每帧 ctx.setTransform(dpr) 映射到物理像素。
    // LOW 档(最弱机)保持 1x，避免像素量×4致软渲染掉帧雪崩（呼应此前 945MB/卡顿治理）。
    // 注：原封顶 2x，鉴于高端机(iPhone 14/17)内存峰值 >1.4GB 有 OOM 风险，下调到 1.5x——
    // 主画布像素量较 2x 降 ~44%，视觉仅略软，内存峰值显著回落（降幅需真机体验分复测确认）。
    // input 触摸坐标已是逻辑像素（与 cw/ch 同坐标系），无需反缩放；下方 canvas.renderScale 仅保留兼容、input 已不再使用。
    // ============================================================
    this.cw = canvas.width;            // 逻辑宽（布局基准，恒定，不随 DPR 变）
    this.ch = canvas.height;           // 逻辑高
    const _sysDpr = (sysInfo && sysInfo.pixelRatio > 0) ? sysInfo.pixelRatio : 1;
    // 内存杠杆（云测 P1·内存峰值 60 分，2026-10-31）：LOW=1x（不变）；
    // MID 封顶 1.5 → 1.25（主画布物理缓冲 -30%，中档机视觉几乎无差）；HIGH 保持 1.5。
    // 注：DPR 仅启动分档时定死（运行时降档不降分辨率，避免闪屏，见下文注释）。
    const dpr = (this.perfLevel === 'LOW') ? 1 : Math.min(_sysDpr, this.perfLevel === 'MID' ? 1.25 : 1.5);
    this.dpr = dpr;
    if (typeof canvas === 'object' && canvas) {
      canvas.dpr = dpr;
      canvas.width = Math.round(this.cw * dpr);
      canvas.height = Math.round(this.ch * dpr);
    }
    this.renderScale = dpr;
    // 注：canvas.renderScale 不再用于 input 反缩放（微信 touch 坐标已是逻辑像素，input.js 直接用）。
    // 保留该字段仅作兼容，避免其他潜在引用在旧逻辑下报错。
    if (typeof canvas === 'object' && canvas) canvas.renderScale = dpr;

    // 胶囊矩形：物理像素 → canvas 逻辑坐标（canvas 逻辑宽 = windowWidth）
    if (this._menuBtnRaw) {
      let _sw = 375;
      try {
        const _si = (typeof wx !== 'undefined' && wx.getSystemInfoSync) ? wx.getSystemInfoSync() : null;
        if (_si && _si.screenWidth > 0) _sw = _si.screenWidth;
      } catch (e) {}
      // 换算基准是 canvas 逻辑宽（= windowWidth）。Main 类没有 this.width 字段，
      // 此前写 this.width 恒为 undefined → 取 375，在 393 宽的机型上系数只有 0.954，
      // 胶囊矩形与安全区都被缩小约 4.6%。与 updateSafeArea 保持同一写法。
      const css = Math.max(0.1, (this.canvas && this.cw > 0 ? this.cw : 375) / Math.max(1, _sw));
      this.menuBtn = {
        left: Math.round(this._menuBtnRaw.left * css),
        top: Math.round(this._menuBtnRaw.top * css),
        width: Math.max(20, Math.round(this._menuBtnRaw.width * css)),
        height: Math.max(20, Math.round(this._menuBtnRaw.height * css))
      };
    }
    // 安全区：物理像素 → 逻辑坐标（与胶囊同比例）
    if (this._safeTopRaw > 0) {
      let _sw2 = 375;
      try {
        const _si2 = (typeof wx !== 'undefined' && wx.getSystemInfoSync) ? wx.getSystemInfoSync() : null;
        if (_si2 && _si2.screenWidth > 0) _sw2 = _si2.screenWidth;
      } catch (e) {}
      const c2 = Math.max(0.1, (this.canvas && this.cw > 0 ? this.cw : 375) / Math.max(1, _sw2));
      this.safeTop = Math.max(20, Math.round(this._safeTopRaw * c2));
      this.safeBottom = Math.max(10, Math.round(this._safeBottomRaw * c2));
    }

    this.game = new GameState();

    // ==========================================================
    // 全局错误捕获与上报：在游戏状态创建后立即初始化
    // 捕获 wx.onError / window.error / unhandledrejection
    // 错误信息包含：错误消息、堆栈、时间戳、设备信息、游戏状态
    // ==========================================================
    try {
      ErrorHandler.init({
        gameState: this.game,
        report: CONFIG.crashReport,   // 运维中心崩溃上报（实时日志 + 计数告警，零后端）
        onError: (errorLog) => {
          // 自定义错误回调：可以在这里添加错误统计、用户提示等
          console.log('[Main] 错误已捕获:', errorLog.source, errorLog.message);
        }
      });
      // 暴露到全局，方便调试
      try { if (typeof wx !== 'undefined') wx.__bbErrorHandler = ErrorHandler; } catch (e) {}
    } catch (e) {
      console.warn('[Main] 错误捕获初始化失败:', e.message);
    }

    // 离线回归奖励：不在启动同步判定（首屏零阻挡）。
    // 延后触发（_maybePromptReturn，两条路径二选一、整局一次）：
    //   ① 玩家首次有效点击（onTap 命中任意可点元素）→ 立即触发；
    //   ② 玩家一直不交互 → loop() 在 CONFIG.returnGraceMs 后兜底触发。
    this._pendingReturnInit = true;
    this._bootStartTime = Date.now();
    // 注：签到面板不再启动期强制弹出（用户反馈：进首页就弹签到体验差，且行业少见）。
    // 改为玩家主动点「签到」按钮才打开（signin 动作 → signOpen=true）。
    // 订阅提醒(requestSubscribeMessage)仅在打卡流程内的手势触发：sign_claim / return_claim / adenergy，
    // 不在首页单独弹窗。autoSignAvailable 纯判定方法仍保留（可用于未来「可签到」红点提示）。
    this.renderer = new Renderer(canvas, ctx, this.game, this.safeTop, this.safeBottom, this.menuBtn);
    this.input = new InputHandler(canvas);
    this.audio = Sfx;
    // 对战模块（spintop）已拆为按需子包：首次进入对战时才 wx.loadSubpackage + 实例化，见 _ensureBattle()
    this.renderer.audio = this.audio;

    // 性能档落到各模块（对象创建之后，确保字段注入生效）
    this.game.lowFX = (perfLevel === 'LOW') ? 0 : 1;
    this.game.perfLevel = perfLevel;
    if (this.renderer) this.renderer.perfLevel = perfLevel;
    if (this.game.battle) { this.game.battle.perfLevel = perfLevel; this.game.battle._applyPerfLevel(); }
    this._applyPerfRuntime('init');   // 统一走运行时应用路径（含 _updateFx 同步阴影档）

    // 调试/预览钩子：暴露 Main 实例（浏览器预览验证特效用，真机无害）
    try { if (typeof wx !== 'undefined') wx.__bbMain = this; } catch (e) {}

    // 内存告警守卫：低端机（iPhone 7 仅 2GB RAM）在内存紧张时会被系统直接 kill，
    // 玩家侧就是「玩着玩着闪退」。必须早于任何重资源加载注册。
    this._setupMemoryGuard();

    this.lastTime = 0;
    // 自适应帧率：静态场景 30fps，动态场景（对战/抽卡/特效）60fps
    // 显著降低 iOS 高 CPU 占用，同时保住动态场景流畅度
    this._curFps = 60;
    this._frameAcc = 0;
    this.running = false;
    this._resultPlayed = false;
    this._chestShown = false;   // 本局竞技宝箱弹窗已提示标记
    this._fpsWin = [];   // 实时 FPS 滑动窗口（60 帧），用于运行时自动降档
    this._renderedThisFrame = false; // 本帧是否实际渲染（FPS 监控采样标记）
    this.lastBattleBb = null;
    this._adBusy = false;
    this._lastRewardedAd = 0;      // 上次被动激励位时间戳（ms），用于 ≥gapMin 间隔
    this._rewardsThisBattle = 0;   // 本局已展示的被动激励位次数（≤gameMax），每局重置
    this._fatalCount = 0;
    this._firstFrameRendered = false;
    this._introDone = false; this._introT = 0; this._introSounded = false;   // ③3-1 首屏呼吸感(一次性)
    this._clubGuideChecked = false; // 首帧后只检查一次游戏圈引导
    this._homeInterstitialTried = false;   // 首页插屏（进首页后仅弹一次/冷启动）守卫
    this._pendingAdsInit = true;   // P2 注入优化：广告对象 init 延到首帧空闲（见 loop）

    // 广告对象 init 延到 loop frame≥2 统一执行（_pendingAdsInit）——
    // 展示本就在 3s 后（预加载错峰），init 晚两帧零损失，换取注入窗口不含 ads 模块
    this._bindInput();
    this._initShare();

    if (typeof wx !== 'undefined' && wx.onShow) {
      wx.onShow((res) => {
        try { this.game._checkShareEntry(res); } catch (e) { console.warn('[onShow]', e); }
        // iOS 回前台：AudioContext 会被系统挂起，尝试恢复（被拒也无妨，下次触摸 input.js 会 unlock）
        try { if (this.audio) this.audio.resume(); } catch (e) {}
        // 首屏预热对战子包：启动即触发下载+实例化，比「开选陀螺面板才预热」更早，
        // 让用户逛首页/看开场动画时分包（~254KB）已下载就绪，点开始对战不再现场等分包下载
        // （尤其流量下 preloadRule 不再限 wifi、首屏 onShow 即预下）。_ensureBattle 幂等
        // （已有 battle / 正在加载则直接返回缓存），切后台回前台重复触发也无妨。失败静默吞。
        try { this._ensureBattle().catch(() => {}); } catch (e) {}
      });
    }

    // 切后台时立即存档（防止用户杀进程丢数据）
    if (typeof wx !== 'undefined' && wx.onHide) {
      wx.onHide(() => {
        try { this.game.save(true); } catch (e) {}
        try { if (this.audio) this.audio.stopSpin(); } catch (e) {}   // 切后台停旋转声
      });
    }

    // iOS 音频打断恢复：游戏中来电 / Siri / 其他 App 抢音频时，系统会挂起 AudioContext，
    // 此时 App 并未进后台、onShow 不会触发。若只靠 onShow 恢复，会导致之后所有战斗音效持续静音，
    // 直到用户手动切一次后台再回来。故在打断结束立即 resume；打断开始先停旋转声，避免挂起期卡住/重叠。
    if (typeof wx !== 'undefined') {
      if (wx.onAudioInterruptionEnd) {
        wx.onAudioInterruptionEnd(() => {
          try { if (this.audio) this.audio.resume(); } catch (e) {}
        });
      }
      if (wx.onAudioInterruptionBegin) {
        wx.onAudioInterruptionBegin(() => {
          try { if (this.audio) this.audio.stopSpin(); } catch (e) {}
        });
      }
    }

    // 注：全局错误兜底已统一由 ErrorHandler.init 注册的 wx.onError 处理，
    // 此处不再重复注册第二个 wx.onError（微信多次注册可能覆盖/重复，会把
    // ErrorHandler 的捕获冲掉或导致双份打印），所有未捕获异常都进 capture()。

    // 新玩家首抽延后：不在构造函数里同步抽 6 次（会阻塞首帧、抬高启动耗时），
    // 改为首屏(标题)渲染完成后由 loop 在空闲帧执行（首帧不依赖抽卡结果）。
    this._pendingNewPlayerInit = (this.game.inventory.length === 0);

    // 埋点：冷启动（P1 数据盲区）。进程内仅上报一次，后端按 openid 去重得启动用户数。
    reportBoot();
    // 生死漏斗（P0-1）：boot（每安装一次）+ D1 回访判定（安装日恰为昨天 → 次日回访）。
    reportFunnelBoot();
    reportFunnelD1Return();
  }

  /**
   * 延迟修正安全区与画布尺寸（jsbridge 冷启动后补正）
   */
  updateSafeArea(sysInfo) {
    try {
      // 真机全屏修复：物理像素 → canvas 逻辑坐标统一换算系数
      // （canvas 逻辑宽 = windowWidth，屏幕物理宽 = screenWidth）
      let _sw = 375;
      try {
        const _si = (typeof wx !== 'undefined' && wx.getSystemInfoSync) ? wx.getSystemInfoSync() : null;
        if (_si && _si.screenWidth > 0) _sw = _si.screenWidth;
      } catch (e) {}
      const css = Math.max(0.1, (this.canvas && this.cw > 0 ? this.cw : 375) / Math.max(1, _sw));
      // 从物理基准（_safeTopRaw）重新计算，避免与已换算的逻辑值混算
      let safeTop = this._safeTopRaw || 56;
      let safeBottom = this._safeBottomRaw || 24;
      let menuBtn = null;
      if (typeof wx !== 'undefined' && wx.getMenuButtonBoundingClientRect) {
        const btn = wx.getMenuButtonBoundingClientRect();
        if (btn && typeof btn.top === 'number' && typeof btn.height === 'number' && btn.top > 0) {
          safeTop = Math.max(safeTop, btn.top + btn.height + 10);
          menuBtn = { left: btn.left, top: btn.top, width: btn.width, height: btn.height };
        }
      }
      const sw = sysInfo && sysInfo.screenWidth;
      const sh = sysInfo && sysInfo.screenHeight;
      const wh = sysInfo && sysInfo.windowHeight;
      if (sw && sh && wh && (sh / sw) > 1.95) safeBottom = Math.max(safeBottom, 34);
      if (sw && sh && wh && sh > wh) safeBottom = Math.max(safeBottom, sh - wh);
      if (sysInfo && typeof sysInfo.statusBarHeight === 'number' && sysInfo.statusBarHeight > 0) {
        safeTop = Math.max(safeTop, sysInfo.statusBarHeight + 18);
      }
      // 统一物理 → 逻辑换算（不再除以 renderScale）
      this.safeTop = Math.max(20, Math.round(safeTop * css));
      this.safeBottom = Math.max(10, Math.round(safeBottom * css));
      if (menuBtn) {
        this.menuBtn = {
          left: Math.round(menuBtn.left * css),
          top: Math.round(menuBtn.top * css),
          width: Math.max(20, Math.round(menuBtn.width * css)),
          height: Math.max(20, Math.round(menuBtn.height * css))
        };
      }
      if (this.renderer) {
        this.renderer.safeTop = this.safeTop;
        this.renderer.safeBottom = this.safeBottom;
        this.renderer.W = this.cw;
        this.renderer.H = this.ch;
        if (this.menuBtn) this.renderer.menuBtn = this.menuBtn;
      }
      if (this.game && this.game.battle) {
        this.game.battle.width = this.cw;
        this.game.battle.height = this.ch;
        this.game.battle.safeTop = this.safeTop;
        this.game.battle.safeBottom = this.safeBottom;
      }
    } catch (e) {
      console.warn('[updateSafeArea]', e);
    }
  }

  /**
   * 旋转/尺寸变更回调（lateResize 触发）：更新逻辑尺寸并同步渲染器。
   * canvas 物理尺寸已由 lateResize 按 DPR 设定，这里只更新逻辑基准(cw/ch)与渲染器布局。
   */
  onResize(lw, lh) {
    try {
      this.cw = lw; this.ch = lh;
      if (this.renderer) this.renderer.resize(lw, lh);
      if (this.game && this.game.battle) {
        this.game.battle.width = lw;
        this.game.battle.height = lh;
      }
    } catch (e) {
      console.warn('[onResize]', e);
    }
  }

  _safeResetIfFatal() {
    if (++this._fatalCount >= 3) {
      try {
        if (this.game.battle) this.game.battle.end();
        this.game.mode = 'main';
        // 注意：不要清空 platformSlots —— 合成台上的陀螺是玩家持有物，清台会造成丢档
        this.game.filterTier = -1;
      } catch (e) {}
      this._fatalCount = 0;
      this._toast('界面异常已重置');
    }
  }

  /** 运行时性能降档：benchmark 分高但实际卡顿的设备（如伪旗舰）自动降一档 */
  _applyPerfRuntime(reason) {
    try {
      const g = this.game;
      if (g) g.perfLevel = this.perfLevel;
      if (g && g.battle) { g.battle.perfLevel = this.perfLevel; g.battle._applyPerfLevel(); }
      if (this.renderer) { this.renderer.perfLevel = this.perfLevel; this.renderer._updateFx(); }
      // 性能模式切换仅后端自动处理，不弹前端 Toast 提示（用户要求无感切换）
      console.log('[perf] runtime downgrade:', reason);
    } catch (e) {}
  }

  /**
   * 注册系统内存告警监听（低端机防 OOM 闪退）。
   *
   * 背景：iPhone 7 只有 2GB RAM，微信自身已占一大块。系统内存吃紧时，
   * 若进程不主动释放，会被系统直接 kill —— 玩家看到的就是「玩着玩着闪退」，
   * 且不带任何 JS 异常，埋点也抓不到。wx.onMemoryWarning 是唯一的提前预警。
   *
   * 分级：
   *  - level 5（轻度）：只清纯计算型缓存，不降档，玩家几乎无感
   *  - level >= 10（紧张/危险）：强制降到 LOW 档 + 清离屏画布与粒子
   *
   * 注意：不锁死 LOW 档。运行时 FPS 监控（loop 内）仍可在帧率确实跑得动时升回，
   * 避免过度干预让机器一直卡在最低画质。
   */
  _setupMemoryGuard() {
    try {
      if (typeof wx === 'undefined' || typeof wx.onMemoryWarning !== 'function') return;
      const self = this;
      wx.onMemoryWarning(function (res) {
        // 告警回调可能在任意时机触发（含渲染中途），整体兜 try 避免打断主循环
        try { self._onMemoryWarning(res && res.level); } catch (e) {}
      });
    } catch (e) {}
  }

  /** 处理一次内存告警：清缓存 → （严重时）强制降档。level 缺失按 10（紧张）处理，宁严勿松。 */
  _onMemoryWarning(level) {
    const lv = (typeof level === 'number') ? level : 10;
    try {
      // 1) 渲染侧缓存（渐变/文本测量/图鉴签名；lv>=10 追加背景离屏画布与粒子）
      let freed = {};
      if (this.renderer && typeof this.renderer._clearMemoryCaches === 'function') {
        freed = this.renderer._clearMemoryCaches(lv) || {};
      }
      // 2) 陀螺 sprite 离屏缓存（最多 60 张小离屏画布，内存大头）。
      //    懒 require：不增加启动期模块依赖，也规避潜在循环依赖；取不到就跳过，不影响主流程。
      let spr = 0;
      try {
        if (this._bbClearSprite === undefined) {
          const bb = require('./beyblade');
          this._bbClearSprite = (bb && typeof bb.clearSpriteCache === 'function') ? bb.clearSpriteCache : null;
        }
        if (this._bbClearSprite && lv >= 10) spr = this._bbClearSprite();
      } catch (e) {}
      // 2.5) 对战离屏 canvas / 背景图缓存（内存告警时释放，下一帧自修复重建；高端机 OOM 风险主因之一）
      try {
        if (this.game && this.game.battle && typeof this.game.battle._clearBattleCaches === 'function') {
          const bc = this.game.battle._clearBattleCaches();
          if (typeof bc === 'number' && bc > 0) freed.battle = bc;
        }
      } catch (e) {}
      // 3) 严重告警 → 强制降 LOW 档（复用现成的运行时应用路径，含阴影档同步）
      let downgraded = false;
      if (lv >= 10 && this.perfLevel !== 'LOW') {
        this.perfLevel = 'LOW';
        this._applyPerfRuntime('memory-warning:lv' + lv);
        downgraded = true;
      }
      // 4) 清 FPS 采样窗口：降档后目标帧率变了，旧样本会误导后续升档判断
      if (this._fpsWin) this._fpsWin.length = 0;

      console.warn('[mem] warning lv=' + lv
        + ' freed=' + JSON.stringify(freed)
        + ' sprite=' + spr
        + ' perfLevel=' + this.perfLevel
        + (downgraded ? ' (强制降档)' : ''));
    } catch (e) {
      console.warn('[mem] warning handler failed:', e && e.message);
    }
  }

  _bindInput() {
    this.input.onTap = (p) => {
      try {
        // 抽卡动画态：仅允许"收入背包"关闭，屏蔽一切其它点击穿透
        if (this.game.drawCard) {
          const h2 = this.renderer.hitTest(p.x, p.y);
          if (h2 && h2.type === 'button' && h2.action === 'draw_close') this._dismissDrawCard();
          return;
        }
        const hit = this.renderer.hitTest(p.x, p.y);
        if (!hit) return;
        // P2 细度：returnDeferToSettle 开启时，首屏点击不再触发回归礼包（延后到首次结算，
        // 见 update() 的结算触发点；30s 无交互兜底仍在 loop 里）
        if (!CONFIG.returnDeferToSettle) this._maybePromptReturn(); // 首次有意义交互即检测回归礼包（选项A：交互早于兜底则立即弹）
        if (hit.type === 'tutorial') { this.game.advanceTutorial(); this.audio.play('click'); return; }
        if (hit.type === 'sign_close') { this.game.signOpen = false; return; }
        switch (hit.type) {
          case 'button': {
            const a = hit.action;
            if (a === 'draw') {
              // 能量不足 → 金币应急抽卡（金币目前唯一的消耗出口）。
              // 金币是「用积累换速度」，能量是免费途径（6/秒自动回满），二者并行不冲突。
              // 免费抽卡券优先（签到第2/4/6天 + 分享发放；D1 留客钩子 2026-11-20）：
              // 有券先免费抽（不扣能量/金币），没有才走能量→金币路径。
              if (this.game.freeDraws > 0) {
                this.game.consumeFreeDraw();
                this._doDraw(p, { useCoins: false, free: true, coupon: true });
              } else {
                // 隐藏式抽卡插屏：抽卡成功后由 _doDraw 计数 + 待弹，收卡时自动弹出（见 _dismissDrawCard）。
                this._doDraw(p, { useCoins: this.game.energy < 8, free: false });
              }
            } else if (a === 'draw_close') {
              this._dismissDrawCard();
            } else if (a === 'merge') {
              const merged = this.game.tryMerge();
              if (merged) {
                merged._glowT = Date.now();   // 陀螺即角色：出炉 1.2s 金环余晖（render.drawPlatform 读）
                // 细节打磨：合成升级对比停顿帧——让玩家看到 Lv 前后的贴图差异
                this.game.mergeReveal = { tierIndex: merged.tierIndex, oldLevel: merged.level - 1, newLevel: merged.level, t: 0 };
                const cx = this.cw / 2;
                const cy = (this.renderer.layout && this.renderer.layout.arenaCy) || (this.ch * 0.42);
                const fromLv = merged.level - 1; // 合成前等级（升级反馈）
                const col = merged.tier.color;
                const isBig = merged.tierIndex >= 4;
                // 合成成功动效：双环冲击波（品质色主环 + 金色扩散环）
                this.renderer.addRing(cx, cy, col);
                this.renderer.addRing(cx, cy, '#ffd54f');
                // 品质色大粒子爆（传说更多）+ 白色闪光点缀
                this.renderer.addParticles(cx, cy, col, isBig ? 44 : 28);
                this.renderer.addParticles(cx, cy, '#ffffff', 10);
                // 升级浮字：Lv.N → Lv.N+1（品质色）+ 金币
                this.renderer.addFloatText(cx, cy - 34, 'Lv' + fromLv + ' → Lv' + merged.level, col);
                this.renderer.addFloatText(cx, cy - 60, '+' + merged.power, '#ffd54f');
                this.audio.play('merge');
                // 批次D·彩蛋（play-design v1）：累计合成触发隐藏传说「流星陀螺」
                if (typeof this.game.checkHiddenEgg === 'function') {
                  const egg = this.game.checkHiddenEgg();
                  if (egg) {
                    this.audio.play('win');
                    this._toast('发现隐藏白虎·流星陀螺！合成 ' + (egg.count * 50) + ' 次达成');
                    this.renderer.addParticles(cx, cy - 60, '#b388ff', 40);
                    this.renderer.addRing(cx, cy - 60, '#b388ff');
                    this.renderer.addFloatText(cx, cy - 100, '流星陀螺！', '#b388ff');
                  }
                }
              } else {
                // 满级检测：同品质同等级且已达 Lv5 → 满级专属提示动效（区别于"不匹配"）
                const slots = this.game.platformSlots;
                let maxed = false;
                for (let i = 0; i < slots.length; i++) {
                  for (let j = i + 1; j < slots.length; j++) {
                    const a = slots[i], b = slots[j];
                    if (a && b && a.tierIndex === b.tierIndex && a.level === b.level && a.level >= 5) { maxed = true; }
                  }
                }
                if (maxed) {
                  const mx = this.cw / 2;
                  const my = (this.renderer.layout && this.renderer.layout.arenaCy) || (this.ch * 0.42);
                  this.renderer.addParticles(mx, my, '#ff5252', 18);
                  this.renderer.addFloatText(mx, my - 40, '已达满级 Lv5', '#ff5252');
                  this.renderer.addFloatText(mx, my - 62, '不可再合成', '#ffd54f');
                  this.audio.play('click');
                } else {
                  this._toast('需要两个同品质·同等级陀螺');
                }
              }
            } else if (a === 'battle_quick') {
              // 出战陀螺选择面板（选项B）：V2 主「对战」按钮发的是 battle_quick，点它先选陀螺，取代直接开战
              this._openBattleSelect();
            } else if (a === 'coop') {
              // 双人合作守关（同屏交替传机·纯客户端）：只记战绩不发资源
              this._startCoop();
            } else if (a === 'coop_pass') {
              this._startCoopPass();
            } else if (a === 'buff') {
              // 增益小按钮：用当前出战陀螺直接打开「局前增益面板」（保留原 buff 功能，独立于选陀螺面板）
              const bbB = this.game.selectBattleBeyblade();
              if (bbB) { this.game.buffBb = bbB; this.game.buffOpen = true; this.game.buffT = 0; this.audio.play('click'); }
              else { this._toast('先抽卡或合成一个陀螺'); }
            } else if (a === 'battle') {
              // 出战陀螺选择面板（选项B）：开战前显式选陀螺
              this._openBattleSelect();
            } else if (a.indexOf('battle_select_pick_') === 0) {
              // 点行 = 仅选中（可见反馈：行高亮 + ✓ 出战 + 顶部「已选」文案 + 0.3s 点选脉冲 + 音效）
              // 开战统一走「开始对战」，避免列表翻页/浏览时误触直接开战
              const gsel = this.game;
              gsel.battleSelectId = a.slice('battle_select_pick_'.length);
              // 点选脉冲：给"点了有反应"的即时反馈（连点已选中的那一行也能看到），替代"每次点选弹一条 toast"
              gsel.battleSelectFlashId = gsel.battleSelectId;
              gsel.battleSelectFlashT = 0.3;
              // 「已选择 XX · 点开始对战」文字提示**只在首次**（新用户第一次点选）弹一次，之后永久静默：
              // 面板本身已有行高亮 + ✓ 出战 + 顶部「已选：XX」文案，每选一只都弹一条字纯属噪音（用户反馈）
              if (!gsel.battleSelectHinted) {
                const sb = gsel._findBbById(gsel.battleSelectId);
                if (sb) this._toast('已选择 ' + sb.tier.name + ' Lv' + sb.level + ' · 点「开始对战」开战');
                gsel.battleSelectHinted = true;
                if (typeof gsel.save === 'function') { try { gsel.save(); } catch (e) {} }
              }
              this.audio.play('click');
            } else if (a === 'battle_select_confirm') {
              this._beginBattleWithSelected();
            } else if (a === 'battle_select_close') {
              this.game.battleSelectOpen = false;
              this.audio.play('click');
            } else if (a === 'battle_select_prev') {
              // 翻页边界给明确反馈：单页/首页时提示「已是第一页」，不再静默无效（防"点了没反应"）
              const gp = this.game;
              if ((gp.battleSelectPage | 0) <= 0) { this._toast('已是第一页'); }
              else { gp.battleSelectPage = (gp.battleSelectPage | 0) - 1; this.audio.play('click'); }
            } else if (a === 'battle_select_next') {
              const gn = this.game;
              const totalPages = Math.max(1, gn.battleSelectPages | 0);
              if ((gn.battleSelectPage | 0) >= totalPages - 1) { this._toast('已是最后一页'); }
              else { gn.battleSelectPage = (gn.battleSelectPage | 0) + 1; this.audio.play('click'); }
            } else if (a === 'battle_again') {
              // #6 核心循环无缝化：连胜中「再战」免 20 能量门票，把连胜串起来，不被能量门槛打断。
              this._battleAgain();
            } else if (a === 'ultimate') {
              // #8 怒气必杀：满怒时 HUD「必杀」按钮触发，全屏演出 + 得分爆发
              const b = this.game.battle;
              if (b && typeof b._releaseUltimate === 'function') {
                const ok = b._releaseUltimate();
                if (!ok) this._toast('怒气未满，无法释放必杀');
              }
            } else if (a === 'buff_close') {
              this.game.buffOpen = false;
            } else if (a === 'buff_buy_fullspeed') {
              this._confirmBattleBuff('fullspeed');
            } else if (a === 'buff_buy_targetdown') {
              this._confirmBattleBuff('targetdown');
            } else if (a === 'buff_buy_doublepower') {
              this._confirmBattleBuff('doublepower');
            } else if (a === 'buff_skip') {
              this._confirmBattleBuff(null);
            } else if (a === 'run_buff_0' || a === 'run_buff_1' || a === 'run_buff_2') {
              // 批次E·选一张 run buff，叠层并打下一关（续战免门票）
              const idx = parseInt(a.slice(-1), 10);
              const b = this.game.battle._runBuffChoices && this.game.battle._runBuffChoices[idx];
              if (!b) { this._toast('增益数据缺失'); return; }
              const stage = this.game.battle.runStage + 1;
              const buffs = this.game.battle.runBuffs.concat(b.id);
              const bb = this.lastBattleBb || this.game.selectBattleBeyblade();
              if (!bb) { this._toast('请先选择陀螺'); return; }
              this.game.runBuffOpen = false;
              this.lastBattleBb = bb; this._chestShown = false;
              this._startBattle(bb, null, { active: true, stage: stage, buffs: buffs });
              this.game.mode = 'battle';
              this.audio.play('clash');
            } else if (a === 'run_buff_skip') {
              // 批次E·结束连战（保留已得金币，回结算页）
              this.game.battle.runActive = false;
              this.game.runBuffOpen = false;
            } else if (a === 'battle_share') {
              this._shareResult();
            } else if (a === 'battle_recommend') {
              // 官方「评价与推荐·朋友推荐」组件（2026-11-21）：高光时刻（胜利）拉起推荐组件。
              // 推荐内容展示在启动小游戏时/搜索结果/发现-小程序等场景，帮游戏吸引更多用户。
              // 官方明确不提倡道具奖励刺激推荐 → 纯自发引导，无任何奖励挂钩。
              this._openGameRecommend();
            } else if (a === 'battle_share_coop') {
              // 双人合作·邀约分享（纯邀请、无奖励，非诱导分享）
              this._shareResultCoop();
            } else if (a === 'battle_result_double') {
              // 胜利结算翻倍（文章验证最优激励位）：看广告金币翻倍
              this._watchResultDouble();
            } else if (a === 'battle_back') {
              // 结算页「返回首页」= 用户主动手势 → 插屏作为间歇后果弹出（自然间歇弹点，启动即弹已废弃）
              this.game.runBuffOpen = false; this._endBattle(); this.game.mode = 'main';
              this._maybeShowHomeInterstitial();
              // D1 留客钩子（2026-11-20）：结算返回手势内追加「每日提醒」订阅请求——
              // 旧覆盖面只有签到/回归礼包手势，玩家不签到就永不授权 → 无推送 → 无次日拉回。
              // 会话内每类模板仅弹一次（_maybePromptSubscribe 内部守卫），合规且不骚扰。
              this._maybePromptSubscribe(['daily']);
            }
            else if (a === 'club_enter') { this.game.closeClubGuide(); this._openGameClub(); }
            else if (a === 'club_guide_close') { this.game.closeClubGuide(); }
            else if (a === 'club') { this._openGameClub(); }
            else if (a === 'mute') { this.audio.toggle(); }
            else if (a === 'tutorial_skip') { this.game.tutorialDone = true; this.game.tutorialStep = 2; this.audio.play('click'); }
            else if (a === 'moregames') { this._openMoreGames(); }
            else if (a === 'signin') { this.game.signOpen = true; this.audio.play('click'); }
            else if (a === 'sign_close') { this.game.signOpen = false; }
            // P2-6 福利中心：签到/每日任务/好友助力 合并单入口（红点 + 直跳）
            else if (a === 'welfare') {
              const gw = this.game;
              gw.offlineOpen = false; gw.signOpen = false; gw.dailyOpen = false;
              gw.boostOpen = false; gw.arenaOpen = false; gw.weekShopOpen = false;
              gw.welfareOpen = true; gw.welfareT = 0;
              this.audio.play('click');
            }
            else if (a === 'welfare_close') { this.game.welfareOpen = false; }
            else if (a === 'welfare_go_sign') { this.game.welfareOpen = false; this.game.signOpen = true; this.game.signT = 0; this.audio.play('click'); }
            else if (a === 'welfare_go_daily') { this.game.welfareOpen = false; this.game._checkDailyReset(); this.game.dailyOpen = true; this.game.dailyT = 0; this.audio.play('click'); }
            else if (a === 'welfare_go_boost') { this.game.welfareOpen = false; this.game.boostOpen = true; this.game.boostT = 0; this.audio.play('click'); }
            else if (a === 'sign_makeup') {
              if (this.game.makeupSign()) {
                this.audio.play('click');
                this._toast('补签成功，连续签到已恢复');
              } else { this._toast('当前无需补签'); }
            }
            else if (a === 'return_claim') {
              const r = this.game.claimReturn();
              if (r) {
                this.audio.play('win');
                let txt = (r.grand ? '炉火未熄 · 回归大礼包：' : '炉火未熄 · 回归礼包：') + '+' + r.coins + '金币 能量回满';
                if (r.coupon) txt += ' · 白虎保底券';
                this.renderer.addFloatText(this.cw / 2, this.ch * 0.4, txt, '#ffd54f');
                this._toast(txt);
                // 高意图手势内请求次日/回归订阅（留存拉回）；会话内仅弹一次，模板未配则静默
                this._maybePromptSubscribe(['daily', 'offline']);
              }
            }
            else if (a === 'return_close') { this.game.offlineOpen = false; this.game._pendingReturn = null; }
            else if (a === 'chest_open') {
              // 青铜宝箱「开启」：当日首次免费开；之后每次强制看广告，看完广告才开箱
              if (!this.game.battleChest) { this._toast('没有可开的宝箱'); return; }
              if (this.game.isChestFreeOpenAvailable()) {
                // 当日首次：免费直接开
                const r = this.game.openBattleChest(false);
                if (r) {
                  this.audio.play('win');
                  this.renderer.addParticles(this.cw / 2, this.ch * 0.4, '#ffd54f', 30);
                  this._toast('宝箱开启：' + r.reward.name + (r.reward.type === 'beyblade' ? ' 入账！' : ''));
                } else { this._toast('宝箱开启失败'); }
                if (!this.game.battleChest) this.game.battleChestOpen = false;
              } else {
                // 非首次：必须先看广告（看完广告后才开箱）。广告不可用则降级免费开，防卡死。
                if (this._adBusy) return;   // 玩家主动点的按钮广告：不做冷却档（开箱失败另有免费降级）
                this._adBusy = true;
                Rewarded.show({
                  adUnitId: CONFIG.chestAdUnitId,
                  onReward: () => {
                    this._adBusy = false;
                    const r = this.game.openBattleChest(true);
                    if (r) {
                      this.audio.play('win');
                      this.renderer.addParticles(this.cw / 2, this.ch * 0.4, '#ffd54f', 30);
                      this._toast('宝箱开启：' + r.reward.name + (r.reward.type === 'beyblade' ? ' 入账！' : ''));
                    } else { this._toast('没有可开的宝箱'); }
                    if (!this.game.battleChest) this.game.battleChestOpen = false;
                  },
                  onFail: (err) => {
                    this._adBusy = false; this.game.chestAdBroken = true;
                    // 降级兜底：广告拉不到也允许免费开启，避免玩家卡在弹窗（与历史 chest_free_force 一致）
                    const r = this.game.openBattleChest(false, true);
                    if (r) {
                      this.audio.play('win');
                      this.renderer.addParticles(this.cw / 2, this.ch * 0.4, '#ffd54f', 30);
                      this._toast('广告暂不可用 · 已免费开启：' + r.reward.name);
                    } else { this._toast('暂无可开宝箱'); }
                    if (!this.game.battleChest) this.game.battleChestOpen = false;
                  },
                  onClose: () => { this._adBusy = false; }
                });
              }
            }
            else if (a === 'chest_close') {
              // 无论广告是否可用，用户随时可关闭弹窗返回游戏（防卡死底线）
              this.game.battleChestOpen = false;
            }
            else if (a === 'boost_open') { this.game.boostOpen = true; this.audio.play('click'); }
            else if (a === 'boost_close') { this.game.boostOpen = false; }
            else if (a === 'boost_claim') {
              if (this.game.claimBoost()) {
                this.audio.play('win');
                this._toast('好友助力 +15 能量 · 今日 ' + this.game.boostCount + '/5');
                this.renderer.addFloatText(this.cw / 2, this.ch * 0.4, '+15 能量', '#ffd54f');
              } else { this._toast('今日助力已领完（5/5），明天再来'); }
            }
            // P0-2 好友榜页签切换（开放数据域渲染，主域只切 board 并通知）
            else if (a === 'ldb_arena') { this.game.ldbBoard = 'arena'; this.audio.play('click'); }
            else if (a === 'ldb_high') { this.game.ldbBoard = 'high'; this.audio.play('click'); }
            else if (a === 'ldb_streak') { this.game.ldbBoard = 'streak'; this.audio.play('click'); }
            else if (a === 'ldb_share') { this._shareLeaderboard(); }
            // P0-3 金币洗词条（金币硬出口）：重掷当前选中陀螺的词条
            else if (a === 'trait_reroll') {
              const rb = this.game._findBbById(this.game.battleSelectId);
              if (!rb) { this._toast('先选择一只陀螺'); }
              else {
                const r = this.game.rerollTraits(rb);
                if (r) {
                  this.audio.play('draw');
                  this._toast('词条已重掷（-' + r.cost + ' 金币）：' + r.names.join(' / '));
                } else {
                  this._toast('金币不足（需 ' + this.game.rerollTraitsCost(rb) + '）');
                }
              }
            }
            else if (a === 'daily') { this.game._checkDailyReset(); this.game.dailyOpen = true; this.audio.play('click'); }
            else if (a === 'daily_close') { this.game.dailyOpen = false; }
            else if (a === 'arena') { this.game.arenaOpen = true; this.audio.play('click'); }
            else if (a === 'arena_close') { this.game.arenaOpen = false; }
            // P1-5 激斗周末·限时商店
            else if (a === 'weekshop') {
              const gws = this.game;
              gws.arenaOpen = false; gws.signOpen = false; gws.dailyOpen = false;
              gws.levelOpen = false; gws.offlineOpen = false; gws.boostOpen = false;
              gws.weekShopOpen = true; gws.weekShopT = 0;
              this.audio.play('click');
            }
            else if (a === 'wshop_close') { this.game.weekShopOpen = false; }
            else if (a === 'wshop_buy_energy' || a === 'wshop_buy_coupon' || a === 'wshop_buy_legend') {
              const key = a.slice('wshop_buy_'.length);
              const r = this.game.buyWeekShopItem(key);
              if (r && r.ok) {
                this.audio.play('win');
                this.renderer.addParticles(this.cw / 2, this.ch * 0.4, '#ffd54f', 24);
                this._toast('已购买：' + r.item.name + ' · ' + r.effect);
              } else if (r && r.error === 'coins') {
                const meta = this.game.weekendShopMeta();
                const it2 = meta.items.find(i => i.key === key);
                this._toast('金币不足（需 ' + (it2 ? it2.cost : '?') + '）');
              }
              else if (r && r.error === 'limit') { this._toast('本周限购已用完'); }
              else if (r && r.error === 'nonweekend') { this._toast('限时商店仅周末开放'); }
            }
            // P1-7 影子战：复刻历史最佳纪录局（目标分 ≥ 纪录 ×1.05）
            else if (a === 'ghost_challenge') {
              const gbb = this.game.selectBattleBeyblade();
              if (!gbb) { this._toast('先抽卡或合成一个陀螺'); return; }
              this.game.buffBb = gbb;
              this._confirmBattleBuff(null, { stage: this.game.ghostStage || 1, ghost: true });
            }
            // P1-6 挑战券：看广告 +2 / 分享 +2
            else if (a === 'ticket_ad') {
              if (this._adBusy) return;
              this._adBusy = true;
              Rewarded.show({
                adUnitId: CONFIG.energyAdUnitId,
                onReward: () => {
                  this._adBusy = false;
                  const n = this.game.grantBonusTickets(2, 'ad');
                  this.audio.play('click');
                  this._toast(n > 0 ? ('挑战券 +' + n + '（现有 ' + this.game.bonusTickets + '）') : '今日广告得券已用完');
                },
                onFail: () => { this._adBusy = false; this._toast('广告暂不可用'); },
                onClose: () => { this._adBusy = false; }
              });
            }
            else if (a === 'ticket_share') { this._share(); }
            // 出售二次确认：确认出售 / 取消
            else if (a === 'sell_confirm') {
              const gain = this.game.confirmSell();
              if (gain) {
                this.audio.play('merge');
                this.renderer.addParticles(this.cw / 2, this.ch / 2, '#ffd54f', 16);
                this.renderer.addFloatText(this.cw / 2, this.ch / 2 - 30, '+' + gain + ' 金币', '#ffd54f');
                this._toast('出售 +' + gain + ' 金币');
              }
            }
            else if (a === 'sell_cancel') { this.game.cancelSell(); this.audio.play('click'); }
            else if (a === 'level') { this.game.levelOpen = true; this.audio.play('click'); }
            else if (a === 'level_close') { this.game.levelOpen = false; }
            else if (a === 'codex_claim') {
              const st = this.game.claimCodexStage();
              if (st) {
                this.audio.play('win');
                const r = st.reward || {};
                let txt = '「' + st.title + '」';
                if (r.coins) txt += ' +' + r.coins + '金币';
                if (r.energy) txt += ' +' + r.energy + '能量';
                if (r.master) txt += ' · 全图鉴限定皮肤';
                this.renderer.addFloatText(this.cw / 2, this.ch * 0.4, txt, '#ffd54f');
                this._toast('图鉴奖励：' + txt);
              } else { this._toast('暂无可领阶段'); }
            }
            else if (a === 'daily_claim') {
              const reward = this.game.claimDailyChest();
              if (reward) {
                this.audio.play('win');
                let txt = '';
                if (reward.type === 'coins') txt = '+' + reward.value + ' 金币';
                else if (reward.type === 'energy') txt = '+' + reward.value + ' 能量';
                else if (reward.type === 'top') txt = reward.value + '!';
                this.renderer.addFloatText(this.cw / 2, this.ch * 0.42, txt, '#ffd54f');
                this._toast('宝箱开启：' + txt);
              } else { this._toast('活跃度未满或今日已领取'); }
            }
            else if (a === 'inv_prev') {
              // 陈列轨道模式：翻页改为按屏横向滚动（网格模式仍走 invPage）
              if (this.renderer.invRailV2On && this.renderer.invRailV2On()) {
                this.renderer.scrollInventoryByScreen(-1); this.audio.play('click');
              } else if (this.game.invPage > 0) { this.game.invPage--; this.audio.play('click'); }
            } else if (a === 'inv_next') {
              if (this.renderer.invRailV2On && this.renderer.invRailV2On()) {
                this.renderer.scrollInventoryByScreen(1); this.audio.play('click');
              } else {
                const L = this.renderer.layout;
                const cap = Math.max(1, L.invCols * this.renderer.inventoryRowsMax());
                const pages = Math.max(1, Math.ceil(this.game.getFilteredInventory().length / cap));
                if (this.game.invPage < pages - 1) { this.game.invPage++; this.audio.play('click'); }
              }
            } else if (a === 'inv_page') {
              this._toast('点左右箭头翻页 · 长按陀螺可出售');
            } else if (a === 'sign_claim') {
              const reward = this.game.checkIn();
              if (reward) {
                this.audio.play('win');
                let txt = '';
                if (reward.coins) txt += '+' + reward.coins + '金币 ';
                if (reward.energy) txt += '+' + reward.energy + '能量 ';
                if (reward.freeDraw) txt += '免费抽卡券×' + reward.freeDraw + ' ';
                if (reward.beyblade) txt += '白虎陀螺!';
                this.renderer.addFloatText(this.cw / 2, this.ch * 0.42, txt.trim(), '#ffd54f');
                // 锻造立场文案（花叔范式「文案有立场」· 2026-11-22）：「开炉」替代通用「签到」
                this._toast('今日开炉 · 第' + reward.day + '天：' + txt.trim());
                // 签到成功后自动关闭签到面板，回到主界面后光晕不再闪
                this.game.signOpen = false;
                // 高意图手势内请求次日订阅（留存拉回）；会话内仅弹一次，模板未配则静默
                this._maybePromptSubscribe(['daily']);
              }
            } else if (a === 'refill') {
              if (this.game.freeRefill()) {
                this.audio.play('click');
                this.renderer.addFloatText(this.cw - 70, 30 + this.safeTop, '能量回满', '#00e676');
                this._toast('能量已回满');
              } else { this._toast('今日回满已用完'); }
            } else if (a === 'adenergy') {
              if (this._adBusy) return;
              if (!this.game.canWatchAdEnergy()) { this._toast('今日广告次数已用完'); return; }
              this._adBusy = true;
              Rewarded.show({
                adUnitId: CONFIG.energyAdUnitId,
                onReward: () => {
                  this.game.watchAdEnergy(); this.audio.play('click');
                  this.renderer.addFloatText(this.cw - 70, 30 + this.safeTop, '能量 +60', '#00e676');
                  this._toast('看广告能量 +60');
                  this._maybePromptSubscribe(['energy']); // 高意图手势：刚拿到能量，顺带请求体力恢复提醒
                },
                onFail: () => { this._adBusy = false; this._toast('广告暂不可用'); },
                onClose: () => { this._adBusy = false; }
              });
            } else if (a === 'battle_revive') {
              if (this._adBusy) return;   // 玩家主动点的按钮广告：不做冷却档（靠各自每日上限）
              this._adBusy = true;
              Rewarded.show({
                onReward: () => { if (this.lastBattleBb) { this._startBattle(this.lastBattleBb); this.audio.play('clash'); } },
                onFail: () => {
                  this._adBusy = false;
                  // 兜底：广告不可用时不让玩家直接死，免费复活一次（广告真失败时才有此分支；看完的正常路径已被 ads.js settled 守卫拦截，不会走到这里）
                  if (this.lastBattleBb) { this._startBattle(this.lastBattleBb); this.audio.play('clash'); this._toast('广告暂不可用 · 已为你免费复活'); }
                  else { this._toast('广告暂不可用'); }
                },
                onClose: () => { this._adBusy = false; }
              });
            }
            break;
          }
          case 'tab': this.game.view = hit.view; if (hit.view === 'codex') this.game.codexGlowT = 0; this.audio.play('click'); break;
          case 'filter': this.game.filterTier = hit.tierIndex; this.game.invPage = 0; this.renderer.invScrollX = 0; break;
          case 'platform': this.game.takeFromPlatform(hit.index); break;
          case 'inventory': {
            const emptyIdx = this.game.platformSlots.findIndex(s => s === null);
            if (emptyIdx >= 0) { this.game.placeOnPlatform(emptyIdx, hit.beyblade); }
            break;
          }
        }
      } catch (e) { console.warn('[onTap]', e); }
    };

    let dragSource = null;
    let invDrag = null;          // 背包轨道滑动候选：{ x0, y0, mode, lastX, vel, scrollStart }
    this._invDragging = false;   // 是否正在横滑背包轨道（控制惯性是否暂停）
    this.input.onDragStart = (t) => {
      try {
        // 按下瞬间触发按钮按下态（0.94 微缩 + 下沉），松手/点击后释放
        this.renderer.pressAt(t.x, t.y);
        if (this.game.mode === 'battle' && this.game.battle && this.game.battle.phase === 'playing') {
          this.game.battle.whipStart(t.x, t.y); return;
        }
        // 主页背包陈列轨道：手指落在轨道上 → 候选横滑/拎起（横向滑动浏览，纵向向上拎起放到合成台）
        if (this.renderer.invRailV2On() && this.renderer.invMaxScroll() > 0) {
          const rr = this.renderer.invRailRect();
          if (t.x >= rr.x && t.x <= rr.x + rr.w && t.y >= rr.y && t.y <= rr.y + rr.h) {
            const hit = this.renderer.hitTest(t.x, t.y);
            if (!hit || hit.type === 'inventory') {
              invDrag = { x0: t.x, y0: t.y, mode: null, lastX: t.x, vel: 0, scrollStart: this.renderer.invScrollX };
              if (hit && hit.type === 'inventory') dragSource = hit.beyblade;
              return; // 方向待定，先不入通用 carry
            }
          }
        }
        const hit = this.renderer.hitTest(t.x, t.y);
        if (hit && hit.type === 'inventory') {
          dragSource = hit.beyblade;
          this.renderer.drag = { beyblade: hit.beyblade, x: t.x, y: t.y };
        }
      } catch (e) { console.warn('[dragStart]', e); }
    };
    this.input.onDragMove = (touches) => {
      try {
        if (this.game.mode === 'battle' && this.game.battle && this.game.battle.phase === 'playing' && touches && touches.length) {
          const t = touches[touches.length - 1];
          this.game.battle.whipMove(t.x, t.y); return;
        }
        const t = touches[0];
        if (invDrag && t) {
          const dx = t.x - invDrag.x0;
          const dy = t.y - invDrag.y0;
          // 方向判定（阈值 8px、取主导轴）：横向 → 滑动浏览；纵向向上 → 拎起放到合成台
          if (!invDrag.mode) {
            if (Math.abs(dx) > 8 && Math.abs(dx) >= Math.abs(dy)) invDrag.mode = 'scroll';
            else if (dy < -8 && Math.abs(dy) > Math.abs(dx)) invDrag.mode = 'carry';
          }
          if (invDrag.mode === 'scroll') {
            this._invDragging = true;
            const maxScroll = this.renderer.invMaxScroll();
            this.renderer.invScrollX = Math.max(0, Math.min(maxScroll, invDrag.scrollStart - dx));
            const v = t.x - invDrag.lastX;
            invDrag.vel = invDrag.vel * 0.6 + v * 0.4; // 平滑速度，供松手惯性
            invDrag.lastX = t.x;
          } else if (invDrag.mode === 'carry') {
            if (!this.renderer.drag && dragSource) this.renderer.drag = { beyblade: dragSource, x: t.x, y: t.y };
            if (this.renderer.drag) { this.renderer.drag.x = t.x; this.renderer.drag.y = t.y; }
          }
          return;
        }
        if (this.renderer.drag && t) { this.renderer.drag.x = t.x; this.renderer.drag.y = t.y; }
      } catch (e) { console.warn('[dragMove]', e); }
    };
    this.input.onDragEnd = (t) => {
      try {
        this.renderer.releasePressedBtn();
        if (this.game.mode === 'battle' && this.game.battle && this.game.battle.phase === 'playing' && this.game.battle.isWhipping) {
          this.game.battle.whipEnd(t.x, t.y); return;
        }
        if (invDrag) {
          this._invDragging = false;
          if (invDrag.mode === 'scroll') {
            // 松手惯性：把平滑速度交 renderer 每帧衰减（_stepInvInertia）
            this.renderer._invVel = Math.max(-40, Math.min(40, invDrag.vel * 1.1));
          } else if (invDrag.mode === 'carry') {
            const hit = this.renderer.hitTest(t.x, t.y);
            if (hit && hit.type === 'platform') { this.game.placeOnPlatform(hit.index, dragSource); }
          }
          this.renderer.drag = null;
          invDrag = null; dragSource = null;
          return;
        }
        if (!this.renderer.drag) return;
        const hit = this.renderer.hitTest(t.x, t.y);
        if (hit && hit.type === 'platform') { this.game.placeOnPlatform(hit.index, dragSource); }
        this.renderer.drag = null;
        dragSource = null;
      } catch (e) { console.warn('[dragEnd]', e); }
    };

    this.input.onLongPress = (p) => {
      try {
        const hit = this.renderer.hitTest(p.x, p.y);
        if (hit && hit.type === 'inventory') {
          this.renderer.drag = null;
          // 出售二次确认：长按打开确认弹窗，不直接出售
          const opened = this.game.openSellConfirm(hit.beyblade);
          if (opened) {
            this.game.sellT = 0;
            this.audio.play('merge');
          }
        }
      } catch (e) { console.warn('[longPress]', e); }
    };
  }

  start() {
    this.running = true;
    this.lastTime = Date.now();
    this._curFps = 60;
    this._frameAcc = 0;
    this.loop();
  }

  stop() { this.running = false; }

  /** 新玩家首抽：延后到首屏渲染后执行，避免阻塞首帧（压低 P2 启动耗时） */
  _initNewPlayer() {
    try {
      for (let i = 0; i < 6; i++) this.game.draw();
      // 新用户体验（2026-11-01）：6 抽 5 品质，鸽笼原理必出同品质对 →
      // 自动预置一对上合成台（槽 0/2，中央格留空——selectBattleBeyblade 的出战兜底
      // 仍回落到背包最佳），让「合成」玩法在首分钟可见可试，不再零曝光。
      const byTier = {};
      for (const bb of this.game.inventory) {
        (byTier[bb.tierIndex] = byTier[bb.tierIndex] || []).push(bb);
      }
      for (let t = 0; t < 5; t++) {
        const pair = byTier[t];
        if (pair && pair.length >= 2) {
          this.game.placeOnPlatform(0, pair[0]);
          this.game.placeOnPlatform(2, pair[1]);
          break;
        }
      }
      this.game.energy = 80;
    } catch (e) { console.warn('[initDraw]', e); }
    this._pendingNewPlayerInit = false; // 自带复位，方法幂等、防重复执行
  }

  /**
   * 拉起官方「朋友推荐」组件（评价与推荐 · 开发接入 2026-11-21）。
   * 官方最佳实践：pageManager + 推荐组件 OPENLINK 常量（官方文档"直接复制即可，无需理解含义"）。
   * load 预加载 → show 展示；destroy 回调 isRecommended=true 表示玩家完成了推荐（基础库 3.8.6+）。
   * 官方明确不提倡道具奖励刺激推荐 → 纯自发引导，无奖励挂钩，也就无需防刷计数。
   */
  _openGameRecommend() {
    try {
      if (typeof wx === 'undefined' || !wx.createPageManager) {
        this._toast('当前微信版本暂不支持推荐');
        return;
      }
      const RECOMMEND_OPENLINK = 'TWFRCqV5WeM2AkMXhKwJ03MhfPOieJfAsvXKUbWvQFQtLyyA5etMPabBehga950uzfZcH3Vi3QeEh41xRGEVFw';
      // 复用实例（官方示例 recommendPageManager 模块级复用）；失败则重建
      if (this._recPM) {
        this._recPM.show({ openlink: RECOMMEND_OPENLINK }).catch(() => {});
        return;
      }
      const pm = wx.createPageManager();
      this._recPM = pm;
      pm.on && pm.on('destroy', (res) => {
        // 玩家关闭推荐组件：isRecommended=true 表示完成了一次真实推荐
        if (res && res.isRecommended) this._toast('感谢推荐！你的推荐会帮到更多玩家');
      });
      pm.load({ openlink: RECOMMEND_OPENLINK })
        .then(() => pm.show({ openlink: RECOMMEND_OPENLINK }))
        .catch((e) => { console.warn('[recommend]', e); this._toast('推荐组件暂时打不开，稍后再试'); this._recPM = null; });
    } catch (e) { console.warn('[recommend]', e); this._toast('推荐组件暂时打不开，稍后再试'); }
  }

  // 打开游戏圈（流量主条件二 · 有效活跃）：从小游戏内进入游戏圈产生互动
  _openGameClub() {
    try {
      if (typeof wx === 'undefined' || !wx.createPageManager) {
        this._toast('当前环境暂不支持游戏圈');
        return;
      }
      // 未配置 openlink 时入口按钮本身就不会渲染（见 render.js 胶囊行），
      // 这里只做防御：静默返回。绝不把"请先在后台配置"这类开发者话术暴露给玩家。
      if (!CONFIG.gameClubOpenlink) {
        console.warn('[club] gameClubOpenlink 未配置，入口应已隐藏');
        return;
      }
      const pm = wx.createPageManager();
      pm.load({ openlink: CONFIG.gameClubOpenlink })
        .then(() => pm.show())
        .catch((e) => { console.warn('[club]', e); this._toast('游戏圈暂时打不开，稍后再试'); });
    } catch (e) { console.warn('[club]', e); this._toast('游戏圈暂时打不开，稍后再试'); }
  }

  _initShare() {
    if (typeof wx === 'undefined') return;
    // 被动转发：右上角「···」菜单的「转发」按钮。
    // 注意 showShareMenu 的参数必须是 menus，withShareTicket 是 updateShareMenu 的参数；
    // 之前写错成 withShareTicket，导致转发按钮大概率不显示，直接砍掉分享裂变入口。
    if (wx.onShareAppMessage) {
      wx.onShareAppMessage(() => ({
        title: '陀螺大师｜免费抽陀螺，合成白虎来对战！',
        query: 'from=share',
        imageUrl: CONFIG.shareCardImage
      }));
    }
    // 朋友圈转发（防御式：仅当平台支持时注册）
    if (wx.onShareTimeline) {
      wx.onShareTimeline(() => ({
        title: '陀螺大师｜免费合成白虎陀螺，单手就能玩',
        query: 'from=share',
        imageUrl: CONFIG.shareCardImage
      }));
    }
    if (wx.showShareMenu) {
      wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] });
    }
  }

  // 打开「更多小游戏」（胶囊左侧手柄入口）
  // 仅当 config.js 配好 moreGamesOpenlink 时入口才渲染（见 render.js 胶囊行），
  // 这里做真实跳转；未配置时入口不出现，此分支仅作防御。
  _openMoreGames() {
    try {
      if (this.audio) this.audio.play('click');
    } catch (e) {}
    if (!CONFIG.moreGamesOpenlink) {
      console.warn('[moregames] moreGamesOpenlink 未配置，入口应已隐藏');
      return;
    }
    if (typeof wx === 'undefined' || !wx.createPageManager) {
      this._toast('更多小游戏 · 敬请期待');
      return;
    }
    try {
      const pm = wx.createPageManager();
      pm.load({ openlink: CONFIG.moreGamesOpenlink })
        .then(() => pm.show())
        .catch((e) => { console.warn('[moregames]', e); this._toast('聚合页暂时打不开，稍后再试'); });
    } catch (e) { console.warn('[moregames]', e); this._toast('聚合页暂时打不开，稍后再试'); }
  }

  _share() {
    if (typeof wx !== 'undefined' && wx.shareAppMessage) {
      wx.shareAppMessage({
        title: '陀螺大师｜免费抽陀螺，合成白虎来对战！',
        query: 'from=share',
        imageUrl: CONFIG.shareCardImage
      });
    }
    if (this.game.doShare()) {
      this.audio.play('click');
      this.renderer.addFloatText(this.cw - 70, 30 + this.safeTop, '能量+20 券+2', '#00e676');
      this._toast('分享成功：能量 +20 · 挑战券 +2 · 免费抽卡券 +1');
    } else {
      this._toast('今日分享奖励已用完');
    }
  }

  // 对战胜利炫耀：分享战绩（不带能量奖励，纯裂变拉新）
  /**
   * 战报分享卡（花叔范式 08 · 2026-11-24）：离屏 canvas 动态生成本局战绩图（500×400, 5:4）
   * ——大分数用 GameDigits 数字嗓音，锻造金框；生成失败回落 CONFIG.shareCardImage 静态图。
   * 离屏 canvas 复用（_shareCvs），避免每次分享新建组件。
   */
  _makeResultShareImage(done) {
    try {
      if (typeof wx === 'undefined' || !wx.createCanvas || !wx.canvasToTempFilePath) { done(null); return; }
      if (!this._shareCvs) this._shareCvs = wx.createCanvas();
      const c = this._shareCvs;
      c.width = 500; c.height = 400;
      const ctx = c.getContext('2d');
      const b = this.game.battle;
      const score = (b && b.score) || 0;
      const stage = (b && b.runStage) || 1;
      const streak = this.game.winStreak || 0;
      const mult = (this.game.streakMultiplier && this.game.streakMultiplier()) || 1;
      // 宇宙底
      const g = ctx.createLinearGradient(0, 0, 0, 400);
      g.addColorStop(0, '#241448');
      g.addColorStop(1, '#0a0620');
      ctx.fillStyle = g; ctx.fillRect(0, 0, 500, 400);
      // 锻造金框
      ctx.strokeStyle = '#ffd54f'; ctx.lineWidth = 3;
      ctx.strokeRect(10, 10, 480, 380);
      // 标题
      ctx.fillStyle = '#ffd54f'; ctx.font = 'bold 22px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('陀螺大师 · 对战战报', 250, 52);
      // 陀螺盘点缀（代码绘制：紫盘 + 金弧轨迹）
      ctx.strokeStyle = '#7e57c2'; ctx.lineWidth = 5;
      ctx.beginPath(); ctx.arc(250, 292, 44, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = '#ffd54f'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(250, 292, 56, -0.6, Math.PI * 1.15); ctx.stroke();
      // 大分数（GameDigits 全局字体，LOW 档自动回退系统字）
      ctx.fillStyle = '#ffffff'; ctx.font = 'bold 72px GameDigits, sans-serif';
      ctx.fillText(String(score), 250, 158);
      // 战绩行
      ctx.font = 'bold 18px sans-serif'; ctx.fillStyle = '#ffd54f';
      ctx.fillText('第 ' + stage + ' 关 · ' + ((b && b.isBoss) ? 'BOSS 战' : '胜利') + ' · 连胜 ×' + streak + ' · 奖励 ×' + mult + ' 倍', 250, 214);
      // 人话号召
      ctx.font = '14px sans-serif'; ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.fillText('目标 ' + ((b && b.targetScore) || 0) + ' 分 · 你也来转一转？', 250, 246);
      // 底部
      ctx.font = '12px sans-serif'; ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillText(new Date().toLocaleDateString('zh-CN') + ' · 微信搜索「陀螺大师」', 250, 372);
      wx.canvasToTempFilePath({
        canvas: c, x: 0, y: 0, width: 500, height: 400, destWidth: 500, destHeight: 400,
        fileType: 'png', quality: 1,
        success: (res) => done(res.tempFilePath),
        fail: () => done(null)
      });
    } catch (e) { done(null); }
  }

  _shareResult() {
    const b = this.game.battle;
    const streak = this.game.winStreak || 1;
    const share = (imageUrl) => {
      if (typeof wx !== 'undefined' && wx.shareAppMessage) {
        wx.shareAppMessage({
          title: '我打到了 ' + ((b && b.score) || 0) + ' 分 · 连胜 x' + streak + '，敢来挑战吗？',
          query: 'from=share',
          imageUrl: imageUrl || CONFIG.shareCardImage
        });
      }
      this.audio.play('click');
      this._toast('分享成功');
    };
    this._makeResultShareImage((img) => share(img));
  }

  // P0-2 好友榜「炫耀战绩 · 挑战好友」：带真实战绩钩子的分享卡片
  //（连胜/最高分都是真数据；无任何战绩时回落到通用文案，不出现空数字）
  _shareLeaderboard() {
    const streak = this.game.streakWeekMax || this.game.winStreak || 0;
    const high = this.game.highScore || 0;
    let title;
    if (streak >= 2 && high > 0) title = '我在陀螺大师连胜 x' + streak + '、单局 ' + high + ' 分，敢来跟我打一场吗？';
    else if (streak >= 2) title = '我在陀螺大师连胜 x' + streak + '，敢来跟我打一场吗？';
    else if (high > 0) title = '我在陀螺大师单局打出 ' + high + ' 分，敢来跟我打一场吗？';
    else title = '陀螺大师｜免费抽陀螺，合成白虎来对战！';
    if (typeof wx !== 'undefined' && wx.shareAppMessage) {
      wx.shareAppMessage({ title: title, query: 'from=share', imageUrl: CONFIG.shareCardImage });
    }
    this.audio.play('click');
    this._toast('把战绩分享给好友吧');
  }

  // 抽卡统一入口：执行 game.draw 并播放仪式动画/保底特效。
  // opts.useCoins: 用金币支付（能量不足应急）；opts.free: 看广告免费抽（不扣能量/金币）。
  // 复用现有 draw 动画、保底反馈、节庆掉落、经验、每日任务逻辑（全在 game.draw 内部）。
  _doDraw(p, opts) {
    const useCoins = !!opts.useCoins;
    const free = !!opts.free;
    if (useCoins && this.game.coins < COIN_DRAW_COST) {
      this._toast('能量不足，稍等回能或看广告');
      return null;
    }
    const pityBefore = { epic: this.game.pityEpic || 0, legend: this.game.pityLegend || 0 };
    const bb = this.game.draw(useCoins, free);
    if (bb) {
      // 隐藏式抽卡插屏：累计抽数 + 安排待弹（按抽数选 draw3/draw6/draw9/rand2 独立位）
      this.game.drawsSinceAd++;
      this._maybeScheduleDrawAd();
    }
    if (free && opts.coupon) this._toast('免费抽卡券 -1（余 ' + this.game.freeDraws + '）——签到/分享可得');
    else if (free) this._toast('看广告免费抽卡 +1');
    else if (useCoins) this._toast('金币抽卡 -' + COIN_DRAW_COST + '（余 ' + this.game.coins + '）');
    if (bb) {
      if (this.game.lastDrawConverted) {
        // 背包已满：本抽折算为金币，不播「获得卡牌」动画，避免 UI 与结果不符
        this._toast('背包已满，+' + this.game.lastDrawConverted + ' 金币已入账');
      } else {
        // 抽卡仪式感：卡牌翻开动画（bb 已入背包，仅展示）
        this.game.drawCard = { bb, t: 0 };
        // 成熟感·出货音效分层（2026-11-21）：传说出货 = 三连音琶音号角（此前与普通抽卡同为单音）
        if (bb.tierIndex >= 4 && this.audio && this.audio.play) this.audio.play('legend');
        this.renderer.addParticles(p.x, p.y, bb.tier.color, 16);
        // 保底出货：史诗/传说保底触发 → 强力出货反馈（环 + 大粒子 + 震屏）
        // draw() 内部先 +1 再判保底（pityLegend>=30 / pityEpic>=10），故 draw 前 >=29 / >=9 即本次必触发
        const isPityLegend = pityBefore.legend >= 29;
        const isPityEpic = pityBefore.epic >= 9;
        const fxX = this.cw / 2, fxY = this.ch * 0.42;
        if (isPityLegend) {
          this.renderer.addRing(fxX, fxY, '#ffd54f');
          this.renderer.addParticles(fxX, fxY, '#ffd54f', 40);
          this.renderer.addParticles(fxX, fxY, '#ffffff', 14);
          this.renderer.shake(10, 0.5);
          this.renderer.addFloatText(fxX, fxY - 80, '保底必出白虎！', '#ffd54f');
        } else if (isPityEpic) {
          this.renderer.addRing(fxX, fxY, bb.tier.color);
          this.renderer.addParticles(fxX, fxY, bb.tier.color, 28);
          this.renderer.shake(6, 0.35);
        }
        this.audio.play('draw');
        // 限时活动（play-design v1）：节日限定额外掉落提示
        if (this.game._festivalDrop) {
          const fd = this.game._festivalDrop;
          this.game._festivalDrop = null;
          this._toast('节日限定掉落！' + fd.tier.name + '·Lv' + fd.level);
        }
      }
    }
    return bb;
  }

  // 在高意图手势（签到成功 / 领回归礼包）后请求订阅消息，拉回次日留存。
  // 按模板类型分别守卫（会话内每种类型最多弹一次），避免重复骚扰；
  // daily/energy/offline 互不阻塞，确保三个订阅场景都能在各自「高意图手势」内弹出。
  // 模板未配置 / 无 wx / 无 API 时由 Subscribe.request 静默 no-op。
  _maybePromptSubscribe(types) {
    try {
      if (typeof Subscribe === 'undefined') return;
      const list = (types && types.length) ? types : ['daily'];
      if (!this._subscribedTypes) this._subscribedTypes = {};
      const pending = list.filter(t => !this._subscribedTypes[t]);
      if (pending.length === 0) return;
      pending.forEach(t => { this._subscribedTypes[t] = true; });
      ensureSub();               // P2 注入优化：懒 require（订阅最早也在签到/领奖手势后才用）
      Subscribe.request(pending);
    } catch (e) {}
  }

  // 回归礼包延后弹（首屏零阻挡）：首次有意义交互即检测离线时长并弹回归面板。
  // 整局只触发一次（_pendingReturnInit 守卫，与 loop() 兜底共用）：
  //   ① 玩家先交互（onTap 命中任意可点元素）→ 立即触发；
  //   ② 玩家一直不交互 → loop() 在 CONFIG.returnGraceMs 后兜底触发，避免离线奖励沉没。
  // 真正是否弹由 game.checkReturn 内部离线时长（≥6h）判定，此处只负责时机。
  _maybePromptReturn() {
    try {
      if (!this._pendingReturnInit) return;
      this._pendingReturnInit = false;
      if (typeof this.game.checkReturn === 'function') this.game.checkReturn();
    } catch (e) {}
  }

  _toast(msg) {
    try {
      if (typeof wx !== 'undefined' && wx.showToast) {
        wx.showToast({ title: msg, icon: 'none', duration: 1500 });
      } else if (typeof console !== 'undefined') {
        console.log('[toast]', msg);
      }
    } catch (e) {}
  }

  /**
   * 抽卡激励广告：抽卡成功后调用，决定是否安排「收卡时自动弹出」的激励视频。
   * 规则层（每3抽必弹+随机补、每日上限）在 game.shouldScheduleDrawInterstitial()。
   * 这里把命中的广告位 key 记到 game._drawRewardKey；收卡时由 _dismissDrawCard 自动弹出激励视频（隐藏式、无按钮）。
   */
  _maybeScheduleDrawAd() {
    if (this.game._drawRewardKey) return;               // 已有待看广告位，不叠加
    const key = this.game.shouldScheduleDrawInterstitial(); // 返回位 key 或 null（抽卡激励广告位）
    if (!key) return;                                  // 本次抽卡不安排广告
    this.game._drawRewardKey = key;                    // 收卡时据此自动弹出对应激励视频位
    // P2 细度：隐藏式广告预告——抽中即告知，给玩家知情预期（广告仍在收卡手势内弹出）。
    if (CONFIG.drawAdPreview !== false) {
      this._toast((CONFIG.drawAdRewardMode || 'redraw') === 'redraw'
        ? '本次抽卡含 1 段短广告 · 看完免费再抽 1 次'
        : '本次抽卡含 1 段短广告 · 看完 +' + (CONFIG.drawAdRewardCoins || 0) + ' 金币');
    }
  }

  /**
   * 收卡时调用：关闭抽卡动画，并在本次抽卡命中广告位时自动弹出激励视频。
   * 隐藏自动弹（无按钮、无选择）；看完（onReward）给小额金币奖励（config.drawAdRewardCoins，默认 50），拉高看完率与计费曝光：
   * 抽卡流程中点第3/6/9抽（及循环、逢2随机）收卡后直接弹激励视频，看完计当日上限。
   * 触发链：收卡这一下本身是用户点击手势 → Rewarded.show 在其内同步调用（ad.load().then(show) 在手势窗口内）→ 满足微信激励视频需用户手势触发的要求。
   */
  _dismissDrawCard() {
    const adKey = this.game._drawRewardKey;
    const gotBb = !!this.game.drawCard && !this.game.lastDrawConverted;   // 本次收卡是否真收入了陀螺
    this.game.drawCard = null;
    this.game._drawRewardKey = null; // 收卡即消费该次广告位
    // P2 细度：首次收卡 → 图鉴引导（一次性）：新陀螺已收录，指向 25 格收集的长线目标
    if (gotBb && typeof this.game.nudgeCodex === 'function' && this.game.nudgeCodex()) {
      this._toast('新陀螺已收录图鉴 · 集齐 25 格领阶段大奖');
      this.game.codexGlowT = 8;   // 图鉴入口呼吸光晕 8s（打开图鉴即消）
    }
    if (!adKey) return;
    const unitMap = { draw3: CONFIG.drawAdUnitId3, draw6: CONFIG.drawAdUnitId6, draw9: CONFIG.drawAdUnitId9, rand2: CONFIG.drawAdUnitIdRand };
    const unit = unitMap[adKey];
    if (!unit) return;
    if (!this._adFreqGate()) {
      // P2 广告优化（2026-11-01）：频控拦截时 key **顺延到下一次收卡**（此前直接丢弃 = 收益沉没）。
      // 玩家无感知（他们不知道有广告被调度）；下一次收卡时 gate 窗口已过即自动补播。
      this.game._drawRewardKey = adKey;
      return;
    }
    const rewardCoins = CONFIG.drawAdRewardCoins || 0;
    const redrawMode = (CONFIG.drawAdRewardMode || 'redraw') === 'redraw';
    ensureAds();   // P2 注入优化：首次真实使用才加载 ads 模块
    Rewarded.show({
      adUnitId: unit,
      onReward: () => {
        if (typeof reportAdWatch === 'function') reportAdWatch(); // 看完漏斗（U10）：监控看完率
        // P2 广告优化：奖励升级「+50 金币」→「免费再抽 1 次」——抽卡场景下再抽的感知价值
        // 远高于小额金币 → 完播率↑收益↑，玩家感受是"赚了"。mode='coins' 可回退旧行为。
        if (redrawMode) {
          this._pendingFreeRedraw = true;   // 广告完全关闭（onClose ended）后自动执行免费再抽
        } else if (rewardCoins > 0 && this.game) {
          this.game.coins += rewardCoins;
          if (typeof this.game.save === 'function') { try { this.game.save(); } catch (e) {} } // 发奖落盘，防崩溃丢金
          this._toast('看广告 +' + rewardCoins + ' 金币');
          if (this.renderer && typeof this.renderer.addFloatText === 'function') {
            this.renderer.addFloatText(this.cw / 2, this.ch * 0.42, '+' + rewardCoins + ' 金币', '#ffd54f');
          }
        }
      },
      onClose: (ended) => {
        if (ended) this.game.markDrawInterstitialShown(); // 计当日抽卡广告上限
        // 奖励升级：广告完全看完后自动执行免费再抽——此时才起卡牌动画，时序正确；
        // 免费再抽走 _doDraw free 路径（零消耗），其 drawsSinceAd++ 自然延续 3/6/9 节奏
        if (ended && this._pendingFreeRedraw) {
          this._pendingFreeRedraw = false;
          this._doDraw({ x: this.cw / 2, y: this.ch * 0.42 }, { free: true });
        }
      }
    });
  }

  // 对战模块懒加载：首次进入对战才下载 battle 子包并实例化 SpintopBattle。
  // 主包不再静态依赖子包；子包模块必须用相对路径 ../battle/spintop.js 动态 require
  //（裸路径 'battle/spintop.js' 会被解析成 src/battle/spintop.js 而找不到），
  // 且必须在 wx.loadSubpackage 的 success 回调里调用。
  _ensureBattle() {
    if (this.game.battle) return Promise.resolve(this.game.battle);
    if (this._battleLoading) return this._battleLoading;
    this._battleLoading = new Promise((resolve, reject) => {
      const instantiate = () => {
        try {
          const SpintopBattle = require('../battle/spintop.js').SpintopBattle;
          const bb = new SpintopBattle(this.game, this.cw, this.ch);
          bb.audio = this.audio;
          bb.safeTop = this.safeTop;
          bb.safeBottom = this.safeBottom;
          bb.perfLevel = this.game.perfLevel;
          if (typeof bb._applyPerfLevel === 'function') bb._applyPerfLevel();
          bb.doubleAvailable = !!CONFIG.resultDoubleAdUnitId;   // 结算翻倍入口：无广告位则不下发
          this.game.battle = bb;
          this._battleLoading = null;
          resolve(bb);
        } catch (e) { this._battleLoading = null; reject(e); }
      };
      if (typeof wx !== 'undefined' && typeof wx.loadSubpackage === 'function') {
        wx.loadSubpackage({
          name: 'battle',
          success: instantiate,
          fail: (err) => { this._battleLoading = null; reject(err || new Error('loadSubpackage failed')); }
        });
      } else {
        instantiate(); // 浏览器/Node 预览：直接同步 require
      }
    });
    return this._battleLoading;
  }

  // 统一入口：确保对战模块就绪后再 start（首次有子包下载延迟，属正常按需加载）
  _startBattle(bb, buff, opts) {
    // 生死漏斗（P0-1）：首战（每安装一次，胜/负都算）。此处是全部开战路径唯一入口
    //（首战/连胜再战/复活/连战下一关/合作均经此），去重由 analytics 内部守卫。
    reportFunnelFirstBattle();
    this._resultDoubled = false;   // 结算翻倍：每局重置（同局只能翻一次）
    this._rewardsThisBattle = 0;   // 频控：本局已弹的被动激励位清零
    this._ensureBattle()
      .then((b) => { b.start(bb, buff || null, opts || undefined); })
      .catch((e) => {
        console.error('[Main] 对战模块加载失败:', e && e.message);
        this._toast('对战模块加载失败，请重试');
      });
  }

  _endBattle() {
    if (this.game.battle) this.game.battle.end();
  }

  // 批次D·局前 buff 确认：校验金币/能量门槛 → 扣费 → 开战
  /** #11 首屏可玩：一键开战 —— 主按钮直接进入战斗，跳过局前增益面板。
   *  增益降级为右侧可选小按钮（action 'battle'），点了才打开增益面板。
   *  开战前的校验（陀螺 / 20 能量门票）完全沿用 _confirmBattleBuff，不绕过任何规则。 */
  // 批次F·出战陀螺选择面板入口（选项B）：开战前显式选陀螺
  _openBattleSelect() {
    const g = this.game;
    if (g.inventory.length === 0 && !g.platformSlots[1]) { this._toast('先抽卡或合成一个陀螺'); return; }
    // 面板互斥：关掉其它模态面板，避免多面板叠加导致按钮命中错位（如回归礼包面板叠上来）
    g.offlineOpen = false; g.signOpen = false; g.dailyOpen = false;
    g.arenaOpen = false; g.levelOpen = false; g.buffOpen = false;
    g.battleChestOpen = false; g.boostOpen = false; g.sellConfirm = false;
    // 默认高亮：已持久选中的，否则战力最高（或合成台中央格）
    let def = null;
    if (g.battleBbId) def = g._findBbById(g.battleBbId);
    if (!def) def = g.selectBattleBeyblade();
    g.battleSelectId = def ? def.id : null;
    g.battleSelectPage = 0;
    g.battleSelectOpen = true;
    g.battleSelectT = 0;
    this.audio.play('click');
    // 预热对战子包：打开选陀螺面板即触发下载+实例化，把分包网络等待与 instantiate 重活
    // 摊到选陀螺交互期间。避免点「开始对战」瞬间 mode 翻成 battle 而 game.battle 尚未就绪、
    // 渲染落回首页（render.js:4641 要求 mode&&battle 才画对战）造成「首页卡一下」的瞬态，
    // 首次进入（分包需网络下载）最明显。失败静默吞掉，不影响选陀螺面板本身。
    this._ensureBattle().catch(() => {});
  }

  // 选陀螺面板：「开始对战」用当前选中（或合成台中央格兜底）的陀螺直接开战。
  // 一步到位，不再经中间「局前增益面板」——减少断点。能量/陀螺门禁仍走 _confirmBattleBuff。
  // 点某一行只做「选中」（有高亮 + toast 反馈），避免浏览/翻页时误触直接开战。
  _beginBattleWithSelected() {
    const g = this.game;
    const id = g.battleSelectId;
    let bb = id ? g._findBbById(id) : null;
    if (!bb && g.platformSlots[1]) bb = g.platformSlots[1];
    g.battleSelectOpen = false;
    if (!bb) { this._toast('请先选择一只陀螺'); return; }
    g.setBattleBeyblade(bb);   // 持久化出战选择
    g.buffBb = bb;
    this._confirmBattleBuff(null);   // 直接开战（内部含 20 能量门票校验）
  }

  _quickBattle() {
    const bb = this.game.selectBattleBeyblade();
    if (!bb) { this._toast('先抽卡或合成一个陀螺'); return; }
    this.game.buffBb = bb;
    this._confirmBattleBuff(null);   // null = 不带增益，直接开战
  }

  _confirmBattleBuff(buff, battleOpts) {
    const cost = buff ? this._buffCost(buff) : 0;
    if (buff && this.game.coins < cost) { this._toast('金币不足'); return; }
    const bb = this.game.buffBb;
    if (!bb) { this._toast('请先选择陀螺'); return; }
    // P1-6 挑战券：免费券(5/日) → 加发券 → 能量门票(20)，逐层消耗。
    // 只作用于「新开一局」；连胜「再战」走 _battleAgain 的免票路径，不过此层。
    const t = this.game.consumeBattleTicket();
    if (!t) { this._toast('能量不足，无法开战'); return; }
    this.game.buffOpen = false;
    this.game.coins -= cost;
    this.lastBattleBb = bb;
    this._chestShown = false;
    this._startBattle(bb, buff, Object.assign({ active: true, stage: 1, buffs: [] }, battleOpts || {}));
    this.game.mode = 'battle';
    this.audio.play('clash');
    if (typeof this.game.save === 'function') { try { this.game.save(); } catch (e) {} }
  }

  // 双人合作守关入口：复用 _quickBattle 的门禁（有陀螺 / 20 能量门票），带 coop 标记开合作关。
  // 结算只记战绩不发资源（见 spintop _settle coop 闸门）。
  // ②2-1 触感脉冲：胜利/翻倍轻震（守护 wx 缺失即跳过；低档机可抑制）
  _haptic(kind) {
    if (typeof wx === 'undefined' || !wx.vibrateShort) return;
    try { wx.vibrateShort({ type: kind === 'win' ? UI.motion.hapticWin : UI.motion.hapticIn }); } catch (e) {}
  }

  _startCoop() {
    if (!(CONFIG.coop && CONFIG.coop.enabled)) return;
    const bb = this.game.selectBattleBeyblade();
    if (!bb) { this._toast('先抽卡或合成一个陀螺'); return; }
    // P1-6：合作开战同样走挑战券层（免费券 → 加发券 → 能量门票）
    const t = this.game.consumeBattleTicket();
    if (!t) { this._toast('能量不足，无法开战'); return; }
    this.game.buffOpen = false;
    this.lastBattleBb = bb;
    this._chestShown = false;
    const stage = (CONFIG.coop && CONFIG.coop.minStage) || 1;
    this._startBattle(bb, null, { active: true, stage: stage, coop: true });
    this.game.mode = 'battle';
    this.audio.play('clash');
    if (typeof this.game.save === 'function') { try { this.game.save(); } catch (e) {} }
  }

  // 双人合作·传给好友（切换持方，仅影响 HUD/贡献统计）
  _startCoopPass() {
    const b = this.game.battle;
    if (b && typeof b.passPhone === 'function') {
      const who = b.passPhone();
      this.audio.play('click');
      this._toast('已传给好友 · 当前持方 ' + who);
    }
  }

  // 双人合作·邀约分享（纯邀请、无奖励，非诱导分享，合规）
  _shareResultCoop() {
    const b = this.game.battle;
    const stage = ((b && b.runStage) || (CONFIG.coop && CONFIG.coop.minStage) || 1);
    const tpl = (CONFIG.coop && CONFIG.coop.shareTitle) || '我和好友双人合力通关了陀螺大师第{stage}关！敢来和我们一起吗？';
    const title = tpl.replace('{stage}', stage);
    if (typeof wx !== 'undefined' && wx.shareAppMessage) {
      wx.shareAppMessage({ title: title, query: 'from=coop', imageUrl: CONFIG.shareCardImage });
    }
    this.audio.play('click');
    this._toast('已邀请好友一起玩');
  }

  // 胜利结算翻倍：赢一局后"看广告金币翻倍"（基础已入账，看后多给 reward → 总 ×2）。
  // 含每日上限 + 同局一次 + 广告位缺失降级，均不伤害已到账的基础奖励。
  _watchResultDouble() {
    const b = this.game.battle;
    if (!b || b.coop || b.result !== 'win') return;
    if (!CONFIG.resultDoubleAdUnitId) { this._toast('翻倍暂未开通'); return; }
    if (this._resultDoubled) { this._toast('本局已翻倍'); return; }
    if (typeof this.game.resultDoubleCountToday === 'function' &&
        this.game.resultDoubleCountToday() >= (CONFIG.resultDoublePerDay || 3)) { this._toast('今日翻倍次数已用完'); return; }
    if (this._adBusy) return;   // 玩家主动点的按钮广告：不做冷却档（靠每日上限）
    this._adBusy = true;
    Rewarded.show({
      adUnitId: CONFIG.resultDoubleAdUnitId,
      onReward: () => {
        this._adBusy = false;
        this._resultDoubled = true;
        this._haptic('win');   // ②2-1 结算翻倍轻震
        if (this.game && typeof this.game.markResultDouble === 'function') this.game.markResultDouble();
        const extra = (b && b.reward) || 0;
        if (this.game) this.game.coins += extra;
        this.audio.play('win');
        if (this.renderer && typeof this.renderer.addFloatText === 'function') {
          this.renderer.addFloatText(this.cw / 2, this.ch * 0.4, '金币翻倍 +' + extra, '#ffd54f');
        }
        this._toast('获得翻倍金币 +' + extra);
        if (typeof this.game.save === 'function') { try { this.game.save(); } catch (e) {} }
      },
      onFail: () => {
        this._adBusy = false;
        this._toast('广告暂不可用，金币未翻倍（基础奖励已保留）');
      }
    });
  }

  /** 广告频控（被动激励位）：一局 ≤ gameMax 次、且距上次 ≥ gapMin 分钟。
   *  通过则本次占位（返回 true），不通过返回 false。主动位（能量）不走此门。 */
  _adFreqGate() {
    const cfg = CONFIG.adFreq || { gameMax: 2, gapMin: 3 };
    if (Date.now() - this._lastRewardedAd < (cfg.gapMin || 3) * 60000) return false;
    if (this._rewardsThisBattle >= (cfg.gameMax || 2)) return false;
    this._lastRewardedAd = Date.now();
    this._rewardsThisBattle += 1;
    return true;
  }

  _buffCost(buff) {
    if (buff === 'fullspeed') return 300;
    if (buff === 'targetdown') return 500;
    if (buff === 'doublepower') return 800;
    return 0;
  }

  // #6 核心循环无缝化：结算页「再战」——连胜中免 20 能量门票，把连胜串起来不被能量门槛打断；
  // 连胜断了（上一局失败）重新开始则照常扣门票，经济规则不变。
  // 难度由 stage 驱动递增（spintop._diffFactor：stage<=3 为 0.45，4 为 0.62，之后渐增至 0.78 封顶），
  // 故连胜越久越难，天然收敛，不会出现「免门票 + 难度不变」的无限刷。
  // 原 in-line 分支漏设 this.game.mode = 'battle' 且每次扣门票、固定 stage:1（最低难度，免门票会无限刷），
  // 现统一为：连胜免门票 + stage 随连胜递增 + 显式战斗态 + 存档。
  _battleAgain() {
    const streak = this.game.winStreak || 0;
    const freeContinue = streak >= 1;
    if (!freeContinue) {
      if (this.game.energy < 20) { this._toast('能量不足，无法再战'); return; }
      this.game.energy -= 20;
    }
    const bb = this.lastBattleBb || this.game.selectBattleBeyblade();
    if (bb) {
      this.lastBattleBb = bb;
      this._chestShown = false;
      this._startBattle(bb, null, { active: true, stage: streak + 1, buffs: [] });
      this.game.mode = 'battle';     // 原分支漏设，靠 mode 仍为 battle 侥幸工作
      this.audio.play('clash');
      if (typeof this.game.save === 'function') { try { this.game.save(); } catch (e) {} }
    }
  }

  // 判断当前是否需要高帧率（动态场景）：对战、抽卡动画、签到面板、存活粒子特效
  _computeTargetFps() {
    try {
      const g = this.game;
      if (!g) return this._curFps;
      // LOW 性能档：对战强制 30fps（低端机 60fps 根本跑不动，硬撑只会掉帧雪崩）；
      // 静止主菜单同样降 15fps 空闲（由下方公共 return 15 兜底）
      if (this.perfLevel === 'LOW' && (g.mode === 'battle' || (g.battle && g.battle.active))) return 30;
      if (this.perfLevel === 'LOW' && (g.drawCard || g.signOpen)) return 30;
      // MID 性能档：对战限制 30fps（45fps 在 P30/vivo S9 等中端机仍掉到 22-23fps，
      // 30fps 渲染预算从 22ms 放宽到 33ms，大概率稳定达标，云测试按 30+ 策略评估）
      if (this.perfLevel === 'MID' && (g.mode === 'battle' || (g.battle && g.battle.active))) return 30;
      // HIGH 性能档：对战 45fps（中端机 60fps 预算 16.6ms 吃不住，掉到 43-56fps 且 CPU 烧到 13-20%；
      // 45fps 预算 22ms 能稳定，CPU 降 ~25%，云测试按 45+ 视为丝滑）
      if (this.perfLevel === 'HIGH' && (g.mode === 'battle' || (g.battle && g.battle.active))) return 45;
      if (g.mode === 'battle') return 60;
      if (g.battle && g.battle.active) return 60;
      if (g.drawCard) return this.perfLevel === 'LOW' ? 30 : (this.perfLevel === 'MID' ? 30 : 45);   // 抽卡动画
      if (g.signOpen) return this.perfLevel === 'LOW' ? 30 : (this.perfLevel === 'MID' ? 30 : 45);   // 签到面板入场
      const r = this.renderer;
      if (r && (r.particles.length || r.rings.length || r.floatTexts.length)) return this.perfLevel === 'LOW' ? 30 : (this.perfLevel === 'MID' ? 30 : 45);
      // 拖拽进行中（合成台拉陀螺/点按按钮）也要升帧，否则 15fps 静止档下手感发粘
      if (r && r.drag) return this.perfLevel === 'LOW' ? 30 : (this.perfLevel === 'MID' ? 30 : 45);
      // 主菜单静止：15fps 空闲降频（静止画面 30→15fps 视觉无差异，CPU/耗电减半，
      // 直击云测试 CPU 均值 16-23% 超标——空闲也在全速重绘是主因）
      return 15;
    } catch (e) { return this._curFps; }
  }

  // 执行一帧的逻辑更新 + 渲染（携带 try-catch 防崩）
  _doFrame(dt) {
    this._renderedThisFrame = true; // FPS 监控采样标记（见 loop 尾部）
    try {
      this.update(dt);
      this.renderer.render(dt);
      this._firstFrameRendered = true; // 首帧渲染成功标记（黑屏监控用）
      this._fatalCount = 0;
      if (!this._clubGuideChecked && this.game.mode === 'main' && this.game.tutorialDone) {
        this._clubGuideChecked = true;
        this.game.maybeOpenClubGuide(); // 每天弹一次游戏圈引导（对玩家无可操作性损失）
      }
    } catch (e) {
      console.error('[loop] error:', e);
      // 全局错误捕获：上报到错误处理模块
      try {
        ErrorHandler.capture(e, 'doFrame', {
          frameCount: this.renderer ? this.renderer._frameCount : 0,
          perfLevel: this.perfLevel,
          gameMode: this.game.mode
        });
      } catch (ehErr) {
        console.warn('[doFrame] 错误上报失败:', ehErr.message);
      }
      this._safeResetIfFatal();
    }
  }

  /**
   * 首页插屏（key='home'）触发器 —— 弹点：结算页「返回首页」之后（2026-11-08 迁移）。
   * 旧弹点「开场动画结束 3.5s 自动弹」已废弃：①启动即弹是留存最差/微信体验评估最险的位置；
   * ② 3.5s 恰好抢玩家第一下点击。新弹点是用户主动手势（返回首页）的自然间歇后果，
   * 且未经本局对战不会触发（保护纯逛首页玩家）。门控链不变：
   *   一次/冷启动 → 未配置跳过 → 首日不弹+每日上限(game.canShowHomeInterstitial)
   *   → 平台频控/能力(Interstitial.canShow) → 实际展示才计数(markHomeInterstitialShown)。
   */
  _maybeShowHomeInterstitial() {
    if (this._homeInterstitialTried) return;
    this._homeInterstitialTried = true;
    const id = CONFIG.homeInterstitialAdUnitId;
    if (!id || /^adunit-0+$/.test(id)) return;          // 未配置：静默跳过
    if (typeof wx === 'undefined' || !wx.createInterstitialAd) return;
    if (!this.game.canShowHomeInterstitial()) return;   // 门控：首日/首次启动不弹 + 每日上限 2 次
    if (!Interstitial.canShow('home')) return;          // 能力/频控守卫（含 60s 最小间隔）
    setTimeout(() => {
      try {
        Interstitial.show({
          key: 'home',
          onShown: () => { this.game.markHomeInterstitialShown(); }, // 实际展示才计当日次数
          onSkip: () => {}
        });
      } catch (e) {}
    }, 600); // 结算返回后稍候 0.6s（让首页先渲染一帧再上插屏，避免切换瞬间卡顿感）；仍受门控：一次/冷启动 + 首日不弹 + 每日上限
  }

  loop() {
    if (!this.running) return;
    try {
      const now = Date.now();
      const frameDt = Math.min((now - this.lastTime) / 1000, 0.05);
      this.lastTime = now;
      // ③3-1 开场首屏呼吸感：首屏 main 0→0.8s 标题淡入/放大/柔光 + 起音（一次性，LOW 档降级）
      if (!this._introDone && this.game.mode === 'main') {
        this._introT += frameDt;
        const _ik = Math.min(1, this._introT / (UI.motion.introDur || 0.8));
        try { this.game.introK = _ik; } catch (e) {}
        if (!this._introSounded && _ik > 0 && this.audio) { try { this.audio.play('click'); } catch (e) {} this._introSounded = true; }
        if (_ik >= 1) { this._introDone = true; }
        // 注：首页插屏不再在开场结束自动弹（2026-11-08 迁移）——启动即弹是留存最差/审核最险的弹点，
        // 且 3.5s 恰好抢玩家第一下点击（抽卡/拖合成台）。合法弹点已迁至结算页「返回首页」手势后果
        // （见 battle_back 分支 → _maybeShowHomeInterstitial），门控不变。
      }

      // 场景驱动的帧率档位切换
      const target = this._computeTargetFps();
      if (target !== this._curFps) {
        this._curFps = target;
        this._frameAcc = 0; // 换挡重置累计，避免一次性补跑多帧
      }

      // 首屏标题已渲染（前 2 帧为极简 splash）后，在空闲帧补跑新玩家首抽，不阻塞首帧
      if (this._pendingNewPlayerInit && this.renderer._frameCount >= 2) {
        this._initNewPlayer(); // 方法内部会复位 _pendingNewPlayerInit
      }
      // P2 注入优化：广告对象 init 延到首帧空闲（frame≥2，与首抽同批）
      if (this._pendingAdsInit && this.renderer._frameCount >= 2) {
        this._pendingAdsInit = false;
        try {
          ensureAds();
          Rewarded.init({ adUnitId: CONFIG.adUnitId, chestAdUnitId: CONFIG.chestAdUnitId, energyAdUnitId: CONFIG.energyAdUnitId });
          // 抽卡激励广告位（drawAdUnitId3/6/9/rand）走 Rewarded.show 按 adUnitId 懒加载，无需 init（收卡时由 _dismissDrawCard 自动弹）
          Interstitial.init({ home: CONFIG.homeInterstitialAdUnitId }); // 首页插屏：结算返回首页后弹（弹点 2026-11-08 已从启动即弹迁走；key='home'，未配置则静默跳过）
        } catch (e) { console.warn('[adsInit]', e); }
      }
      // 回归礼包延后弹·兜底（首屏零阻挡）：玩家 returnGraceMs 内无任何交互才自动触发一次，
      // 避免离线奖励沉没；若玩家先交互则由 _maybePromptReturn（onTap 内）更早触发。
      // P2 细度：returnDeferToSettle 时兜底延长到 30s（给"先打一局再领"留出窗口）
      const _returnGrace = CONFIG.returnDeferToSettle ? Math.max(CONFIG.returnGraceMs || 8000, 30000) : (CONFIG.returnGraceMs || 8000);
      if (this._pendingReturnInit && (now - this._bootStartTime) >= _returnGrace) {
        this._maybePromptReturn();
      }

      if (this._curFps >= 60) {
        // 动态场景：全速渲染
        this._doFrame(frameDt);
      } else {
        // 静态/降帧场景：累计真实时间到达帧间隔(1/curFps)才更新渲染，跳过其余 rAF 回调
        this._frameAcc += frameDt;
        if (this._frameAcc >= (1 / this._curFps)) {
          const d = Math.min(this._frameAcc, 0.1); // 上限 0.1s，防切后台回来跳变
          // 扣减必须与目标帧间隔一致（1/curFps），否则会越积越多、实际渲染被压到 ~10fps
          this._frameAcc = Math.max(0, this._frameAcc - (1 / this._curFps));
          this._doFrame(d);
        }
      }
      // 实时 FPS 监控（覆盖所有档位）：连续 60 次渲染平均帧率低于目标档位 2/3，说明设备吃不住 → 自动降一档
      // 此前只在 60fps 分支统计，45fps/30fps 档永不降档（中端机 45 档死磕掉帧雪崩）
      // ⚠️ 必须在实际渲染（_doFrame）时采样渲染帧率，而不是 rAF 回调间隔（节流档 rAF 恒接近 60）
      if (this._renderedThisFrame) {
        this._fpsWin.push(1 / Math.max(frameDt, 0.001));
        if (this._fpsWin.length > 60) this._fpsWin.shift();
        if (this._fpsWin.length === 60) {
          let sum = 0;
          for (let i = 0; i < 60; i++) sum += this._fpsWin[i];
          const avg = sum / 60;
          const threshold = Math.min(40, this._curFps * 2 / 3); // 目标档位 2/3，60 档取 40
          if (avg < threshold && this.perfLevel !== 'LOW') {
            this._fpsWin.length = 0;
            if (this.perfLevel === 'HIGH') {
              this.perfLevel = 'MID';
              this._applyPerfRuntime('HIGH→MID');
            } else if (this.perfLevel === 'MID') {
              this.perfLevel = 'LOW';
              this._applyPerfRuntime('MID→LOW');
            }
          } else if (avg >= threshold * 1.3) {
            // 连续 60 帧显著高于目标档位 1.3 倍 → 升回一档（LOW→MID→HIGH）
            // 用实际渲染帧率 avg 判断：MID 档跑满 30fps（avg>=26）且目标档是动态场景（_curFps>=30）才升
            if (this.perfLevel === 'LOW' && this._curFps >= 30) {
              this.perfLevel = 'MID';
              this._applyPerfRuntime('LOW→MID');
            } else if (this.perfLevel === 'MID' && avg >= 40 && this._curFps >= 30) {
              this.perfLevel = 'HIGH';
              this._applyPerfRuntime('MID→HIGH');
            }
            this._fpsWin.length = 0;
          }
        }
      }
      this._renderedThisFrame = false;
    } catch (e) {
      console.error('[loop] error:', e);
      // 全局错误捕获：上报到错误处理模块
      try {
        ErrorHandler.capture(e, 'mainLoop', {
          frameCount: this.renderer ? this.renderer._frameCount : 0,
          perfLevel: this.perfLevel,
          curFps: this._curFps
        });
      } catch (ehErr) {
        console.warn('[loop] 错误上报失败:', ehErr.message);
      }
      this._safeResetIfFatal();
    }
    const loopFn = this._loopFn || (this._loopFn = this.loop.bind(this));
    try {
      if (typeof wx !== 'undefined' && wx.requestAnimationFrame) {
        wx.requestAnimationFrame(loopFn);
      } else if (typeof requestAnimationFrame !== 'undefined') {
        requestAnimationFrame(loopFn);
      }
    } catch (e) { console.error('[raf]', e); }
  }

  update(dt) {
    try { this.game.rechargeEnergy(dt); } catch (e) { console.warn('[energy]', e); }
    // 背包陈列轨道：非拖拽时每帧推进松手惯性（_stepInvInertia 内部钳制 + 衰减）
    if (!this._invDragging) this.renderer._stepInvInertia();
    // 推进抽卡动画时间
    if (this.game.drawCard) this.game.drawCard.t += dt;
    // 细节打磨：合成升级对比停顿帧计时
    if (this.game.mergeReveal) {
      this.game.mergeReveal.t += dt;
      if (this.game.mergeReveal.t > 1.5) this.game.mergeReveal = null;
    }
    // 签到面板入场动画计时：关闭即归零，每次打开重新播放入场
    this.game.signT = this.game.signOpen ? (this.game.signT + dt) : 0;
    // 每日任务面板入场动画计时（同签到）
    this.game.dailyT = this.game.dailyOpen ? (this.game.dailyT + dt) : 0;
    // 竞技场面板入场动画计时（同签到）
    this.game.arenaT = this.game.arenaOpen ? (this.game.arenaT + dt) : 0;
    // P1-5 周末限时商店面板入场动画计时
    this.game.weekShopT = this.game.weekShopOpen ? ((this.game.weekShopT || 0) + dt) : 0;
    // 出售确认弹窗入场动画计时
    this.game.sellT = this.game.sellConfirm ? (this.game.sellT + dt) : 0;
    // 大师等级面板入场动画计时
    this.game.levelT = this.game.levelOpen ? (this.game.levelT + dt) : 0;
    // P2-6 福利中心面板入场动画计时
    this.game.welfareT = this.game.welfareOpen ? ((this.game.welfareT || 0) + dt) : 0;
    // P2-4 图鉴入口呼吸光晕剩余时间（打开图鉴即清零，见 tab 分发）
    if (this.game.codexGlowT > 0) this.game.codexGlowT = Math.max(0, this.game.codexGlowT - dt);
    // 回归礼包弹窗入场动画计时
    this.game.returnT = this.game.offlineOpen ? ((this.game.returnT || 0) + dt) : 0;
    // 竞技宝箱 / 好友助力弹窗入场动画计时
    this.game.battleChestT = this.game.battleChestOpen ? ((this.game.battleChestT || 0) + dt) : 0;
    this.game.boostT = this.game.boostOpen ? ((this.game.boostT || 0) + dt) : 0;
    // 批次D·局前 buff 弹窗入场动画计时
    this.game.buffT = this.game.buffOpen ? ((this.game.buffT || 0) + dt) : 0;
    // 批次E·连战三选一浮层入场动画计时（P2-6：原先硬弹无缓动）
    this.game.runBuffT = this.game.runBuffOpen ? ((this.game.runBuffT || 0) + dt) : 0;
    // 批次F·出战陀螺选择面板入场动画计时。
    // ⚠️ 必须递增，不可省：beginPanelAnim(t) 在 t=0 时算出 scale=0.525（k=0 → ease=-1.97），
    // 面板会被画成半尺寸，而 modalRects 仍按 1.0 布局注册 → 视觉与命中整体错开约一倍，
    // 表现为「点关闭X/上一页/下一页/开始对战，实际命中的都是某一行陀螺 → 直接开战」。
    this.game.battleSelectT = this.game.battleSelectOpen ? ((this.game.battleSelectT || 0) + dt) : 0;
    // 点选脉冲递减：不依赖面板开关（关面板后也必须收敛到 0，避免残留描边常亮）
    if (this.game.battleSelectFlashT > 0) this.game.battleSelectFlashT = Math.max(0, this.game.battleSelectFlashT - dt);
    // 升级反馈：升级后弹一次提示 + 全屏金色粒子 + 震屏（统一强力反馈）
    if (this.game._levelUpReward) {
      const r = this.game._levelUpReward;
      this.game._levelUpReward = null;
      this._toast('升级！Lv.' + r.level + ' · ' + r.bonus);
      const ux = this.cw / 2, uy = this.ch * 0.42;
      this.renderer.addParticles(ux, uy, '#ffd54f', 32);
      this.renderer.addParticles(ux, uy, '#ffffff', 12);
      this.renderer.addRing(ux, uy, '#ffd54f');
      this.renderer.shake(8, 0.4);
      this.audio.play('win');
    }
    // 竞技场周结算反馈：跨周自动发奖后弹一次提示
    if (this.game._arenaWeekReward) {
      const r = this.game._arenaWeekReward;
      this.game._arenaWeekReward = null;
      this._toast('竞技场赛季结算：' + r.tier + '段位 +' + r.coins + '金币' + (r.energy ? ' +' + r.energy + '能量' : ''));
    }
    if (this.game.battle && this.game.battle.active) {
      try {
        this.game.battle.update(dt);
        if (this.game.battle.phase === 'result') {
          if (!this._resultPlayed) {
            const cx = this.cw / 2;
            const cy = this.ch * 0.4;
              if (this.game.battle.result === 'win') {
              this._haptic('win');   // ②2-1 胜利轻震
              this.renderer.addFloatText(cx, cy + 130, '+' + this.game.battle.reward, '#ffd54f');
              if (this.game.battle.counter) {
                this.audio.play('crit');
                this.renderer.addFloatText(cx, cy + 96, '克制必杀!', '#ff5252');
              } else {
                this.audio.play('win');
              }
              // 批次D·竞技宝箱：胜利掉落时自动弹出开箱面板（每局 1 次）
              if (this.game.battle.chestDropped && !this._chestShown) {
                this.game.battleChestOpen = true;
                this.game.chestAdBroken = false; // 每次打开弹窗复位广告降级标志
                this._chestShown = true;
              }
            } else {
              this.audio.play('lose');
              reportBattleDefeat(this.game.battle.runStage); // 零成本埋点：战败漏斗（关卡维度）
            }
            this.game.onBattleEnd(this.game.battle.result === 'win'); // 首程引导收口：首胜即完成；连败 3 场兜底收起
            this._resultPlayed = true;
            // P2 细度：回归礼包延后到本日首次结算再弹（首屏零阻挡最后一公里）
            if (CONFIG.returnDeferToSettle) this._maybePromptReturn();
          }
        } else {
          this._resultPlayed = false;
        }
      } catch (e) { console.warn('[battle.update]', e); }
    }
    // 陀螺旋转动画（原地遍历，不创建新数组）
    try {
      const inv = this.game.inventory;
      for (let i = 0; i < inv.length; i++) {
        const bb = inv[i];
        if (bb && typeof bb.update === 'function') bb.update(dt);
      }
      const ps = this.game.platformSlots;
      for (let i = 0; i < ps.length; i++) {
        if (ps[i] && typeof ps[i].update === 'function') ps[i].update(dt);
      }
    } catch (e) { console.warn('[spin]', e); }
    try { this.game.save(); } catch (e) { console.warn('[save]', e); }
  }
}

// 自动化调试钩子（仅开发版/体验版暴露，正式版不挂全局引用）：
// 供 miniprogram-automator / cli auto 驱动真实画面截图做 UI/UX 审计。
try {
  if (typeof wx !== 'undefined' && wx.getAccountInfoSync) {
    const _env = (wx.getAccountInfoSync().miniProgram || {}).envVersion;
    if (_env && _env !== 'release') GameGlobal.__game = this;
  }
} catch (e) {}

module.exports = Main;
