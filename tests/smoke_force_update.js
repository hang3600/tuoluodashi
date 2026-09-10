/**
 * 强制更新（A 档：单按钮弹窗）—— 新版本就绪后强制用户重启应用
 *
 * 背景：平台默认**不强制**。冷启动发现有新版本时，客户端会异步下载新包，
 *       但**本次仍用本地旧包启动**，新版本要等「下一次冷启动」才生效
 *       （官方口径：最差 24 小时覆盖全量）。要「强制用最新版」必须主动接 UpdateManager。
 *
 * 本套件把根入口 game.js 的 setupForceUpdate() 隔离加载（注入可控 wx + 假 require，
 * 让 require('./src/main') 返回 null → boot() 在 `if (!Main) return` 处空转），
 * 从而在不拉起整个游戏的前提下，精确断言更新链路的每一步。
 *
 * 核心断言：
 *   1. 启动时注册 UpdateManager，三个回调（check/ready/failed）全部挂上
 *   2. onUpdateReady 时**先同步存档再弹窗**（applyUpdate 立即重启、不走 onHide，
 *      而常规存档是每帧**异步**写 → 不补同步 save(true) 会有丢档窗口）
 *   3. 弹窗 **showCancel:false** 且 confirmText='立即更新' → 无取消按钮 = 强制语义
 *   4. 用户确认后 applyUpdate() 恰好调用 1 次
 *   5. 存档对象缺失 / save 抛错 → 不阻塞，仍强制更新
 *   6. showModal 异常 → 兜底直接 applyUpdate，不丢失「强制」语义
 *   7. 老基础库无 getUpdateManager → 静默跳过、不抛异常
 *   8. onUpdateFailed → 仅告警，不 applyUpdate（下次冷启动自动重试）
 */
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(desc, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + desc + (extra ? ' — ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + desc + (extra ? ' — ' + extra : '')); }
}

const GAME_JS = path.join(__dirname, '..', 'game.js');
const SRC = fs.readFileSync(GAME_JS, 'utf8');

/**
 * 把 game.js 源码装进隔离作用域执行。
 * fakeRequire 对 './src/main' 返回 null → Main = null → boot() 首行 return，
 * 不会 new Main / game.start()，因此无 rAF 循环、无 canvas 依赖。
 * 末尾 return 出 setupForceUpdate 便于直接复用（虽然源码里已自调用一次）。
 */
function loadGameJs(wxMock) {
  const rec = { requiredPaths: [] };
  const factory = new Function(
    'require', 'wx', 'console', 'setTimeout', 'module', 'exports',
    SRC + '\nreturn { setupForceUpdate: (typeof setupForceUpdate === "function") ? setupForceUpdate : null };'
  );
  const api = factory(
    (p) => { rec.requiredPaths.push(p); return null; },
    wxMock,
    console,
    (fn) => setTimeout(fn, 0),
    { exports: {} },
    {}
  );
  return { api, rec };
}

/** 构造一套可控的 wx + UpdateManager 探针 */
function makeHarness(opts) {
  opts = opts || {};
  const rec = {
    getUM: 0, applyUpdate: 0, saveCalls: [], modals: [], order: [],
    hasUpdateLogged: null, failureWarned: 0
  };
  const um = {
    _cbs: {},
    onCheckForUpdate(cb) { this._cbs.check = cb; },
    onUpdateReady(cb) { this._cbs.ready = cb; },
    onUpdateFailed(cb) { this._cbs.failed = cb; },
    applyUpdate() { rec.applyUpdate++; rec.order.push('apply'); }
  };
  const wx = {
    getUpdateManager() { rec.getUM++; return um; },
    showModal(o) {
      rec.modals.push(o);
      rec.order.push('modal');
      if (opts.modalThrows) throw new Error('showModal boom');
      // 模拟用户点「立即更新」（confirm 为 false 的情况另设 opts.confirm）
      if (o && typeof o.success === 'function' && opts.confirm !== false) {
        o.success({ confirm: true });
      }
    },
    onError() {}, onUnhandledRejection() {}
  };
  if (opts.noUpdateManager) delete wx.getUpdateManager;
  return { wx, um, rec };
}

/** 造一个 Main 实例桩：GameState 在 .game 上，save 记录 force 参数 */
function makeMainStub(rec, opts) {
  opts = opts || {};
  return {
    game: {
      save(force) {
        rec.saveCalls.push(force);
        rec.order.push('save');
        if (opts.saveThrows) throw new Error('save boom');
      }
    }
  };
}

// ═══════════════════════════════════════════════════════════════
// 场景 1：正常有更新 → 先同步存档 → 单按钮弹窗 → 确认后 applyUpdate
// ═══════════════════════════════════════════════════════════════
console.log('\n═══ 场景 1：新版本就绪 → 同步存档 + 单按钮弹窗 + applyUpdate ═══\n');
{
  const h = makeHarness();
  const { api } = loadGameJs(h.wx);
  ok('game.js 暴露 setupForceUpdate 函数', typeof api.setupForceUpdate === 'function');
  ok('启动即注册 UpdateManager（getUpdateManager 调用 1 次）', h.rec.getUM === 1, '实际 ' + h.rec.getUM);
  ok('三个回调全部注册（check/ready/failed）',
    !!(h.um._cbs.check && h.um._cbs.ready && h.um._cbs.failed));

  // 模拟游戏已启动：wx.game = Main 实例（GameState 在 .game 上）
  h.wx.game = makeMainStub(h.rec);
  h.um._cbs.ready();

  ok('onUpdateReady 触发了同步存档 save(true)',
    h.rec.saveCalls.length === 1 && h.rec.saveCalls[0] === true,
    'saveCalls=' + JSON.stringify(h.rec.saveCalls));
  ok('存档发生在弹窗之前（堵住 applyUpdate 立即重启的丢档窗口）',
    h.rec.order.join('>') === 'save>modal>apply', '实际顺序 ' + h.rec.order.join(' > '));
  ok('弹窗为**单按钮**（showCancel:false）→ 用户无法拒绝',
    h.rec.modals.length === 1 && h.rec.modals[0].showCancel === false,
    'showCancel=' + (h.rec.modals[0] && h.rec.modals[0].showCancel));
  ok('确认按钮文案为「立即更新」',
    h.rec.modals[0] && h.rec.modals[0].confirmText === '立即更新');
  ok('applyUpdate 恰好调用 1 次', h.rec.applyUpdate === 1, '实际 ' + h.rec.applyUpdate);
}

// ═══════════════════════════════════════════════════════════════
// 场景 2：wx.game 尚未挂载 → 守卫生效，不崩且仍强制更新
// ═══════════════════════════════════════════════════════════════
console.log('\n═══ 场景 2：wx.game 不存在（更新早于游戏启动）→ 守卫不崩 ═══\n');
{
  const h = makeHarness();
  loadGameJs(h.wx);
  h.um._cbs.ready();
  ok('未挂 wx.game 时无异常抛出', true);
  ok('跳过存档（saveCalls 为空）', h.rec.saveCalls.length === 0);
  ok('仍然弹出更新弹窗并 applyUpdate', h.rec.modals.length === 1 && h.rec.applyUpdate === 1);
}

// ═══════════════════════════════════════════════════════════════
// 场景 3：save 抛错 → 不影响强制更新
// ═══════════════════════════════════════════════════════════════
console.log('\n═══ 场景 3：save 抛异常 → 不阻塞，仍强制更新 ═══\n');
{
  const h = makeHarness();
  loadGameJs(h.wx);
  h.wx.game = makeMainStub(h.rec, { saveThrows: true });
  h.um._cbs.ready();
  ok('save 抛错被吞掉（不向上冒泡）', h.rec.saveCalls.length === 1);
  ok('仍弹窗 + applyUpdate', h.rec.modals.length === 1 && h.rec.applyUpdate === 1);
}

// ═══════════════════════════════════════════════════════════════
// 场景 4：showModal 异常 → 兜底直接 applyUpdate（不丢「强制」语义）
// ═══════════════════════════════════════════════════════════════
console.log('\n═══ 场景 4：showModal 抛异常 → 兜底直接 applyUpdate ═══\n');
{
  const h = makeHarness({ modalThrows: true });
  loadGameJs(h.wx);
  h.wx.game = makeMainStub(h.rec);
  h.um._cbs.ready();
  ok('弹窗异常未向上抛出', true);
  ok('兜底路径同样调用 applyUpdate（强制语义不丢失）', h.rec.applyUpdate === 1, '实际 ' + h.rec.applyUpdate);
  ok('兜底前仍完成了同步存档', h.rec.saveCalls.length === 1 && h.rec.order[0] === 'save');
}

// ═══════════════════════════════════════════════════════════════
// 场景 5：老基础库无 getUpdateManager → 静默跳过
// ═══════════════════════════════════════════════════════════════
console.log('\n═══ 场景 5：无 getUpdateManager（老基础库）→ 静默跳过不抛 ═══\n');
{
  const h = makeHarness({ noUpdateManager: true });
  let threw = false;
  try { loadGameJs(h.wx); } catch (e) { threw = true; }
  ok('不抛异常（老基础库安全降级）', !threw);
  ok('未尝试注册任何回调', !h.um._cbs.ready);
}

// ═══════════════════════════════════════════════════════════════
// 场景 6：下载失败 → 仅告警，不 applyUpdate（下次冷启动自动重试）
// ═══════════════════════════════════════════════════════════════
console.log('\n═══ 场景 6：新包下载失败 → 不阻塞玩家，下次冷启动重试 ═══\n');
{
  const h = makeHarness();
  loadGameJs(h.wx);
  h.wx.game = makeMainStub(h.rec);
  h.um._cbs.failed();
  ok('下载失败不弹窗、不 applyUpdate', h.rec.modals.length === 0 && h.rec.applyUpdate === 0);
}

// ═══════════════════════════════════════════════════════════════
// 场景 7：源码级「强制」语义回归（防止被人顺手加回取消按钮）
// ═══════════════════════════════════════════════════════════════
console.log('\n═══ 场景 7：源码级强制语义（showCancel 恒为 false）═══\n');
{
  ok('源码含 showCancel: false（强制）', /showCancel:\s*false/.test(SRC));
  ok('源码不含 showCancel: true（不存在可拒绝路径）', !/showCancel:\s*true/.test(SRC));
  ok('源码在 applyUpdate 前显式调用了 save(true)', /save\(true\)/.test(SRC));
  ok('回调主逻辑挂在 onUpdateReady（onCheckForUpdate 在部分客户端不触发）',
    /onUpdateReady\(function/.test(SRC) && /onCheckForUpdate\(function/.test(SRC));
}

// ═══════════════════════════════════════════════════════════════
// 场景 8：对战进行中触发 → 挂起弹窗，不弄丢当前这局
// ═══════════════════════════════════════════════════════════════
console.log('\n═══ 场景 8：对战中触发更新 → 挂起，不打断当前这局 ═══\n');
{
  const h = makeHarness();
  loadGameJs(h.wx);
  const stub = makeMainStub(h.rec);
  stub.game.mode = 'battle';
  stub.game.battle = { phase: 'playing' };
  h.wx.game = stub;
  h.um._cbs.ready();
  ok('挂起前仍先完成同步存档', h.rec.saveCalls.length === 1 && h.rec.order[0] === 'save');
  ok('对战中不立即弹窗（不打断当前这局）', h.rec.modals.length === 0, 'modals=' + h.rec.modals.length);
  ok('对战中不 applyUpdate', h.rec.applyUpdate === 0);
  stub.game.mode = 'main';   // 收尾：让挂起的轮询尽快收敛，避免残留定时器空转
}

// ═══════════════════════════════════════════════════════════════
// 场景 9：本局结束 → 轮询补弹（强制语义不因延后而丢失）
// ═══════════════════════════════════════════════════════════════
console.log('\n═══ 场景 9：本局结束 → 轮询补弹强制更新（语义不丢）═══\n');
(async function () {
  const h = makeHarness();
  loadGameJs(h.wx);
  const stub = makeMainStub(h.rec);
  stub.game.mode = 'battle';
  stub.game.battle = { phase: 'playing' };
  h.wx.game = stub;
  h.um._cbs.ready();
  stub.game.battle.phase = 'result';   // 本局结束（同步改，早于下一次轮询）
  await new Promise(function (r) { setTimeout(r, 30); });
  ok('本局结束后轮询补弹弹窗', h.rec.modals.length === 1, 'modals=' + h.rec.modals.length);
  ok('补弹的弹窗仍是单按钮强制（showCancel:false）',
    !!(h.rec.modals[0] && h.rec.modals[0].showCancel === false));
  ok('确认后 applyUpdate（强制语义未丢失）', h.rec.applyUpdate === 1, '实际 ' + h.rec.applyUpdate);

  // ═══════════════════════════════════════════════════════════════
  // 场景 10：源码级回归（防止「对战安全点」被顺手改回立即弹窗）
  // ═══════════════════════════════════════════════════════════════
  console.log('\n═══ 场景 10：源码级对战安全点回归 ═══\n');
  ok('源码含 isInBattle 判定（对战中不硬重启）', /function isInBattle\(\)/.test(SRC));
  ok('onUpdateReady 里先判 isInBattle 再决定是否弹窗',
    /if \(isInBattle\(\)\)/.test(SRC) && /deferUntilBattleEnd\(um\)/.test(SRC));
  ok('对战判定口径与 main.js 一致（phase === \'playing\'）',
    /b\.phase === 'playing'/.test(SRC), '口径漂移会导致对战中被打断、或永远不弹');
  ok('延后带轮询上限（状态卡住也照样强制）', /MAX_TRIES/.test(SRC));

  console.log('\n' + '═'.repeat(40));
  if (fail === 0) {
    console.log('✅ 强制更新套件：通过 ' + pass + ' / 失败 0');
  } else {
    console.log('❌ 强制更新套件：通过 ' + pass + ' / 失败 ' + fail);
  }
  console.log('═'.repeat(40) + '\n');
  process.exit(fail === 0 ? 0 : 1);
})();
