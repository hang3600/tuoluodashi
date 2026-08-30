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

function readSystemInfo() {
  try {
    if (typeof wx === 'undefined') return null;
    if (typeof wx.getWindowInfo === 'function') return wx.getWindowInfo();
    if (typeof wx.getSystemInfoSync === 'function') return wx.getSystemInfoSync();
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

boot();
