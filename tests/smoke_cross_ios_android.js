// 冒烟套件 16 —— 跨平台 iOS/Android 一致性修复门禁
//
// 背景：陀螺大师此前存在三类「安卓正常 / 苹果异常（或反之）」的确定性差异：
//   #1 iOS benchmarkLevel 虚低 → 同游戏 iPhone 被过度限帧/降级
//   #2 iOS 平台被一刀切关闭装饰阴影（诊断发现原逻辑所有设备 shadowScale 恒为 0）
//   #3 canvas 不乘 DPR → iOS 高 DPR 屏被拉伸变糊
// 本套件守住这三处修复的核心不变量，防止后续误改回退。
const fs = require('fs');
const path = require('path');

const SRC_DIR = path.resolve(__dirname, '..', 'src');
const ROOT_DIR = path.resolve(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(SRC_DIR, 'main.js'), 'utf8');
const renderSrc = fs.readFileSync(path.join(SRC_DIR, 'render.js'), 'utf8');
// 入口 game.js 在项目根目录（src/game.js 为历史遗留旧文件，不含 DPR 逻辑）
const gameSrc = fs.readFileSync(path.join(ROOT_DIR, 'game.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

console.log('\n【X-1】iOS benchmarkLevel 分档补偿（虚低 → 回到真实档位）');
{
  ok('main.js 对 iOS 做 benchmarkLevel +25 补偿', /isIOS\)\s*bl\s*=\s*bl\s*\+\s*25/.test(mainSrc));
  ok('补偿仅作用于 iOS（isIOS 判定存在）', /const isIOS\s*=/.test(mainSrc));
  ok('LOW 阈值 30 不变（补偿不破坏低端判定）', /bl\s*<\s*30\)\s*perfLevel\s*=\s*'LOW'/.test(mainSrc));
}

console.log('\n【X-2】iOS 装饰阴影放开（仅 HIGH 档 iOS 旗舰）');
{
  ok('render.js 以 allowShadow = HIGH && _isIOS 放开', /allowShadow\s*=\s*\(this\.perfLevel === 'HIGH' && this\._isIOS\)/.test(renderSrc));
  ok('shadowScale 由 allowShadow 决定（不再 _isIOS 一刀切）', /this\.shadowScale\s*=\s*\(low \|\| !allowShadow\)/.test(renderSrc));
}

console.log('\n【X-3】canvas DPR 超采样（逻辑/物理解耦）');
{
  ok('main.js 物理尺寸 = round(逻辑cw * dpr)', /canvas\.width\s*=\s*Math\.round\(this\.cw \* dpr\)/.test(mainSrc));
  ok('main.js 保存逻辑尺寸 this.cw/this.ch', /this\.cw\s*=\s*canvas\.width/.test(mainSrc) && /this\.ch\s*=\s*canvas\.height/.test(mainSrc));
  ok('main.js input 反缩放 = dpr（renderScale）', /canvas\.renderScale\s*=\s*dpr/.test(mainSrc));
  ok('render.js 每帧 setTransform(dpr) 映射物理像素', /this\.ctx\.setTransform\(/.test(renderSrc));
  ok('render.js 逻辑尺寸 = 物理 / dpr', /this\.width\s*=\s*.*canvas\.width\s*\/\s*this\.dpr/.test(renderSrc));
  ok('render.js resize 同步物理尺寸 × dpr', /this\.canvas\.width\s*=\s*Math\.round\(w \* d\)/.test(renderSrc));
  ok('game.js lateResize 物理 = 逻辑 × dpr', /physicalW\s*=\s*Math\.round\(lw\s*\*\s*dpr\)/.test(gameSrc));
  ok('LOW 档 dpr 强制 1x（保护最弱机）', /this\.perfLevel === 'LOW'\)\s*\?\s*1\s*:\s*Math\.min/.test(mainSrc));
}

console.log('\n【X-4】Renderer 运行时：DPR 解耦 + 阴影矩阵（不变量实测）');
{
  let r = null, threw = null;
  try {
    const { Renderer } = require(path.join(SRC_DIR, 'render.js'));
    // 安全 game mock：可调用 Proxy，任意属性访问返回自身（可链式读/可当方法调用，均不抛）；关键字段给具体值
    let safeGame;
    safeGame = new Proxy(function () {}, {
      get(t, k) {
        if (k === Symbol.toPrimitive) return (hint) => (hint === 'string' ? '' : 0);
        if (k === 'toString') return () => '';
        if (k === 'lowFX') return undefined;
        if (k === 'battle') return { active: false, width: 0, height: 0, safeTop: 0, safeBottom: 0 };
        if (k === 'mode') return 'menu';
        if (k === 'energy' || k === 'drawCard' || k === 'signOpen') return false;
        return safeGame; // 函数自身：作对象读返回自身，作方法调用 apply 也返回自身
      },
      set() { return true; },
      apply() { return safeGame; }
    });
    // 物理 750×1624（dpr=2）→ 逻辑应 375×812
    const canvas = { width: 750, height: 1624, dpr: 2, getContext: () => ctx };
    const ctx = {
      setTransform() {}, save() {}, restore() {}, beginPath() {}, closePath() {},
      moveTo() {}, lineTo() {}, arc() {}, fill() {}, stroke() {},
      measureText: () => ({ width: 10 }), fillRect() {}, clearRect() {}, drawImage() {},
      createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} })
    };
    global.wx = undefined; // 避免构造内误触 wx API
    r = new Renderer(canvas, ctx, safeGame, 56, 24, null);
  } catch (e) { threw = e; }
  ok('Renderer 构造不抛错', threw === null, threw && threw.message);
  if (r) {
    ok('逻辑宽 = 物理 / dpr (750/2=375)', r.width === 375, 'w=' + r.width);
    ok('逻辑高 = 物理 / dpr (1624/2=812)', r.height === 812, 'h=' + r.height);
    ok('renderer.dpr = 2', r.dpr === 2, 'dpr=' + r.dpr);
    // 隔离变量：强制非 compact、无 lowFX 覆盖，仅测平台×档位对阴影的影响
    r.layout = { compact: false };
    r.perfLevel = 'HIGH'; r._isIOS = true;  r._updateFx();
    ok('iOS HIGH → shadowScale=1（此前被误杀）', r.shadowScale === 1, 's=' + r.shadowScale);
    r.perfLevel = 'HIGH'; r._isIOS = false; r._updateFx();
    ok('Android HIGH → shadowScale=0（保留原性能决策）', r.shadowScale === 0, 's=' + r.shadowScale);
    r.perfLevel = 'MID';  r._isIOS = true;  r._updateFx();
    ok('iOS MID → shadowScale=0（中端 WebKit 软阴影贵）', r.shadowScale === 0, 's=' + r.shadowScale);
    r.perfLevel = 'LOW';  r._isIOS = true;  r._updateFx();
    ok('iOS LOW → shadowScale=0（最弱机）', r.shadowScale === 0, 's=' + r.shadowScale);
    r.perfLevel = 'MID';  r._isIOS = false; r._updateFx();
    ok('Android MID → shadowScale=0', r.shadowScale === 0, 's=' + r.shadowScale);
  }
}

console.log('\n────────────────────────');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
