// 烟雾测试：iOS 音频健壮性
// 覆盖：手势解锁 unlock()、onShow/onAudioInterruptionEnd 恢复、首声调度错开、打断保护注册。
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
const audioSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'audio.js'), 'utf8');

console.log('P0-3 iOS 音频健壮性');

// 1) main.js 注册了音频打断恢复（与 onShow resume 同一类问题）
ok('main.js 注册 onAudioInterruptionEnd 恢复音频', /wx\.onAudioInterruptionEnd/.test(mainSrc));
ok('main.js 注册 onAudioInterruptionBegin 停旋转声', /wx\.onAudioInterruptionBegin/.test(mainSrc));
ok('main.js onShow 已 resume 音频', /onShow[\s\S]{0,300}this\.audio\.resume\(\)/.test(mainSrc));

// 2) audio.js 具备手势解锁与首声错开
ok('audio.js 暴露 unlock()', /unlock\(\)\s*\{/.test(audioSrc));
ok('audio.js _tone 在非 running 时向前错开调度(lead)', /lead = ctx\.state === 'running' \? 0 : 0\.06/.test(audioSrc));
ok('audio.js resume() 处理 suspended', /state === 'suspended'/.test(audioSrc));

// 3) 运行时 mock：模拟 iOS suspended 初始态，验证 unlock→running 且 play 不抛错
function mockCtx() {
  return {
    state: 'suspended',
    currentTime: 0,
    sampleRate: 44100,
    destination: {},
    resume() { this.state = 'running'; return Promise.resolve(); },
    createBufferSource() { return { buffer: null, loop: false, connect() {}, start() {}, stop() {}, disconnect() {} }; },
    createBiquadFilter() { return { type: '', frequency: { setTargetAtTime() {} }, connect() {}, disconnect() {} }; },
    createGain() { return { gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {}, setTargetAtTime() {} }, connect() {}, disconnect() {} }; },
    createOscillator() { return { type: '', frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, start() {}, stop() {} }; },
    createBuffer() { return { getChannelData() { return new Float32Array(8); } }; }
  };
}
global.wx = { createWebAudioContext: () => mockCtx(), getStorageSync: () => '', setStorageSync() {} };

const { Sfx } = require(path.join(__dirname, '..', 'src', 'audio.js'));
let threw = false;
try {
  Sfx.unlock();
  ok('unlock 后 ctx 进入 running', Sfx.ctx && Sfx.ctx.state === 'running');
  Sfx.play('click');
  Sfx.play('win');
  ok('play 在解锁后不抛错', true);
  // 模拟打断：挂起后再 resume 路径
  Sfx.ctx.state = 'suspended';
  Sfx.resume();
  ok('resume 在打断后能恢复 running', Sfx.ctx.state === 'running');
  Sfx.toggle(); Sfx.toggle();
  ok('toggle 静音/取消不抛错', true);
} catch (e) {
  threw = true;
  console.log('    runtime error:', e && e.message);
}
ok('整体运行时无异常抛出', !threw);

console.log(`\nP0-3 结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
