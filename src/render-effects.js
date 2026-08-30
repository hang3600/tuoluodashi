/**
 * 渲染器特效模块（Mixin）
 * 
 * 包含：背景绘制、粒子系统、浮动文字、光环、震屏、启动标题等特效相关方法
 * 
 * 使用方式：
 * const { RendererEffects } = require('./render-effects');
 * Object.assign(Renderer.prototype, RendererEffects);
 * 
 * 注意：这些方法依赖 Renderer 实例的 this 属性，必须通过 Mixin 方式混合到 Renderer 类中。
 */

const { APPLE_FONT } = require('./utils');

const RendererEffects = {
  /**
   * 更新特效设置（根据设备性能档自动调整阴影/发光等高耗特效）
   */
  _updateFx() {
    let low = !!(this.layout && this.layout.compact);
    if (this.game && this.game.lowFX !== undefined) low = !!this.game.lowFX;
    // MID 档也关装饰软投影（中端机同样吃不起每帧 shadowBlur，只保留触摸按下反馈）
    else if (this.perfLevel === 'MID') low = true;
    // HIGH 档 Android 旗舰（如 Xiaomi 13 实测 21fps）同样吃不起装饰阴影：只留触摸反馈，砍每帧模糊
    else if (this.perfLevel === 'HIGH' && !this._isIOS) low = true;
    // iOS：WebKit 软渲染阴影无 GPU 加速，大屏高配同样昂贵 → 装饰阴影强制关闭（P1 主因）
    // LOW 档（lowFX===0）：最弱机器本就背不起每帧 shadowBlur，故同列入关闭集合
    this.shadowScale = (low || this._isIOS || this.perfLevel === 'LOW') ? 0 : 1;
    // 按下态阴影：仅当用户显式关闭特效(lowFX===0)才关，否则始终保留触摸反馈
    this.pressShadow = (this.game && this.game.lowFX === 0) ? 0 : 1;
  },

  /**
   * 首帧极简画面：背景 + 居中副标题（渲染最轻，保证像素立刻上屏，降低首屏渲染耗时）
   */
  drawSplashTitle() {
    const ctx = this.ctx;
    const W = this.width;
    const L = this.layout;
    const ty = (L && typeof L.titleY === 'number') ? L.titleY : this.height * 0.3;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(209,196,233,0.9)';
    ctx.font = '13px ' + APPLE_FONT;
    ctx.fillText('收集 · 合成 · 对战', W / 2, ty);
  },

  /**
   * 静态背景（渐变 + 星星）：首次渲染到离屏画布缓存，之后每帧仅一次 drawImage。
   * 大幅降低每帧 createLinearGradient + 26 个 arc 的绘制指令（诊断 drawcall 178 的主因之一）。
   * 离屏创建失败时自动回退为逐帧绘制，保证兼容性（微信小游戏 / 老基础库）。
   */
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
        this._bgCache = bg;
        this._bgCacheKey = key;
        return bg;
      } catch (e) {
        this._bgCache = null;
        return null;
      }
    }
    return this._bgCache;
  },

  /**
   * 绘制背景（优先使用离屏缓存，失败时回退逐帧绘制）
   */
  drawBackground() {
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
  },

  /**
   * 添加浮动文字（如能量+60、金币+100等）
   */
  addFloatText(x, y, text, color = '#ffd54f') {
    this.floatTexts.push({ x, y, text, color, life: 1.0, maxLife: 1.0 });
  },

  /**
   * 绘制浮动文字（向上飘动并淡出）
   */
  drawFloatTexts(dt) {
    const ctx = this.ctx;
    for (let i = this.floatTexts.length - 1; i >= 0; i--) {
      const f = this.floatTexts[i];
      if (!this._debugFreezeFx) { f.life -= dt; f.y -= dt * 26; }
      if (f.life <= 0) { this.floatTexts.splice(i, 1); continue; }
      ctx.globalAlpha = Math.max(0, f.life / f.maxLife);
      ctx.fillStyle = f.color;
      ctx.font = 'bold 16px ' + APPLE_FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(f.text, f.x, f.y);
    }
    ctx.globalAlpha = 1;
  },

  /**
   * 绘制粒子和环形冲击波
   */
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
  },

  /**
   * 添加粒子效果（合成成功、抽卡等）
   */
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
  },

  /**
   * 环形扩散冲击波（合成成功 / 升级时用），跟随 renderer 帧更新
   */
  addRing(x, y, color) {
    if (!this.rings) this.rings = [];
    this.rings.push({ x, y, color, radius: 8, maxRadius: 90, alpha: 0.8 });
  },

  /**
   * 震屏反馈（传说出货 / 强力事件时用）：dur 秒内随机偏移、幅度衰减
   */
  shake(mag = 8, dur = 0.4) {
    this._shakeT = dur;
    this._shakeDur = dur;
    this._shakeMag = mag;
  },

  /**
   * 绘制圆角矩形路径（不填充/描边，仅创建路径）
   */
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
};

module.exports = { RendererEffects };
