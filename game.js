/**
 * 陀螺大师 - 小游戏入口（打磨版）
 * - 启动兜底：createCanvas/getContext 失败不崩
 * - 刘海屏安全区：读取系统信息透传给 Main
 * - jsbridge not ready 重试：指数退避 60→120→240ms，仍失败用默认尺寸兜底
 * - 启动后 500ms 延迟修正：若初始为默认尺寸，尝试获取真实尺寸并更新
 * - 黑屏防护：基础库检测 + 全局错误捕获 + 首帧渲染监控（5s 未出画自动重启主循环）
 */
const DEFAULT_W = 375;
const DEFAULT_H = 667;

// 全局错误捕获：优先注册，尽量收集启动期异常（配合体验版 vConsole 排查黑屏）
try {
  if (typeof wx !== 'undefined') {
    if (wx.onError) wx.onError(function (err) { console.error('[wx.onError]', err); });
    if (wx.onUnhandledRejection) wx.onUnhandledRejection(function (res) { console.error('[unhandledRejection]', res && res.reason); });
  }
} catch (e) {}

// 入口模块加载：任一依赖解析/加载失败都不应静默黑屏
let Main = null;
try {
  Main = require('./src/main');
} catch (e) {
  console.error('[boot] main module load failed:', e);
  try {
    if (typeof wx !== 'undefined' && wx.showToast) wx.showToast({ title: '资源加载失败，请重启', icon: 'none' });
  } catch (e2) {}
}

// 记录系统信息是从哪个 API 拿到的（真机诊断用：
// 若日志出现 sysInfoVia=DEFAULT，说明 jsbridge 迟迟未就绪、走了默认尺寸兜底，
// 需要靠 500ms 后的 lateResize 修正，可与基础库那条"jsbridge not ready"区分开）
let _sysInfoVia = null;

function readSystemInfo() {
  try {
    if (typeof wx === 'undefined') return null;
    if (typeof wx.getWindowInfo === 'function') {
      const i = wx.getWindowInfo();
      if (i) { _sysInfoVia = 'getWindowInfo'; return i; }
    }
    if (typeof wx.getSystemInfoSync === 'function') {
      const i = wx.getSystemInfoSync();
      if (i) { _sysInfoVia = 'getSystemInfoSync'; return i; }
    }
  } catch (e) {}
  return null;
}

/** 基础库关键 API 检测：缺失则提示并退出，避免黑屏 */
function checkBaseLib() {
  try {
    if (typeof wx === 'undefined') return true; // 浏览器/调试环境
    const hasCanvas = typeof wx.createCanvas === 'function';
    const hasSysInfo = typeof wx.getSystemInfoSync === 'function' || typeof wx.getWindowInfo === 'function';
    if (!hasCanvas || !hasSysInfo) {
      console.error('[boot] 基础库异常：createCanvas/getSystemInfoSync 不可用');
      try { if (wx.showToast) wx.showToast({ title: '基础库版本过低，请升级微信后重试', icon: 'none', duration: 3000 }); } catch (e) {}
      if (wx.exitMiniProgram) setTimeout(function () { try { wx.exitMiniProgram(); } catch (e) {} }, 3000);
      return false;
    }
  } catch (e) {}
  return true;
}

/**
 * 是否运行在「开放数据域」（子域）环境里。
 * getSharedCanvas 是开放数据域专属 API（主域没有），是最可靠的子域信号。
 *
 * 背景（2026-10-31 接入 openDataContext 后实测）：本版本 macOS DevTools 会把主域入口
 * game.js 也放进子域环境求值 —— 子域里 wx.onTouchStart 不存在、canvas 无 addEventListener，
 * 主游戏照常 boot 会在 InputHandler 崩溃（WAGameSubContext 栈）。主域逻辑只在主域跑：
 * 检测到子域环境时跳过 boot，把执行权留给 opencontext/index.js。
 */
function inOpenDataDomain() {
  try {
    return typeof wx !== 'undefined' && typeof wx.getSharedCanvas === 'function';
  } catch (e) { return false; }
}

/** 首帧渲染监控：启动 5s 内未渲染出画面 → 判定黑屏，尝试重启主循环 */
function watchFirstFrame(game) {
  if (!game) return;
  setTimeout(function () {
    try {
      if (game._firstFrameRendered) return; // 已出画，正常
      console.error('[boot] 首帧未渲染（疑似黑屏）');
      if (!game.running && typeof game.start === 'function') {
        console.warn('[boot] 主循环未运行，重新启动');
        game.start();
        return;
      }
      try {
        if (typeof wx !== 'undefined' && wx.showToast) wx.showToast({ title: '画面加载异常，请重启', icon: 'none', duration: 3000 });
      } catch (e) {}
    } catch (e) { console.error('[watchFirstFrame]', e); }
  }, 5000);
}

function launch(info) {
  const winW = (info && info.windowWidth > 0) ? info.windowWidth : DEFAULT_W;
  const winH = (info && info.windowHeight > 0) ? info.windowHeight : DEFAULT_H;
  // 真机全屏：canvas 高度用「全屏逻辑高」= screenHeight / pixelRatio。
  // 微信小游戏主屏 canvas 显示区域 = canvas 像素尺寸（真机不自动拉伸全屏），
  // 若用 windowHeight（不含状态栏+底部导航），真机会在底部留黑边、画面被压缩成"变形"。
  const fullH = (info && info.screenHeight > 0 && info.pixelRatio > 0)
    ? Math.max(winH, Math.round(info.screenHeight / info.pixelRatio))
    : winH;
  try {
    if (typeof wx === 'undefined' || typeof wx.createCanvas !== 'function') {
      console.error('[boot] wx.createCanvas unavailable');
      return null;
    }
    const canvas = wx.createCanvas();
    const ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
    if (!ctx) {
      console.error('[boot] createCanvas / getContext failed');
      return null;
    }
    canvas.width = winW;
    canvas.height = fullH;
    // 启动诊断：一眼看出系统信息走的是哪条路径（ok=正常取到；DEFAULT=jsbridge 未就绪兜底）
    console.log('[boot] launch: sysInfoVia=' + (_sysInfoVia || 'DEFAULT')
      + ' win=' + winW + 'x' + winH + ' canvas=' + canvas.width + 'x' + canvas.height);
    const game = new Main(canvas, ctx, info);
    game.start();
    if (typeof wx !== 'undefined') wx.game = game;
    watchFirstFrame(game);
    return { game, canvas, usedDefault: !info };
  } catch (e) {
    console.error('[boot] fatal:', e);
    try {
      if (typeof wx !== 'undefined' && wx.showToast) wx.showToast({ title: '初始化异常，请重启', icon: 'none' });
    } catch (e2) {}
    return null;
  }
}

function boot() {
  if (inOpenDataDomain()) {
    // 开放数据域环境：主域入口不应在此启动（入口是 opencontext/index.js），
    // 直接静默返回，避免在子域里创建 Main/InputHandler 崩溃。
    console.log('[boot] open data domain detected — skip main boot');
    return;
  }
  if (!Main) return; // 入口模块加载失败，已提示
  if (!checkBaseLib()) return;
  let info = readSystemInfo();
  if (info) {
    const r = launch(info);
    // 启动后延迟修正：即使首次成功，也尝试更新一次（防止首次拿到的尺寸不准）
    setTimeout(function () { lateResize(r && r.game, r && r.canvas); }, 500);
    return;
  }

  // jsbridge 尚未就绪：指数退避重试
  const delays = [60, 120, 240];
  let attempt = 0;
  function retry() {
    info = readSystemInfo();
    if (info) {
      const r = launch(info);
      setTimeout(function () { lateResize(r && r.game, r && r.canvas); }, 500);
    } else if (attempt < delays.length) {
      setTimeout(retry, delays[attempt++]);
    } else {
      // 全部重试失败：用默认尺寸兜底启动
      const r = launch(null);
      setTimeout(function () { lateResize(r && r.game, r && r.canvas); }, 500);
    }
  }
  setTimeout(retry, delays[attempt++]);
}

function lateResize(game, canvas) {
  if (!game || !canvas) return;
  try {
    const info = readSystemInfo();
    if (!info) return;
    const realW = (info.windowWidth > 0) ? info.windowWidth : 0;
    const realH = (info.windowHeight > 0) ? info.windowHeight : 0;
    // 真机全屏：高度用全屏逻辑高（screenHeight/pixelRatio），避免底部黑边/变形
    const fullH = (info.screenHeight > 0 && info.pixelRatio > 0) ? Math.max(realH, Math.round(info.screenHeight / info.pixelRatio)) : realH;
    // 【跨平台修复 #3】DPR 超采样：canvas 物理尺寸 = 逻辑 × dpr（与 Main 构造一致）。
    // 逻辑尺寸(lw/lh)作为布局基准恒定，物理缓冲交给 canvas 承担。
    const dpr = (game && game.dpr) || 1;
    const lw = (realW > 0) ? Math.max(240, Math.round(realW)) : 0;
    const lh = (fullH > 0) ? Math.max(320, Math.round(fullH)) : 0;
    const physicalW = Math.round(lw * dpr);
    const physicalH = Math.round(lh * dpr);
    // 只在物理尺寸确实变化时更新（canvas.width 现存储物理像素）
    if (physicalW > 0 && physicalH > 0 && (physicalW !== canvas.width || physicalH !== canvas.height)) {
      canvas.width = physicalW;
      canvas.height = physicalH;
      if (typeof game.onResize === 'function') game.onResize(lw, lh);
      if (typeof game.updateSafeArea === 'function') game.updateSafeArea(info);
      console.log('[boot] lateResize updated:', physicalW + 'x' + physicalH, '(logical ' + lw + 'x' + lh + ', dpr=' + dpr + ')');
    }
    // 安全区也更新（即使尺寸没变，safeTop/SafeBottom 可能初始不准）
    if (typeof game.updateSafeArea === 'function') game.updateSafeArea(info);
  } catch (e) {
    console.warn('[boot] lateResize failed:', e);
  }
}

/**
 * 强制更新：新版本下载完成后弹「无取消按钮」弹窗，用户点确定即重启应用新版本。
 *
 * 背景：平台默认**不强制** —— 冷启动发现有新版本时，会异步下载新包但本次仍用本地旧包启动，
 * 新版本要等「下一次冷启动」才生效（官方口径：最差 24 小时内覆盖全量用户）。
 * 要「强制用户使用最新版本」，必须主动接 UpdateManager。
 * 参见 https://developers.weixin.qq.com/minigame/dev/guide/runtime/update-mechanism
 *
 * ⚠️ 注意：
 * - 开发版/体验版没有「版本」概念，不会触发；只能在线上正式版验证。
 *   DevTools 可用「编译模式 → 下次编译时模拟更新」调试，真机无法调试。
 * - onCheckForUpdate 在部分客户端（Mac / 低版本 PC）不触发，故主逻辑必须放 onUpdateReady。
 * - applyUpdate() 会**立即重启、不走 onHide**，而常规存档是每帧**异步**写（src/main.js:1358），
 *   最后那一帧可能未落盘 → 重启前必须补一次**同步** save(true)，否则存在丢档窗口。
 * - wx.game 挂的是 **Main 实例**（见下方 launch()），GameState 在 Main 的 .game 上（src/main.js:162），
 *   故调用路径是 wx.game.game.save(true)，别写成 wx.game.save(true)。
 * - applyUpdate() 会**立即重启**，若此刻正在对战（mode==='battle' && battle.phase==='playing'），
 *   当前这局会被直接弄丢。故对战中会**挂起弹窗**、每 1s 轮询到本局结束再弹（带上限，超时照弹）。
 */
/**
 * 是否处于「不适合立刻重启」的时机：对战进行中。
 * 判定口径与 src/main.js:782 一致（mode === 'battle' && battle.phase === 'playing'）。
 * wx.game 尚未挂载（游戏还没 boot 完）时返回 false —— 此时重启反而最省事，不必等。
 */
function isInBattle() {
  try {
    const gs = wx.game && wx.game.game;
    if (!gs || gs.mode !== 'battle') return false;
    const b = gs.battle;
    return !!(b && b.phase === 'playing');
  } catch (e) {
    return false;   // 状态读取异常 → 按「不在对战」处理，保证强制更新不丢
  }
}

/**
 * 同步落盘：堵住 applyUpdate()「立即重启、不走 onHide」造成的丢档窗口。
 * 常规存档是每帧**异步**写（src/main.js:1358），最后那一帧很可能还没落盘。
 */
function saveNow() {
  try {
    const mainInst = wx.game;
    const gs = mainInst && mainInst.game;   // Main 实例上的 GameState
    if (gs && typeof gs.save === 'function') gs.save(true);
  } catch (e) {
    console.warn('[update] save before restart failed:', e && e.message);
  }
}

/**
 * 单按钮弹窗（showCancel:false）→ 用户只能点「立即更新」，实现强制。
 * 弹窗本身抛异常（极端情况）→ 兜底直接 applyUpdate，保证「强制」语义不丢失。
 */
function showForceModal(um) {
  try {
    wx.showModal({
      title: '更新提示',
      content: '新版本已就绪，点击确定立即更新',
      showCancel: false,      // 无取消按钮 = 强制
      confirmText: '立即更新',
      success: function (r) {
        if (r && r.confirm) um.applyUpdate();
      }
    });
  } catch (e) {
    try { um.applyUpdate(); } catch (e2) {}
  }
}

/**
 * 对战进行中 → 挂起弹窗，每 1s 轮询到本局结束再弹。
 * applyUpdate() 会**立即重启**，中途弹窗等于把玩家当前这局直接弄丢（存档保住、这局白打）。
 * 带轮询上限：状态万一卡住也不让「强制」语义丢失 —— 超时后照样弹。
 */
function deferUntilBattleEnd(um) {
  var tries = 0;
  var MAX_TRIES = 60;   // ≈60s
  (function poll() {
    tries++;
    if (!isInBattle()) { showForceModal(um); return; }
    if (tries > MAX_TRIES) {
      console.warn('[update] 等待本局结束超时 → 仍然强制提示更新');
      showForceModal(um);
      return;
    }
    setTimeout(poll, 1000);
  })();
}

function setupForceUpdate() {
  try {
    if (typeof wx === 'undefined' || typeof wx.getUpdateManager !== 'function') return; // 非微信环境/老基础库
    const um = wx.getUpdateManager();

    um.onCheckForUpdate(function (res) {
      console.log('[update] check done: hasUpdate=' + !!(res && res.hasUpdate));
    });

    um.onUpdateReady(function () {
      console.log('[update] ready → 强制重启以应用新版本');
      saveNow();                  // ① 先同步落盘，堵住丢档窗口
      if (isInBattle()) {         // ② 对战中 → 挂起到本局结束再弹
        console.log('[update] 对战进行中 → 延后到本局结束再提示（避免重启弄丢当前这局）');
        deferUntilBattleEnd(um);
        return;
      }
      showForceModal(um);         // ③ 单按钮弹窗 → 强制
    });

    um.onUpdateFailed(function () {
      // 多为网络问题：不阻塞玩家，下次冷启动会自动重试
      console.warn('[update] download failed, will retry on next cold start');
    });
  } catch (e) {
    console.warn('[update] setup failed:', e && e.message);
  }
}

if (!inOpenDataDomain()) {
  setupForceUpdate();
}
boot();
