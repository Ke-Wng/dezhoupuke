## 德州扑克 Online — 项目交付文档

### 项目概况

在线多人德州扑克游戏，支持 2-6 人联机 + AI 人机对战，5 种玩法模式（经典/急速/短牌/高额/All-in Fold），含 WebRTC 语音聊天、成就系统、排行榜、每日签到、筹码经济、角色换装、10个赌桌场景、占卜塔罗牌。

### 技术架构

前端：单文件 SPA，全部 HTML/CSS/JS 内联在 `public/index.html`（约 3000+ 行），无构建工具，无框架，原生 JS + WebSocket。
后端：Node.js，纯 WebSocket 服务（ws 包，无 Express），进程用 PM2 管理。
文件结构：
```
/opt/poker-online/
├── public/index.html        ← 唯一前端文件
├── server/
│   ├── index.js             ← WebSocket 服务器 + 消息路由
│   ├── room.js              ← 房间管理（创建/加入/离开/状态，含头像传递）
│   ├── game.js              ← 游戏引擎（发牌/下注/摊牌/bot AI 用蒙特卡洛模拟，含头像）
│   └── userStore.js         ← 用户持久化（JSON 文件，含注册/登录/统计/成就/筹码/签到/头像）
├── data/users.json          ← 用户数据文件
└── package.json             ← 依赖：ws@^8.18.0
```

### 服务器与部署

服务器 IP：47.106.206.100
SSH：root / gevK6sWHF_w_4Ug
免密密钥：`~/.ssh/id_ed25519_deploy`（已配好，部署时加 `-i ~/.ssh/id_ed25519_deploy`）
部署目录：`/opt/poker-online/`
重启命令：`cd /opt/poker-online && pm2 restart poker-online`
验证：`curl -s -o /dev/null -w '%{http_code}' http://localhost:3000`（应返回 200）
部署流程：scp 传文件 → SSH 执行 pm2 restart，示例：
```bash
scp -i ~/.ssh/id_ed25519_deploy public/index.html root@47.106.206.100:/opt/poker-online/public/index.html
ssh -i ~/.ssh/id_ed25519_deploy root@47.106.206.100 "cd /opt/poker-online && pm2 restart poker-online"
```
域名：用户正在阿里云注册域名（审核中），后续需配 Nginx + Let's Encrypt SSL 以实现 HTTPS（解决浏览器麦克风权限要求安全上下文的问题）。当前通过 `http://47.106.206.100:3000` 访问。

### WebSocket 协议

客户端 → 服务端：auth / user:register / user:login / user:tokenLogin / user:profile / user:guest / user:checkin / user:checkinInfo / user:setAvatar / room:create / room:join / room:leave / room:start / room:ready / room:list / room:botGame / room:spectate / room:interact / game:action / game:nextHand / stats:get / voice:join / voice:leave / voice:offer / voice:answer / voice:ice-candidate
服务端 → 客户端：auth:ok / user:registered / user:loggedIn / user:profile / user:checkin / user:checkinInfo / user:avatarUpdated / user:achievement / user:error / room:created / room:joined / room:state / room:players / room:playerJoined / room:playerLeft / room:ready / room:interact / room:error / room:left / room:destroyed / room:list / game:started / game:state / game:action / game:finished / game:hand-result / game:waitingForNext / stats:data / voice:*

### 前端关键结构（index.html）

页面/屏幕：#lobbyScreen（首页大厅）→ #createRoomScreen（创建房间页）→ #roomScreen（等待房间）→ #table-container（游戏桌面）
大厅功能按钮：💰筹码余额 / 📅签到 / 😊换装 / 🎰场景 / 🔮占卜 / 🏆排行榜 / 📖教程
JS 工具函数：`$(id)` 获取元素，`showScreen(id)` 切换屏幕，`toast(msg)` 弹提示，`showError(msg)` 显示错误
语音：VoiceChat 模块（IIFE），基于 WebRTC P2P + WebSocket 信令
音效：Web Audio API 合成（无外部音频文件）
背景音乐：BGMusic 模块，Web Audio API 合成赌场氛围音乐（和弦进行 Cmaj7→Am7→Fmaj7→G7）
语音播报：Web Speech API (TTS)
成就：20 个成就定义，JSON 文件持久化

---

### 已实现功能清单

**P1 — 核心游戏体验（已部署 ✅）**

1. ✅ **45 秒操作倒计时**：SVG 圆环倒计时，≤5s 脉冲警告，超时服务端自动弃牌（game.js 45000ms timeout）
2. ✅ **不自动开下一手**：一手结束后显示 #nextHandBar，15s 倒计时，房主可点"立即开始"跳过（game:nextHand）
3. ✅ **赢家结算画面**：#settlementOverlay 全屏 overlay 展示赢家信息（皇冠+牌型+金额），8s 自动关闭
4. ✅ **手机预设加注九宫格**：移动端显示 50/100/200/500/1K/2K/5K/ALL IN/自定义 按钮网格，隐藏滑条
5. ✅ **手机横屏模式**：@media (max-height:500px) and (orientation:landscape) 紧凑布局
6. ✅ **局内退出按钮**：#gameExitBtn 左上角 ✕ 按钮，发送 room:leave

**P2 — UI/交互增强（已部署 ✅）**

7. ✅ **背景音乐**：BGMusic 模块，Web Audio 合成，🎵 开关按钮，localStorage 记忆状态
8. ✅ **筹码飞行动画**：跟注/加注/All-in 时 .flying-chip 元素飞向底池（CSS @keyframes chipFly）
9. ✅ **玩家间互动**：座位 😊 触发按钮 → #interactPanel（🌹送花/💰送筹码/🍺敬酒/👏鼓掌/😂嘲笑/🎉庆祝）→ room:interact WebSocket 消息 → spawnGiftFly 动画

**P3 — 系统功能（已部署 ✅）**

10. ✅ **每日签到 + 筹码经济**：
    - 服务端：userStore.js 新增 chips（初始1000）/lastCheckin/checkinStreak 字段
    - 连续签到 7 天奖励递增：50/80/100/150/200/300/500
    - 客户端：大厅显示 💰筹码余额 + 📅签到按钮，登录后自动弹出签到弹窗
    - 个人中心显示筹码余额
11. ✅ **角色换装 + 座位头像**：
    - 18 个头像 emoji + 12 个颜色可选
    - 选择保存到 userStore（avatar + avatarColor 字段）
    - 游戏中座位显示自定义头像和颜色（替代默认的索引分配）
    - 房间等待界面也显示头像

**P4 — 大型功能（已部署 ✅）**

12. ✅ **10 个赌桌场景**：CSS 变量主题切换
    - 经典绿毡 / 澳门永利 / 拉斯维加斯 / 摩纳哥 / 地下赌场 / 大西洋城 / 私人会所 / 皇家赌场 / 太空舱 / 竹林雅室
    - 大厅 🎰场景 按钮打开选择器，选中后立即应用到牌桌
13. ✅ **占卜模块（水晶球）**：输入问题 → 水晶球脉冲动画 → 随机 24 条运势
14. ✅ **塔罗牌**：22 张大阿尔卡纳牌组，抽 3 张（过去/现在/未来），逐张翻牌动画 + 解读

### 待处理事项

1. **HTTPS 配置**：域名审核通过后，配置 Nginx + Let's Encrypt SSL，解决 getUserMedia 麦克风权限问题
2. **语音引导修复**：TTS 播报需要 HTTPS + 用户交互后才能播放，移动端可能需要额外处理
3. **语音聊天**：WebRTC 的 getUserMedia 要求安全上下文（HTTPS），当前 HTTP 下不可用
4. **局内排行榜侧边栏**：游戏进行中可查看实时排行榜（stats:get 协议已有，前端未做侧边栏 UI）
5. **筹码与游戏联动**：当前签到获得筹码，但游戏输赢尚未与用户筹码余额联动（只是房间内的虚拟筹码）

### 注意事项

- 前端是单文件 3000+ 行，修改时注意不要引入重复 ID，改完后用 `grep -oP 'id="[^"]*"' file | sort | uniq -d` 检查
- 所有新屏幕需要加入 showScreen() 的管理（`.screen` class）
- WebSocket 新增消息类型需要同时改 server/index.js 的路由和前端的事件监听
- 手机端测试用 Chrome DevTools 的 Device Mode
- HTTPS 配好后语音聊天才能正常工作（getUserMedia 要求安全上下文）
- Task 子代理容易改错文件路径，建议直接编辑而非使用子代理
