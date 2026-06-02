# 德州扑克 Online

WebSocket 多人联机德州扑克，服务端权威架构。

## 快速启动

```bash
# 1. 安装依赖
npm install

# 2. 启动服务
npm start

# 3. 打开浏览器
# http://localhost:3000
```

多个浏览器标签页/设备打开同一地址即可联机。

## 项目结构

```
poker-online/
├── server/
│   ├── index.js      # HTTP + WebSocket 服务入口
│   ├── game.js       # 德州扑克游戏引擎（服务端权威）
│   └── room.js       # 房间管理（创建/加入/生命周期）
├── public/
│   └── index.html    # 客户端（大厅 + 牌桌 UI + 网络层）
├── package.json
└── README.md
```

## 架构设计

### 服务端权威

所有游戏逻辑运行在服务端，客户端只负责渲染和发送操作指令。这防止了客户端作弊。

### 通信协议

**Client → Server:**
| 消息类型 | 数据 | 说明 |
|---------|------|------|
| `auth` | `{ name }` | 认证并获取 playerId |
| `room:create` | `{ name, options }` | 创建房间 |
| `room:join` | `{ code, name }` | 加入房间 |
| `room:leave` | - | 离开房间 |
| `room:start` | - | 房主开始游戏 |
| `room:ready` | `{ ready }` | 准备/取消 |
| `room:list` | - | 获取在线房间列表 |
| `game:action` | `{ action, amount }` | 执行操作（fold/check/call/raise/allin） |
| `voice:join` | `{ name }` | 加入语音聊天 |
| `voice:leave` | - | 离开语音 |
| `voice:offer` | `{ targetId, sdp }` | WebRTC SDP Offer |
| `voice:answer` | `{ targetId, sdp }` | WebRTC SDP Answer |
| `voice:ice-candidate` | `{ targetId, candidate }` | WebRTC ICE 候选 |

**Server → Client:**
| 消息类型 | 说明 |
|---------|------|
| `auth:ok` | 认证成功，返回 playerId |
| `room:created` | 房间创建成功，返回房间号 |
| `room:players` | 房间内玩家列表更新 |
| `room:gameStarted` | 游戏开始 |
| `game:state` | 完整游戏状态（按玩家过滤，隐藏他人手牌） |
| `game:yourTurn` | 轮到你了，附带可操作信息（仅发给当前玩家） |
| `game:handEnd` | 本手结束，公布赢家 |
| `voice:join` | 有玩家加入语音（含 fromId, fromName） |
| `voice:offer/answer/ice-candidate` | WebRTC 信令转发（含 fromId） |

### 房间系统

- 6位随机房间号，易于分享
- 支持 2~6 人
- 房主可开始游戏
- 断线自动检测，30秒超时自动弃牌
- 支持断线重连（5次重试，指数退避）
- 空房间自动清理

### 游戏引擎

- 完整德州扑克规则：翻牌前 → 翻牌 → 转牌 → 河牌 → 摊牌
- 盲注 10/20，初始筹码 2000
- 完整的牌型评估：高牌到皇家同花顺
- 支持 All-in 和边池
- 自动发牌、自动轮转

## 部署

### 本地开发

```bash
npm run dev   # 使用 --watch 自动重启
```

### 生产部署

```bash
# 设置端口
PORT=8080 npm start

# 使用 PM2 守护进程
npm install -g pm2
pm2 start server/index.js --name poker-online
pm2 save
```

### Docker 部署

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
EXPOSE 3000
CMD ["node", "server/index.js"]
```

```bash
docker build -t poker-online .
docker run -d -p 3000:3000 --name poker poker-online
```

### Nginx 反向代理（WebSocket 支持）

```nginx
server {
    listen 80;
    server_name poker.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 86400;
    }
}
```

## 微信小程序适配

如果要迁移到微信小程序，主要改动：

1. **前端**: 将 HTML/CSS 改为 WXML/WXSS，Canvas 渲染牌桌
2. **网络**: `new WebSocket()` 改为 `wx.connectSocket()`
3. **部署**: 服务器需要 HTTPS + 域名备案
4. **审核**: 只能用虚拟币，不能涉及真钱

核心游戏引擎 (`server/game.js`) 和房间管理 (`server/room.js`) 完全不需要改动，直接复用。

## 扩展方向

- [x] 音效和动画（发牌、翻牌、筹码、胜利粒子）
- [x] 排行榜和统计系统
- [x] 观战模式
- [x] AI 人机对战（4种风格 × 3种难度）
- [x] WebRTC P2P 语音聊天
- [x] 公开房间大厅 + 一键加入
- [x] 移动端适配 + 分享房间号
- [ ] 好友系统和私信
- [ ] 多种盲注级别
- [ ] 锦标赛模式
- [ ] 数据库持久化（MongoDB/PostgreSQL）
- [ ] Redis 做房间状态缓存（横向扩展）
