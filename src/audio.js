/**
 * 音效管理：零素材依赖，使用 WebAudio 合成
 * 微信小游戏与浏览器通用（wx.createWebAudioContext / window.AudioContext）
 *
 * 跨平台音频策略（2026-08-30 修复 #4/#5/#6）：
 *  - #4 iOS 硬件静音拨片无法静音 WebAudio（Apple 平台特性），故统一走「软件音量/静音」：
 *    masterGain 覆盖所有输出，iOS / Android 行为一致；若将来引入文件音(inner audio)，
 *    wx.setInnerAudioOption({ obeyMuteSwitch:true }) 让其在 iOS 上也尊重静音键。
 *  - #5 Android 无 onAudioInterruption 事件，来电未进后台时 AudioContext 挂起不自愈；
 *    由 input.js 在每次触摸时调用 Sfx.ensureRunning() 兜底恢复（iOS 仍保留打断事件）。
 *  - #6 旋转风声（白噪声长循环 + 实时增益调制）在 iOS 部分版本易爆音：噪声缓冲首尾淡入/淡出
 *    消除 loop 接缝咔哒；起停均经 masterGain 并用 setTargetAtTime 平滑，停声前先 ramp 到 0。
 */

const Sfx = {
  ctx: null,
  muted: false,
  volume: 1,
  ready: false,
  _master: null,

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

    // #4 跨平台 parity：iOS 硬件静音拨片无法静音 WebAudio，统一用软件音量/静音覆盖两端。
    // 若后续引入文件音（inner audio），obeyMuteSwitch 让其在 iOS 也尊重静音键。
    if (typeof wx !== 'undefined' && wx.setInnerAudioOption) {
      try { wx.setInnerAudioOption({ obeyMuteSwitch: true, mixWithOther: false }); } catch (e) {}
    }

    this._loadMuted();
    this._loadVolume();
    this._buildMaster();
    this.ready = true;
    this.resume();   // iOS：创建后立即尝试 resume（首次必须在用户手势内，由 input.js 的 unlock 触发）
  },

  /** 建立 masterGain：所有音效（含旋转风声）经此输出，软件音量/静音统一控制 */
  _buildMaster() {
    if (!this.ctx) return;
    try {
      const g = this.ctx.createGain();
      g.gain.value = this.muted ? 0 : this.volume;
      g.connect(this.ctx.destination);
      this._master = g;
    } catch (e) { this._master = null; }
  },

  /** 输出节点：优先 masterGain（受软件音量/静音控制），降级直连 destination */
  _out() {
    if (this._master) return this._master;
    if (this.ctx && this.ctx.destination) return this.ctx.destination;
    return null;
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

  /**
   * #5 跨平台自愈：任意用户手势 / 每帧调用，suspended 时恢复 AudioContext。
   * 覆盖 Android 无 onAudioInterruption 事件、来电未进后台导致音频挂起不恢复的缺口。
   * @returns {boolean} 若本次触发了恢复返回 true
   */
  ensureRunning() {
    if (this.ctx && this.ctx.state === 'suspended') {
      const r = this.ctx.resume();
      if (r && r.catch) r.catch(() => {});
      return true;
    }
    return false;
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

  _loadVolume() {
    try {
      let v = null;
      if (typeof wx !== 'undefined' && wx.getStorageSync) {
        const s = wx.getStorageSync('bb_volume');
        if (s !== '' && s !== null && s !== undefined) v = parseFloat(s);
      } else if (typeof localStorage !== 'undefined') {
        const s = localStorage.getItem('bb_volume');
        if (s !== null) v = parseFloat(s);
      }
      if (v === null || isNaN(v) || v < 0 || v > 1) v = 1;
      this.volume = v;
    } catch (e) { this.volume = 1; }
  },

  _saveVolume() {
    try {
      if (typeof wx !== 'undefined' && wx.setStorageSync) {
        wx.setStorageSync('bb_volume', this.volume);
      } else if (typeof localStorage !== 'undefined') {
        localStorage.setItem('bb_volume', String(this.volume));
      }
    } catch (e) {}
  },

  /** 设置软件音量（0..1），平滑 ramp；与静音标志独立。iOS 等效于 Android「音量=0 静音」 */
  setVolume(v) {
    this.init();
    v = Math.max(0, Math.min(1, v));
    this.volume = v;
    this._saveVolume();
    if (this._master && this.ctx) {
      const now = this.ctx.currentTime;
      this._master.gain.setTargetAtTime(this.muted ? 0 : v, now, 0.02);
    }
  },

  toggle() {
    this.init();   // 确保 ctx 已创建（首次点静音也要初始化，否则下次 play 才建）
    this.muted = !this.muted;
    this._saveMuted();
    // 静音走 masterGain 即时归零，覆盖旋转声等所有输出，无需等 stopSpin
    if (this._master && this.ctx) {
      const now = this.ctx.currentTime;
      this._master.gain.setTargetAtTime(this.muted ? 0 : this.volume, now, 0.02);
    }
    if (!this.muted) this.play('click');
    else this.stopSpin();   // 静音时停掉旋转摩擦声（省 CPU）
    return this.muted;
  },

  /** 旋转摩擦声：持续循环音（陀螺高速旋转）——低通白噪声的"呼呼"风声，柔和不刺耳，音色随转速变亮 */
  playSpin(speedRatio, tierIndex = 0) {
    this.init();
    if (this.muted || !this.ctx) return;
    this.resume();
    const ctx = this.ctx;
    const out = this._out();
    if (!out) return;
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
        src.connect(filter); filter.connect(g); g.connect(out);
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
      // #6 平滑调制：setTargetAtTime 避免直接赋值产生的 zipper 噪声
      g2.gain.setTargetAtTime(targetGain, now, 0.08);
      this._spinFilter.frequency.setTargetAtTime(cutoff, now, 0.08);
    }
  },

  /** 停掉旋转摩擦声（#6：先平滑 ramp 到 0 再停，避免挂起/停止瞬间的爆音/咔哒） */
  stopSpin() {
    const ctx = this.ctx;
    const src = this._spinSrc, filter = this._spinFilter, g = this._spinGain;
    // 先清空引用，避免重复 stop
    this._spinSrc = null; this._spinFilter = null; this._spinGain = null;
    if (!src) return;
    if (g && ctx) {
      try {
        const now = ctx.currentTime;
        g.gain.cancelScheduledValues(now);
        g.gain.setTargetAtTime(0, now, 0.012);          // ~36ms 平滑归零
        const stopAt = now + 0.06;
        try { src.stop(stopAt); } catch (e) {}          // 归零后再停，无咔哒
        // 延迟断开，避免切断 60ms 渐隐尾巴
        const f = filter, gg = g;
        setTimeout(() => {
          try { src.disconnect(); } catch (e) {}
          try { f && f.disconnect(); } catch (e) {}
          try { gg && gg.disconnect(); } catch (e) {}
        }, 120);
        return;
      } catch (e) {}
    }
    // 降级：直接停 + 立即断开
    try { src.stop(); } catch (e) {}
    try { src.disconnect(); } catch (e) {}
    try { filter && filter.disconnect(); } catch (e) {}
    try { g && g.disconnect(); } catch (e) {}
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
      // #7 打击感·音效分层：轻击（短促高频脆响）/ 重击（低频闷砸）/ 必杀（上扫轰鸣）/ 出界（下扫坠落）
      clash_light:  { freq: 1500, slideTo: 900, type: 'square', dur: 0.06, gain: 0.20, noise: true },
      clash_heavy:  { freq: 240, slideTo: 110, type: 'sawtooth', dur: 0.16, gain: 0.30 },
      ultimate:     { freq: 200, slideTo: 1700, type: 'sawtooth', dur: 0.5, gain: 0.24 },
      ringout:      { freq: 320, slideTo: 60, type: 'sawtooth', dur: 0.5, gain: 0.2 },
      win:   { freq: 660, slideTo: 1320, type: 'triangle', dur: 0.35, gain: 0.15 },
      lose:  { freq: 500, slideTo: 180, type: 'sawtooth', dur: 0.4, gain: 0.14 },
      crit:  { freq: 880, slideTo: 1760, type: 'square', dur: 0.28, gain: 0.16 },
      countdown: { freq: 660, type: 'sine', dur: 0.12, gain: 0.12 },
      collect:   { freq: 880, slideTo: 1320, type: 'triangle', dur: 0.15, gain: 0.13 }
    };
    // 成熟感·多音符 Jingle（2026-11-21）：里程碑时刻单音撑不起仪式——
    //   record  = 破纪录号角（上行三连音 do-mi-so，金亮三角波）
    //   legend  = 传说出货三连音（琶音上行 + 高八度收尾）
    const jingles = {
      record: [523, 659, 784],                                  // C5-E5-G5
      legend: [523, 659, 784, 1046]                             // C5-E5-G5-C6
    };
    if (jingles[type]) {
      const notes = jingles[type];
      notes.forEach((freq, i) => {
        setTimeout(() => {
          try { this._tone({ freq, type: 'triangle', dur: 0.16, gain: 0.15 }); } catch (e) {}
        }, i * 110);
      });
      return;
    }
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
    const out = this._out();
    if (!out) return;
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
          src.connect(ng); ng.connect(out);
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
    g.connect(out);
    osc.start(now);
    osc.stop(now + dur + 0.02);
  },

  /** 预生成 1s 白噪声 Buffer（鞭响噪声层，复用避免每次创建）；#6 首尾淡入/淡出消除 loop 接缝爆音 */
  _noiseBuffer(ctx) {
    if (this._noiseBuf && this._noiseBuf.ctx === ctx) return this._noiseBuf.buf;
    try {
      const len = Math.floor(ctx.sampleRate * 1);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      // 首尾各 ~12ms 线性淡入/淡出，使 loop 接缝振幅≈0（无缝循环，消除周期性咔哒）
      const fade = Math.min(512, Math.floor(len / 8));
      for (let i = 0; i < fade; i++) {
        const w = i / fade;
        data[i] *= w;                  // 开头淡入 0→1
        data[len - 1 - i] *= w;        // 结尾淡出 1→0
      }
      this._noiseBuf = { ctx, buf };
      return buf;
    } catch (e) { return null; }
  },
};

module.exports = { Sfx };
