/**
 * 回归测试：微信小游戏触摸坐标归一化（修复 #2 点击无响应）
 * 根因：微信 touch 事件的 x/y 已是逻辑像素，与渲染逻辑坐标 cw/ch 同坐标系；
 * 旧 _normalize 错误地除以 canvas.renderScale(=dpr)，导致 dpr=2/3 时点击落点
 * 缩小 2~3 倍、偏到画面角落 → 开发者工具/真机均「点击无响应」。
 * 本套件验证：onTap/onDragStart 收到的坐标 == 触摸逻辑坐标，不被 DPR 缩放。
 */
const path = require('path');
const SRC = path.join(__dirname, '..');

// 微信环境 mock（不定义 window，避免走浏览器 mouse 路径）
global.__h = {};
global.wx = {
  onTouchStart(f) { global.__h.start = f; },
  onTouchMove(f) { global.__h.move = f; },
  onTouchEnd(f) { global.__h.end = f; },
  onTouchCancel(f) { global.__h.cancel = f; },
};

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond) {
  if (cond) { pass++; } else { fail++; fails.push(name); }
  console.log((cond ? '✓' : '✗') + ' ' + name);
}

const { InputHandler } = require(path.join(SRC, 'src/input'));

function newHandler(renderScale) {
  // 每次 new 都会重新注册 wx.onTouchStart，捕获最新 handler
  const canvas = {
    renderScale,
    addEventListener() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 375, height: 812 }; },
  };
  const h = new InputHandler(canvas);
  return { h, start: global.__h.start, end: global.__h.end };
}

// --- dpr=2 设备：触摸逻辑坐标 (200,400) 应原样到达 onTap ---
{
  const { h, start, end } = newHandler(2);
  let tap = null;
  h.onTap = (p) => { tap = p; };
  start({ changedTouches: [{ identifier: 1, x: 200, y: 400 }] });
  end({ changedTouches: [{ identifier: 1, x: 200, y: 400 }] });
  ok('dpr=2：onTap 收到未缩放逻辑坐标 (200,400)', tap && tap.x === 200 && tap.y === 400);
}

// --- dpr=3 设备：触摸逻辑坐标 (300,600) 应原样到达 onTap（不被 ÷3）---
{
  const { h, start, end } = newHandler(3);
  let tap = null;
  h.onTap = (p) => { tap = p; };
  start({ changedTouches: [{ identifier: 7, x: 300, y: 600 }] });
  end({ changedTouches: [{ identifier: 7, x: 300, y: 600 }] });
  ok('dpr=3：onTap 收到 (300,600) 不被 ÷3', tap && tap.x === 300 && tap.y === 600);
}

// --- dragStart 也应收到逻辑坐标（不被 ÷dpr）---
{
  const { h, start } = newHandler(2);
  let drag = null;
  h.onDragStart = (p) => { drag = p; };
  start({ changedTouches: [{ identifier: 3, x: 120, y: 80 }] });
  ok('dpr=2：onDragStart 收到 (120,80) 不被 ÷2', drag && drag.x === 120 && drag.y === 80);
}

// --- 边界：触摸坐标原点 (0,0) 仍正确（不被误判为 NaN）---
{
  const { h, start, end } = newHandler(2);
  let tap = null;
  h.onTap = (p) => { tap = p; };
  start({ changedTouches: [{ identifier: 9, x: 0, y: 0 }] });
  end({ changedTouches: [{ identifier: 9, x: 0, y: 0 }] });
  ok('原点 (0,0) 不丢失/不为 NaN', tap && tap.x === 0 && tap.y === 0 && !isNaN(tap.x) && !isNaN(tap.y));
}

console.log('\n[' + (fail === 0 ? 'PASS' : 'FAIL') + '] smoke_input_touch: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) { console.error('FAILURES:', fails); process.exit(1); }
process.exit(0);
