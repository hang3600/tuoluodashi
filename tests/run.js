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
  { file: 'smoke_analytics.js', desc: 'P1 数据盲区：零成本埋点（boot/battle_start/first_battle_done 去重）' },
  { file: 'smoke_cross_ios_android.js', desc: '跨平台 iOS/Android 一致性门禁（benchmarkLevel 补偿/阴影放开/DPR 解耦）' },
  { file: 'smoke_audio_cross.js', desc: '跨平台音频 #4/#5/#6（软件音量 parity/Android 打断自愈/旋转风声防爆音）' },
  { file: 'smoke_audio_ios.js', desc: '跨平台 iOS 音频 #3：打断(onAudioInterruption*)恢复/挂起错开调度(P0-3)' },
  { file: 'smoke_input_touch.js', desc: '回归：触摸坐标归一化（逻辑像素，不被 ÷dpr，修复开发者工具点击无响应）' },
  { file: 'smoke_ads_multiunit.js', desc: '多广告位支持（宝箱独立位 adunit-9d11e5b028812190，不连坐默认位）' },
  { file: 'smoke_ads_onclose_once.js', desc: '广告实例单例 & onClose 单次绑定 & 展示中叠加 show 被 _busy 守卫忽略（防 removeTextView 洪流）' },
  { file: 'smoke_ads_multiton.js', desc: '多广告位 multiton 多例模式 + SDK 强制单例兜底（消除微信「绑定了多次 onError/onClose」告警）' },
  { file: 'smoke_ads_lru.js', desc: '激励视频实例数上限(maxInstances=5) + LRU 回收(destroy 最久未用空闲位，busy/共享实例不回收)（消除微信「实例过多」告警，2026-09-12 五台 iOS 真机日志定位）' },
  { file: 'smoke_return_defer.js', desc: '回归礼包延后弹(选项A)：启动不同步判定、onTap 首次有效交互即弹、CONFIG.returnGraceMs 兜底、_pendingReturnInit 整局一次守卫、game 功能未误删' },
  { file: 'smoke_interstitial_multi.js', desc: '抽卡插屏拆 4 独立位（draw3/draw6/draw9/rand2，按抽数调度）' },
  { file: 'smoke_interstitial_home.js', desc: '首页插屏(2026-10-02)：进首页后延迟自动弹一次，key=home 路由 + load→show 兜底 + 未配置/占位静默跳过 + main.js 接线源码门禁' },
  { file: 'smoke_result_layout.js', desc: '结算页(失败/胜利)布局：再接再厉不压按钮、连战文案不压胶囊' },
  { file: 'smoke_result_gamefeel.js', desc: '结算页游戏化打磨：_settle 触发音效/粒子/起始时间、按钮按下态、能量充电动画' },
  { file: 'smoke_home_v2.js', desc: '主界面游戏化 V2：骨架(去大标题/圆盘放大) + 锻造工坊 + 异形主次按钮 + 命中区不丢 + 回退开关' },
  { file: 'smoke_home_bg.js', desc: '主页 AI 宇宙星海背景接入：homebg 合法性 + 无头安全跳过 + 回退路径不崩' },
  { file: 'smoke_home_bg_realdevice.js', desc: '主页背景真机加载回归：_HOME_B64=null(真机)下 drawBackground 仍加载包内 images/home/home_cosmic.jpg，不早返回走渐变（守防 2026-09-02 真机丢背景 bug）' },
  { file: 'smoke_home_bg_devtools_fallback.js', desc: '主页背景模拟器兜底回归：DevTools 下包内路径 404 仍回退 base64 出图（守防 本地模拟器紫色默认渐变、看不到自定义背景）' },
  { file: 'smoke_codex_bg_devtools_fallback.js', desc: '图鉴背景模拟器兜底回归：DevTools 下优先 base64 直接出图、不撞包内 404（与主页对称，F5 消除 404 噪声）' },
  { file: 'smoke_codex_bg.js', desc: '图鉴独立背景接入：codexbg 合法性 + 无头安全跳过 + view 分流(home/codex 互不干扰)' },
  { file: 'smoke_inv_rail.js', desc: '背包陈列轨道 V2：卡片命中契约(拖拽/长按不失效) + 按屏滚动钳制 + 翻页控件 + 空状态 + 回退网格' },
  { file: 'smoke_battle_again.js', desc: '#6 核心循环无缝化：连胜免门票 + stage 递增 + 连胜断扣票 + 能量不足/无陀螺拦截 + 显式战斗态+存档' },
  { file: 'smoke_hitfeel_v2.js', desc: '#7 打击感升级：硬碰硬·无形变（白闪+震屏承担） + 拖尾辉光 + 音效分层(轻/重/暴击/碰撞)' },
  { file: 'smoke_ultimate.js', desc: '#8 怒气必杀：怒气积累(命中/撞击/打偏不攒/封顶) + 满怒必杀按钮 + 释放演出+得分爆发 + HUD 怒气条' },
  { file: 'smoke_level_boss.js', desc: '#9 关卡/BOSS 化：每5关BOSS + 二阶段狂暴(分数过半×1.25) + 敌血条=目标分映射 + 第N关/对手名 HUD' },
  { file: 'smoke_coop.js', desc: '双人合作守关：同屏交替传机·只记战绩不发资源 + BOSS强化 + passPhone + 纯邀约分享(非诱导) + 灰度门控' },
  { file: 'smoke_icon_3_3.js', desc: '③3-3 图标单色系统一：icon令牌 + drawIconButton 统一描边' },
  { file: 'smoke_intro_3_1.js', desc: '③3-1 情绪氛围·开场首屏呼吸感(标题淡入/微放大/柔光+起音，一次性)' },
  { file: 'smoke_micro_2_1.js', desc: '②-2-1 细节手感：触感脉冲(胜利/翻倍/里程碑) + 飘字节奏统一' },
  { file: 'smoke_ui_tokens.js', desc: '①一致性收口·设计令牌：UI令牌 + render迁字体/色彩/按钮手感' },
  { file: 'smoke_quality_evolution.js', desc: '皮肤/外观：大师限定盘面持久化+渲染(终局奖品) + 合成晋级闭环' },
  { file: 'smoke_quality_polish.js', desc: '②质感精修：盘面高光扫过/战斗氛围随局变化/统一动效，纯装饰受性能分档约束' },
  { file: 'smoke_stage_preview.js', desc: '拉单局时长：暴击次数里程碑飘字 + 结算→下一关目标预览' },
  { file: 'smoke_result_double.js', desc: '胜利结算翻倍：赢一局看广告金币×2 + 每日上限/同局一次/无广告位门控' },
  { file: 'smoke_ad_freq.js', desc: '广告频控：被动激励位一局≤2次且间隔≥3分钟，主动位(能量)不受限' },
  { file: 'smoke_battle_frame.js', desc: '对战页 HUD 框（电影感游戏界面）：烘焙+缓存 + 低能量危机暗角不崩' },
  { file: 'smoke_chest_open.js', desc: '青铜宝箱「开启」门控：首次免费/之后看广告 + 跨天复用 + 降级兜底' },
  { file: 'smoke_topimg_load.js', desc: '陀螺/角标 PNG 加载 v8（对齐 spintop：单次赋 src + 不再调 wx.loadImage + 6s 换路兜底 + 金/木/水/火/土 level 专属贴图）' },
  { file: 'smoke_topimg_directdraw.js', desc: '陀螺贴图真机矢量修复：离屏画布坏掉时 drawBeyblade 直接画 PNG 兜底（非矢量）' },
  { file: 'smoke_force_update.js', desc: '强制更新：新版本就绪 → 先同步存档 + 单按钮弹窗(showCancel:false) → applyUpdate（含降级/异常兜底）' },
  { file: 'smoke_memory_guard.js', desc: '内存告警守卫：wx.onMemoryWarning → level 5 只清缓存不降档 / level≥10 强制降 LOW + 清 sprite（含缺失/异常兜底，防低端机 OOM 闪退）' },
  { file: 'smoke_perf_runtime_fixes.js', desc: '运行性能优化：_clearBattleCaches 释放 5 张离屏+背景图 / downscaleToCap 背景封顶720降采样（高端机 OOM + 低端机 CPU 修复）' },
  { file: 'smoke_arena_subpkg.js', desc: 'arena 背景分包：prepSrc 真机分支把 arena 映射到 battle/images/arena，tops/home 路径不变（主包 −192KB）' },
  { file: 'smoke_jpg_compress.js', desc: 'Phase-2a JPG 压缩：home/codex 保 720 原分辨率仅重编码(q0.82)，share-card 降至 621x466；体积受控防回弹（主包再 −~389KB）' },
  { file: 'smoke_perf_p18.js', desc: 'P1-8 其他性能项（光束/装饰缓存、measureText、拖尾池、展开运算符）' },
  { file: 'smoke_perf_spintop_grad.js', desc: '对战循环渐变缓存 _gradFor（静态渐变 9/帧 → 0；动画渐变刻意不缓存；跨 ctx 隔离）' },
  { file: 'smoke_offscreen_transparent.js', desc: '离屏画布透明底色回归（守防陀螺/图标「大方块白底」：getBeybladeSprite + _bakeTopSprite 烘焙前先 clearRect）' },
  { file: 'smoke_imgb64_alpha.js', desc: 'imgb64 内联图透明度回归（守防模拟器白方块：data URI 必须 PNG+RGBA，陀螺真实含透明像素）' },
  { file: 'smoke_arena_bg_sync.js', desc: '对战擂台背景同源回归（守防 DevTools/真机背景不一致：arenabg.js 内联 base64 必须与 battle/images/arena/arena_neon_bg.jpg 同源 sha256+同尺寸+JPEG）' },
  { file: 'smoke_crash_report.js', desc: 'P1 稳定性：生产崩溃上报（运维中心实时日志 + 计数事件 wx.reportEvent，零后端；devtools/空ID/链路抛错/无wx 守卫；旧 Lib 回退 reportMonitor）' },
  { file: 'smoke_bg_memory.js', desc: 'U10 内存优化：非当前视图释放背景图（_releaseInactiveBg）+ LOW 档解码封顶 540p（capForLevel）' },
  { file: 'smoke_perf_startup_mem.js', desc: '启动/内存性能：4 个 base64 shim 打包排除（−954KB，require 守卫防真机崩）+ 离屏退避重探（永久闭锁→2/4/8s…60s）+ 背景位图归零 + render-effects 死代码移除' },
  { file: 'smoke_onboarding.js', desc: 'P0 首程直达轻引导：obStep/obDone/obTries 状态机（新档→抽卡→首胜收口/连败3兜底）+ 存档 roundtrip + 老档 level>1 兼容 + _drawObGlow 无全屏遮罩源码级门禁' },
  { file: 'smoke_draw_reward.js', desc: '抽卡广告位转化（2026-09-06）：4 个插屏位→激励视频，改为「看广告免费再抽一次」按钮；config 新 ID 就位、main 走 Rewarded.show、render 画按钮、game 调度逻辑不变' },
  { file: 'smoke_retention_subscribe.js', desc: '留存 P0：订阅消息封装(config 驱动/no-op 降级) + 启动期自动弹签到纯判定(无副作用) + main 接线与 config 占位门禁' },
  { file: 'smoke_battle_select.js', desc: '批次F 出战陀螺选择面板(选项B)：selectBattleBeyblade 优先 battleBbId→中央格→战力最高 + 持久化 round-trip + 对战入口改开面板 + render 面板绘制/命中守卫' },
  { file: 'smoke_battle_select_interact.js', desc: '批次F 选陀螺面板·交互链路门禁（2026-09-12）：真实 Main 实例化+模拟点击——面板互斥/按钮注册/hitTest 命中与不穿透/点行即开战/关闭X/翻页 全链路 + 源码防回退标记' },
  { file: 'smoke_arena_redraw.js', desc: '批次G 对战擂台实体化重绘（2026-09-12）：金属盘沿/下沉碗体/磨砂磨损/阵营分界/VS 徽章结构锚点 + 敌方色接线 + 烘焙缓存性能承诺 + 运行时真实绘制与兜底不抛错' },
  { file: 'smoke_battle_select_hint.js', desc: '批次F 选陀螺面板·点选文字提示只弹一次（2026-09-12 用户反馈「每选一只弹一次太吵」）：首次弹一次+入存档跨会话不再弹 + 点选脉冲即时反馈且收敛 + update 递减不依赖面板开关 + 源码防回退' },
  { file: 'smoke_beast_naming.js', desc: '命名体系（2026-09-13）：TIERS 陀螺名 = 麒麟/青龙/玄武/朱雀/白虎（顺序不变）+ ELEMENTS 元素名 = 金/木/水/火/土（与陀螺名零重名，两轴分离）+ 相克与抽卡概率一分未动 + 图鉴筛选/徽章名对齐 + 可执行代码无旧名残留' },
  { file: 'smoke_element_formula.js', desc: '方案A·元素=f(品质,等级)（2026-09-13 回退）：(tier*7+(lv%5)*3)%5 精确 + 每档5级覆盖5元素 + 25种「神兽×元素」满 + 元素环倍率不动 + 羁绊按元素跨品质 + 敌方元素随档位 + 老档零迁移 + 面板行只标「元素·X」单字' },
  // ── P0 三件套（2026-10-31）：生死漏斗 / 开放数据域好友榜 / 金币洗词条 ──
  { file: 'smoke_funnel.js', desc: 'P0-1 生死漏斗：boot→首抽→首战→首胜→D1回访（reportEvent 通道 + 每安装一次去重 + D1 判定=安装日恰为昨天 + 无wx静默 + 触发点源码级接线）' },
  { file: 'smoke_leaderboard.js', desc: 'P0-2 开放数据域好友榜：KV 四 key（streak 周口径过滤）+ 同步节流 + noteBattleScore 高分/周连胜 + 假好友榜零残留防回退 + opencontext 纯函数（排序/去重/过期周）+ 主域三榜页签/sharedCanvas 接线' },
  { file: 'smoke_traits.js', desc: 'P0-3 词条系统：7 词条池 + 获取点分配 + 合成并集继承封顶2 + clone 携带 + 战斗映射（暴击/连击窗/开局怒气/出界线/得分/抽打/回怒）+ 金币洗词条递增定价（含周末半价）+ 存档持久化与老档迁移' },
  { file: 'smoke_p1_wave.js', desc: 'P1 第二波：#5 激斗周末（限时商店限量/周记账/BOSS积分×2/洗词条半价） + #6 挑战券（每日5免费+广告/分享+2，免费→加发→能量逐层消耗，_battleAgain 免票语义不变） + #7 影子战（纪录局关卡号 + ghost 局目标分≥纪录×1.05） + UI/派发接线门禁' },
  { file: 'smoke_polish_wave.js', desc: 'P2 细度波：爆发抽打免费化(去隐藏扣能) + 收卡广告预告(手势窗口内) + 图鉴引导(首收卡toast+tab光晕一次性) + 福利中心(签到/任务/助力三合一单入口) + 赛季荣耀(巅峰段位+首达大师限定) + run流派协同(攻/金/守 2层触发) + 回归礼包延后到首次结算' },
  { file: 'smoke_render_matrix.js', desc: '全链路渲染状态矩阵（2026-11-08）：32 状态×12 帧 render() 零抛错 + 冷启动首帧对齐不暗闪 + 切Tab暗闪回归锁（真机 doFrame ctx not defined 事故门禁）' },
  { file: 'smoke_world_role.js', desc: '8.0→9.0 三大件门禁（2026-11-24 · 花叔范式 01/07/08）：HUD 矿石槽+炉温计 / 陀螺即角色三态(旋转·火星·出炉金环) / 战报分享卡(离屏canvas+GameDigits+回落)' }
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
