// 冒烟测试聚合 runner
//   依次运行 4 个套件，聚合「通过/失败」计数；任一脚本退出码非 0 则整体退出码为 1。
// 用法：
//   node tests/run.js            # 跑全部
//   node tests/run.js smoke_p2   # 只跑某个套件（传文件名，可多个）
//
// 说明：每个 smoke_*.js 自带 process.exit，故此处用 spawn 逐个独立运行并归集结果，
// 不会因单个套件 exit 而影响其余套件。

const { spawnSync } = require('child_process');
const path = require('path');

const SUITES = [
  { file: 'smoke_core.js',  desc: '核心：保底/时区/签到/每日限额 (P0)' },
  { file: 'smoke_coin.js',  desc: '金币出口与产出下调 (P1-5)' },
  { file: 'smoke_tiers.js', desc: 'TIERS 索引错位收口 (P1-2/3/4 + main.js:351)' },
  { file: 'smoke_p2.js',    desc: 'P2 八项打磨' },
  { file: 'smoke_ui_p2.js', desc: 'P2 UI 一致性与打磨（无头渲染回归：面板外壳/安全区/遮罩/门控）' },
  { file: 'smoke_battle_pacing.js', desc: 'P0-1 战斗节奏（目标分公式 + 达标即结算）' },
  { file: 'smoke_club.js', desc: 'P0-2 游戏圈入口（矢量图标 + 话术不泄露 + 配置门控）' },
  { file: 'smoke_energy.js', desc: 'P0-3 战败能量惩罚（扣除额与结算页文案一致）' },
  { file: 'smoke_whip_feel.js', desc: '批次F 抽打力度曲线 + 命中定帧 hitstop' },
  { file: 'smoke_element.js', desc: 'P1-2 元素克制倍率进入得分公式' },
  { file: 'smoke_particles.js', desc: 'P1-5 粒子颜色与淡出（分组绘制 + drawcall 上界）' },
  { file: 'smoke_arena.js', desc: 'P1-6 竞技积分结算页展示' },
  { file: 'smoke_layout_sig.js', desc: 'P1-7 布局签名浮点 energy → 每帧全量 reflow' },
  { file: 'smoke_perf_p18.js', desc: 'P1-8 其他性能项（光束/装饰缓存、measureText、拖尾池、展开运算符）' },
  { file: 'smoke_analytics.js', desc: 'P1 数据盲区：零成本埋点（boot/battle_start/first_battle_done 去重）' },
  { file: 'smoke_cross_ios_android.js', desc: '跨平台 iOS/Android 一致性门禁（benchmarkLevel 补偿/阴影放开/DPR 解耦）' },
  { file: 'smoke_audio_cross.js', desc: '跨平台音频 #4/#5/#6（软件音量 parity/Android 打断自愈/旋转风声防爆音）' },
];

function runOne(file) {
  const r = spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit' });
  if (r.error) { console.error('  ✗ 无法启动 ' + file + '：' + r.error.message); return 1; }
  return r.status === 0 ? 0 : 1;
}

// 允许通过命令行参数只跑部分套件
const only = process.argv.slice(2);
const targets = only.length
  ? SUITES.filter(s => only.some(a => s.file.includes(a)))
  : SUITES;

if (only.length && targets.length === 0) {
  console.error('未匹配到套件，可选：' + SUITES.map(s => s.file).join(', '));
  process.exit(2);
}

let failed = 0;
for (const s of targets) {
  console.log('\n══════════════════════════════════════');
  console.log('▶ ' + s.file + '  —  ' + s.desc);
  console.log('══════════════════════════════════════');
  failed += runOne(s.file);
}

console.log('\n══════════════════════════════════════');
if (failed === 0) {
  console.log('✅ 全部套件通过（' + targets.length + ' 个）');
  process.exit(0);
} else {
  console.log('❌ 有 ' + failed + ' 个套件失败');
  process.exit(1);
}
