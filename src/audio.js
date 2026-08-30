/**
 * 音效管理：零素材依赖，使用 WebAudio 合成
 * 微信小游戏与浏览器通用（wx.createWebAudioContext / window.AudioContext）
 */

const Sfx = {
  ctx: null,
  muted: false,
  ready: false,

  init() {
    if (this.ready) {
      this.resume();
      return;
    }
    try {
      if (typeof wx !== 'undefined' && wx.createWebAudioContext) {
        this.ctx = wx.createWebAudioContext();
      } else if (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)) {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      }
    } catch (e) {
      console.warn('audio init failed', e);
    }
    this._loadMuted();
    this.ready = true;
    this.resume();   // iOS：创建后立即尝试 resume（首次必须在用户手势内，由 input.js 的 unlock 触发）
  },

  /** 在用户手势内调用：创建并恢复 AudioContext（iOS 仅允许在手势内解锁音频） */
  unlock() {
    this.init();
    this.resume();
  },

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      const r = this.ctx.resume();
      if (r && r.catch) r.catch(() => {});
    }
  },

  _loadMuted() {
    try {
      if (typeof wx !== 'undefined' && wx.getStorageSync) {
        this.muted = !!wx.getStorageSync('bb_muted');
      } else if (typeof localStorage !== 'undefined') {
        this.muted = localStorage.getItem('bb_muted') === '1';
      }
    } catch (e) {}
  },

  _saveMuted() {
    try {
      if (typeof wx !== 'undefined' && wx.setStorageSync) {
        wx.setStorageSync('bb_muted', this.muted);
      } else if (typeof localStorage !== 'undefined') {
        localStorage.setItem('bb_muted', this.muted ? '1' : '0');
      }
    } catch (e) {}
  },

  toggle() {
    this.init();   // 确保 ctx 已创建（首次点静音也要初始化，否则下次 play 才建）
    this.muted = !this.muted;
    this._saveMuted();
    if (!this.muted) this.play('click');
    else this.stopSpin();   // 静音时停掉旋转摩擦声
    return this.muted;
  },

  /** 旋转摩擦声：持续循环音（陀螺高速旋转）——低通白噪声的"呼呼"风声，柔和不刺耳，音色随转速变亮 */
  playSpin(speedRatio, tierIndex = 0) {
    this.init();
    if (this.muted || !this.ctx) return;
    this.resume();
    const ctx = this.ctx;
    // 首次：建立 噪声源(循环) → 低通滤波 → 增益 链路
    if (!this._spinSrc) {
      const buf = this._noiseBuffer(ctx);
      if (!buf) return;
      try {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.loop = true;   // 白噪声循环 = 持续风声
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        const g = ctx.createGain();
        g.gain.value = 0;
        src.connect(filter); filter.connect(g); g.connect(ctx.destination);
        src.start();
        this._spinSrc = src; this._spinFilter = filter; this._spinGain = g;
      } catch (e) { this._spinSrc = null; return; }
    }
    const now = ctx.currentTime;
    // 转速越高 cutoff 越高 → 风声更"亮"；金属大陀螺（tierIndex 高）基础 cutoff 略高
    const cutoff = 300 + speedRatio * 900 + tierIndex * 50;
    const g2 = this._spinGain;
    if (g2) {
      const targetGain = Math.min(0.03 + speedRatio * 0.05, 0.09);   // 音量小，柔和不吵
      g2.gain.setTargetAtTime(targetGain, now, 0.1);
      this._spinFilter.frequency.setTargetAtTime(cutoff, now, 0.1);
    }
  },

  /** 停掉旋转摩擦声 */
  stopSpin() {
    if (this._spinSrc) {
      try { this._spinSrc.stop(); } catch (e) {}
      try { this._spinSrc.disconnect(); } catch (e) {}
    }
    if (this._spinFilter) { try { this._spinFilter.disconnect(); } catch (e) {} }
    if (this._spinGain) { try { this._spinGain.disconnect(); } catch (e) {} }
    this._spinSrc = null; this._spinFilter = null; this._spinGain = null;
  },

  /**
   * 播放音效
   * @param {string} type click | draw | merge | clash | win | lose
   */
  play(type, override) {
    this.init();   // 先初始化（创建 AudioContext），再判断 muted/ctx —— 修复首次点击无声
    if (this.muted) return;
    if (!this.ctx) return;
    this.resume();

    const presets = {
      click: { freq: 620, type: 'sine', dur: 0.08, gain: 0.12 },
      draw:  { freq: 420, slideTo: 920, type: 'triangle', dur: 0.18, gain: 0.14 },
      merge: { freq: 520, slideTo: 1040, type: 'sawtooth', dur: 0.22, gain: 0.13 },
      // 鞭响：短促噪声爆音 + 高频瞬态（模拟鞭子"啪"）——健身陀螺抽打
      clash: { freq: 1800, slideTo: 900, type: 'square', dur: 0.09, gain: 0.32, noise: true },
      win:   { freq: 660, slideTo: 1320, type: 'triangle', dur: 0.35, gain: 0.15 },
      lose:  { freq: 500, slideTo: 180, type: 'sawtooth', dur: 0.4, gain: 0.14 },
      crit:  { freq: 880, slideTo: 1760, type: 'square', dur: 0.28, gain: 0.16 },
      countdown: { freq: 660, type: 'sine', dur: 0.12, gain: 0.12 },
      collect:   { freq: 880, slideTo: 1320, type: 'triangle', dur: 0.15, gain: 0.13 }
    };
    const p = presets[type] || presets.click;
    if (override) {
      if (override.freq !== undefined) p.freq = override.freq;
      if (override.gain !== undefined) p.gain = override.gain;
    }
    this._tone(p);
  },

  _tone({ freq, slideTo, type = 'sine', dur = 0.15, gain = 0.12, noise = false }) {
    const ctx = this.ctx;
    if (!ctx) return;
    // iOS 关键：context 处于 suspended 时 currentTime 冻结为 0，若把音调度在 now=0，
    // resume 后该时刻已被"跨过"→ 首声被丢弃（首声静音 bug）。未 running 时向前错开 60ms 确保发声。
    const lead = ctx.state === 'running' ? 0 : 0.06;
    const now = ctx.currentTime + lead;
    // 鞭响：噪声爆音层（短促、高频、快速衰减——模拟鞭子"啪"）
    if (noise) {
      const buf = this._noiseBuffer(ctx);
      if (buf) {
        try {
          const src = ctx.createBufferSource();
          src.buffer = buf;
          const ng = ctx.createGain();
          ng.gain.setValueAtTime(gain, now);
          ng.gain.exponentialRampToValueAtTime(0.0001, now + dur);
          src.connect(ng); ng.connect(ctx.destination);
          src.start(now); src.stop(now + dur + 0.02);
        } catch (e) {}
      }
    }
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, now + dur);

    g.gain.setValueAtTime(gain, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + dur + 0.02);
  },

  /** 预生成 1s 白噪声 Buffer（鞭响噪声层，复用避免每次创建） */
  _noiseBuffer(ctx) {
    if (this._noiseBuf && this._noiseBuf.ctx === ctx) return this._noiseBuf.buf;
    try {
      const len = Math.floor(ctx.sampleRate * 1);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      this._noiseBuf = { ctx, buf };
      return buf;
    } catch (e) { return null; }
  },
};

module.exports = { Sfx };
