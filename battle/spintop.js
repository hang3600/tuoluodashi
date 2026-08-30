/**
 * 抽陀螺实战（核心循环）
 * 从 datuoluo 移植的抽打爽感：滑动抽打陀螺 → 转速/连击/得分/道具
 * 陀螺品质/等级通过 Beyblade 映射为摩擦、最高转速、得分倍率。
 */

const { randomBeyblade, drawBeyblade, ELEMENTS, elementMultiplier } = require('../src/beyblade');
const { drawVectorIcon, prepSrc: _prepSrc } = require('../src/utils');
const { reportBattleStart, reportFirstBattleDone } = require('../src/analytics'); // 零成本埋点（P1 数据盲区）

/**
 * 战败额外扣除的能量（开战门票 20 已在 main.js:435/834 扣除且不退）。
 *
 * 这是**唯一真值来源**：结算页的「能量 -N」文案直接读这个常量渲染，不再硬编码字符串。
 * 历史上这里出现过三处漂移 —— 注释写 -25、代码实际扣 -50、结算页却显示「能量 -15」，
 * 玩家看到的损失只有真实值的 30%。收敛成常量后，调平衡只改这一处，UI 会自动跟着变。
 *
 * 取 15 而不是 50 的理由：满能量开局时，首次战败的能量条会瞬间掉 1/3（-50/150），
 * 这个"啪一下掉一大截"的观感对新玩家的第一印象成本很高；15 保留了
 * "输比赢亏"（35 vs 20）的张力，又不至于让人想关掉小游戏。
 */
const LOSE_ENERGY_PENALTY = 15;

/**
 * 抽打力度曲线（批次F · 替代旧的 Math.min(dist*0.5*eff, maxSpeed)）
 *
 * 旧公式在滑动 25px 处就饱和到 maxSpeed，而屏宽 375 —— 现实中每一划都打满，
 * 三档评级（perfect/normal/miss）和"划得多远"完全不影响得分，技巧层形同虚设。
 *
 * 新公式以 maxSpeed 为基准、按滑动距离缩放：
 *   力度 = maxSpeed × 距离系数 × 评级倍率 × 防打满衰减
 *   距离系数 = WHIP_DIST_MIN ~ WHIP_DIST_MAX（滑动达 WHIP_DIST_FULL px 即"划满"）
 * 仍是**有界**的（保留 clamp 的防爆作用），否则超长滑动会直接击穿 P0-1 的目标分校准。
 *
 * 满划时的力度倍率（距离系数 × 评级倍率）：
 *   perfect 1.15×1.6 = 1.84 ／ normal 1.15×0.65 = 0.75 ／ miss 1.15×0.25 = 0.29
 *   → 同一个陀螺，划得好与划得烂的差距达 6.3 倍（旧版恒为 1.0，零差距）。
 */
const WHIP_DIST_FULL = 150;   // px：滑动达到此长度即算"划满"
const WHIP_DIST_MIN = 0.35;   // 极短轻点的力度下限（相对 maxSpeed）
const WHIP_DIST_MAX = 1.15;   // 划满的力度上限（相对 maxSpeed；旧 clamp 恒为 1.0）
const IMPULSE_CAP = 1.5;      // 位移冲量按 maxSpeed 的多少倍封顶（防止高段位陀螺被抽飞失控）
const FORCE_CAP_MULT = 2.8;   // 力道硬上限（相对 maxSpeed）：1.15(划满)×1.6(perfect)×1.5(爆发)=2.76，留 0.04 余量

/** 震屏上限：力道提高后不封顶会抖到看不清（原最大约 12，取 14 留余量） */
const SHAKE_MAX = 14;

/**
 * 暴击倍率（P1-3）。1.5 沿用代码里原本写死的值，尊重原设计意图。
 * 注意它**不是随机事件**：perfect 档 efficiency 恒为 1.6 > 0.85 ⇒ 完美划必定暴击，
 * 所以这个倍率实质上是"完美档奖励"的一部分，会与力度曲线、元素倍率连乘。
 */
const CRIT_MULT = 1.5;

/**
 * 目标分校准参考倍率（相对 maxSpeed×30），用于抵消批次F 三个倍率的连乘影响。
 *
 * P0-1 建立目标分时，单次抽打力道被 clamp 在 maxSpeed，故参考值是 1.0。
 * 批次F 之后，一次"合格的好划"的实际输出是三者连乘：
 *   力度曲线(完美长划 1.84) × 暴击(完美必爆 1.5) × 元素(克制 1.35 / 被克 0.75)
 * 参考值仍取 1.0 的话，目标分会被这些倍率整体架空 —— 实测新号首战完美划只要
 * 5~7 抽（7.5s）就结束，又滑回 P0-1 想解决的"太快打完"。
 *
 * 取 1.5 是折中：完美划约 9~13.5s（不急促），普通划约 19.5~27s（仍可赢，保证新手能过前 3 关）。
 *
 * ⚠️ 以后改动力度曲线 / CRIT_MULT / 元素倍率，都必须重新校准这个值并跑 sim 验证。
 */
const TARGET_REF_MULT = 1.5;

/**
 * 命中定帧（hitstop）：撞击/暴击瞬间冻结玩法时间，是打击感最大的单项杠杆。
 * 冻结期间物理、计时器、回能都不推进（玩家不会因顿帧被扣时间），
 * 但震屏按真实时间继续衰减 —— 否则画面完全僵住会像"卡了"而不是"打中了"。
 */
const HITSTOP_COLLISION = 0.09;   // 撞击：90ms
const HITSTOP_CRIT = 0.05;        // 暴击：50ms

/**
 * 撞击定帧的两道闸门（必须同时存在，否则会出严重 bug）：
 *
 * 1. HITSTOP_MIN_IMPACT —— 只有"相对速度够大的真撞击"才定帧。
 *    两个陀螺贴着蹭时相对速度约等于 0，若每次碰撞响应都定帧，会陷入
 *    "定帧→物理停→解除→又碰撞→再定帧"的死循环：实测 60 帧里 52 帧处于定帧（87%），
 *    游戏近乎静止，连胜利结算都被拖到 5 秒后才触发。
 * 2. HITSTOP_COLLISION_CD —— 冷却，杜绝短时间内反复触发。
 */
/**
 * 粒子淡出的透明度档位数（P1-5）。
 *
 * 旧实现为了性能用"单次 beginPath + 单次 fill"画完所有粒子，代价是无法逐粒子设
 * 颜色与透明度 —— 金色暴击粒子被画成陀螺色，且粒子只缩小、不淡出、到点硬消失。
 *
 * 逐粒子 fill() 又太贵（上限 140 个粒子 × 每帧，低端机扛不住）。
 * 折中：把 alpha 量化成 8 档，按「颜色 + alpha 档」分批，每批一次 fill()。
 * 粒子是**按创建批次**入列的，同批的颜色相同、life 也接近，所以相邻粒子大多落在同一批，
 * 实测每帧只有个位数次 fill()，视觉上又是平滑淡出。
 */
const PARTICLE_ALPHA_STEPS = 8;

const HITSTOP_MIN_IMPACT = 1.5;      // 相对法向速度阈值（px/帧量级），低于此视为"贴身"而非撞击
const HITSTOP_COLLISION_CD = 0.4;    // 撞击定帧冷却（秒）

const POWERUPS = [
  { id: 'speed',        name: '极速', icon: 'bolt', color: '#FAAD14', effect: 'speed',        duration: 3 },
  { id: 'doubleScore',  name: '双倍', icon: 'star', color: '#FF4D4F', effect: 'doubleScore',  duration: 5 },
  { id: 'slowFriction', name: '延寿', icon: 'snow', color: '#13C2C2', effect: 'slowFriction', duration: 4 }
];

// 道具图标真实 PNG（设计稿 v3 落地）：bolt/star/snow → speed/double/slow
const _propFiles = { bolt: 'icon-speed.png', star: 'icon-double.png', snow: 'icon-slow.png' };
const _propImgs = {};
// base64 内嵌（require 直接注入）；真机加载加固由 utils.prepSrc 负责（dataURI onload 不可靠 → 改文件路径）
const _ICON_B64 = (function () { try { return require('../src/assets').icons; } catch (e) { return null; } })();
(function loadPropPNGs() {
  try {
    const mkImg = (typeof wx !== 'undefined' && wx.createImage) ? wx.createImage
      : (typeof Image !== 'undefined' ? function () { return new Image(); } : null);
    if (!mkImg) return;
    for (const k in _propFiles) {
      const im = mkImg();
      im.onload = (function (o) { return function () { o._ok = true; }; })(im);
      im.onerror = function () {};
      // 真机加固：dataURI onload 不可靠 → 改从 USER_DATA_PATH 文件路径加载（见 utils.prepSrc）
      im.src = _prepSrc(_ICON_B64 && _ICON_B64[_propFiles[k]], _propFiles[k], 'icons');
      _propImgs[k] = im;
    }
  } catch (e) { /* PNG 缺失时回退矢量绘制 */ }
})();
/** 道具图标：优先 PNG，未就绪回退矢量 */
function drawPropIcon(ctx, icon, cx, cy, size) {
  const im = _propImgs[icon];
  if (im && im._ok && im.width > 0) {
    ctx.drawImage(im, cx - size / 2, cy - size / 2, size, size);
    return true;
  }
  return false;
}

// 战斗陀螺本体真实品质 PNG（五行系统）：土→木→水→火→金
const _topFiles = ['top-earth.png', 'top-wood.png', 'top-water.png', 'top-fire.png', 'top-metal.png'];
const _topImgs = [];
// base64 内嵌（require 直接注入）；真机加载加固由 utils.prepSrc 负责（dataURI onload 不可靠 → 改文件路径）
const _TOP_B64 = (function () { try { return require('../src/assets').tops; } catch (e) { return null; } })();
(function loadTopPNGs() {
  try {
    const mkImg = (typeof wx !== 'undefined' && wx.createImage) ? wx.createImage
      : (typeof Image !== 'undefined' ? function () { return new Image(); } : null);
    if (!mkImg) return;
    for (let i = 0; i < _topFiles.length; i++) {
      const im = mkImg();
      im.onload = (function (o) { return function () { o._ok = true; }; })(im);
      im.onerror = function () {};
      // 真机加固：dataURI onload 不可靠 → 改从 USER_DATA_PATH 文件路径加载（见 utils.prepSrc）
      im.src = _prepSrc(_TOP_B64 && _TOP_B64[i], _topFiles[i], 'tops');
      _topImgs[i] = im;
    }
  } catch (e) { /* PNG 缺失时回退矢量烘焙 */ }
})();

// HUD/结算图标真实 PNG（五行系统）：返回 / 金币 / 双倍 / 能量 / 金木水火土元素
const _hudFiles = { back: 'icon-back.png', coin: 'icon-coin.png', double: 'icon-double.png', energy: 'icon-energy.png', metal: 'icon-metal.png', wood: 'icon-wood.png', water: 'icon-water.png', fire: 'icon-fire.png', earth: 'icon-earth.png', play: 'icon-play.png', star: 'icon-star.png', sparkle: 'icon-sparkle.png' };
const _hudImgs = {};
(function loadHudPNGs() {
  try {
    const mkImg = (typeof wx !== 'undefined' && wx.createImage) ? wx.createImage
      : (typeof Image !== 'undefined' ? function () { return new Image(); } : null);
    if (!mkImg) return;
    for (const k in _hudFiles) {
      const im = mkImg();
      im.onload = (function (o) { return function () { o._ok = true; }; })(im);
      im.onerror = function () {};
      // 真机加固：dataURI onload 不可靠 → 改从 USER_DATA_PATH 文件路径加载（见 utils.prepSrc）
      im.src = _prepSrc(_ICON_B64 && _ICON_B64[_hudFiles[k]], _hudFiles[k], 'icons');
      _hudImgs[k] = im;
    }
  } catch (e) { /* PNG 缺失时回退矢量/文字 */ }
})();
/** HUD/结算图标：优先 PNG，未就绪回退占位圆 */
function drawHudIcon(ctx, key, cx, cy, size) {
  const im = _hudImgs[key];
  if (im && im._ok && im.width > 0) {
    ctx.drawImage(im, cx - size / 2, cy - size / 2, size, size);
    return true;
  }
  return false;
}

const APPLE_FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "PingFang SC", "Helvetica Neue", sans-serif';

function hexToRgba(hex, alpha) {
  const h = (hex || '#ffffff').replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** HUD/对战提示用的轻量数字格式化（不依赖 utils） */
function formatNumber0(n) {
  const v = Number(n) || 0;
  if (v < 10000) return String(Math.floor(v));
  if (v < 100000000) return (Math.floor(v / 100) / 10).toFixed(1).replace(/\.0$/, '') + '万';
  return (Math.floor(v / 1000000) / 10).toFixed(1).replace(/\.0$/, '') + '亿';
}

class SpintopBattle {
  constructor(game, width, height) {
    this.game = game;
    this.width = width;
    this.height = height;
    this.active = false;
    this.phase = 'idle'; // idle | playing | result
    this.result = null;  // win | lose
    this.reward = 0;
    this.dropItem = null;
    this.arenaGained = 0;   // 本局获得的竞技积分（结算后展示用）
    this.playerBb = null;
    this.audio = null;

    this.countdown = 0;      // 开局 3-2-1-GO 倒计时（秒），>0 期间不结算不消耗时间
    this._countGoPlayed = false;

    this.top = null;

    // 每帧渐变对象缓存：满帧对战里反复 createRadialGradient 是 GC 主因，按 颜色+半径 复用即可
    this._topGrads = {};
    this._arenaGrad = null;
    this._topCache = null;         // 玩家陀螺离屏位图缓存（关键 DrawCall 优化）
    this._enemyCache = null;       // 敌方陀螺独立缓存
    this._bgSprite = null;         // 对战背景合并位图（arena 渐变 + 星空，每帧 1 次全屏 drawImage）
    this._bgSpriteW = 0;
    this._bgSpriteH = 0;
    this._arenaDecorSprite = null; // 战斗盘静态 8 层装饰离屏位图（按 top.color+尺寸缓存，每帧 1 次 drawImage）
    this._arenaDecorKey = '';
    this._sceneSprite = null;      // 静态场景合并位图（_bgSprite + _arenaDecorSprite 合成一张，每帧 1 次全屏 drawImage 替代 2 次）
    this._sceneKey = '';

    this.score = 0;
    this.displayScore = 0;
    this.targetScore = 0;
    this.timeLimit = 30;
    this.timeRemaining = 30;
    this._winLockT = 0;    // P0-1：达标后的胜利锁定倒计时（让最后一击特效播完再结算）
    this.scoreMultiplier = 1;
    this.power = 0;

    this.combo = 0;
    this.comboTimer = 0;
    this.maxCombo = 0;   // 单局峰值 COMBO（宝箱品质 / 隐藏彩蛋条件）
    this._comboWindow = 1.5;   // 连击窗口（start 按 stage 覆盖：新手 2.4s → 后期 1.6s）

    this.isWhipping = false;
    this.whipStartX = 0; this.whipStartY = 0;
    this.whipEndX = 0; this.whipEndY = 0;
    this.whipCount = 0;

    // 批次C·技巧系统（play-design v1）：节奏抽打 vs 爆发抽打
    this.lastWhipTime = 0;     // 上次抽打时间戳（连打触发爆发）
    this._burstCd = 0;         // 爆发冷却（秒）
    this.lastWhipGrade = null; // 上次抽打评级（'miss'/'good'/'perfect'）；null=尚无。连打爆发要求上一次非打偏
    this._burstCount = 0;      // 本局爆发次数
    this._rhythmCount = 0;     // 本局节奏次数
    this.lastWhipStyle = 'rhythm'; // 本次抽打风格（节奏/爆发，HUD 提示）
    this._startBoost = 0;      // 传说被动：开局极速标记
    this.bondActive = false;   // 羁绊共鸣激活
    this.bondElementIdx = 0;
    this.bondBonus = 0;
    this.enemyElementIdx = 0;  // 对手元素（策略预判）
    this.elementMult = 1;
    this.elementRel = 'neutral';
    this.elementBonus = 0;     // 克制开局加成
    this.passive = null;       // 品质 Lv5 被动

    this.particles = [];
    this._particlePool = [];   // 粒子对象池：复用对象，消除 splice/GC 抖动
    this.floatingTexts = [];
    this._ftPool = [];         // 浮文字对象池：复用对象，消除抽打高频 GC
    this.trailPoints = [];
    this._trailPool = [];       // 拖尾对象池：复用 {x,y,alpha,size}，消除每帧 new
    this.shockwaves = [];
    this.screenShake = 0;
    this._hitstopT = 0;    // 批次F·命中定帧剩余时间（>0 时冻结玩法时间）
    this._hitstopCd = 0;   // 撞击定帧冷却（防持续贴身反复触发导致游戏近乎静止）

    // 性能护栏：粒子硬上限 + 帧率软上限（低端机防极端掉帧，兜底 P1）
    this.MAX_PARTICLES = 140;
    this._lowPerf = false;       // 软上限标志：低帧率时降效（少生粒子/关拖尾）
    this._avgDt = 0;             // 滚动帧时均值（秒），自适应判定用
    this.perfLevel = 'MID';      // 启动时性能档（LOW/MID/HIGH），LOW 直接减半粒子上限+关拖尾

    this.powerups = [];
    this.powerupSpawnTimer = 0;
    this.activePowerups = { speed: false, doubleScore: false, slowFriction: false };
    this.powerupTimers = { speed: 0, doubleScore: 0, slowFriction: 0 };

    // 预生成背景星点
    this.stars = [];
    let seed = 9876.5432;
    for (let i = 0; i < 40; i++) {
      seed = (seed * 9301 + 49297) % 233280;
      const rx = seed / 233280;
      seed = (seed * 9301 + 49297) % 233280;
      const ry = seed / 233280;
      seed = (seed * 9301 + 49297) % 233280;
      const rs = seed / 233280;
      this.stars.push({ rx, ry, s: rs * 1.8 + 0.3, tw: 2 + (i % 4) * 0.7, ph: i * 1.7 });
    }

    // 结算页面游戏化状态
    this._resultStartTime = 0;    // 结算开始时间（用于入场动画）
    this._resultParticles = [];   // 结算粒子（胜利金色/失败灰色）
    this._resultStarCount = 0;    // 胜利星级（1-3星）
  }

  /** 启动时性能档应用：LOW 关装饰阴影+粒子减半+关拖尾；MID 中画质（减半粒子+降光晕）；HIGH 全特效 */
  _applyPerfLevel() {
    if (this.perfLevel === 'LOW') {
      this.MAX_PARTICLES = 40;   // 低画质：荣耀Play5T/Helio G25 软渲染每个粒子都是像素填充，70→40
      this._fxLow = true;
      this._lowPerf = true;
      this.trailPoints.length = 0;
      this._trailPool.length = 0;
    } else if (this.perfLevel === 'MID') {
      this.MAX_PARTICLES = 90;       // 中画质：粒子减半（140→90），缓解中端机 CPU
      this._fxLow = false;
      this._lowPerf = false;
    } else {
      // HIGH：100 粒子（原 140 减到 100：粒子是 Canvas 2D 每帧 arc+fill 大头，
      // 中端机 bl>60 跑 45fps 档，140 粒子 CPU 烧 13-20%；100 个视觉差异小，CPU 降 ~30%）
      this.MAX_PARTICLES = 100;
      this._fxLow = false;
      this._lowPerf = false;
    }
  }

  resize(w, h) {
    this.width = w;
    this.height = h;
  }

  /** 由出战陀螺映射战斗属性，开始一局抽打 */
  start(playerBb, buff, run) {
    if (!playerBb) return false;
    this.buff = buff || null;   // 批次D·局前 buff（满速 / 目标-10% / 道具翻倍）
    this._powerupDouble = (buff === 'doublepower');
    // 批次E·连战 run 状态：{active, stage, buffs[]}
    const _run = run || { active: false, stage: 1, buffs: [] };
    this.runActive = !!_run.active;
    this.runStage = _run.stage || 1;
    this.runBuffs = Array.isArray(_run.buffs) ? _run.buffs.slice() : [];
    this.runBuffOpen = false;
    // 埋点：每局开始（P1 数据盲区）。stage 用于关卡分布 / 人均局数。
    reportBattleStart(_run.stage || 1);
    this._pendingRun = false;
    this._runBuffChoices = null;
    this._shieldCharges = 0;
    // 批次E·run buff 乘子
    this._scoreMult = 1; this._comboMult = 1; this._knockMult = 1; this._coinMult = 1; this._critChance = 0;
    this.playerBb = playerBb.clone();
    this.playerBb.angle = 0;
    this.power = playerBb.power;

    const t = this.playerBb.tier;
    const lv = this.playerBb.level;

    // 批次A·真实敌方陀螺：用 randomBeyblade 生成对手，元素/克制信息与之绑定
    const enemyBb = randomBeyblade();
    this.enemyBb = enemyBb;
    this.enemyElementIdx = enemyBb.elementIdx;
    this.elementMult = elementMultiplier(this.playerBb.elementIdx, this.enemyElementIdx);
    this.elementRel = this.elementMult > 1 ? 'adv' : (this.elementMult < 1 ? 'counter' : 'neutral');
    this.elementBonus = this.elementMult > 1 ? 60 : 0; // 克制开局 +60 分

    // 批次C·羁绊系统（play-design v1）：背包同元素 ≥3 件 → 元素共鸣，出战全属性 +10%
    const bond = (this.game && typeof this.game.bondResonance === 'function') ? this.game.bondResonance() : { active: false };
    this.bondActive = bond.active;
    this.bondElementIdx = bond.elementIdx;
    this.bondBonus = bond.active ? 0.1 : 0;

    // 品质/等级 → 物理属性（羁绊共鸣加成先算入 base）
    let maxSpeed = 18 + lv * 2 + this.playerBb.tierIndex * 2;
    let friction = 0.995 - this.playerBb.tierIndex * 0.0008 - (lv - 1) * 0.0004;
    if (this.bondActive) { maxSpeed *= (1 + this.bondBonus); this.power *= (1 + this.bondBonus); }

    // 批次C·羁绊系统：品质 Lv5 专属被动
    this.passive = (this.game && typeof this.game.qualityPassive === 'function') ? this.game.qualityPassive(playerBb) : null;
    if (this.passive) {
      if (this.passive.type === 'spin') maxSpeed *= 1.05;   // 普通=转速+5%
      if (this.passive.type === 'start') this._startBoost = 1; // 传说=开局极速（开战后立即满速）
    }

    this.scoreMultiplier = 1 + this.playerBb.tierIndex * 0.3 + (lv - 1) * 0.1;
    // 钩子墙难度曲线（统一由 stage 驱动，避免 winStreak 与 runStage 重复叠加）
    const ws = (this.game && this.game.winStreak) ? this.game.winStreak : 0;
    const stage = this.runActive ? this.runStage : ws;
    // 前3关≈0（建立信心+依恋，降低早期卸载）；第4关起台阶式加难（墙：差一点就过的挫败点→复活广告高频）；墙后继续爬坡
    let _diffFactor, _diff0, _timeCut, _comboWin;
    if (stage <= 3)      { _diffFactor = 0.45; _diff0 = 0;    _timeCut = 0; _comboWin = 2.4; }
    else if (stage === 4){ _diffFactor = 0.62; _diff0 = 0.45; _timeCut = 0; _comboWin = 2.0; }
    else                 { _diffFactor = Math.min(0.78, 0.62 + (stage - 4) * 0.03); _diff0 = Math.min(1, 0.45 + (stage - 4) * 0.11); _timeCut = (stage - 4) * 2; _comboWin = 1.6; }
    // 连击窗口随阶段收紧：新手期 2.4s 容错（手速慢也能连上），后期 1.6s 逼近原 1.5s 的紧张感。
    // 不这么做的话，目标分提上来后新手会因连击断掉而必输，违背"前3关建立信心"的既有设计意图。
    this._comboWindow = _comboWin;

    // 目标分（P0-1 重做）：跟"连击二次曲线"走，而不是跟 power×10 的线性走。
    // 旧公式 = (400 + power*10) * ramp → 新号目标仅 500，而满速单次抽打就有 600 分
    // （maxSpeed 20 × 30，见 :486），导致"划一下就赢 + 空转到 30 秒结束"。
    // 新公式：先按"满速单次抽打基准分"算出 N 次连击的理论累计输出，再乘阶段难度系数。
    // 目标始终与玩家自身输出挂钩 → 任何等级都必须全程维持连击才够，难度不会后期倒挂。
    const N_EXPECT = 16;                                           // 期望抽打次数（30s 内约 1.7s 一次）
    const baseWhip = Math.max(1, Math.floor(maxSpeed * 30));       // 与 :486 的 fEff*30 同源
    const comboCurve = N_EXPECT + 0.2 * N_EXPECT * (N_EXPECT - 1); // 连击二次增长累计系数
    this.targetScore = Math.max(400, Math.floor(baseWhip * TARGET_REF_MULT * comboCurve * this.scoreMultiplier * _diffFactor));

    const rad = 46 + lv * 2;
    const cx = this.width / 2;
    const cy = this.height / 2;  // 陀螺在屏幕正中心，与战斗盘/背景光环对齐
    this.top = {
      x: cx, y: cy, radius: rad, rotation: 0, angularVelocity: 8,
      vx: 0, vy: 0,   // 批次B·位移速度（让陀螺真正游走，不再钉死中心）
      friction, maxSpeed, wobble: 0, mass: 1,
      color: t.color, secondaryColor: t.glow || t.color, glowColor: t.glow || t.color, trailColor: t.glow || t.color
    };
    // 一局内 top 颜色/半径固定，重建失败无效，这里清缓存重新生成
    this._topGrads = {};
    this._arenaGrad = null;
    this._topCache = null;   // 批次A·玩家/敌方各自独立精灵缓存
    this._bgSprite = null;   // 背景合并位图依赖 top.color，换局重建
    this._bgSpriteW = 0;
    this._bgSpriteH = 0;
    this._arenaDecorSprite = null; // 装饰位图依赖 top.color，换局重建
    this._arenaDecorKey = '';

    // 批次A·真实敌方陀螺（难度由钩子墙 diff0 驱动）
    const arenaR0 = Math.min(this.width, this.height) * 0.40;
    // 钩子墙：diff0 由上方 stage 统一计算（前3关=0，第4关=0.45 墙，之后爬坡）
    const diff0 = _diff0;
    this._diff0 = diff0;
    const eTier = (this.enemyBb && this.enemyBb.tierIndex) || 0;
    const eLv = (this.enemyBb && this.enemyBb.level) || 1;
    const eRad = 46 + eLv * 2;
    const maxIn = arenaR0 - eRad - 6;
    const needGap = (rad + eRad) + 10;
    const eDist0 = Math.min(maxIn, needGap);
    const eTierColor = (this.enemyBb.tier && this.enemyBb.tier.color) || '#ff5252';
    const eTierGlow = (this.enemyBb.tier && this.enemyBb.tier.glow) || eTierColor;
    this.enemy = {
      x: cx, y: cy - eDist0,
      radius: eRad,
      vx: 0, vy: 0,
      angularVelocity: 8, maxSpeed: 6 + eTier * 1.2 + eLv * 0.4 + diff0 * 4,
      friction: 0.985,
      rotation: 0, wobble: 0,
      color: eTierColor, secondaryColor: eTierGlow, glowColor: eTierGlow, trailColor: eTierGlow,
      mass: 1 + eTier * 0.15 + diff0 * 0.4
    };
    this._enemyChargeCd = 1.6;
    this._enemyCharging = 0;
    this._enemyWanderAng = Math.random() * Math.PI * 2;
    this._enemyCache = null;   // 敌方独立精灵缓存
    this.isRingOut = false;

    this.score = this.elementBonus || 0;   // 策略系统：克制开局 +60 分
    this.displayScore = this.score;
    // 钩子墙：时间随 stage 收紧（仅墙后 stage≥5 才减，前4关满时间；下限 15s 保底可玩）
    this.timeRemaining = Math.max(15, this.timeLimit - _timeCut);
    this._winLockT = 0;
    this.combo = 0;
    this.comboTimer = 0;
    this.maxCombo = 0;
    this.isWhipping = false;
    this.whipCount = 0;
    this._burstCount = 0;
    this._rhythmCount = 0;
    this.lastWhipStyle = 'rhythm';
    this.lastWhipTime = 0;
    this._burstCd = 0;
    this.lastWhipGrade = null;   // 跨局重置，避免上一局评级泄漏到新局首鞭
    // 传说被动「开局极速」：开局立即满速
    if (this._startBoost && this.top) this.top.angularVelocity = this.top.maxSpeed;
    // 批次D·局前 buff 应用
    if (this.buff === 'fullspeed' && this.top) this.top.angularVelocity = this.top.maxSpeed;
    if (this.buff === 'targetdown') this.targetScore = Math.floor(this.targetScore * 0.9);
    if (this.buff === 'doublepower') this._powerupDouble = true;
    // 批次E·应用已累积的 run buff（叠层）
    for (let i = 0; i < this.runBuffs.length; i++) this._applyRunBuff(this.runBuffs[i]);
    this.particles.length = 0;
    this.floatingTexts.length = 0;
    this.trailPoints.length = 0;
    this._trailPool.length = 0;
    this.shockwaves.length = 0;
    this.screenShake = 0;
    this._hitstopT = 0;
    this._hitstopCd = 0;
    this.powerups.length = 0;
    this.powerupSpawnTimer = 0;
    this.activePowerups.speed = false;
    this.activePowerups.doubleScore = false;
    this.activePowerups.slowFriction = false;
    this.powerupTimers.speed = 0;
    this.powerupTimers.doubleScore = 0;
    this.powerupTimers.slowFriction = 0;

    this.result = null;
    this.reward = 0;
    this._hitScoreCd = 0;   // 撞击得分冷却（防持续贴身刷分导致不操作自动赢）
    this.dropItem = null;
    this.active = true;
    this.phase = 'playing';
    this.countdown = 1.2;                 // 3-2-1-GO 倒计时（0.3s/数字，3+2+1+GO 共 4 拍 = 1.2s）
    this._countGoPlayed = false;
    if (this.audio) this.audio.play('countdown');
    return true;
  }

  whipStart(x, y) {
    if (this.phase !== 'playing') return;
    if (this.countdown > 0) return;   // 倒计时期间不允许抽打
    this.isWhipping = true;
    this.whipStartX = x; this.whipStartY = y;
    this.whipEndX = x; this.whipEndY = y;
  }

  whipMove(x, y) {
    if (!this.isWhipping) return;
    this.whipEndX = x; this.whipEndY = y;
  }

  whipEnd(x, y) {
    if (!this.isWhipping) return;
    this.whipEndX = x; this.whipEndY = y;
    this._calculateWhipForce();
    this._collectPowerup(x, y);
    this.isWhipping = false;
    this.whipStartX = this.whipStartY = this.whipEndX = this.whipEndY = 0;
  }

  _calculateWhipForce() {
    const top = this.top;
    const dx = this.whipEndX - this.whipStartX;
    const dy = this.whipEndY - this.whipStartY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (!isFinite(distance) || distance < 5) return;

    const angleToTop = Math.atan2(top.y - this.whipStartY, top.x - this.whipStartX);
    const whipAngle = Math.atan2(dy, dx);
    let angleDiff = Math.abs(whipAngle - angleToTop);
    while (angleDiff > Math.PI) angleDiff = Math.PI * 2 - angleDiff;

    // 批次C·三档角度判定（替代连续 efficiency）：让"准划"优于"快划"
    let grade, effMul, impMul;
    if (angleDiff <= 15 * Math.PI / 180) { grade = 'perfect'; effMul = 1.6; impMul = 1.0; }
    else if (angleDiff <= 45 * Math.PI / 180) { grade = 'normal'; effMul = 0.65; impMul = 1.0; }
    else { grade = 'miss'; effMul = 0.25; impMul = 1.5; }   // 打偏：力度低，但位移冲量×1.5（易砸墙）

    // 防"打满"：转速 >92% 上限时再抽，效能×0.4（杜绝无脑快划）
    const overSpin = Math.abs(top.angularVelocity) > top.maxSpeed * 0.92 ? 0.4 : 1;

    const efficiency = effMul * overSpin;
    // 批次F·距离系数：短划吃亏、长划有上限（常量定义见文件头）
    const distFactor = WHIP_DIST_MIN + (WHIP_DIST_MAX - WHIP_DIST_MIN) * Math.min(1, distance / WHIP_DIST_FULL);
    const force = top.maxSpeed * distFactor * efficiency;

    // 批次C·节奏 vs 爆发：连打（间隔 <0.45s）+ 能量≥1 + 上一次非打偏 → 爆发（快须建立在准之上）
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const gap = this.lastWhipTime ? (now - this.lastWhipTime) : 9999;
    this.lastWhipTime = now;
    let burst = false;
    if (gap < 450 && this._burstCd <= 0 && this.game && this.game.energy > 0 && this.lastWhipGrade !== 'miss') {
      burst = true;
      this.game.energy -= 1;
      this._burstCd = 0.9;
    }
    // 批次F：爆发 ×1.5，受"力道硬上限"约束而非 maxSpeed。
    // 旧代码是 Math.min(force*1.5, top.maxSpeed) —— 在新力度曲线下（满划可超过 maxSpeed）
    // 会把爆发的力道砍回 maxSpeed，导致爆发反而**弱于**普通满划，必须同步修掉。
    const forceCap = top.maxSpeed * FORCE_CAP_MULT;
    const fEff = burst ? Math.min(force * 1.5, forceCap) : Math.min(force, forceCap);
    this.lastWhipStyle = burst ? 'burst' : 'rhythm';
    if (burst) this._burstCount++; else this._rhythmCount++;
    this.lastWhipGrade = grade;

    const crossProduct = dx * (top.y - this.whipStartY) - dy * (top.x - this.whipStartX);
    const direction = crossProduct > 0 ? 1 : -1;

    top.angularVelocity += fEff * direction;
    if (top.angularVelocity > top.maxSpeed) top.angularVelocity = top.maxSpeed;
    if (top.angularVelocity < -top.maxSpeed) top.angularVelocity = -top.maxSpeed;

    // 批次B·位移冲量：抽打方向推进陀螺（打偏时冲量×1.5，配合盘壁回弹制造技巧压力）
    const whipLen = Math.sqrt(dx * dx + dy * dy) || 1;
    const impMag = Math.min(fEff, top.maxSpeed * IMPULSE_CAP) * 0.30 * impMul;
    top.vx += (dx / whipLen) * impMag;
    top.vy += (dy / whipLen) * impMag;

    if (grade === 'miss') this.combo = 0;   // 打偏断连击

    this.combo++;
    this.whipCount++;
    this.comboTimer = this._comboWindow || 1.5;
    if (this.combo > this.maxCombo) this.maxCombo = this.combo;

    // 游戏化特效：暴击判定（效率>0.85 或 爆发抽打）
    // 批次F·P1-3：必须在计分之前算。旧代码把 critMult 算在 earnedScore 之后，
    // 导致它是个**死变量**（全文件只出现一次）—— 暴击有金色粒子、双冲击波、放大飘字，收益却是 0。
    // 注意：perfect 档 efficiency 恒为 1.6 > 0.85，所以「完美划 ⇒ 必定暴击」，
    // critMult 实质上是完美档奖励的一部分，而非随机事件。
    const isCrit = burst || efficiency > 0.85 || (this._critChance > 0 && Math.random() < this._critChance);
    const critMult = isCrit ? CRIT_MULT : 1;
    // 批次F·命中定帧：暴击瞬间冻结 50ms（撞击定帧见碰撞处，两者取较大值，不叠加）
    if (isCrit) this._hitstopT = Math.max(this._hitstopT, HITSTOP_CRIT);

    const baseScore = Math.floor(fEff * 30);
    const comboBonus = Math.floor(baseScore * (this.combo - 1) * 0.4 * this._comboMult);
    let earnedScore = Math.max(5, baseScore + comboBonus);
    if (this.activePowerups.doubleScore) earnedScore *= 2;
    // 批次F·元素克制真正进入公式。旧版 1.35/0.75 只用于 HUD 显示，实际被拍平成"克制开局 +60 分"，
    // 于是 HUD 大张旗鼓展示"克制/被克"却毫无收益 —— 玩家以为选角有讲究，其实预判是假的。
    // 现在全程生效：克制 ×1.35 / 持平 ×1.0 / 被克 ×0.75（开局 +60 的一次性奖励保留，作为"开局信号"）。
    const elemMult = this.elementMult || 1;
    earnedScore = Math.floor(earnedScore * this.scoreMultiplier * this._scoreMult * elemMult * critMult);

    this.score += earnedScore;
    this.screenShake = Math.min(SHAKE_MAX, fEff * 0.6);

    // 命中闪光（陀螺位置爆发光效）
    this.shockwaves.push({ x: top.x, y: top.y, radius: top.radius * 1.5, maxRadius: top.radius * (isCrit ? 6 : 4), alpha: isCrit ? 1 : 0.8, color: isCrit ? '#FFD700' : top.color });
    if (isCrit) {
      // 暴击：双重冲击波
      this.shockwaves.push({ x: top.x, y: top.y, radius: top.radius * 0.8, maxRadius: top.radius * 5, alpha: 0.6, color: '#FF6B6B' });
    }
    this._createParticles(top.x, top.y, fEff * (isCrit ? 5 : 3));
    if (isCrit) {
      // 暴击：额外金色粒子
      this._createParticles(top.x, top.y, 12, '#FFD700');
    }
    if (grade === 'miss') this._createParticles(top.x, top.y, 8, '#ff5252');

    // 浮动文字（暴击更大更醒目；完美/打偏给出评级反馈）
    let ftText = '+' + earnedScore;
    if (burst) ftText = '爆发！+' + earnedScore;
    else if (grade === 'perfect') ftText = '完美！+' + earnedScore;
    else if (grade === 'miss') ftText = '打偏 ' + earnedScore;
    const ftColor = burst ? '#ffd54f' : (isCrit ? '#FF6B6B' : (grade === 'perfect' ? '#FFD700' : (grade === 'miss' ? '#FF5252' : '#FFFFFF')));
    this._addFloatingText(top.x, top.y - 70, ftText, ftColor, this.combo > 1 || isCrit, isCrit ? 1.5 : 1);

    // 连击里程碑特效（combo = 5/10/20/50/100）
    const comboMilestones = [5, 10, 20, 50, 100];
    if (comboMilestones.includes(this.combo)) {
      this._addFloatingText(top.x, top.y - 110, this.combo + ' 连击！', '#FFD700', true, 2);
      this.screenShake = Math.max(this.screenShake, 8);
      // 里程碑：大范围粒子爆发
      this._createParticles(top.x, top.y, 25, '#FFD700');
      this.shockwaves.push({ x: top.x, y: top.y, radius: top.radius * 2, maxRadius: top.radius * 8, alpha: 0.7, color: '#FFD700' });
    }

    if (typeof wx !== 'undefined' && wx.vibrateShort) {
      wx.vibrateShort({ type: isCrit ? 'heavy' : (fEff > top.maxSpeed * 0.8 ? 'heavy' : 'medium') });
    }
    if (this.audio) this.audio.play('clash', { freq: 1400 + fEff * 8 + (isCrit ? 400 : 0), gain: 0.22 + fEff * 0.004 + (isCrit ? 0.1 : 0) });
  }

  _addFloatingText(x, y, text, color, isCombo, scale) {
    let ft = this._ftPool.pop();
    if (!ft) ft = {};   // 池空才 new，其余复用（对象池：消除抽打高频 GC）
    ft.x = x + (Math.random() - 0.5) * 30; ft.y = y; ft.text = text; ft.color = color;
    ft.size = isCombo ? 32 : 24; ft.alpha = 1; ft.vy = -2.5;
    ft.rotation = (Math.random() - 0.5) * 0.3; ft.scale = (isCombo ? 1.8 : 1) * (scale || 1);
    ft.isCombo = isCombo; ft.bounce = 0;
    this.floatingTexts.push(ft);
  }

  _createParticles(x, y, speed, color) {
    const top = this.top;
    let count = Math.min(Math.floor(Math.abs(speed) / 1.2) + 8, 40);
    if (this._lowPerf) count = Math.floor(count / 2);   // 软上限：低帧率时减半粒子
    if (this.perfLevel === 'LOW') count = Math.min(count, 18);   // 低端机单次抽打粒子硬限：软渲染像素填充太贵
    for (let i = 0; i < count; i++) {
      if (this.particles.length >= this.MAX_PARTICLES) {
        // 硬上限：回收最旧（归还池），内存有界
        const old = this.particles.shift();
        if (old) this._particlePool.push(old);
      }
      let p = this._particlePool.pop();
      if (!p) p = {};   // 池空才 new，其余复用
      const angle = Math.random() * Math.PI * 2;
      const velocity = Math.random() * 6 + 3;
      p.x = x + (Math.random() - 0.5) * top.radius * 1.8;
      p.y = y + (Math.random() - 0.5) * top.radius * 1.8;
      p.vx = Math.cos(angle) * velocity; p.vy = Math.sin(angle) * velocity;
      p.life = 1; p.decay = Math.random() * 0.02 + 0.01;
      p.size = Math.random() * 8 + 2; p.color = color || top.color;
      p.type = 'circle';   // 全部圆形火花：星形在高速飞溅+旋转时低分辨率下像棱形块（视觉脏）
      this.particles.push(p);
    }
  }

  _spawnPowerup() {
    if (this.powerups.length >= 3) return;
    const type = POWERUPS[Math.floor(Math.random() * POWERUPS.length)];
    const W = this.width, H = this.height;
    const ST = this.safeTop || 44;
    const SB = this.safeBottom || 24;
    const topR = this.top ? this.top.radius : 50;
    const cx = this.top ? this.top.x : (W / 2);
    const cy = this.top ? this.top.y : (H * 0.42);

    // ============================================================
    // 绝对禁带（这些矩形里永远不刷道具，严格不等式）
    // · 陀螺区：外接 (cx, cy) 半径 topR + 64 的外扩
    // · HUD 顶带：ST 顶部 + 分数行(36) + 激活道具(34) + 气隙 16 = off+92 以上（激活道具行底）
    // · HUD 底带：速度条 y-30 以下（包含目标条文字 + 目标条 + 速度条 + 其下 Home Bar）
    // · 教程卡：whipCount<2 存在时的 (w/2-160, H/2+70, 320, 100) 矩形
    // · 返回按钮：(12, ST+2, 66, 34) → 扩展 y<ST+2+34+12
    // ============================================================
    const topBandBottom = (28 + ST) + 36 + 34 + 16;            // 顶 HUD 底
    const progH = 10, speedH = 10, barGap = 12, txtGap = 16;
    const barW = W * 0.68, barX = (W - barW) / 2;
    const progBarY = H - SB - 60;
    const speedBarY = progBarY + progH + barGap;
    const speedBarBottom = speedBarY + speedH;
    const bottomBandTop = Math.min(progBarY - txtGap, speedBarBottom + 20);   // 底 HUD 顶：进度条文案上沿

    const gyroMinX = cx - topR - 56;
    const gyroMaxX = cx + topR + 56;
    const gyroMinY = cy - topR - 56;
    const gyroMaxY = cy + topR + 56;

    const tutorialActive = this.whipCount < 2;
    const tutX1 = W / 2 - 170, tutX2 = W / 2 + 170;
    const tutY1 = H / 2 + 60, tutY2 = H / 2 + 180;

    const backBtnY2 = (ST + 2) + 34 + 16;            // 返回按钮底 + 气隙

    // 候选条：把剩余可用 Y 切成若干 horizontal bands
    // Band A：topBandBottom ~ min(gyroMinY, backBtnY2) 之上
    // Band B：gyroMaxY ~ bottomBandTop
    const bandA_top = Math.max(ST + 20, topBandBottom, backBtnY2);
    const bandA_bot = gyroMinY - 36;
    const bandB_top = gyroMaxY + 36;
    const bandB_bot = bottomBandTop - 36;

    let bandOK = [];
    if (bandA_bot - bandA_top >= 40) bandOK.push([bandA_top, bandA_bot]);
    if (bandB_bot - bandB_top >= 40) bandOK.push([bandB_top, bandB_bot]);
    if (!bandOK.length) {
      // 兜底：陀螺上方最顶，绝对不撞顶 HUD
      const y = Math.max(ST + 120, H * 0.24);
      bandOK.push([y, y + 36]);
    }
    const [t0, t1] = bandOK[Math.floor(Math.random() * bandOK.length)];
    const y = t0 + Math.random() * (t1 - t0);

    // x：避开教程卡横带（若 active）+ 避开陀螺横带 + 避开进度条横带中央（barX~barX+barW）
    let x = 0;
    const padding = 48;
    for (let tries = 0; tries < 16; tries++) {
      x = padding + Math.random() * (W - padding * 2);
      // 陀螺横带
      if (x >= gyroMinX - 36 && x <= gyroMaxX + 36 && y >= gyroMinY - 36 && y <= gyroMaxY + 36) continue;
      // 教程卡矩形
      if (tutorialActive && x >= tutX1 - 36 && x <= tutX2 + 36 && y >= tutY1 - 36 && y <= tutY2 + 36) continue;
      // 进度条（只对 y 落在 progBarY 段时保护 x 中段）
      if (y >= progBarY - 36 && y <= speedBarBottom + 36 && x >= barX - 24 && x <= barX + barW + 24) continue;
      break;
    }
    this.powerups.push(Object.assign({}, type, {
      x: x, y: y,
      scale: 1, pulseDirection: 1, rotation: 0, spawnTime: Date.now()
    }));
  }

  _collectPowerup(x, y) {
    for (let i = this.powerups.length - 1; i >= 0; i--) {
      const p = this.powerups[i];
      const dist = Math.hypot(x - p.x, y - p.y);
      if (dist < 35) {
        this._activatePowerup(p.effect, p.duration);
        this.powerups.splice(i, 1);
        // 游戏化收集反馈：粒子+冲击波+屏幕震动+醒目文字
        this._createParticles(p.x, p.y, 20, p.color);
        this.shockwaves.push({ x: p.x, y: p.y, radius: 15, maxRadius: 60, alpha: 0.7, color: p.color });
        this.screenShake = Math.max(this.screenShake, 4);
        this._addFloatingText(p.x, p.y - 10, p.name + '!', p.color, true, 1.3);
        if (this.audio) this.audio.play('collect');
        // 震动反馈
        if (typeof wx !== 'undefined' && wx.vibrateShort) {
          wx.vibrateShort({ type: 'light' });
        }
        break;
      }
    }
  }

  _activatePowerup(effect, duration) {
    this.activePowerups[effect] = true;
    this.powerupTimers[effect] = duration;
    if (effect === 'speed') {
      this.top.angularVelocity = Math.min(this.top.maxSpeed, this.top.angularVelocity + this.top.maxSpeed * 0.5);
    }
  }

  _settle(force) {
    if (this.phase !== 'playing') return;
    this.phase = 'result';
    // 埋点：首局完成（P1 数据盲区）。每用户一生仅一次，用于算"首局完成率"。
    reportFirstBattleDone();
    // 每日挑战：完成 1 局对战（胜/负都算）
    if (this.game && typeof this.game.recordDailyTask === 'function') {
      this.game.recordDailyTask('battle');
    }
    this.isRingOut = (force === 'win' || force === 'lose');
    const win = (force === 'win') || (force !== 'lose' && this.score >= this.targetScore);
    if (win) {
      this.result = 'win';
      // 批次E·连战胜利 → 弹出三选一 buff（免费叠层继续下一关）
      if (this.runActive) {
        this._pendingRun = true;
        this._rollRunBuffChoices();
        if (this.game) this.game.runBuffOpen = true;
      }
      if (this.game && typeof this.game.winStreak === 'number') this.game.winStreak += 1;
      // 连胜倍率（play-design v1）：金币奖励 × 1x/2x/3x/5x（断连归零）
      const mult = (this.game && typeof this.game.streakMultiplier === 'function') ? this.game.streakMultiplier() : 1;
      // 限时活动（play-design v1）：周末双倍金币
      let actMult = 1;
      if (this.game && typeof this.game.activityInfo === 'function') {
        actMult = this.game.activityInfo().weekendDouble ? 2 : 1;
      }
      // 金币产出：连胜/活动倍率只放大「得分」部分，战力底盘不参与放大。
      // 原写法把整个式子（含 power*1.5）一起乘倍率 —— 战力随品质×等级指数增长，
      // 再叠 5 倍连胜会让 Lv5 传说一局刷到近 8000 金币。而金币此前没有任何消耗出口，
      // 纯单向灌入等于通胀。调整后同场景约 2020，仍是最高档收益。
      const scorePart = Math.floor(this.score / 50) * mult * actMult;
      const powerPart = Math.floor(this.power * 0.5);
      this.reward = Math.floor((scorePart + powerPart + 20) * this._coinMult);
      if (this.isRingOut) this.reward = Math.floor(this.reward * 1.25) + 40; // 出界制胜额外奖励
      this.game.coins += this.reward;
      // 大师等级：对战胜利 +50 经验
      if (this.game && typeof this.game.addExp === 'function') this.game.addExp(50);
      // 竞技场天梯：胜利按得分折算竞技积分（周赛）
      if (this.game && typeof this.game.addArenaScore === 'function') {
        this.arenaGained = this.game.addArenaScore(this.score);
      }
      if (Math.random() < 0.35) {
        this.dropItem = randomBeyblade();
        if (this.game.inventory.length < 400) {
          this.game.inventory.push(this.dropItem);
          this.game.unlockCollection(this.dropItem.tierIndex, this.dropItem.level);
        } else {
          this.game.coins += Math.max(1, Math.floor(this.dropItem.power * 0.1));
        }
      }
      // 批次D·对战掉落宝箱（play-design v1）：胜利 30% 概率掉「竞技宝箱」，高连击提升品质
      this.chestDropped = null;
      if (Math.random() < 0.3) {
        const q = this.maxCombo >= 15 ? 2 : (this.maxCombo >= 8 ? 1 : 0); // 高连击 → 高品质
        this.chestDropped = { quality: q };
        if (this.game && typeof this.game.dropBattleChest === 'function') this.game.dropBattleChest(q);
      }
      // 胜负结算后立即存档（绕过 2s 节流）
      if (this.game && typeof this.game.save === 'function') {
        this.game.lastSave = 0;
        try { this.game.save(); } catch (e) {}
      }
    } else {
      this.result = 'lose';
      this.reward = 0;
      // 批次E·连战失败 → 结束连战
      this.runActive = false;
      if (this.game) this.game.runBuffOpen = false;
      // 失败惩罚：门票 20 已扣不退，此处再扣 LOSE_ENERGY_PENALTY（唯一真值来源，见文件头）
      this.game.energy = Math.max(0, this.game.energy - LOSE_ENERGY_PENALTY);
      if (this.game && typeof this.game.winStreak === 'number') this.game.winStreak = 0;
      // 败也存档
      if (this.game && typeof this.game.save === 'function') {
        this.game.lastSave = 0;
        try { this.game.save(); } catch (e) {}
      }
    }
  }

  update(dt) {
    if (!this.active || this.phase !== 'playing') return;

    // 滚动帧时统计 → 软上限：持续低帧率则降效，防低端机掉帧雪崩（带迟滞）
    this._avgDt = this._avgDt * 0.9 + dt * 0.1;
    if (this._avgDt > 1 / 30) this._lowPerf = true;        // <30fps 触发
    else if (this._avgDt < 1 / 50) this._lowPerf = false;  // >50fps 恢复

    // 开局倒计时：期间只让陀螺缓慢自转，不消耗时间 / 不刷道具 / 不结算
    if (this.countdown > 0) {
      this.countdown -= dt;
      if (this.countdown <= 0.3 && !this._countGoPlayed) {
        this._countGoPlayed = true;
        if (this.audio) this.audio.play('win');
      }
      if (this.top) this.top.rotation += 2.5 * Math.min(dt / 0.016, 3);
      this._updateParticles();
      this._updateFloatingTexts();
      this._updateShockwaves();
      return;
    }

    // 批次F·命中定帧（hitstop）：撞击/暴击瞬间冻结玩法时间。
    // - 用**真实时间**倒计时，定帧本身不吃被冻结的时间；
    // - 物理/计时器/回能/连击窗口全部不推进 → 玩家不会因顿帧被扣时间；
    // - 但震屏按真实时间继续衰减：若画面完全静止会像"卡住了"，微颤才是"打中了"。
    // - 例外：胜利锁定(_winLockT)是"结算延迟"而非玩法时间，定帧期间照常推进 ——
    //   否则玩家达标后还要为每一次顿帧多等，结算迟迟不弹。
    if (this._hitstopT > 0) {
      this._hitstopT -= dt;
      if (this._hitstopCd > 0) this._hitstopCd -= dt;
      if (this._winLockT > 0) {
        this._winLockT -= dt;
        if (this._winLockT <= 0) { this._settle(); return; }
      }
      if (this.screenShake > 0) {
        this.screenShake *= Math.pow(0.85, Math.min(dt / 0.016, 3));
        if (this.screenShake < 0.1) this.screenShake = 0;
      }
      return;   // 粒子/浮字/冲击波一并定格，形成冲击瞬间画面
    }
    if (this._hitstopCd > 0) this._hitstopCd -= dt;

    const top = this.top;
    if (!isFinite(top.angularVelocity)) top.angularVelocity = 8;

    // 持续旋转摩擦声：转速越高越尖（金属大陀螺 tierIndex 高 → 更尖锐刺耳）
    if (this.audio && Math.abs(top.angularVelocity) > 0.5) {
      const ratio = Math.min(Math.abs(top.angularVelocity) / top.maxSpeed, 1);
      const tierIdx = (this.playerBb && this.playerBb.tierIndex) || 0;
      this.audio.playSpin(ratio, tierIdx);
    } else if (this.audio) {
      this.audio.stopSpin();
    }

    const timeScale = Math.min(dt / 0.016, 3);
    top.rotation += top.angularVelocity * timeScale;
    top.wobble = Math.sin(top.rotation * 0.5) * (1 - Math.abs(top.angularVelocity) / top.maxSpeed) * 0.3;

    let friction = top.friction;
    if (this.activePowerups.slowFriction) friction = 0.9985;
    top.angularVelocity *= Math.pow(friction, timeScale);
    if (Math.abs(top.angularVelocity) < 0.001) top.angularVelocity = 0;

    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) this.combo = 0;
    }
    if (this._hitScoreCd > 0) this._hitScoreCd -= dt;   // 撞击得分冷却递减
    if (this._burstCd > 0) this._burstCd -= dt;
    if (this.screenShake > 0) {
      this.screenShake *= Math.pow(0.85, timeScale);
      if (this.screenShake < 0.1) this.screenShake = 0;
    }

    if (!this._lowPerf && Math.abs(top.angularVelocity) > 2) {
      const ratio = Math.abs(top.angularVelocity) / top.maxSpeed;
      // 池化：复用对象，避免每帧 new（粒子/浮字都已池化，拖尾漏了）
      const tp = this._trailPool.length ? this._trailPool.pop() : {};
      tp.x = top.x; tp.y = top.y; tp.alpha = ratio; tp.size = ratio * 30;
      this.trailPoints.push(tp);
      if (this.trailPoints.length > 30) {
        const removed = this.trailPoints.shift();
        if (this._trailPool.length < 30) this._trailPool.push(removed);
      }
    } else if (this.trailPoints.length) {
      // 回收当前拖尾对象到池，避免每帧重建
      while (this.trailPoints.length) {
        const removed = this.trailPoints.pop();
        if (this._trailPool.length < 30) this._trailPool.push(removed);
      }
    }

    // 批次A·开放场地 + 软边界：玩家/敌方皆在盘内游走，越过 RING_R 才出界（Ring Out）
    const arenaR = Math.min(this.width, this.height) * 0.40;
    const RING_R = arenaR * 1.05;        // 出界硬阈值（留 5% 缓冲，避免轻微越界即判负）
    const SOFT_START = arenaR * 0.70;    // 从 70% 半径起施加向心回中力
    const ccx = this.width / 2, ccy = this.height / 2;

    // 软边界回中力（作用于速度，先于位移）：越靠近边缘，朝外速度被削减越多 + 向心加速度越强
    // 作用：中心区自由游走不变；靠近边界被柔和拉回；仅被高速正撞才可能真正出界（保留 Ring Out 张力）
    const pDist0 = Math.hypot(top.x - ccx, top.y - ccy);
    if (pDist0 > SOFT_START) {
      const t = Math.min(1, (pDist0 - SOFT_START) / (arenaR - SOFT_START));
      const dirx = (ccx - top.x) / (pDist0 || 1);
      const diry = (ccy - top.y) / (pDist0 || 1);
      // 向心加速度：0.4 → 1.2 渐强（参数经 /tmp/ringout_tune.js 定标）
      const pull = (0.4 + 0.8 * t) * t;
      top.vx += dirx * pull * timeScale;
      top.vy += diry * pull * timeScale;
      // 朝外速度分量衰减（盘边摩擦，防高速甩出）：每帧削减 12% → 42%
      const vOut = top.vx * (-dirx) + top.vy * (-diry);
      if (vOut > 0) {
        const damp = Math.min(vOut, vOut * (0.12 + 0.30 * t));
        top.vx += dirx * damp;
        top.vy += diry * damp;
      }
    }

    // 玩家位移积分 + 阻尼（无墙：越出 RING_R 才判负）
    top.x += top.vx * timeScale;
    top.y += top.vy * timeScale;
    top.vx *= Math.pow(0.90, timeScale);
    top.vy *= Math.pow(0.90, timeScale);

    // 敌方 AI 行动 + 位移积分
    if (this.enemy) this._updateEnemyAI(dt, timeScale, ccx, ccy, arenaR);

    // 玩家 ↔ 敌方 碰撞击退
    if (this.enemy) this._resolveCollision(top, this.enemy);

    // 敌方软边界保护（更强更早，参数经 /tmp/enemy_ringout_sim.js 定标）：防止敌方被碰撞弹飞后
    // 惯性冲出界「自杀送赢」——这是继撞击刷分外第二条「不操作自动赢」路径，一并堵掉。
    if (this.enemy) {
      const eD = Math.hypot(this.enemy.x - ccx, this.enemy.y - ccy);
      const SOFT_E = arenaR * 0.75;
      if (eD > SOFT_E) {
        const t = Math.min(1, (eD - SOFT_E) / (RING_R - SOFT_E));
        const edx = (ccx - this.enemy.x) / (eD || 1), edy = (ccy - this.enemy.y) / (eD || 1);
        this.enemy.vx += edx * (0.8 + 1.5 * t) * t * timeScale;
        this.enemy.vy += edy * (0.8 + 1.5 * t) * t * timeScale;
        const vO = this.enemy.vx * -edx + this.enemy.vy * -edy;
        if (vO > 0) { const d = Math.min(vO, vO * (0.20 + 0.50 * t)); this.enemy.vx += edx * d; this.enemy.vy += edy * d; }
      }
    }

    // 出界判定（Ring Out）：任一方越过 RING_R（含 5% 缓冲）才分胜负
    const pDist = Math.hypot(top.x - ccx, top.y - ccy);
    if (pDist > RING_R) { this._ringOut('lose'); return; }
    if (this.enemy) {
      const eDist = Math.hypot(this.enemy.x - ccx, this.enemy.y - ccy);
      if (eDist > RING_R) { this._ringOut('win'); return; }
    }

    // 道具刷新（buff「道具翻倍」将间隔减半）
    this.powerupSpawnTimer += dt;
    const spawnInterval = this._powerupDouble ? 2.5 : 5;
    if (this.powerupSpawnTimer >= spawnInterval) { this._spawnPowerup(); this.powerupSpawnTimer = 0; }
    for (const p of this.powerups) {
      p.scale += 0.015 * p.pulseDirection * timeScale;
      p.rotation += 0.05 * timeScale;
      if (p.scale >= 1.2 || p.scale <= 0.8) p.pulseDirection *= -1;
    }
    // 固定三键遍历：替代 Object.keys 每帧建数组（GC 来源）
    const ptk = ['speed', 'doubleScore', 'slowFriction'];
    for (let k = 0; k < ptk.length; k++) {
      const key = ptk[k];
      if (this.powerupTimers[key] > 0) {
        this.powerupTimers[key] -= dt;
        if (this.powerupTimers[key] <= 0) { this.powerupTimers[key] = 0; this.activePowerups[key] = false; }
      }
    }

    // 分数滚动显示
    if (this.displayScore < this.score) {
      this.displayScore += Math.ceil((this.score - this.displayScore) * 0.15);
    }

    // 粒子 / 飘字 / 冲击波（帧更新）
    this._updateParticles();
    this._updateFloatingTexts();
    this._updateShockwaves();

    // 倒计时与胜负判定
    // P0-1：达标即结算。旧逻辑只等 timeRemaining 归零（30s 里前 2s 就赢了，剩下 28s 纯空转）。
    // 留 0.8s 胜利锁定窗口：让达标那一下的粒子/飘字/冲击波播完再弹结算，避免手感被硬切。
    if (this._winLockT > 0) {
      this._winLockT -= dt;
      if (this._winLockT <= 0) { this._settle(); return; }
    } else if (this.score >= this.targetScore) {
      this._winLockT = 0.8;
      this._addFloatingText(top.x, top.y - 130, '目标达成！', '#00e676', true, 1.6);
      this.screenShake = Math.max(this.screenShake, 10);
      this.shockwaves.push({ x: top.x, y: top.y, radius: top.radius * 2, maxRadius: top.radius * 9, alpha: 0.8, color: '#00e676' });
    }

    this.timeRemaining -= dt;
    if (this.timeRemaining <= 0 || top.angularVelocity === 0) {
      this._settle();
    }
  }

  _updateEnemyAI(dt, timeScale, ccx, ccy, arenaR) {
    const e = this.enemy;
    const top = this.top;
    const eDistC = Math.hypot(e.x - ccx, e.y - ccy);
    const diff = this._diff0 || 0;   // 缓启动难度（与 start 统一，避免 winStreak 双重叠加）
    let dirX, dirY, accel;
    this._enemyChargeCd -= dt;
    if (eDistC > arenaR * 0.72) {
      // 求生：靠近边界则强烈回中，避免自爆出界
      dirX = ccx - e.x; dirY = ccy - e.y;
      accel = 0.9 + diff * 0.4;     // 回中加速度（恢复第一版：敌方更激进）
    } else if (this._enemyCharging > 0) {
      // 冲撞玩家
      this._enemyCharging -= dt;
      dirX = top.x - e.x; dirY = top.y - e.y;
      accel = 0.7 + diff * 0.5;     // 冲撞加速度（恢复第一版：敌方更激进）
    } else {
      // 游走
      this._enemyWanderAng += (Math.random() - 0.5) * 0.3;
      dirX = Math.cos(this._enemyWanderAng); dirY = Math.sin(this._enemyWanderAng);
      accel = 0.35;
      if (this._enemyChargeCd <= 0) {
        this._enemyCharging = 0.8 + Math.random() * 0.6;
        this._enemyChargeCd = Math.max(0.9, 2.2 - diff * 1.0);  // 冲撞频率（恢复第一版：高压迫）
      }
    }
    const len = Math.hypot(dirX, dirY) || 1;
    e.vx += (dirX / len) * accel * timeScale;
    e.vy += (dirY / len) * accel * timeScale;
    const sp = Math.hypot(e.vx, e.vy);
    if (sp > e.maxSpeed) { e.vx = e.vx / sp * e.maxSpeed; e.vy = e.vy / sp * e.maxSpeed; }
    e.vx *= Math.pow(e.friction, timeScale);
    e.vy *= Math.pow(e.friction, timeScale);
    e.x += e.vx * timeScale;
    e.y += e.vy * timeScale;
    e.rotation += e.angularVelocity * timeScale;
    e.angularVelocity *= Math.pow(e.friction, timeScale);
    if (Math.abs(e.angularVelocity) < 4) e.angularVelocity = 6 + diff * 4;
  }

  _resolveCollision(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const dist = Math.hypot(dx, dy);
    const minDist = a.radius + b.radius;
    if (dist === 0 || dist >= minDist) return;
    const nx = dx / (dist || 1), ny = dy / (dist || 1);
    const overlap = minDist - dist;
    const ma = a.mass || 1, mb = b.mass || 1;
    const total = ma + mb;
    // 分离重叠
    a.x -= nx * overlap * (mb / total);
    a.y -= ny * overlap * (mb / total);
    b.x += nx * overlap * (ma / total);
    b.y += ny * overlap * (ma / total);
    // 沿法线交换动量（弹性碰撞）
    const rvx = b.vx - a.vx, rvy = b.vy - a.vy;
    const velAlongNormal = rvx * nx + rvy * ny;
    if (velAlongNormal > 0) return; // 正在分离则不再施加冲量
    const e = 0.85;   // 撞击弹性系数（恢复第一版：更硬更实，易被弹飞、Ring Out 张力强）
    const j = -(1 + e) * velAlongNormal / total * (this._knockMult || 1);
    const ix = j * nx, iy = j * ny;
    a.vx -= ix * mb; a.vy -= iy * mb;
    b.vx += ix * ma; b.vy += iy * ma;
    // 撞击反馈（复用现有粒子/震屏/音效）
    const hx = (a.x + b.x) / 2, hy = (a.y + b.y) / 2;
    this._createParticles(hx, hy, 10, '#ffd54f');
    this.screenShake = Math.max(this.screenShake, 6);
    // 批次F·命中定帧：撞击是最重的打击点，冻结 90ms（与暴击定帧取较大值，不叠加）
    // 两道闸门：相对速度够大（真撞击而非贴着蹭）+ 冷却已过。缺任一都会让贴身状态卡死游戏。
    if (Math.abs(velAlongNormal) > HITSTOP_MIN_IMPACT && this._hitstopCd <= 0) {
      this._hitstopT = Math.max(this._hitstopT, HITSTOP_COLLISION);
      this._hitstopCd = HITSTOP_COLLISION_CD;
    }
    if (this.audio) this.audio.play('clash', { freq: 500, gain: 0.2 });
    // 撞击小额得分奖励（鼓励进攻）；加冷却，避免持续贴身每帧刷分导致「不操作自动赢」
    if (this._hitScoreCd <= 0) {
      this.score += Math.floor(6 * (this.scoreMultiplier || 1));
      this._hitScoreCd = 0.7;
    }
  }

  // 批次E·应用单个 run buff（叠层）
  _applyRunBuff(id) {
    switch (id) {
      case 'torque': if (this.top) this.top.maxSpeed *= 1.12; break;
      case 'score':  this._scoreMult *= 1.20; break;
      case 'knock':  this._knockMult *= 1.30; break;
      case 'coin':   this._coinMult *= 1.25; break;
      case 'target': this.targetScore = Math.floor(this.targetScore * 0.92); break;
      case 'combo':  this._comboMult *= 1.15; break;
      case 'crit':   this._critChance += 0.10; break;
      case 'shield': this._shieldCharges += 1; break;
    }
  }

  // 批次E·胜利后抽取 3 张 run buff 供三选一
  _rollRunBuffChoices() {
    const pool = RUN_BUFFS.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
    }
    this._runBuffChoices = pool.slice(0, 3).map(b => ({ id: b.id, label: b.label, color: b.color, name: b.name, desc: b.desc, icon: b.icon }));
  }

  _ringOut(kind) {
    if (this.phase !== 'playing') return;
    // 批次E·免死护盾：玩家出界时消耗一层并回中续战
    if (kind === 'lose' && this._shieldCharges > 0) {
      this._shieldCharges -= 1;
      const cx = this.width / 2, cy = this.height / 2;
      this.top.x = cx; this.top.y = cy; this.top.vx = 0; this.top.vy = 0;
      this._addFloatingText(cx, cy - 70, '护盾抵挡!', '#4fc3f7', true, 1.6);
      this.screenShake = Math.max(this.screenShake, 6);
      this._createParticles(cx, cy, 20, '#4fc3f7');
      if (this.audio) this.audio.play('clash', { freq: 900, gain: 0.25 });
      return;
    }
    this._settle(kind);
  }

  _updateParticles() {
    const ps = this.particles;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.x += p.vx; p.y += p.vy; p.vy += 0.08; p.vx *= 0.97; p.vy *= 0.97;
      p.life -= p.decay; p.size *= 0.96;
      if (p.life <= 0) {
        ps.splice(i, 1);
        if (this._particlePool.length < 60) this._particlePool.push(p);  // 池有界，避免无限累积
      }
    }
  }

  _updateFloatingTexts() {
    const fts = this.floatingTexts;
    for (let i = fts.length - 1; i >= 0; i--) {
      const ft = fts[i];
      ft.y += ft.vy; ft.vy *= 0.96; ft.alpha -= 0.015; ft.bounce += 0.15;
      if (ft.isCombo) { ft.scale = Math.max(1, ft.scale - 0.02); ft.y += Math.sin(ft.bounce) * 2; }
      if (ft.scale > 1) { ft.scale -= 0.03; if (ft.scale < 1) ft.scale = 1; }
      if (ft.alpha <= 0) {
        fts.splice(i, 1);
        if (this._ftPool.length < 40) this._ftPool.push(ft);   // 池有界
      }
    }
  }

  _updateShockwaves() {
    for (let i = this.shockwaves.length - 1; i >= 0; i--) {
      const s = this.shockwaves[i];
      s.radius += 8;
      s.alpha -= 0.03;
      if (s.alpha <= 0 || s.radius >= s.maxRadius) this.shockwaves.splice(i, 1);
    }
  }

  end() {
    this.active = false;
    this.phase = 'idle';
    this.isWhipping = false;
    this.countdown = 0;
    this._countGoPlayed = false;
    if (this.audio) this.audio.stopSpin();   // 战斗结束停掉旋转摩擦声

    // ============================================================
    // 结算页面游戏化初始化
    // ============================================================
    this._resultStartTime = Date.now();
    const isWin = this.result === 'win';

    // 星级评价（胜利时）：根据分数/目标比例
    if (isWin) {
      const ratio = this.targetScore > 0 ? this.score / this.targetScore : 1;
      if (ratio >= 1.5) this._resultStarCount = 3;      // 超过目标50% → 3星
      else if (ratio >= 1.2) this._resultStarCount = 2; // 超过目标20% → 2星
      else this._resultStarCount = 1;                      // 刚好达标 → 1星
    } else {
      this._resultStarCount = 0;
    }

    // 结算粒子初始化（胜利：金色星星/圆点；失败：灰色碎片）
    this._resultParticles = [];
    const pCount = this._fxLow ? 15 : 30;
    for (let i = 0; i < pCount; i++) {
      this._resultParticles.push({
        x: Math.random() * this.width,
        y: -20 - Math.random() * 100,  // 从屏幕上方开始
        vx: (Math.random() - 0.5) * 1.5,
        vy: 1 + Math.random() * 2,
        size: isWin ? (3 + Math.random() * 5) : (2 + Math.random() * 3),
        rotation: Math.random() * Math.PI * 2,
        rotSpeed: (Math.random() - 0.5) * 0.1,
        alpha: 0.6 + Math.random() * 0.4,
        type: isWin ? (Math.random() > 0.5 ? 'star' : 'dot') : 'shard',
        color: isWin ? (Math.random() > 0.5 ? '#FFD700' : '#FFA500') : '#888888'
      });
    }

    // 震动反馈：胜利轻震动，失败重震动
    if (typeof wx !== 'undefined' && wx.vibrateShort) {
      if (isWin) {
        wx.vibrateShort({ type: 'light' });
      } else {
        wx.vibrateShort({ type: 'heavy' });
      }
    }

    // 清理特效数组，释放内存
    this.particles.length = 0;
    this.floatingTexts.length = 0;
    this.trailPoints.length = 0;
    this.shockwaves.length = 0;
    this.powerups.length = 0;
  }

  /** 渲染整屏抽打场景，返回结果面板按钮（供 hitTest 使用） */
  draw(ctx) {
    const w = this.width, h = this.height;
    const top = this.top;
    const buttons = [];

    let arenaGrad = this._arenaGrad;
    if (!arenaGrad) {
      // 背景光环在屏幕正中心（h/2）
      arenaGrad = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w);
      arenaGrad.addColorStop(0, hexToRgba(top.color, 0.32));
      arenaGrad.addColorStop(0.5, hexToRgba(top.color, 0.16));
      arenaGrad.addColorStop(1, '#0a0a0f');
      this._arenaGrad = arenaGrad;
    }
    // 背景合并层：arena 渐变 + 星空烘焙成一张位图，每帧只 1 次全屏 drawImage
    // （替代 fillRect 全屏渐变 + _starsBg 全屏 blit 两层全屏操作，低端机软渲染最大头）
    if (!this._bgSprite || this._bgSpriteW !== w || this._bgSpriteH !== h) {
      let cv = null;
      try {
        if (typeof wx !== 'undefined' && wx.createOffscreenCanvas) {
          cv = wx.createOffscreenCanvas({ width: w, height: h });
        } else if (typeof document !== 'undefined' && document.createElement) {
          cv = document.createElement('canvas');
          cv.width = w; cv.height = h;
        }
      } catch (e) { cv = null; }
      if (cv && cv.getContext) {
        const c = cv.getContext('2d');
        if (c) {
          c.fillStyle = arenaGrad;
          c.fillRect(0, 0, w, h);
          c.fillStyle = '#ffffff';
          for (const st of this.stars) {
            c.globalAlpha = 0.35;
            c.beginPath();
            c.arc(st.rx * w, st.ry * h, st.s, 0, Math.PI * 2);
            c.fill();
          }
          c.globalAlpha = 1;
          this._bgSprite = cv; this._bgSpriteW = w; this._bgSpriteH = h;
        }
      }
    }
    // 注：_bgSprite 仅在此烘焙，不在本处绘制——改由下方「静态场景合并位图」一次性绘制（或回退分支绘制），每帧省 1 次全屏 blit。

    // ============================================================
    // 精致化竞技场战斗盘：多层边框 + 径向渐变 + 丰富纹理 + 脉冲核心 + 方位标记
    // ============================================================
    const arenaCx = w / 2;
    const arenaCy = h / 2;  // 战斗盘在屏幕正中心，与背景光环对齐
    const arenaR = Math.min(w, h) * 0.40;
    const innerR = arenaR - 10;  // 内部区域半径
    ctx.save();

    // 静态 8 层装饰：按 top.color + 尺寸离屏烘焙一次，每帧仅 1 次 drawImage（仿 _bgSprite）。
    // 脉冲核心（第 9 层）依赖每帧动画，保留实时绘制（见下方）。
    const decorKey = top.color + '|' + w + '|' + h;
    if (!this._arenaDecorSprite || this._arenaDecorKey !== decorKey) {
      this._arenaDecorSprite = this._buildArenaDecorSprite(w, h, arenaCx, arenaCy, arenaR, innerR, top.color);
      this._arenaDecorKey = decorKey;
    }

    // 静态场景合并位图：_bgSprite + _arenaDecorSprite 合成一张，每帧仅 1 次全屏 drawImage（替代 2 次）。
    // 视觉与「先画 bg 再画装饰」逐像素一致；key 同 decorKey，仅变色/改尺寸时一次性重烤，弱 GPU 省 1 次全屏 blit。
    if ((!this._sceneSprite || this._sceneKey !== decorKey) && this._bgSprite && this._arenaDecorSprite) {
      let scv = null;
      try {
        if (typeof wx !== 'undefined' && wx.createOffscreenCanvas) {
          scv = wx.createOffscreenCanvas({ width: w, height: h });
        } else if (typeof document !== 'undefined' && document.createElement) {
          scv = document.createElement('canvas'); scv.width = w; scv.height = h;
        }
      } catch (e) { scv = null; }
      if (scv && scv.getContext) {
        const sc = scv.getContext('2d');
        if (sc) {
          try {
            sc.drawImage(this._bgSprite, 0, 0, w, h);
            sc.drawImage(this._arenaDecorSprite, 0, 0, w, h);
            this._sceneSprite = scv; this._sceneKey = decorKey;
          } catch (e) { this._sceneSprite = null; }
        }
      }
    }
    // 绘制：优先合并位图（1 次 blit）；不可用时回退「bg + 装饰」分两次（保持原行为）
    if (this._sceneSprite) {
      try { ctx.drawImage(this._sceneSprite, 0, 0, w, h); }
      catch (e) { this._sceneSprite = null; }
    }
    if (!this._sceneSprite) {
      if (this._bgSprite) {
        try { ctx.drawImage(this._bgSprite, 0, 0, w, h); }
        catch (e) { this._bgSprite = null; ctx.fillStyle = arenaGrad; ctx.fillRect(0, 0, w, h); this._drawStars(ctx); }
      } else {
        ctx.fillStyle = arenaGrad; ctx.fillRect(0, 0, w, h); this._drawStars(ctx);
      }
      if (this._arenaDecorSprite) {
        try { ctx.drawImage(this._arenaDecorSprite, 0, 0, w, h); }
        catch (e) { this._arenaDecorSprite = null; this._bakeArenaDecor(ctx, arenaCx, arenaCy, arenaR, innerR, top.color); }
      } else {
        this._bakeArenaDecor(ctx, arenaCx, arenaCy, arenaR, innerR, top.color);
      }
    }

    // ---- 9. 中心能量核心（脉冲：外圈 + 内圈 + 中心点）----
    const corePulse = 0.5 + 0.5 * Math.sin(Date.now() / 500);
    // 核心外圈（脉冲扩散）
    ctx.strokeStyle = hexToRgba(top.color, 0.25 + 0.2 * corePulse);
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(arenaCx, arenaCy, 20 + corePulse * 8, 0, Math.PI * 2); ctx.stroke();
    // 核心内圈
    ctx.fillStyle = hexToRgba(top.color, 0.15 + 0.1 * corePulse);
    ctx.beginPath(); ctx.arc(arenaCx, arenaCy, 15, 0, Math.PI * 2); ctx.fill();
    // 核心中心点
    ctx.fillStyle = hexToRgba(top.color, 0.5 + 0.3 * corePulse);
    ctx.beginPath(); ctx.arc(arenaCx, arenaCy, 5, 0, Math.PI * 2); ctx.fill();
    // 核心高光点
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.beginPath(); ctx.arc(arenaCx - 1.5, arenaCy - 1.5, 2, 0, Math.PI * 2); ctx.fill();

    ctx.restore();

    // 批次A·出界危险边环：任一方逼近场地边界时脉冲红环预警
    if (this.phase === 'playing') {
      const dN = Math.max(
        Math.hypot(top.x - arenaCx, top.y - arenaCy) / arenaR,
        (this.enemy ? Math.hypot(this.enemy.x - arenaCx, this.enemy.y - arenaCy) / arenaR : 0)
      );
      if (dN > 0.78) {
        const a = 0.3 + 0.5 * Math.min(1, (dN - 0.78) / 0.22);
        ctx.save();
        ctx.strokeStyle = 'rgba(255,60,60,' + a.toFixed(3) + ')';
        ctx.lineWidth = 4 + 3 * Math.abs(Math.sin(Date.now() / 180));
        ctx.beginPath(); ctx.arc(arenaCx, arenaCy, arenaR, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      }
    }

    ctx.save();
    if (this.screenShake > 0) {
      ctx.translate((Math.random() - 0.5) * this.screenShake, (Math.random() - 0.5) * this.screenShake);
    }

    this._drawTrail(ctx);
    ctx.save();
    ctx.translate(top.x, top.y);
    ctx.rotate(top.rotation);
    // 陀螺本体已烘进离屏位图（含渐变/阴影/光晕）；外层 shadowBlur 对整张位图做模糊是
    // 每帧最贵开销，且 drawImage 不受 shadowBlur 影响（微信 Canvas 2D），直接去掉。
    this._drawTop(ctx);
    ctx.restore();

    if (this.enemy && this.phase === 'playing') {
      ctx.save();
      ctx.translate(this.enemy.x, this.enemy.y);
      ctx.rotate(this.enemy.rotation);
      this._drawEnemyTop(ctx);
      ctx.restore();
    }

    this._drawParticles(ctx);
    this._drawShockwaves(ctx);
    this._drawFieldPowerups(ctx);    // 场中飘浮的可收集道具球（与 HUD/激活道具分画）

    if (this.isWhipping) this._drawWhipGesture(ctx);
    this._drawFloatingTexts(ctx);

    if (this.phase === 'playing') this._drawHUD(ctx);
    if (this.phase === 'playing') {
      // 顶部操作条 · 返回按钮（游戏化胶囊：渐变背景+发光边框+高光+图标+文字）
      const backW = 72, backH = 34;
      const backX = 14;
      const backY = (this.safeTop || 44) + 8;
      const backCx = backX + backW / 2;
      const backCy = backY + backH / 2;

      // 悬停/按下反馈（轻微缩放）
      const backHover = this._backHover || false;
      const backScale = backHover ? 1.05 : 1;

      ctx.save();
      ctx.translate(backCx, backCy);
      ctx.scale(backScale, backScale);
      ctx.translate(-backCx, -backCy);

      // 外发光（主题色）
      if (!this._fxLow) {
        ctx.shadowColor = top.color;
        ctx.shadowBlur = 8;
      }

      // 渐变背景（深色→主题色→深色）
      const backGrad = ctx.createLinearGradient(backX, backY, backX, backY + backH);
      backGrad.addColorStop(0, this._lightenColor(top.color, 0.15));
      backGrad.addColorStop(0.5, top.color);
      backGrad.addColorStop(1, this._darkenColor(top.color, 0.2));
      ctx.fillStyle = backGrad;
      roundRectPath(ctx, backX, backY, backW, backH, backH / 2); ctx.fill();

      ctx.shadowBlur = 0;

      // 发光边框（主题色+白色内边）
      ctx.strokeStyle = hexToRgba(top.color, 0.8);
      ctx.lineWidth = 1.5;
      roundRectPath(ctx, backX + 0.75, backY + 0.75, backW - 1.5, backH - 1.5, backH / 2 - 0.75); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 0.5;
      roundRectPath(ctx, backX + 2, backY + 2, backW - 4, backH - 4, backH / 2 - 2); ctx.stroke();

      // 顶部高光
      ctx.save();
      roundRectPath(ctx, backX, backY, backW, backH / 2, backH / 2);
      ctx.clip();
      const hlGrad = ctx.createLinearGradient(backX, backY, backX, backY + backH / 2);
      hlGrad.addColorStop(0, 'rgba(255,255,255,0.3)');
      hlGrad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = hlGrad;
      ctx.fillRect(backX, backY, backW, backH / 2);
      ctx.restore();

      // 返回图标（左侧）
      drawHudIcon(ctx, 'back', backX + 18, backCy, 16);

      // 返回文字（右侧）
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 14px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = 2;
      ctx.fillText('返回', backX + 30, backCy + 0.5);
      ctx.shadowBlur = 0;

      ctx.restore();

      buttons.push({ x: backX, y: backY, w: backW, h: backH, action: 'battle_back' });
    }
    if (this.phase === 'playing' && this.whipCount < 2) this._drawTutorialHint(ctx);

    ctx.restore();

    // 开局倒计时覆盖层（3-2-1-GO），游戏化特效
    if (this.countdown > 0 && this.phase === 'playing') {
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.fillRect(0, 0, w, h);
      // 3 2 1 GO 各自占 0.3s
      const num = Math.max(1, Math.min(3, Math.ceil((this.countdown - 0.3) / 0.3)));
      const isGo = this.countdown <= 0.3;
      // 当前数字的进度（0~1，用于缩放和淡出动画）
      const phaseProgress = isGo ? (1 - this.countdown / 0.3) : (1 - (this.countdown - 0.3) % 0.3 / 0.3);
      // 缩放：出现时从小到大（0~0.3），然后保持（0.3~0.7），最后淡出缩小（0.7~1）
      let scale;
      if (phaseProgress < 0.25) {
        scale = 0.5 + (phaseProgress / 0.25) * 0.6;  // 0.5 → 1.1
      } else if (phaseProgress < 0.7) {
        scale = 1.1 - ((phaseProgress - 0.25) / 0.45) * 0.1;  // 1.1 → 1.0
      } else {
        scale = 1.0 - ((phaseProgress - 0.7) / 0.3) * 0.3;  // 1.0 → 0.7
      }
      const alpha = phaseProgress > 0.7 ? (1 - (phaseProgress - 0.7) / 0.3) : 1;
      const cdColor = isGo ? '#00e676' : '#ffd54f';

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.globalAlpha = alpha;

      // 圆环扩散特效（每个数字出现时扩散一个圆环）
      if (phaseProgress < 0.6) {
        const ringR = 30 + phaseProgress * 120;
        const ringAlpha = (1 - phaseProgress / 0.6) * 0.5;
        ctx.strokeStyle = cdColor;
        ctx.globalAlpha = ringAlpha;
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(w / 2, h / 2, ringR, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = alpha;
      }

      // 大字（带发光）
      ctx.font = 'bold ' + Math.floor(90 * scale) + 'px sans-serif';
      ctx.fillStyle = cdColor;
      ctx.shadowColor = cdColor;
      ctx.shadowBlur = this._fxLow ? 0 : 35;
      ctx.fillText(isGo ? 'GO!' : String(num), w / 2, h / 2);
      ctx.shadowBlur = 0;

      // GO时的全屏闪光
      if (isGo && phaseProgress < 0.3) {
        ctx.globalAlpha = (1 - phaseProgress / 0.3) * 0.3;
        ctx.fillStyle = '#00e676';
        ctx.fillRect(0, 0, w, h);
      }

      ctx.globalAlpha = 1;
      ctx.restore();
    }

    if (this.phase === 'result') {
      const rButtons = this._drawResult(ctx);
      buttons.push(...rButtons);
    }

    return buttons;
  }

  _drawStars(ctx) {
    // 离屏缓存：静态星空一次性烘成位图，每帧只 drawImage（替代 40 个 arc + 全局透明度切换）
    if (!this._starsBg || this._starsBgW !== this.width || this._starsBgH !== this.height) {
      const W = this.width, H = this.height;
      let cv = null;
      try {
        if (typeof wx !== 'undefined' && wx.createOffscreenCanvas) {
          cv = wx.createOffscreenCanvas({ width: W, height: H });
        } else if (typeof document !== 'undefined' && document.createElement) {
          cv = document.createElement('canvas');
          cv.width = W; cv.height = H;
        }
      } catch (e) { cv = null; }
      if (cv && cv.getContext) {
        const c = cv.getContext('2d');
        if (c) {
          c.fillStyle = '#ffffff';
          for (const st of this.stars) {
            c.globalAlpha = 0.35;
            c.beginPath();
            c.arc(st.rx * W, st.ry * H, st.s, 0, Math.PI * 2);
            c.fill();
          }
          this._starsBg = cv; this._starsBgW = W; this._starsBgH = H;
        }
      }
    }
    if (this._starsBg) {
      try {
        ctx.drawImage(this._starsBg, 0, 0, this.width, this.height);
        return;
      } catch (e) { this._starsBg = null; }
    }
    // 回退：无离屏能力时逐帧画（低端机冻结闪烁）
    const now = this._lowPerf ? 0 : Date.now() * 0.001;
    ctx.fillStyle = '#ffffff';
    for (const st of this.stars) {
      const tw = Math.sin(now * st.tw + st.ph) * 0.3 + 0.7;
      ctx.globalAlpha = 0.35 * tw;
      ctx.beginPath();
      ctx.arc(st.rx * this.width, st.ry * this.height, st.s, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /**
   * 径向渐变缓存：满帧对战里每帧 rebuild 一组 createRadialGradient 是 GC 主因之一。
   * 渐变坐标/色标仅在 top 颜色、半径改变时变化（一局内固定），按 key 复用即可。
   * 注意小游戏 canvas 渐变不支持透明背景缓存，直接缓存渐变对象（非离屏位图）。
   */
  _radial(ctx, key, x0, y0, r0, x1, y1, r1, stops) {
    let g = this._topGrads[key];
    if (!g) {
      g = ctx.createRadialGradient(x0, y0, r0, x1, y1, r1);
      for (let i = 0; i < stops.length; i++) g.addColorStop(stops[i][0], stops[i][1]);
      this._topGrads[key] = g;
    }
    return g;
  }

  _topSpriteKeyFor(t) {
    return [t.color, t.secondaryColor, t.trailColor, t.radius].join('|');
  }

  /**
   * 战斗盘静态 8 层装饰离屏位图构建（P1-8-2）：把虚线环/边框/径向底色/纹理/刻度/顶部高光
   * 一次性烘焙成全屏尺寸位图，每帧仅 1 次 drawImage。依赖 top.color + 尺寸 → 按 key 缓存。
   * 平台无关：优先 wx.createOffscreenCanvas，回退 document.createElement('canvas')，再不行返回 null（由 _bakeArenaDecor 实时绘制兜底）。
   */
  _buildArenaDecorSprite(w, h, arenaCx, arenaCy, arenaR, innerR, topColor) {
    let cv = null;
    try {
      if (typeof wx !== 'undefined' && wx.createOffscreenCanvas) {
        cv = wx.createOffscreenCanvas({ width: w, height: h });
      } else if (typeof document !== 'undefined' && document.createElement) {
        cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
      }
    } catch (e) { cv = null; }
    if (cv && cv.getContext) {
      const c = cv.getContext('2d');
      if (c) { this._bakeArenaDecor(c, arenaCx, arenaCy, arenaR, innerR, topColor); return cv; }
    }
    return null;
  }

  /**
   * 战斗盘静态 8 层装饰绘制（g 可为离屏 ctx 或实时 ctx）。纯静态几何，不含脉冲核心（第 9 层）。
   */
  _bakeArenaDecor(g, arenaCx, arenaCy, arenaR, innerR, topColor) {
    g.save();
    // ---- 1. 外圈装饰（虚线环 + 方位标记点）----
    const outerRingR = arenaR + 8;
    g.strokeStyle = hexToRgba(topColor, 0.3);
    g.lineWidth = 1;
    g.setLineDash([6, 4]);
    g.beginPath(); g.arc(arenaCx, arenaCy, outerRingR, 0, Math.PI * 2); g.stroke();
    g.setLineDash([]);
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * Math.PI * 2 - Math.PI / 2;
      const dx = arenaCx + Math.cos(ang) * outerRingR;
      const dy = arenaCy + Math.sin(ang) * outerRingR;
      g.fillStyle = hexToRgba(topColor, 0.5);
      g.beginPath(); g.arc(dx, dy, 3, 0, Math.PI * 2); g.fill();
    }
    // ---- 2. 外圈粗边框（主题色）----
    g.strokeStyle = hexToRgba(topColor, 0.75);
    g.lineWidth = 3;
    g.beginPath(); g.arc(arenaCx, arenaCy, arenaR, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.25)';
    g.lineWidth = 1;
    g.beginPath(); g.arc(arenaCx, arenaCy, arenaR - 3, 0, Math.PI * 2); g.stroke();
    // ---- 3. 战斗盘底色（径向渐变：中心亮，边缘暗）----
    const dishGrad = g.createRadialGradient(arenaCx, arenaCy, 0, arenaCx, arenaCy, innerR);
    dishGrad.addColorStop(0, hexToRgba(topColor, 0.14));
    dishGrad.addColorStop(0.6, hexToRgba(topColor, 0.07));
    dishGrad.addColorStop(1, 'rgba(0,0,0,0.25)');
    g.fillStyle = dishGrad;
    g.beginPath(); g.arc(arenaCx, arenaCy, innerR, 0, Math.PI * 2); g.fill();
    // ---- 4. 内圈细边框 ----
    g.strokeStyle = 'rgba(255,255,255,0.15)';
    g.lineWidth = 1;
    g.beginPath(); g.arc(arenaCx, arenaCy, innerR, 0, Math.PI * 2); g.stroke();
    // ---- 5. 内部纹理：同心圆（3圈）----
    g.strokeStyle = 'rgba(255,255,255,0.06)';
    g.lineWidth = 1;
    for (let i = 1; i <= 3; i++) {
      g.beginPath(); g.arc(arenaCx, arenaCy, innerR * (i / 4), 0, Math.PI * 2); g.stroke();
    }
    // ---- 6. 内部纹理：放射线（8条，从中心到内圈）----
    g.strokeStyle = 'rgba(255,255,255,0.04)';
    g.lineWidth = 1;
    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * Math.PI * 2;
      g.beginPath();
      g.moveTo(arenaCx + Math.cos(ang) * 30, arenaCy + Math.sin(ang) * 30);
      g.lineTo(arenaCx + Math.cos(ang) * (innerR - 5), arenaCy + Math.sin(ang) * (innerR - 5));
      g.stroke();
    }
    // ---- 7. 刻度标记（每45度一个小刻度，在内圈边缘）----
    g.strokeStyle = 'rgba(255,255,255,0.12)';
    g.lineWidth = 1.5;
    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * Math.PI * 2;
      const r1 = innerR - 8;
      const r2 = innerR - 2;
      g.beginPath();
      g.moveTo(arenaCx + Math.cos(ang) * r1, arenaCy + Math.sin(ang) * r1);
      g.lineTo(arenaCx + Math.cos(ang) * r2, arenaCy + Math.sin(ang) * r2);
      g.stroke();
    }
    // ---- 8. 顶部高光（战斗盘上半部分的白色渐变）----
    g.save();
    g.beginPath(); g.arc(arenaCx, arenaCy, innerR - 1, 0, Math.PI * 2); g.clip();
    const hlGrad = g.createLinearGradient(arenaCx, arenaCy - innerR, arenaCx, arenaCy);
    hlGrad.addColorStop(0, 'rgba(255,255,255,0.12)');
    hlGrad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = hlGrad;
    g.fillRect(arenaCx - innerR, arenaCy - innerR, innerR * 2, innerR);
    g.restore();
    g.restore();
  }

  /**
   * 通用陀螺离屏预渲染（批次A：玩家与敌方共用）：把每帧多渐变+路径一次性烘成位图，
   * 一局内颜色/半径固定 → 缓存一次复用。各自传入独立缓存对象（cache）。
   */
  _bakeTopSprite(t, tIdx, lv, cache) {
    const pngOk = !!(_topImgs[tIdx] && _topImgs[tIdx]._ok && _topImgs[tIdx].width > 0);
    const key = this._topSpriteKeyFor(t) + '|' + (pngOk ? 'png' : 'vec');
    if (cache.sprite && cache.key === key) return cache.sprite;
    const R = t.radius;
    const pad = 4;
    const S = Math.ceil((R * 2 + pad * 2) / 4) * 4;   // 4px 对齐，兼容部分机型 drawImage 偶数尺寸限制
    const half = S / 2;
    let cv = null;
    try {
      if (typeof wx !== 'undefined' && wx.createOffscreenCanvas) {
        cv = wx.createOffscreenCanvas({ width: S, height: S });
      } else if (typeof document !== 'undefined' && document.createElement) {
        cv = document.createElement('canvas');
        cv.width = S; cv.height = S;
      }
    } catch (e) { cv = null; }
    if (!cv || !cv.getContext) { cache.sprite = null; cache.key = null; return null; }
    const c = cv.getContext('2d');
    if (!c) { cache.sprite = null; cache.key = null; return null; }
    c.translate(half, half);

    // 光环（4 圈）——静态部分全部烘焙
    for (let i = 3; i >= 0; i--) {
      const ratio = i / 4;
      const rr = R * (1 + ratio * 0.25);
      c.globalAlpha = 0.35 * ratio;
      const tg = this._radial(c, 'ring|' + Math.round(rr * 100) + '|' + t.trailColor,
        -R * 0.1, -R * 0.1, 0, 0, 0, rr,
        [[0, hexToRgba(t.trailColor, 0.35)], [1, 'rgba(0,0,0,0)']]);
      c.beginPath(); c.arc(0, 0, rr, 0, Math.PI * 2); c.fillStyle = tg; c.fill();
    }
    c.globalAlpha = 1;

    // 本体：真实品质 PNG；未就绪回退矢量烘焙
    const topImg = _topImgs[tIdx];
    if (topImg && topImg._ok && topImg.width > 0) {
      const tgt = R * 2.05;
      c.drawImage(topImg, -tgt / 2, -tgt / 2, tgt, tgt);
      c.fillStyle = '#ffffff';
      c.font = 'bold ' + Math.floor(R * 0.5) + 'px sans-serif';
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.strokeStyle = 'rgba(12,6,28,0.8)'; c.lineWidth = 3;
      c.strokeText(String(lv), 0, 0);
      c.fillText(String(lv), 0, 0);
    } else {
      const outer = this._radial(c, 'outer|' + R + t.color,
        -R * 0.3, -R * 0.3, 0, 0, 0, R,
        [[0, 'rgba(255,255,255,0.4)'], [0.2, t.secondaryColor], [0.6, t.color], [0.9, 'rgba(0,0,0,0.3)'], [1, 'rgba(0,0,0,0.6)']]);
      c.beginPath(); c.arc(0, 0, R, 0, Math.PI * 2); c.fillStyle = outer; c.fill();
      const inner = this._radial(c, 'inner|' + R + t.color,
        -R * 0.2, -R * 0.2, 0, 0, 0, R * 0.75,
        [[0, 'rgba(255,255,255,0.6)'], [0.4, t.secondaryColor], [0.8, t.color], [1, 'rgba(0,0,0,0.3)']]);
      c.beginPath(); c.arc(0, 0, R * 0.75, 0, Math.PI * 2); c.fillStyle = inner; c.fill();
      for (let i = 0; i < 6; i++) {
        c.save();
        c.rotate((i / 6) * Math.PI * 2);
        c.beginPath();
        c.arc(0.55 * R, 0, 0.14 * R, 0, Math.PI * 2);
        c.fillStyle = 'rgba(255,255,255,0.22)'; c.fill();
        c.restore();
      }
      const center = this._radial(c, 'center|' + R + t.color,
        -R * 0.08, -R * 0.08, 0, 0, 0, R * 0.28,
        [[0, '#ffffff'], [0.4, t.secondaryColor], [1, t.color]]);
      c.beginPath(); c.arc(0, 0, R * 0.28, 0, Math.PI * 2); c.fillStyle = center; c.fill();
      c.beginPath(); c.arc(0, 0, R * 0.12, 0, Math.PI * 2); c.fillStyle = '#333'; c.fill();
      c.beginPath(); c.arc(0, 0, R * 0.05, 0, Math.PI * 2); c.fillStyle = '#fff'; c.fill();
    }

    cache.sprite = cv;
    cache.key = key;
    return cv;
  }

  _ensureTopSprite() {
    if (!this._topCache) this._topCache = { sprite: null, key: null };
    return this._bakeTopSprite(this.top, (this.playerBb && this.playerBb.tierIndex) || 0, (this.playerBb && this.playerBb.level) || 1, this._topCache);
  }

  _ensureEnemySprite() {
    if (!this.enemy) return null;
    if (!this._enemyCache) this._enemyCache = { sprite: null, key: null };
    return this._bakeTopSprite(this.enemy, (this.enemyBb && this.enemyBb.tierIndex) || 0, (this.enemyBb && this.enemyBb.level) || 1, this._enemyCache);
  }

  _drawTop(ctx) {
    const r = this.top.radius;
    const speed = Math.abs(this.top.angularVelocity);
    const wobble = this.top.wobble;
    const sprite = this._ensureTopSprite();
    if (sprite) {
      // 位图路径：一次 drawImage 替代几十条矢量指令（含全部渐变/阴影）
      ctx.save();
      if (wobble !== 0) { ctx.rotate(wobble); ctx.translate(0, wobble * 5); }
      ctx.drawImage(sprite, -r, -r, r * 2, r * 2);
      ctx.restore();
      return;
    }
    // 回退：离屏不可用时走原矢量路径（完整保留）
    const ctx2 = ctx;
    ctx2.save();
    if (wobble !== 0) { ctx2.rotate(wobble); ctx2.translate(0, wobble * 5); }

    // 去掉陀螺下方的椭圆阴影（真机上走矢量路径时会显示不规则黑色阴影）
    // ctx2.beginPath(); ctx2.arc(0, r * 0.5, r * (0.7 + speed / this.top.maxSpeed * 0.3), 0, Math.PI * 2);
    // ctx2.fillStyle = 'rgba(0,0,0,0.25)'; ctx2.fill();

    if (speed > 5) {
      for (let i = 3; i >= 0; i--) {
        const ratio = i / 4;
        const rr = r * (1 + ratio * 0.25);
        ctx2.globalAlpha = 0.35 * ratio;
        ctx2.beginPath(); ctx2.arc(0, 0, rr, 0, Math.PI * 2);
        const tg = this._radial(ctx2, 'ring|' + Math.round(rr * 100) + '|' + this.top.trailColor,
          -r * 0.1, -r * 0.1, 0, 0, 0, rr,
          [[0, hexToRgba(this.top.trailColor, 0.35)], [1, 'rgba(0,0,0,0)']]);
        ctx2.fillStyle = tg; ctx2.fill();
      }
      ctx2.globalAlpha = 1;
    }

    const outer = this._radial(ctx2, 'outer|' + r + this.top.color,
      -r * 0.3, -r * 0.3, 0, 0, 0, r,
      [[0, 'rgba(255,255,255,0.4)'], [0.2, this.top.secondaryColor], [0.6, this.top.color], [0.9, 'rgba(0,0,0,0.3)'], [1, 'rgba(0,0,0,0.6)']]);
    ctx2.beginPath(); ctx2.arc(0, 0, r, 0, Math.PI * 2);
    ctx2.fillStyle = outer; ctx2.fill();

    const inner = this._radial(ctx2, 'inner|' + r + this.top.color,
      -r * 0.2, -r * 0.2, 0, 0, 0, r * 0.75,
      [[0, 'rgba(255,255,255,0.6)'], [0.4, this.top.secondaryColor], [0.8, this.top.color], [1, 'rgba(0,0,0,0.3)']]);
    ctx2.beginPath(); ctx2.arc(0, 0, r * 0.75, 0, Math.PI * 2);
    ctx2.fillStyle = inner; ctx2.fill();

    for (let i = 0; i < 6; i++) {
      ctx2.save();
      ctx2.rotate((i / 6) * Math.PI * 2);
      // 旋转装饰：正圆光点（与 _drawTop 主路径一致，圆形旋转对称无菱形）
      ctx2.beginPath();
      ctx2.arc(0.55 * r, 0, 0.14 * r, 0, Math.PI * 2);
      ctx2.fillStyle = 'rgba(255,255,255,0.22)'; ctx2.fill();
      ctx2.restore();
    }

    const center = this._radial(ctx2, 'center|' + r + this.top.color,
      -r * 0.08, -r * 0.08, 0, 0, 0, r * 0.28,
      [[0, '#ffffff'], [0.4, this.top.secondaryColor], [1, this.top.color]]);
    ctx2.beginPath(); ctx2.arc(0, 0, r * 0.28, 0, Math.PI * 2);
    ctx2.fillStyle = center; ctx2.fill();
    ctx2.beginPath(); ctx2.arc(0, 0, r * 0.12, 0, Math.PI * 2);
    ctx2.fillStyle = '#333'; ctx2.fill();
    ctx2.beginPath(); ctx2.arc(0, 0, r * 0.05, 0, Math.PI * 2);
    ctx2.fillStyle = '#fff'; ctx2.fill();

    ctx2.restore();
  }

  _drawEnemyTop(ctx) {
    if (!this.enemy) return;
    const r = this.enemy.radius;
    const wobble = this.enemy.wobble;
    const sprite = this._ensureEnemySprite();
    ctx.save();
    // 危险红环：始终标识对手，便于与玩家区分
    ctx.strokeStyle = 'rgba(255,70,70,0.9)';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(0, 0, r + 5, 0, Math.PI * 2); ctx.stroke();
    if (sprite) {
      if (wobble !== 0) { ctx.rotate(wobble); ctx.translate(0, wobble * 5); }
      ctx.drawImage(sprite, -r, -r, r * 2, r * 2);
    } else {
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fillStyle = this.enemy.color; ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = 'bold ' + Math.floor(r * 0.5) + 'px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String((this.enemyBb && this.enemyBb.level) || 1), 0, 0);
    }
    ctx.restore();
  }

  _drawParticles(ctx) {
    // 批量填充：所有粒子共用 1 个 fillStyle + 单次 beginPath，每粒子只 set globalAlpha，
    // 消除每粒子 save/restore + shadowBlur 分支（低端机 drawcall 大户）
    // 全部为圆形火花（不生成 star：星形在高速飞溅+旋转时低分辨率下像棱形块）
    // ⚠️ 关键：每个 arc 前必须 moveTo 抬笔，否则 Canvas 会用 lineTo 自动连接相邻圆的
    // 弧起点，fill() 后把一堆圆形火花填成连体多边形/棱形块（抽打时满屏菱形块的根因）。
    const circles = this.particles;
    const n = circles.length;
    if (!n) return;

    // P1-5：按「颜色 + 量化 alpha 档位」分组，每组一次 beginPath + 一次 fill()。
    // 这样 drawcall 上界 = 颜色数 × 档位数（与粒子总数无关）：
    //   - 既保留逐粒子的真实颜色（不再被 this.top.color 覆盖，金色暴击粒子是金色）
    //   - 也保留 life 淡出（globalAlpha 随 life 量化档位变化）
    //   - 又不会因为 decay 随机（0.01~0.03）导致同帧生成的粒子 life 错开、退化成逐粒子 drawcall
    // 旧实现只合并"数组相邻"的同色同档粒子，最坏情况 fill 数 ≈ 粒子数（低端机崩）。
    const groups = new Map();   // key: "color@bucket" -> { color, alpha, items:[{x,y,size}] }
    for (let i = 0; i < n; i++) {
      const p = circles[i];
      const life = p.life > 1 ? 1 : (p.life > 0 ? p.life : 0);
      const bucket = Math.max(1, Math.round(life * PARTICLE_ALPHA_STEPS));
      const key = (p.color || '#fff') + '@' + bucket;
      let g = groups.get(key);
      if (!g) { g = { color: p.color || '#fff', alpha: bucket / PARTICLE_ALPHA_STEPS, items: [] }; groups.set(key, g); }
      g.items.push(p);
    }

    ctx.save();
    for (const g of groups.values()) {
      ctx.fillStyle = g.color;
      ctx.globalAlpha = g.alpha;
      ctx.beginPath();
      for (let j = 0; j < g.items.length; j++) {
        const p = g.items[j];
        ctx.moveTo(p.x + p.size, p.y);   // 抬笔到圆周起点，断开与上一圆的连线（防止连体菱形块）
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      }
      ctx.fill();
    }
    ctx.restore();
  }

  _drawTrail(ctx) {
    if (this.trailPoints.length < 2) return;
    const step = (this._lowPerf || this.perfLevel === 'MID') ? 2 : 1;   // 低端/中端机跳画一半线段
    ctx.save();
    ctx.strokeStyle = this.top.trailColor;
    ctx.lineCap = 'round';
    for (let i = 1; i < this.trailPoints.length; i += step) {
      const p1 = this.trailPoints[i - 1], p2 = this.trailPoints[i];
      ctx.globalAlpha = p2.alpha * 0.3;
      ctx.lineWidth = p2.size * 0.5;
      ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
    }
    ctx.restore();
  }

  _drawShockwaves(ctx) {
    for (const s of this.shockwaves) {
      ctx.save();
      ctx.globalAlpha = s.alpha;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(s.x, s.y, s.radius, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
  }

  _drawWhipGesture(ctx) {
    const g = ctx.createLinearGradient(this.whipStartX, this.whipStartY, this.whipEndX, this.whipEndY);
    g.addColorStop(0, 'rgba(255,255,255,0.9)');
    g.addColorStop(1, 'rgba(255,255,255,0.1)');
    ctx.strokeStyle = g;
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(this.whipStartX, this.whipStartY); ctx.lineTo(this.whipEndX, this.whipEndY); ctx.stroke();
    const arrowAngle = Math.atan2(this.whipEndY - this.whipStartY, this.whipEndX - this.whipStartX);
    ctx.save();
    ctx.translate(this.whipEndX, this.whipEndY);
    ctx.rotate(arrowAngle);
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.beginPath(); ctx.moveTo(-10, -5); ctx.lineTo(0, 0); ctx.lineTo(-10, 5); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  _drawFloatingTexts(ctx) {
    for (const ft of this.floatingTexts) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, ft.alpha);
      ctx.translate(ft.x, ft.y);
      ctx.rotate(ft.rotation);
      ctx.scale(ft.scale, ft.scale);
      ctx.font = 'bold ' + ft.size + 'px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (ft.isCombo && !this._fxLow) { ctx.shadowColor = '#FFD700'; ctx.shadowBlur = 10; }
      ctx.fillStyle = ft.color;
      ctx.fillText(ft.text, 0, 0);
      ctx.restore();
    }
  }

  _drawHUD(ctx) {
    const w = this.width, h = this.height;
    const top = this.top;  // 修复：_drawHUD 中使用 top.color/secondaryColor，需要定义 top 变量
    const speed = Math.abs(this.top.angularVelocity);
    const ST = this.safeTop || 44;
    const SB = this.safeBottom || 24;
    const cx = w / 2;

    // ============================================================
    // 设计稿 v3 四段式 HUD：
    //   ① 顶部操作条：右倒计时胶囊（左返回圆钮由 draw() 绘制，避微信胶囊/more-btn）
    //   ② 居中分数面板：大分数 + 目标小字 + COMBO（金色呼吸）
    //   ③ 元素克制条：PNG 图标 + 克制文字（居中胶囊）+ 羁绊共鸣小标
    //   ④ 底部：目标/速度进度条
    // ============================================================

    // ---- ① 倒计时胶囊（顶部居中，与分数面板中心线对齐，游戏化：发光+低时间脉冲）----
    // 垂直布局：以屏幕中心为基准，顶部元素均匀分布
    const topY = ST + 10;  // 顶部第一个元素，距安全区10px
    const timeLeft = Math.ceil(this.timeRemaining);
    const warn = timeLeft <= 10;
    const tTxt = timeLeft + 's';
    ctx.font = 'bold 17px sans-serif';
    const tW = Math.ceil(ctx.measureText(tTxt).width) + 36;
    const tH = 34;
    // 水平居中，与下面的分数面板中心线对齐
    const tX = (w - tW) / 2;
    // 低时间脉冲
    const warnPulse = warn ? (0.5 + 0.5 * Math.sin(Date.now() / 200)) : 0;
    // 外发光
    ctx.save();
    ctx.shadowColor = warn ? 'rgba(255,82,82,' + (0.5 + 0.3 * warnPulse) + ')' : 'rgba(255,255,255,0.3)';
    ctx.shadowBlur = warn ? (8 + 6 * warnPulse) : 5;
    ctx.fillStyle = warn ? 'rgba(255,82,82,' + (0.18 + 0.12 * warnPulse) + ')' : 'rgba(255,255,255,0.14)';
    roundRectPath(ctx, tX, topY, tW, tH, tH / 2); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = warn ? 'rgba(255,107,107,' + (0.55 + 0.35 * warnPulse) + ')' : 'rgba(255,255,255,0.32)';
    ctx.lineWidth = warn ? (1 + 0.5 * warnPulse) : 1;
    roundRectPath(ctx, tX + 0.5, topY + 0.5, tW - 1, tH - 1, tH / 2 - 0.5); ctx.stroke();
    // 顶部高光
    const tHl = ctx.createLinearGradient(tX, topY, tX, topY + tH / 2);
    tHl.addColorStop(0, 'rgba(255,255,255,0.2)');
    tHl.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = tHl;
    roundRectPath(ctx, tX + 2, topY + 1, tW - 4, tH / 2 - 1, tH / 2 - 2); ctx.fill();
    // 时钟图标（圆 + 指针）
    ctx.strokeStyle = warn ? '#FF6B6B' : '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(tX + 14, topY + tH / 2, 6, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(tX + 14, topY + tH / 2 - 4); ctx.lineTo(tX + 14, topY + tH / 2);
    ctx.moveTo(tX + 14, topY + tH / 2); ctx.lineTo(tX + 17, topY + tH / 2);
    ctx.stroke();
    // 时间文字（加阴影）
    ctx.fillStyle = warn ? '#FF6B6B' : '#ffffff';
    ctx.font = 'bold 17px sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 2;
    ctx.fillText(tTxt, tX + 27, topY + tH / 2 + 0.5);
    ctx.shadowBlur = 0;
    ctx.restore();

    // ---- ② 居中分数面板（游戏化：发光+数字跳动+COMBO醒目）----
    // 垂直布局：倒计时下方22px呼吸空间（倒计时底部ST+42，分数顶部ST+64）
    const spY = ST + 64;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    // 大分数（加发光）
    ctx.save();
    ctx.shadowColor = hexToRgba(top.color, 0.7);
    ctx.shadowBlur = 12;
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 38px sans-serif';
    ctx.fillText(formatNumber0(this.displayScore), cx, spY);
    ctx.shadowBlur = 0;
    ctx.restore();
    // 目标小字
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '12px sans-serif';
    ctx.fillText('目标 ' + formatNumber0(this.targetScore), cx, spY + 30);
    // COMBO（游戏化：金色发光+缩放脉冲+边框）
    if (this.combo > 1) {
      const cs = 1 + Math.sin(Date.now() / 80) * 0.12;
      ctx.save();
      ctx.translate(cx, spY + 52);  // 分数下方22px
      ctx.scale(cs, cs);
      // COMBO背景胶囊
      const comboTxt = this.combo + ' COMBO';
      ctx.font = 'bold 16px sans-serif';
      const cW = Math.ceil(ctx.measureText(comboTxt).width) + 28;
      const cH = 26;
      ctx.fillStyle = 'rgba(255,215,0,0.15)';
      roundRectPath(ctx, -cW / 2, -cH / 2, cW, cH, cH / 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,215,0,0.6)';
      ctx.lineWidth = 1.5;
      roundRectPath(ctx, -cW / 2 + 0.5, -cH / 2 + 0.5, cW - 1, cH - 1, cH / 2 - 0.5); ctx.stroke();
      // COMBO文字（金色发光）
      ctx.shadowColor = '#FFD700';
      ctx.shadowBlur = this._fxLow ? 0 : 14;
      ctx.fillStyle = '#FFD700';
      ctx.fillText(comboTxt, 0, 1);
      ctx.shadowBlur = 0;
      ctx.restore();
    }

    // ---- ③ 元素克制条（PNG 图标 + 文字，居中胶囊）----
    // 垂直布局：COMBO下方，距战斗盘顶部有合理呼吸空间
    if (ELEMENTS && this.enemyElementIdx !== undefined && this.playerBb) {
      const elY = ST + 154;  // 顶部最后一个元素，距战斗盘顶部约30px
      const eEl = ELEMENTS[this.enemyElementIdx];
      const pEl = ELEMENTS[this.playerBb.elementIdx];
      // 批次F：把倍率明写出来（旧版只写"克制/被克"却不兑现，现在收益与文案一一对应）
      const relTxt = this.elementRel === 'adv' ? ('克制 x' + this.elementMult)
        : (this.elementRel === 'counter' ? ('被克 x' + this.elementMult) : '持平');
      const relCol = this.elementRel === 'adv' ? '#66ff9a' : (this.elementRel === 'counter' ? '#ff8a80' : 'rgba(255,255,255,0.6)');
      ctx.font = 'bold 13px sans-serif';
      const pW = Math.ceil(ctx.measureText(pEl.name).width);
      const eW = Math.ceil(ctx.measureText(eEl.name).width);
      const relW = Math.ceil(ctx.measureText(relTxt).width);
      const chipW = 16 + 20 + 6 + pW + 8 + relW + 8 + 20 + 6 + eW + 16;
      const chipH = 28;
      const chipX = cx - chipW / 2;
      ctx.fillStyle = 'rgba(0,0,0,0.38)';
      roundRectPath(ctx, chipX, elY, chipW, chipH, chipH / 2); ctx.fill();
      ctx.strokeStyle = relCol; ctx.lineWidth = 1;
      roundRectPath(ctx, chipX + 0.5, elY + 0.5, chipW - 1, chipH - 1, chipH / 2 - 0.5); ctx.stroke();
      // 我方元素图标 + 名
      let ex = chipX + 16;
      drawHudIcon(ctx, pEl.key, ex + 10, elY + chipH / 2, 17);
      ctx.fillStyle = pEl.color;
      ctx.font = 'bold 13px sans-serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(pEl.name, ex + 26, elY + chipH / 2);
      // 克制关系
      ex += 26 + pW;
      ctx.fillStyle = relCol;
      ctx.font = 'bold 11px sans-serif';
      ctx.fillText(relTxt, ex + 4, elY + chipH / 2);
      // 对手图标 + 名
      ex += 4 + relW + 8;
      drawHudIcon(ctx, eEl.key, ex + 10, elY + chipH / 2, 17);
      ctx.fillStyle = relCol;
      ctx.font = 'bold 13px sans-serif';
      ctx.fillText(eEl.name, ex + 26, elY + chipH / 2);
      // 羁绊共鸣小标
      if (this.bondActive) {
        ctx.fillStyle = '#d1c4e9';
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('元素共鸣×1.1', cx, elY + chipH + 13);
      }
    }

    // ---- 激活道具（移到底部：战斗盘下方30px，给顶部留呼吸空间）----
    // 注意：arenaR 需要在本函数内定义，不能引用战斗盘绘制函数中的变量（作用域不同）
    const arenaR = Math.min(w, h) * 0.40;
    const powerupY = h / 2 + arenaR + 30;  // 战斗盘底部下方30px
    this._drawActivePowerups(ctx, 16, powerupY);

    // ============================================================
    // HUD 底 · 目标进度条 + 速度条（游戏化：发光+分段+金属边框）
    // 垂直布局：道具下方40px，底部留合理空间
    // ============================================================
    const barW = w * 0.72;
    const barH = 12;
    const barX = (w - barW) / 2;
    // 进度条在道具下方40px（道具底部 = h/2+arenaR+64，加40px间距）
    const progBarY = h / 2 + arenaR + 104;
    // 目标文字
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('目标 ' + formatNumber0(this.targetScore) + '  ·  当前 ' + formatNumber0(this.score), w / 2, progBarY - 6);
    // 目标条背景（深色+内阴影）
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    roundRectPath(ctx, barX, progBarY, barW, barH, 6); ctx.fill();
    // 目标条填充（渐变+发光）
    const prog = Math.min(this.score / this.targetScore, 1);
    if (prog > 0) {
      ctx.save();
      ctx.shadowColor = hexToRgba(top.color, 0.6);
      ctx.shadowBlur = 8;
      const pg = ctx.createLinearGradient(barX, progBarY, barX + barW, progBarY);
      pg.addColorStop(0, top.color); pg.addColorStop(0.5, '#ffffff'); pg.addColorStop(1, top.secondaryColor);
      ctx.fillStyle = pg;
      roundRectPath(ctx, barX, progBarY, barW * prog, barH, 6); ctx.fill();
      ctx.shadowBlur = 0;
      // 顶部高光
      const pgl = ctx.createLinearGradient(barX, progBarY, barX, progBarY + barH / 2);
      pgl.addColorStop(0, 'rgba(255,255,255,0.35)');
      pgl.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = pgl;
      roundRectPath(ctx, barX + 1, progBarY + 1, barW * prog - 2, barH / 2 - 1, 4); ctx.fill();
      ctx.restore();
    }
    // 目标条边框（金属感）
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1;
    roundRectPath(ctx, barX + 0.5, progBarY + 0.5, barW - 1, barH - 1, 5.5); ctx.stroke();
    // 分段标记（4段）
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const segX = barX + (barW / 4) * i;
      ctx.beginPath(); ctx.moveTo(segX, progBarY + 2); ctx.lineTo(segX, progBarY + barH - 2); ctx.stroke();
    }

    // 速度条（游戏化：彩虹渐变+发光）
    const speedBarY = progBarY + barH + 12;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    roundRectPath(ctx, barX, speedBarY, barW, barH, 6); ctx.fill();
    const sp = Math.min(speed / this.top.maxSpeed, 1);
    if (sp > 0) {
      ctx.save();
      ctx.shadowColor = 'rgba(255,255,255,0.4)';
      ctx.shadowBlur = 6;
      const sg = ctx.createLinearGradient(barX, speedBarY, barX + barW, speedBarY);
      sg.addColorStop(0, '#FF4D4F'); sg.addColorStop(0.4, '#FAAD14'); sg.addColorStop(0.7, '#52C41A'); sg.addColorStop(1, '#13C2C2');
      ctx.fillStyle = sg;
      roundRectPath(ctx, barX, speedBarY, barW * sp, barH, 6); ctx.fill();
      ctx.shadowBlur = 0;
      // 顶部高光
      const sgl = ctx.createLinearGradient(barX, speedBarY, barX, speedBarY + barH / 2);
      sgl.addColorStop(0, 'rgba(255,255,255,0.35)');
      sgl.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = sgl;
      roundRectPath(ctx, barX + 1, speedBarY + 1, barW * sp - 2, barH / 2 - 1, 4); ctx.fill();
      ctx.restore();
    }
    // 速度条边框
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1;
    roundRectPath(ctx, barX + 0.5, speedBarY + 0.5, barW - 1, barH - 1, 5.5); ctx.stroke();
    // 速度文字
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('转速', barX, speedBarY - 4);
    ctx.textAlign = 'right';
    ctx.fillText(Math.floor(sp * 100) + '%', barX + barW, speedBarY - 4);
  }

  /** 激活道具：顶部左下横排胶囊（圆 + 剩余时间），一行 3 个 不撞底部进度条 */
  _drawActivePowerups(ctx, x0, y0) {
    const order = ['speed', 'doubleScore', 'slowFriction'];
    const pad = 10, gap = 10, icoR = 14, txtW = 26;
    const capW = icoR * 2 + txtW + pad * 2;   // 每个胶囊 ≈ 28+26+20 = 74
    const capH = icoR * 2 + 6;                 // 34
    let cx = x0;
    for (const key of order) {
      if (!this.activePowerups[key]) continue;
      const p = POWERUPS.find(x => x.effect === key);
      const remain = this.powerupTimers[key];
      const alpha = 0.62 + Math.max(0, Math.min(1, remain / p.duration)) * 0.38;
      ctx.save();
      ctx.globalAlpha = alpha;
      // 胶囊底（去 shadowBlur：HUD 常驻行，模糊每帧开销）
      ctx.fillStyle = 'rgba(0,0,0,0.38)';
      roundRectPath(ctx, cx, y0, capW, capH, capH / 2); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1;
      roundRectPath(ctx, cx + 0.5, y0 + 0.5, capW - 1, capH - 1, capH / 2 - 0.5); ctx.stroke();
      // 图标圆
      const icX = cx + pad + icoR, icY = y0 + capH / 2;
      const g = ctx.createRadialGradient(icX, icY - 4, 2, icX, icY, icoR);
      g.addColorStop(0, '#ffffff'); g.addColorStop(1, p.color);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(icX, icY, icoR, 0, Math.PI * 2); ctx.fill();
      if (!drawPropIcon(ctx, p.icon, icX, icY, 16)) drawVectorIcon(ctx, p.icon, icX, icY, 14, '#ffffff');
      // 剩余秒数
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(Math.ceil(remain) + 's', cx + pad + icoR * 2 + 4, icY);
      ctx.restore();
      cx += capW + gap;
    }
  }

  /** 场中飘浮的可收集道具球（游戏化：脉冲发光） */
  _drawFieldPowerups(ctx) {
    for (const p of this.powerups) {
      const fy = Math.sin(Date.now() * 0.003 + p.spawnTime) * 8;
      const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 300 + p.spawnTime);
      ctx.save();
      ctx.translate(p.x, p.y + fy);
      ctx.scale(p.scale, p.scale);
      // 脉冲外发光
      ctx.shadowColor = p.color;
      ctx.shadowBlur = this._fxLow ? 0 : (8 + 6 * pulse);
      // 道具球
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(0, 0, 28, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      // 高光
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath(); ctx.arc(-9, -10, 9, 0, Math.PI * 2); ctx.fill();
      // 边框（脉冲）
      ctx.strokeStyle = 'rgba(255,255,255,' + (0.5 + 0.3 * pulse) + ')';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, 28, 0, Math.PI * 2); ctx.stroke();
      if (!drawPropIcon(ctx, p.icon, 0, 0, 20)) drawVectorIcon(ctx, p.icon, 0, 0, 18, '#ffffff');
      ctx.restore();
    }
  }

  _drawTutorialHint(ctx) {
    const w = this.width, h = this.height;
    const t = Date.now() / 420; // 手势动画时间基准
    const bw = Math.min(310, w - 48), bh = 116;
    const bx = (w - bw) / 2;
    const by = h / 2 + 32;

    ctx.save();

    // 苹果风卡片：玻璃半透明 + 金边 + 顶部高亮
    const g = ctx.createLinearGradient(bx, by, bx, by + bh);
    g.addColorStop(0, 'rgba(255,255,255,0.16)');
    g.addColorStop(1, 'rgba(255,255,255,0.06)');
    ctx.fillStyle = g;
    roundRectPath(ctx, bx, by, bw, bh, 18); ctx.fill();
    ctx.strokeStyle = 'rgba(255,213,79,0.9)'; ctx.lineWidth = 1.5;
    roundRectPath(ctx, bx + 0.75, by + 0.75, bw - 1.5, bh - 1.5, 18); ctx.stroke();
    const hl = ctx.createLinearGradient(bx + 8, by, bx + 8, by + 10);
    hl.addColorStop(0, 'rgba(255,255,255,0.55)');
    hl.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = hl;
    roundRectPath(ctx, bx + 8, by, bw - 16, 10, 6); ctx.fill();

    // 手势动画：上滑手指 + 运动轨迹箭头（循环）
    const gx = bx + 46, gy = by + bh / 2;
    const bob = Math.sin(t * Math.PI * 2) * 3;
    // 运动拖尾：上行小箭头（渐隐，3 颗）
    const cyc = t % 1.4;
    for (let i = 0; i < 3; i++) {
      const ph = (cyc + i * 0.45) % 1.4;
      if (ph > 1.05) continue;
      ctx.globalAlpha = (1 - ph / 1.05) * 0.9;
      ctx.fillStyle = '#ffd54f';
      const yy = gy - 30 - ph * 22;
      ctx.beginPath();
      ctx.moveTo(gx, yy - 7);
      ctx.lineTo(gx - 6, yy + 2);
      ctx.lineTo(gx + 6, yy + 2);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    // 手指：圆角指身 + 指尖高光，随动画轻微上下
    ctx.fillStyle = '#ffd54f';
    roundRectPath(ctx, gx - 9, gy - 12 + bob, 18, 26, 9); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.beginPath();
    ctx.arc(gx, gy - 5 + bob, 6, 0, Math.PI * 2);
    ctx.fill();

    // 文案
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 16px ' + APPLE_FONT;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText('滑动屏幕抽打陀螺', gx + 26, gy - 10);
    ctx.font = '12px ' + APPLE_FONT;
    ctx.fillStyle = 'rgba(255,255,255,0.72)';
    ctx.fillText('快速上滑 · 连击得分更高', gx + 26, gy + 14);
    ctx.font = '11px ' + APPLE_FONT;
    ctx.fillStyle = 'rgba(255,213,79,0.9)';
    ctx.fillText('攒够目标分数即获胜 · 把对手撞飞是额外惊喜', gx + 26, gy + 38);
    ctx.restore();
  }

  _drawButton(ctx, x, y, w, h, text, color) {
    // 游戏化按钮：渐变+边框+高光
    const grad = ctx.createLinearGradient(x, y, x, y + h);
    grad.addColorStop(0, this._lightenColor(color, 0.2));
    grad.addColorStop(0.5, color);
    grad.addColorStop(1, this._darkenColor(color, 0.15));
    ctx.fillStyle = grad;
    roundRectPath(ctx, x, y, w, h, 16); ctx.fill();
    // 边框
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    roundRectPath(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 15.5); ctx.stroke();
    // 顶部高光
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    roundRectPath(ctx, x + 2, y + 1, w - 4, h / 2 - 1, 14); ctx.fill();
    // 文字
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 15px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.4)';
    ctx.shadowBlur = 2;
    ctx.fillText(text, x + w / 2, y + h / 2 + 0.5);
    ctx.shadowBlur = 0;
  }

  _lightenColor(color, amount) {
    // 简单的颜色变亮：增加RGB值
    const hex = color.replace('#', '');
    const r = Math.min(255, parseInt(hex.substr(0, 2), 16) + Math.floor(255 * amount));
    const g = Math.min(255, parseInt(hex.substr(2, 2), 16) + Math.floor(255 * amount));
    const b = Math.min(255, parseInt(hex.substr(4, 2), 16) + Math.floor(255 * amount));
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  _darkenColor(color, amount) {
    // 简单的颜色变暗：减少RGB值
    const hex = color.replace('#', '');
    const r = Math.max(0, parseInt(hex.substr(0, 2), 16) - Math.floor(255 * amount));
    const g = Math.max(0, parseInt(hex.substr(2, 2), 16) - Math.floor(255 * amount));
    const b = Math.max(0, parseInt(hex.substr(4, 2), 16) - Math.floor(255 * amount));
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  _drawResult(ctx) {
    const w = this.width, h = this.height;
    const ST = this.safeTop || 44;
    const SB = this.safeBottom || 24;
    const buttons = [];
    const isWin = this.result === 'win';

    // 背景：半透明遮罩 + 胜利时金色径向光效
    ctx.fillStyle = 'rgba(10,5,25,0.78)';
    ctx.fillRect(0, 0, w, h);
    if (isWin) {
      const winGrad = ctx.createRadialGradient(w / 2, h * 0.35, 0, w / 2, h * 0.35, h * 0.5);
      winGrad.addColorStop(0, 'rgba(255,215,0,0.15)');
      winGrad.addColorStop(0.5, 'rgba(255,215,0,0.05)');
      winGrad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = winGrad;
      ctx.fillRect(0, 0, w, h);
    }

    const cx = w / 2;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // ---- 先测量整块（标题+分数+奖励+胜利专属+按钮）高度，再整体垂直居中 ----
    const TITLE_H = 48, SCORE_H = 54, CHIP_H = 26, SPACER = 16, BTN_H = 42;
    const STREAK_H = 20, DROP_H = 76, CHEST_H = 20, NOTE_H = 22;

    const streak = (this.game && this.game.winStreak) ? this.game.winStreak : 1;
    const mult = (this.game && typeof this.game.streakMultiplier === 'function') ? this.game.streakMultiplier() : 1;

    let totalH = TITLE_H + SCORE_H + CHIP_H + SPACER + BTN_H;
    let showStreak = false, showDrop = false, showChest = false;
    if (isWin) {
      showStreak = (streak >= 3 && mult < 5);
      showDrop = !!this.dropItem;
      showChest = !!this.chestDropped;
      if (showStreak) totalH += STREAK_H;
      if (showDrop) totalH += DROP_H;
      if (showChest) totalH += CHEST_H;
      if (this.arenaGained > 0) totalH += 28;   // 竞技积分行（P1-6：展示本局获得的竞技积分）
    } else {
      totalH += NOTE_H;
    }
    if (this.runActive) totalH += 18;   // 连战关数行

    // 居中于安全区（避开头顶状态栏与底部 Home 指示条），内容过高则贴顶
    const availTop = ST + 8;
    const availBottom = h - SB - 12;
    let cursor = availTop + (availBottom - availTop - totalH) / 2;
    if (cursor < availTop) cursor = availTop;

    // ---- 标题（发光+缩放脉冲）----
    const titleY = cursor + TITLE_H / 2;
    const titlePulse = 1 + Math.sin(Date.now() / 400) * 0.04;
    ctx.save();
    ctx.translate(cx, titleY);
    ctx.scale(titlePulse, titlePulse);
    ctx.fillStyle = isWin ? '#00e676' : '#ff5252';
    ctx.shadowColor = isWin ? '#00e676' : '#ff5252';
    ctx.shadowBlur = this._fxLow ? 0 : 20;
    ctx.font = 'bold 40px sans-serif';
    const titleTxt = this.isRingOut ? (isWin ? '出界制胜!' : '被撞出界') : (isWin ? '胜利!' : '失败');
    ctx.fillText(titleTxt, 0, 0);
    ctx.shadowBlur = 0;
    ctx.restore();
    cursor += TITLE_H;

    // ---- 大分数 + 目标 ----
    const scoreY = cursor + SCORE_H / 2 - 4;
    const targetY = scoreY + 28;
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 44px sans-serif';
    ctx.fillText(formatNumber0(this.score), cx, scoreY);
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '12px sans-serif';
    ctx.fillText('目标 ' + formatNumber0(this.targetScore), cx, targetY);
    if (this.runActive) {
      ctx.fillStyle = 'rgba(255,213,79,0.9)';
      ctx.font = '12px sans-serif';
      ctx.fillText('连战 · 第 ' + this.runStage + ' 关', cx, targetY + 18);
    }
    cursor += SCORE_H;

    // ---- 奖励胶囊行 ----
    const chipTop = cursor;
    if (isWin) {
      const chips = [
        { icon: 'coin', txt: '+' + formatNumber0(this.reward) },
        { icon: 'double', txt: '连胜 ×' + streak + '  ×' + mult + '倍' }
      ];
      const gap = 10, cw = 94, chh = 26;
      const total = cw * chips.length + gap * (chips.length - 1);
      let cxx = cx - total / 2;
      for (const c of chips) {
        ctx.fillStyle = 'rgba(255,255,255,0.1)';
        roundRectPath(ctx, cxx, chipTop, cw, chh, chh / 2); ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 1;
        roundRectPath(ctx, cxx + 0.5, chipTop + 0.5, cw - 1, chh - 1, chh / 2 - 0.5); ctx.stroke();
        drawHudIcon(ctx, c.icon, cxx + 15, chipTop + chh / 2, 18);
        ctx.fillStyle = '#ffd54f';
        ctx.font = 'bold 13px sans-serif';
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(c.txt, cxx + 30, chipTop + chh / 2);
        ctx.textAlign = 'center';
        cxx += cw + gap;
      }
    } else {
      const cw = 112, chh = 26;
      const cxx = cx - cw / 2;
      ctx.fillStyle = 'rgba(255,255,255,0.1)';
      roundRectPath(ctx, cxx, chipTop, cw, chh, chh / 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,82,82,0.35)'; ctx.lineWidth = 1;
      roundRectPath(ctx, cxx + 0.5, chipTop + 0.5, cw - 1, chh - 1, chh / 2 - 0.5); ctx.stroke();
      drawHudIcon(ctx, 'energy', cxx + 15, chipTop + chh / 2, 18);
      ctx.fillStyle = '#ff5252';
      ctx.font = 'bold 13px sans-serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText('能量 -' + LOSE_ENERGY_PENALTY, cxx + 30, chipTop + chh / 2);
      ctx.textAlign = 'center';
    }
    cursor += CHIP_H;

    // ---- 竞技积分（P1-6：胜利时算出但此前结算页未展示）----
    if (isWin && this.arenaGained > 0) {
      const aY = cursor + 14;
      ctx.fillStyle = 'rgba(255,213,79,0.95)';
      ctx.font = 'bold 13px sans-serif';
      ctx.fillText('竞技积分 +' + formatNumber0(this.arenaGained), cx, aY);
      cursor += 28;
    }

    // ---- 胜利专属内容（连胜引导 / 掉落陀螺 / 竞技宝箱）----
    if (isWin) {
      if (showStreak) {
        const sy = cursor + STREAK_H / 2;
        ctx.fillStyle = '#ffd54f';
        ctx.font = 'bold 12px sans-serif';
        const againTxt = '再赢一局 · 金币 5 倍';
        const againTw = ctx.measureText(againTxt).width;
        drawHudIcon(ctx, 'play', cx - againTw / 2 - 12, sy, 14);
        ctx.fillText(againTxt, cx, sy);
        cursor += STREAK_H;
      }
      if (showDrop) {
        const topCy = cursor + 22;
        ctx.save();
        ctx.translate(cx, topCy);
        ctx.rotate(Date.now() * 0.002);
        drawBeyblade(ctx, 0, 0, this.dropItem, 0.85);
        ctx.restore();
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.font = '12px sans-serif';
        ctx.fillText(this.dropItem.tier.name + ' · Lv' + this.dropItem.level, cx, topCy + 48);
        cursor += DROP_H;
      }
      if (showChest) {
        const qy = cursor + CHEST_H / 2;
        const qNames = ['青铜', '白银', '黄金'];
        ctx.fillStyle = '#ffd54f';
        ctx.font = 'bold 12px sans-serif';
        ctx.fillText('获得' + qNames[this.chestDropped.quality] + '竞技宝箱！', cx, qy);
        cursor += CHEST_H;
      }
    } else {
      const lost = (this.game && this.game.winStreak > 0);
      const noteY = chipTop + CHIP_H + 16;
      ctx.fillStyle = 'rgba(255,255,255,0.72)';
      ctx.font = '11px sans-serif';
      ctx.fillText(lost ? '连胜中断，再接再厉' : '再接再厉', cx, noteY);
    }

    // ---- 按钮（整行水平居中，随内容块一起垂直居中）----
    cursor += SPACER;
    const btnY = cursor;
    if (isWin) {
      const btnW3 = 88, gap3 = 10;
      const total3 = btnW3 * 3 + gap3 * 2;
      const x0 = cx - total3 / 2;
      const share  = { x: x0, y: btnY, w: btnW3, h: BTN_H, action: 'battle_share' };
      const again  = { x: x0 + btnW3 + gap3, y: btnY, w: btnW3, h: BTN_H, action: 'battle_again' };
      const back   = { x: x0 + (btnW3 + gap3) * 2, y: btnY, w: btnW3, h: BTN_H, action: 'battle_back' };
      this._drawButton(ctx, share.x, share.y, share.w, share.h, '炫耀', '#ffb300');
      this._drawButton(ctx, again.x, again.y, again.w, again.h, '再战', '#e53935');
      this._drawButton(ctx, back.x,  back.y,  back.w,  back.h,  '返回', '#7e57c2');
      buttons.push(share, again, back);
    } else {
      const halfGap = 10;
      const btnW_a = 96, btnW_b = 96;
      const revive = { x: cx - btnW_a - halfGap, y: btnY, w: btnW_a, h: BTN_H, action: 'battle_revive' };
      const back   = { x: cx + halfGap,         y: btnY, w: btnW_b, h: BTN_H, action: 'battle_back' };
      this._drawButton(ctx, revive.x, revive.y, revive.w, revive.h, '看广告复活', '#ffb300');
      this._drawButton(ctx, back.x,   back.y,   back.w,   back.h,   '返回',       '#7e57c2');
      buttons.push(revive, back);
    }

    return buttons;
  }
}

// 批次E·连战 run buff 池（每胜随机抽 3 张，可叠层累积）
const RUN_BUFFS = [
  { id: 'torque', label: '速', color: '#ffb300', name: '转速强化', desc: '陀螺最大转速 +12%', icon: 'spin' },
  { id: 'score',  label: '分', color: '#ef5350', name: '得分狂热', desc: '得分获取 +20%', icon: 'coin' },
  { id: 'knock',  label: '撞', color: '#42a5f5', name: '撞击精通', desc: '碰撞击退力 +30%', icon: 'clash' },
  { id: 'coin',   label: '金', color: '#ffca28', name: '金币磁铁', desc: '金币奖励 +25%', icon: 'coin' },
  { id: 'target', label: '标', color: '#66bb6a', name: '目标削减', desc: '目标分 -8%', icon: 'target' },
  { id: 'combo',  label: '连', color: '#ab47bc', name: '连击大师', desc: '连击得分 +15%', icon: 'combo' },
  { id: 'crit',   label: '暴', color: '#ff7043', name: '暴击几率', desc: '暴击率 +10%', icon: 'crit' },
  { id: 'shield', label: '盾', color: '#29b6f6', name: '免死护盾', desc: '出界免疫一次', icon: 'shield' }
];

module.exports = {
  SpintopBattle, POWERUPS, RUN_BUFFS, LOSE_ENERGY_PENALTY,
  WHIP_DIST_FULL, WHIP_DIST_MIN, WHIP_DIST_MAX, IMPULSE_CAP, SHAKE_MAX, FORCE_CAP_MULT,
  HITSTOP_COLLISION, HITSTOP_CRIT, CRIT_MULT, TARGET_REF_MULT,
  HITSTOP_MIN_IMPACT, HITSTOP_COLLISION_CD, PARTICLE_ALPHA_STEPS
};
