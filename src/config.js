/**
 * 运营/业务统一配置
 * - 集中管理需要替换为真实值的对外标识，避免散落在各处难以维护。
 * - 所有配置改动只需修改本文件，无需改业务逻辑。
 */
const CONFIG = {
  // 产品版本号：随每次发布 bump，用于版本展示 / 强更判断等。
  // 注：小游戏埋点走「场景分析 / 分支曝光上报」(wx.reportUserBehaviorBranchAnalytics)，
  //     该接口 branchDim 仅接受 1-100 整数、放不下版本号，故埋点改用「发布前后时间段对比」
  //     （见 analytics.js），不再依赖此字段做切片。
  version: '1.0.0',

  // 激励视频广告位 ID（默认位真源；已确认真实流量主广告位 adunit-1183de0d72298c4d，上线前勿改）
  // 复活 / 看广告能量 等场景使用此默认位。
  adUnitId: 'adunit-1183de0d72298c4d',

  // 看广告回能量独立广告位（用户 2026-08-30 回填：adunit-af16958aaf84edbf）。
  // 与默认位 / 宝箱位分开：能量位点击频率高，独立位便于在 MP 后台单独看填充/曝光数据，
  // 也避免"能量位失败连坐默认位 / 宝箱位"。必须是「激励视频」类型。
  energyAdUnitId: 'adunit-af16958aaf84edbf',

  // 青铜宝箱「看广告开」独立广告位（用户 2026-08-30 回填：adunit-9d11e5b028812190）。
  // 与默认位分开：宝箱恰好在战斗刚胜利、主线程最忙的瞬间被快速点击，独立位可避免
  // 「宝箱位失败连坐默认位」、也便于在 MP 后台单独看宝箱位的填充/曝光数据。
  // 注意：必须是「激励视频」类型（与默认位同级），不能复用插屏位 ID。
  chestAdUnitId: 'adunit-9d11e5b028812190',

  // 插屏广告位 ID（隐藏式自动弹广告用）—— ⚠️ 与上面激励视频是「两套独立广告位」！
  // 必须去 MP 后台「流量主 → 广告位 → 插屏广告」单独新建，类型选「插屏」，不能直接复用激励视频 ID。
  // 抽卡激励广告位（2026-09-06 用户换 ID，且确认 MP 后台建为「激励视频」类型）：
  //   收卡时自动弹出激励视频（隐藏式、无按钮，等同原「隐藏插屏」行为；仅第3/6/9抽+逢2随机触发）。4 个独立位按抽数分配：
  //   draw3  第3抽 → adunit-4729d5af4e1dabc8
  //   draw6  第6抽 → adunit-f02da65fdd7f378f
  //   draw9  第9抽 → adunit-b87930618c41419e
  //   rand2  逢2的倍数随机 → adunit-af96563df3ed4e15
  // ⚠️ 必须是「激励视频」类型（与默认位/能量位/宝箱位同级）；走 Rewarded.show 按 adUnitId 懒加载，不进 Interstitial。
  drawAdUnitId3: 'adunit-4729d5af4e1dabc8',
  drawAdUnitId6: 'adunit-f02da65fdd7f378f',
  drawAdUnitId9: 'adunit-b87930618c41419e',
  drawAdUnitIdRand: 'adunit-af96563df3ed4e15',

  // 首页插屏广告位（2026-10-02 新增；2026-11-08 弹点迁移）：微信后台「流量主 → 广告位 → 插屏广告」新建，类型必须选「插屏」。
  // ⚠️ 与上面所有激励视频是「两套独立广告位」，不能复用激励视频 ID（类型错配会被微信拒绝）。
  // 弹点：结算页「返回首页」手势之后（自然间歇），不再是启动 3.5s 自动弹——启动即弹伤留存、
  // 抢玩家第一下点击、且是微信体验评估的扣分项。门控：首日不弹 + 每日上限 2 次 + 一次/冷启动。
  // 留空/占位(adunit-0...) → 静默跳过，不弹。
  homeInterstitialAdUnitId: 'adunit-1e8b1ad59011ef1d',

  // 抽卡广告看完奖励（P2 广告优化 2026-11-01）：奖励从「+50 金币」升级为「免费再抽 1 次」——
  // 抽卡场景下再抽的感知价值远高于小额金币 → 完播率↑收益↑，玩家感受是"赚了"而非"被打扰"。
  // drawAdRewardMode: 'redraw'（免费再抽，推荐）| 'coins'（回退旧金币模式，金额见 drawAdRewardCoins）。
  drawAdRewardMode: 'redraw',
  drawAdRewardCoins: 50,

  // 结算页「胜利翻倍」激励位（文章验证 eCPM 最高、最不伤留存的广告位）：赢一局后"看广告金币翻倍"。
  // 留空 = 结算页不渲染「翻倍」按钮（无死按钮），配好即生效。
  resultDoubleAdUnitId: 'adunit-1183de0d72298c4d',  // 复用默认激励位（结算翻倍启用；留空则按钮不渲染）
  resultDoublePerDay: 3,     // 每日可「翻倍」次数上限（管住手，避免刷屏）

  // 广告频控纪律（文章铁律3）：被动激励位一局最多 gameMax 次、且距上次广告至少 gapMin 分钟；
  // 主动位（看广告得能量）不受此限。降免受打扰、保护耐心。
  adFreq: { gameMax: 2, gapMin: 3 },

  // 游戏圈 openlink：必须是短 token（形如 xxxxxxx-xxxxxx），不是浏览器 URL。
  // 唯一正确取法：登录 mp.weixin.qq.com → 游戏能力地图 → 游戏圈 → 基础设置 / 帖子·话题列表，
  // 复制那里的 openlink 原文覆盖此处。
  //
  // 留空时的行为（重要）：胶囊左侧的「社区」入口**不会渲染**，玩家看不到、也没有任何提示。
  // 所以该入口永远不会是"点了没反应"的死按钮 —— 配好即出现，没配就不出现。
  gameClubOpenlink: '',

  // 更多小游戏 openlink：与 gameClubOpenlink 同源，留空则胶囊左侧「更多小游戏」入口**不渲染**，
  // 避免"点了只弹敬请期待"的死按钮（P2-8）。配好聚合页/跳转盒子 openlink 后入口自动出现，
  // 点击走 wx.createPageManager().load({openlink}) 真实跳转。
  moreGamesOpenlink: '',

  // 场景分析 / 分支曝光上报的 branchId（小游戏专用，对应 wx.reportUserBehaviorBranchAnalytics）。
  // 三个场景在 MP 后台「统计 → 基础数据 → 场景分析 → 场景管理」各建一个，把分配的 branchId 填进来：
  //   boot            启动
  //   battleStart     每局开始（branchDim 自动传 stage 关卡号 1-100）
  //   firstBattleDone 首局完成（每用户一生仅一次）
  //   draw            抽卡（branchDim 自动传抽到稀有度 1-5）
  //   merge           合成（branchDim 自动传产物稀有度 1-5）
  //   battleDefeat    战败（branchDim 自动传关卡 stage 1-100）
  //   share           分享成功（无维度）
  //   adWatch         激励视频看完（无维度）
  // 留空 = 不上报（避免空打）；填好即自动生效，无需改业务逻辑。
  // 2026-10-31 已回填：8 个场景在 MP 后台「统计 → 场景分析 → 场景管理」创建，
  // branchId 由后台分配（经 获取代码 弹窗逐一提取）。
  // 注意：branchId 通道是"场景/维度分布"的补充通道；生死漏斗主通道走 reportEvent（见下方 funnel）。
  analyticsBranch: {
    boot: 'BCBgAAoXHx5d1mfRPcbFAn',
    battleStart: 'BCBgAAoXHx5d1mfRPcbFAg',
    firstBattleDone: 'BCBgAAoXHx5d1mfRPcbFAh',
    draw: 'BCBgAAoXHx5d1mfRPcbFAi',
    merge: 'BCBgAAoXHx5d1mfRPcbFAj',
    battleDefeat: 'BCBgAAoXHx5d1mfRPcbFAs',
    share: 'BCBgAAoXHx5d1mfRPcbFAt',
    adWatch: 'BCBgAAoXHx5d1mfRPcbFAu'
  },

  // 生死漏斗（P0-1 · 2026-10-31）：boot → first_draw → first_battle → first_win → d1_return
  // 通道：wx.reportEvent（WE分析自定义事件），每安装一次去重，统一上报 {count:1}。
  // ⚠️ 上线前一次性配置（不配则数据不上账，但绝不影响玩法）：
  //   MP 后台 → 运维中心 → WE分析 → 数据管理 → 上报管理 → 新建事件，
  //   事件名必须与 prefix 拼出的 5 个名字完全一致：
  //     bb_funnel_boot / bb_funnel_first_draw / bb_funnel_first_battle
  //     bb_funnel_first_win / bb_funnel_d1_return
  //   用法：次日留存 = d1_return 总数 / boot 总数；首战率 = first_battle / boot；
  //        首战胜率 = first_win / first_battle。
  funnel: { enabled: true, prefix: 'bb_funnel_' },

  // 词条系统（P0-3 · 2026-10-31）：金币洗词条 = 金币回流战斗的硬出口。
  // 定价：第 1 次洗词条 rerollBase，之后每次 +rerollStep（按单只陀螺累计次数）。
  // 依据：新手 ~35 金币/局、高阶 ~2020/局，300 起步与金币抽卡同价、逐步涨价防无脑连洗。
  trait: { rerollBase: 300, rerollStep: 150, maxTraits: 2 },

  // 抽卡隐藏式广告预告（P2 细度 · 2026-10-31）：抽中"待播广告位"的那一抽立即 toast 预告，
  // 给玩家知情预期（广告本身仍在收卡手势内同步弹出——setTimeout 延展会破坏微信手势窗口要求，勿改）。
  drawAdPreview: true,

  // 回归礼包延后到「本日首次对战结算」再弹（P2 细度 · 2026-10-31）：
  // 首屏零阻挡最后一公里——回归玩家先进一局再领礼包，避免开局第一下点击被领取弹窗吃掉。
  // 兜底：若一直不开战，30s 无交互后照常弹（防离线奖励沉没）。
  returnDeferToSettle: true,

  // 生产崩溃上报（运维中心，零后端）
  // ==========================================================================
  // 两条通道都基于微信「运维中心」，无需自建服务器：
  //   gameLog : 小游戏实时日志（base lib 3.7.4+，wx.getGameLogManager）。
  //             把完整 errorLog（source/message/stack 截断/设备/游戏状态）写进去，
  //             后台「运维中心 → 小游戏实时日志」按 openid 可查，真机偶发崩溃可定位。
  //   eventId : 崩溃计数事件 ID。capture() 会 wx.reportEvent(eventId, {crash_count:1, source})
  //             把崩溃计数 +1，可在后台看趋势 / 设预警。
  //             ⚠️ 注意：wx.reportMonitor 自基础库 2.31.1 起「停止维护」，本项目基础库
  //             3.17.1 必须用 wx.reportEvent；事件在「运维中心 / WE分析 → 数据管理 →
  //             上报管理」新建（事件名必须与此 eventId 完全一致，最多 128 个）。
  //             留空 = 不上报计数（仅走实时日志），降级安全。
  // 两条通道都 `typeof wx` + API 存在性 + devtools 守卫，缺失即静默跳过、绝不抛错。
  crashReport: {
    gameLog: true,
    eventId: 'bb_crash'
  },

  // 分享卡片图片
  shareCardImage: 'images/share-card.jpg',

  // 一次性订阅消息模板（留存拉回：次日提醒玩家回来签到/领体力）
  // ==========================================================================
  // ⚠️ 必须先在 MP 后台申请，再把模板 ID 填进来，否则订阅封装会静默 no-op（不弹不报错）。
  // 申请路径：mp.weixin.qq.com → 功能 → 订阅消息 → 一次性订阅模板 → 选用/申请「系统通知类」模板，
  //   例如：「每日签到提醒」「体力恢复提醒」「离线收益领取提醒」（关键词自拟，过审即用）。
  //   每个模板分配一个 templateId（形如 0Sxyz...），复制到下面对应 key。
  // 调用点：main.js 在 sign_claim（签到成功）/ return_claim（领回归礼包）用户手势内触发，
  //   通过 wx.requestSubscribeMessage 请求对应场景的模板授权；授权后微信可在次日给玩家下发服务通知，拉回 D1 留存。
  // 注意：一次性订阅每次授权仅当次有效，需玩家每次主动触发；不要指望一次授权永久生效。
  //   留空 = 不弹订阅（安全降级），不影响任何现有功能。
  subscribeTemplates: {
    daily:   't7eOtI7N4xfKWMXditAif1pSd0GHE6xAUiDkMEBiO-k', // 每日登录提醒（MP 后台申请的 templateId，已填 → 订阅生效）
    energy:  'd1rxqpkdmCq03l1yvSX4QHWif93dLFJ-MEuPf2-6CNw', // 体力恢复提醒（MP 后台申请的 templateId，已填 → 订阅生效）
    offline: 'eSUW_kfbp_4X2xYMiQBycjlve786bkkdvodtu-yo4NA'  // 离线收益领取提醒（MP 后台申请的 templateId，已填 → 订阅生效）
  },

  // 回归礼包延后弹·兜底时长(ms)：启动后若玩家一直无交互，超过此时长也自动触发一次
  // 离线礼包判定，避免离线奖励沉没；玩家先点击任意按钮则立即触发（首屏零阻挡，见 main._maybePromptReturn）。
  returnGraceMs: 8000,

  // 双人合作守关（纯客户端·同屏交替传机）：零后端「一起玩」裂变。
  // enabled=false 时主页「双人」入口不渲染（无死按钮），灰度验证玩法价值后再开。
  coop: {
    enabled: false,
    bossMult: 2,                 // BOSS 目标分放大倍率（合作关更强）
    minStage: 1,                 // 合作关起步关卡（挂 run.stage 传）
    shareTitle: '我和好友双人合力通关了陀螺大师第{stage}关！敢来和我们一起吗？'
  }
};

module.exports = {
  CONFIG
};
