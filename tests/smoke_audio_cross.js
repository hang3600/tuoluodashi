// 烟雾测试：跨平台音频三项修复（#4 iOS 静音键 / #5 Android 打断自愈 / #6 旋转风声爆音）
// 覆盖：masterGain + 软件音量、obeyMuteSwitch、ensureRunning 自愈、噪声 loop 接缝淡入淡出、stopSpin 平滑归零。
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

const audioSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'audio.js'), 'utf8');
const inputSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'input.js'), 'utf8');
const mainSrc  = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');

console.log('【跨平台音频 #4/#5/#6】');

// ───────────────────────── #4 iOS 静音键差异（软件音量 / masterGain / obeyMuteSwitch） ─────────────────────────
console.log('\n#4 iOS 静音键：软件音量 parity');
ok('audio.js 调用 wx.setInnerAudioOption(obeyMuteSwitch:true)', /setInnerAudioOption\(\{\s*obeyMuteSwitch:\s*true/.test(audioSrc));
ok('audio.js 建立 masterGain(_buildMaster)', /_buildMaster\(\)/.test(audioSrc) && /createGain\(\)/.test(audioSrc));
ok('audio.js 提供 _out() 统一输出节点', /_out\(\)/.test(audioSrc));
ok('audio.js 暴露 setVolume()', /setVolume\(/.test(audioSrc));
ok('audio.js 持久化音量 bb_volume', /bb_volume/.test(audioSrc));
ok('playSpin 经 _out() 输出(受 masterGain 控制)', /g\.connect\(out\)/.test(audioSrc));
ok('toggle 经 masterGain 即时静音(非仅停旋转)', /_master\.gain\.setTargetAtTime\(this\.muted \? 0 : this\.volume/.test(audioSrc));

// ───────────────────────── #5 Android 音频打断自愈 ─────────────────────────
console.log('\n#5 Android 打断自愈');
ok('audio.js 暴露 ensureRunning()', /ensureRunning\(\)\s*\{/.test(audioSrc));
ok('ensureRunning 在 suspended 时 resume', /ensureRunning\(\)\s*\{[\s\S]{0,200}state === 'suspended'[\s\S]{0,200}resume\(\)/.test(audioSrc));
ok('input.js 每次触摸调用 Sfx.ensureRunning()', /Sfx\.ensureRunning\(\)/.test(inputSrc));
ok('main.js onShow 已 resume 音频(兜底)', /onShow[\s\S]{0,300}this\.audio\.resume\(\)/.test(mainSrc));
ok('main.js 注册 onAudioInterruptionEnd(iOS)', /wx\.onAudioInterruptionEnd/.test(mainSrc));

// ───────────────────────── #6 iOS 旋转风声爆音 ─────────────────────────
console.log('\n#6 旋转风声爆音');
ok('_noiseBuffer 首尾淡入/淡出消除 loop 接缝', /data\[i\] \*= w/.test(audioSrc) && /data\[len - 1 - i\] \*= w/.test(audioSrc));
ok('playSpin 增益/截止用 setTargetAtTime 平滑调制', /g2\.gain\.setTargetAtTime\(targetGain, now, 0\.08\)/.test(audioSrc) && /frequency\.setTargetAtTime\(cutoff, now, 0\.08\)/.test(audioSrc));
ok('stopSpin 先 ramp 到 0 再延迟 stop(无咔哒)', /g\.gain\.setTargetAtTime\(0, now, 0\.012\)/.test(audioSrc) && /src\.stop\(stopAt\)/.test(audioSrc));

// ───────────────────────── 运行时 mock 实测 ─────────────────────────
function mockGainParam(initial) {
  return {
    value: initial,
    _ops: [],
    setValueAtTime(v, t) { this.value = v; this._ops.push({ op: 'set', v, t }); },
    setTargetAtTime(v, t, tc) { this.value = v; this._ops.push({ op: 'target', v, t, tc }); },
    exponentialRampToValueAtTime(v, t) { this.value = v; this._ops.push({ op: 'exp', v, t }); },
    linearRampToValueAtTime(v, t) { this.value = v; this._ops.push({ op: 'lin', v, t }); },
    cancelScheduledValues(t) { this._ops.push({ op: 'cancel', t }); }
  };
}
const createdGains = [];
const createdSources = [];
function mockCtx() {
  const ctx = {
    state: 'suspended',
    currentTime: 0,
    sampleRate: 44100,
    destination: {},
    resume() { this.state = 'running'; return Promise.resolve(); },
    createBufferSource() { const s = { buffer: null, loop: false, _stopTime: null, connect() {}, disconnect() {}, start() {}, stop(t) { this._stopTime = t; } }; createdSources.push(s); return s; },
    createBiquadFilter() { return { type: '', frequency: mockGainParam(0), connect() {}, disconnect() {} }; },
    createGain() { const g = { gain: mockGainParam(0), connect() {}, disconnect() {} }; createdGains.push(g); return g; },
    createOscillator() { return { type: '', frequency: mockGainParam(0), connect() {}, start() {}, stop() {} }; },
    createBuffer(ch, len, rate) { const arr = new Float32Array(len); return { getChannelData() { return arr; } }; }
  };
  return ctx;
}
let innerOpt = null;
const store = {};
global.wx = {
  createWebAudioContext: () => mockCtx(),
  getStorageSync: (k) => (k in store ? store[k] : ''),
  setStorageSync: (k, v) => { store[k] = v; },
  setInnerAudioOption: (o) => { innerOpt = o; },
  onShow() {}, onHide() {}, onAudioInterruptionEnd() {}, onAudioInterruptionBegin() {}
};

const { Sfx } = require(path.join(__dirname, '..', 'src', 'audio.js'));
let threw = false;
try {
  Sfx.unlock();
  ok('#4 运行时：init 后 masterGain 已建立', !!Sfx._master);
  ok('#4 运行时：wx.setInnerAudioOption 设 obeyMuteSwitch=true', innerOpt && innerOpt.obeyMuteSwitch === true);
  ok('#4 运行时：_out() 返回 masterGain(受软件音量控制)', Sfx._out() === Sfx._master);
  ok('#4 运行时：ctx 进入 running', Sfx.ctx && Sfx.ctx.state === 'running');

  // 软件音量
  Sfx.setVolume(0.5);
  ok('#4 运行时：setVolume 持久化 bb_volume', store['bb_volume'] === 0.5);
  const masterGain = Sfx._master.gain;
  const volOps = masterGain._ops.filter(o => o.op === 'target');
  ok('#4 运行时：masterGain 平滑 ramp 到 0.5', volOps.length > 0 && Math.abs(volOps[volOps.length - 1].v - 0.5) < 1e-6);

  // 静音经 masterGain 即时归零
  const before = masterGain._ops.length;
  Sfx.toggle(); // -> muted
  ok('#4 运行时：toggle 后 muted=true', Sfx.muted === true);
  const muteOps = masterGain._ops.slice(before).filter(o => o.op === 'target');
  ok('#4 运行时：静音经 masterGain ramp 到 0', muteOps.length > 0 && muteOps[muteOps.length - 1].v === 0);
  Sfx.toggle(); // -> unmuted，恢复
  ok('#4 运行时：再次 toggle 取消静音', Sfx.muted === false);

  // #5 ensureRunning 自愈
  ok('#5 运行时：ensureRunning 为函数', typeof Sfx.ensureRunning === 'function');
  Sfx.ctx.state = 'suspended';
  const healed = Sfx.ensureRunning();
  ok('#5 运行时：suspended 时 ensureRunning 返回 true 并恢复 running', healed === true && Sfx.ctx.state === 'running');

  // #6 噪声 loop 接缝：首尾样本应≈0（淡入淡出）
  const nbuf = Sfx._noiseBuffer(Sfx.ctx);
  const ndata = nbuf.getChannelData(0);
  const nlen = ndata.length;
  ok('#6 运行时：噪声缓冲长度=采样率(1s)', nlen === 44100);
  ok('#6 运行时：loop 起点淡入到≈0(无接缝咔哒)', Math.abs(ndata[0]) < 1e-6);
  ok('#6 运行时：loop 终点淡出到≈0(无接缝咔哒)', Math.abs(ndata[nlen - 1]) < 1e-6);
  // 中部仍有能量（淡入淡出未削弱整体；取绝对值求和，噪声正负相消不应判为无能量）
  let mid = 0; for (let i = 2000; i < 4000; i++) mid += Math.abs(ndata[i]);
  ok('#6 运行时：中部保留噪声能量', mid > 1);

  // #6 stopSpin 平滑归零：先 ramp 到 0，再延迟 stop
  Sfx.ctx.state = 'running';
  Sfx.playSpin(0.8, 0);
  const spinGain = Sfx._spinGain;
  const spinSrc = Sfx._spinSrc;
  ok('#6 运行时：playSpin 已建立旋转链路', !!spinGain && !!spinSrc);
  const gOpsBefore = spinGain.gain._ops.length;
  Sfx.stopSpin();
  const gOps = spinGain.gain._ops.slice(gOpsBefore);
  const rampZero = gOps.filter(o => o.op === 'target' && o.v === 0);
  ok('#6 运行时：stopSpin 先 ramp 增益到 0', rampZero.length > 0);
  ok('#6 运行时：stopSpin 延迟 stop(now+0.06) 而非立即', spinSrc._stopTime !== null && spinSrc._stopTime > Sfx.ctx.currentTime);
  ok('#6 运行时：stopSpin 后引用已清空(防重复停)', Sfx._spinSrc === null && Sfx._spinGain === null);

  // 整体不抛异常
  Sfx.play('click'); Sfx.play('clash'); Sfx.play('win');
  ok('#6 运行时：播放各类音效不抛错', true);
} catch (e) {
  threw = true;
  console.log('    runtime error:', e && e.message);
}
ok('整体运行时无异常抛出', !threw);

console.log(`\n【跨平台音频 #4/#5/#6】结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
