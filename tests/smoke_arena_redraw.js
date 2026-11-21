// 冒烟套件 —— 批次G：对战擂台「实体化重绘」
//
// 背景：改前战斗盘 = 8 层细几何线 + 中心脉冲点，观感像"示意图/雷达屏"，且盘底为主题色实心亮盘。
// 实测问题：传说级（金 #ffd54f）陀螺落在金色亮盘上几乎融进盘里，**己方陀螺可读性差**；
// 盘无厚度、无凹陷、无材质，玩家反馈"像象征的圆，不像擂台"。
//
// 改法（_bakeArenaDecor 整体重绘，仍全部烘焙进 _arenaDecorSprite，每帧仍只 1 次 drawImage）：
//   金属盘沿(厚度+三道倒角+8 螺栓) → 下沉碗体(壁影环+偏心碗底) → 磨砂磨损纹理
//   → 阵营分界(我/敌) → 盘沿 36 格刻度+顶部指针 → 危险区 → 中心 VS 浮雕徽章 → 顶光/底反光
//   动态层：原"中心能量核心"改为 VS 徽章呼吸光环（帧率不变）
//
// 本套件锁死：① 新结构锚点存在（防被回退成旧几何线）② 敌方色接线完整 ③ 性能承诺不破
//            ④ 运行时真能画出（不是空函数）且离屏不可用时兜底不抛错
process.env.TZ = 'Asia/Shanghai';
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const { GameState } = require(path.join(ROOT, 'src', 'game.js'));
const { Beyblade } = require(path.join(ROOT, 'src', 'beyblade.js'));
const { SpintopBattle } = require(path.join(ROOT, 'battle', 'spintop.js'));

const src = fs.readFileSync(path.join(ROOT, 'battle', 'spintop.js'), 'utf8');
const testsSrc = fs.readFileSync(path.join(ROOT, 'tests', 'run.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

/** 记录型 ctx：统计绘制调用次数 + 收集 fillText/strokeText 文本 */
function recordingCtx() {
  const c = {
    _calls: 0, _texts: [], _grads: 0,
    createLinearGradient() { this._calls++; this._grads++; return { addColorStop() {} }; },
    createRadialGradient() { this._calls++; this._grads++; return { addColorStop() {} }; },
    measureText(t) { return { width: (t ? String(t).length : 0) * 8 }; },
    fillText(t) { this._calls++; this._texts.push(String(t)); },
    strokeText(t) { this._calls++; this._texts.push(String(t)); },
    _tick() { this._calls++; },
  };
  return new Proxy(c, {
    get(t, p) {
      if (p in t) return t[p];
      if (typeof p === 'string' && /^[a-z]/.test(p)) return () => { t._calls++; };
      return undefined;
    },
    set(t, p, v) { t[p] = v; return true; },
  });
}

function mkBattle() {
  const g = new GameState();
  const b = new SpintopBattle(g, 375, 812);
  b.safeTop = 56; b.safeBottom = 24;
  b.start(new Beyblade(0, 1));
  b.phase = 'playing';
  return b;
}

/** 取 _bakeArenaDecor 方法源码块（花括号配平） */
function fnBlock(sig) {
  const i = src.indexOf(sig);
  if (i < 0) return '';
  let depth = 0, started = false;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') { depth++; started = true; }
    else if (src[k] === '}') { depth--; if (started && depth === 0) return src.slice(i, k + 1); }
  }
  return '';
}
const bake = fnBlock('_bakeArenaDecor(g, arenaCx, arenaCy, arenaR, innerR, topColor, enemyColor)');

// ---------------------------------------------------------------------------
console.log('\n【1】函数契约：敌方色参数贯穿（阵营分界需要）');
{
  ok('_bakeArenaDecor 新增 enemyColor 形参', bake.length > 0);
  ok('_buildArenaDecorSprite 接收并透传 enemyColor',
    /_buildArenaDecorSprite\(w, h, arenaCx, arenaCy, arenaR, innerR, topColor, enemyColor\)/.test(src) &&
    /_bakeArenaDecor\(c, arenaCx, arenaCy, arenaR, innerR, topColor, enemyColor\)/.test(src));
  ok('装饰缓存 key 含敌方色（换敌/换陀螺才重烤）',
    /decorKey\s*=\s*top\.color\s*\+\s*'\|'\s*\+\s*eColor/.test(src));
  ok('无离屏兜底路径两处均透传 eColor',
    (src.match(/_bakeArenaDecor\(ctx, arenaCx, arenaCy, arenaR, innerR, top\.color, eColor\)/g) || []).length === 2);
  ok('eColor 回退值存在（enemy 缺失时用 #ef5350）', /enemyColor \|\| '#ef5350'/.test(bake));
}

// ---------------------------------------------------------------------------
console.log('\n【2】擂台结构锚点（防回退成旧的 8 层细线）');
{
  ok('① 落地投影：盘"抬"在场景上（径向投影 + 1.2R 扩散）',
    /rgba\(0,0,0,0\.58\)/.test(bake) && /R \* 1\.20/.test(bake));
  ok('② 金属盘沿：15% 环带 + 斜向金属渐变', /rimW = Math\.max\(11, R \* 0\.10\)/.test(bake) && /#eef2f8/.test(bake));
  ok('② 盘沿三道倒角线（外亮/中暗/内亮）',
    /rgba\(255,255,255,0\.55\)/.test(bake) && /rgba\(0,0,0,0\.62\)/.test(bake) && /rgba\(255,255,255,0\.14\)/.test(bake));
  ok('② 盘沿 8 颗螺栓（平色 + 高光点，刻意不用径向渐变省对象）',
    /#93a0b4/.test(bake) && /rgba\(255,255,255,0\.78\)/.test(bake) && /i < 8; i\+\+/.test(bake));
  ok('③ 碗壁下沉阴影环（造成凹陷体积）', /rgba\(0,0,0,0\.78\)/.test(bake));
  ok('④ 碗底深色金属（不再用主题色亮盘）',
    /#4a5364/.test(bake) && /#0e1119/.test(bake) && !/shade\(topColor, 0\.30\)/.test(bake));
  ok('④ 主题色仅作微染（0.13 中心 → 0.02 边缘，保持金属暗度）',
    /hexToRgba\(topColor, 0\.13\)/.test(bake) && /hexToRgba\(topColor, 0\.02\)/.test(bake));
  ok('⑤ 磨砂纹理：12 圈同心 + 24 条放射',
    /i <= 12; i\+\+/.test(bake) && /i < 24; i\+\+/.test(bake));
  ok('⑤ 磨损噪点用固定种子（每次烘焙一致，不闪烁）', /seed = 20260912/.test(bake));
  ok('⑥ 阵营分界：左我方色 / 右敌方色', /hexToRgba\(topColor, 0\.30\)/.test(bake) && /hexToRgba\(eColor, 0\.30\)/.test(bake));
  ok('⑦ 盘沿 36 格刻度刻线', /i < 36; i\+\+/.test(bake) && /i % 9 === 0/.test(bake));
  ok('⑦ 顶部指针三角（标"上"位）', /const py = cy - innerR \+ 4/.test(bake));
  ok('⑦ 盘沿内侧主题色能量环（双描边免 shadowBlur）',
    /hexToRgba\(topColor, 0\.68\)/.test(bake) && /lineWidth = 7/.test(bake));
  ok('⑧ 出界危险区常驻淡红虚环', /rgba\(255,86,86,0\.32\)/.test(bake) && /setLineDash\(\[7, 10\]\)/.test(bake));
  ok('⑨ 中心 VS 浮雕徽章（描边 + 金属渐变字）',
    /strokeText\('VS'/.test(bake) && /fillText\('VS'/.test(bake) && /#e6ecf6/.test(bake));
  ok('⑨ 徽章含刻线 + 主题色光晕', /br - 9/.test(bake) && /hexToRgba\(topColor, 0\.26\)/.test(bake));
  ok('⑩ 顶部高光 + 底部冷色反光（单光源立体感）',
    /rgba\(255,255,255,0\.14\)/.test(bake) && /rgba\(176,208,255,0\.11\)/.test(bake));
  ok('旧"中心能量核心"已移除（不再有 20 + corePulse*8 三环点）', src.indexOf('20 + corePulse * 8') < 0);
  ok('动态层改为徽章呼吸光环', /badgeR \+ 7 \+ corePulse \* 5/.test(src));
}

// ---------------------------------------------------------------------------
console.log('\n【3】性能承诺：装饰仍一次性烘焙 + 按 key 缓存');
{
  const b = mkBattle();
  const ctx = recordingCtx();
  b._arenaDecorSprite = null; b._arenaDecorKey = '';
  let buildCalls = 0;
  const origBuild = b._buildArenaDecorSprite.bind(b);
  b._buildArenaDecorSprite = function (...a) {
    buildCalls++;
    return origBuild(...a) || { _fakeSprite: true, width: a[0], height: a[1] };
  };
  b.draw(ctx);
  b.draw(ctx);
  b.draw(ctx);
  ok('连续 3 帧只烘焙 1 次（其后命中缓存）', buildCalls === 1, 'buildCalls=' + buildCalls);
  ok('缓存键写入（_arenaDecorKey 非空）', !!b._arenaDecorKey);
  const sourceChunk = fs.readFileSync(path.join(ROOT, 'battle', 'spintop.js'), 'utf8');
  ok('烘焙走离屏 + 失败降级实时绘制（原机制保留）',
    /wx\.createOffscreenCanvas/.test(sourceChunk) && /_bakeArenaDecor\(ctx, arenaCx, arenaCy, arenaR, innerR, top\.color, eColor\)/.test(sourceChunk));
  const arenaKeys = ['arenashadow|', 'arenarim|', 'arenawall|', 'arenadish|', 'arenatint|', 'arenafaction|',
    'arenaptr|', 'arenahalo|', 'arenabadge|', 'arenavs|', 'arenahl|', 'arenabl|'];
  const notWired = arenaKeys.filter((p) => bake.indexOf(p) < 0);
  ok('12 个擂台渐变全部接入 _gradFor 缓存（降级路径每帧零新建）', notWired.length === 0, '未接入=' + notWired.join(','));
}

// ---------------------------------------------------------------------------
console.log('\n【4】运行时：真实绘制有输出（不是空函数），离屏不可用兜底不抛错');
{
  const b = mkBattle();
  const ctx = recordingCtx();
  let err = null;
  const calls0 = ctx._calls;
  try { b._bakeArenaDecor(ctx, 187.5, 406, 150, 140, '#ffd54f', '#ef5350'); }
  catch (e) { err = e; }
  const calls = ctx._calls - calls0;
  ok('_bakeArenaDecor(实时 ctx) 无异常（离屏不可用的兜底路径）', !err,
    err ? (err.message + ' @' + (err.stack || '').split('\n')[1]) : '');
  ok('绘制调用量 > 200（真内容，非空实现）', calls > 200, 'calls=' + calls);
  ok('确实创建了渐变对象（> 8 个：盘沿/碗底/微染/分界/螺栓/徽章/光影）', ctx._grads >= 8, 'grads=' + ctx._grads);
  ok('VS 徽章文字被真实绘制', ctx._texts.indexOf('VS') >= 0, 'texts=' + JSON.stringify(ctx._texts.slice(0, 4)));

  // 小屏 / 大屏不越界、不抛错（R 随 min(w,h) 变化）
  let err2 = null;
  try {
    b._bakeArenaDecor(recordingCtx(), 160, 320, 128, 118, '#a1887f', null);
    b._bakeArenaDecor(recordingCtx(), 384, 900, 153, 143, '#42a5f5', '#66bb6a');
  } catch (e) { err2 = e; }
  ok('不同尺寸/土色主题/enemy 为 null 时不抛错', !err2, err2 ? err2.message : '');
}

// ---------------------------------------------------------------------------
console.log('\n【5】门禁注册与运行时联动');
{
  ok('本套件已注册进 tests/run.js', testsSrc.indexOf('smoke_arena_redraw.js') >= 0);
  const b = mkBattle();
  const ctx = recordingCtx();
  b._arenaDecorSprite = null; b._arenaDecorKey = '';
  let threw = null;
  try { b.draw(ctx); } catch (e) { threw = e; }
  ok('整帧 draw() 在真实 battle 实例上无异常', !threw, threw ? threw.message : '');
}

console.log('\n══════════════════════');
console.log('擂台重绘门禁：' + pass + '/' + (pass + fail) + ' 通过' + (fail ? '（失败 ' + fail + '）' : ''));
process.exit(fail === 0 ? 0 : 1);
