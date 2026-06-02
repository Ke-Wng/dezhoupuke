/**
 * Texas Hold'em Online — WebSocket Server
 *
 * Protocol:
 *   Client → Server:
 *     { type: 'auth',         data: { playerId, name } }
 *     { type: 'room:create',  data: { name, options } }
 *     { type: 'room:join',    data: { code, name } }
 *     { type: 'room:leave' }
 *     { type: 'room:start' }
 *     { type: 'room:ready',   data: { ready } }
 *     { type: 'room:list' }
 *     { type: 'game:action',  data: { action, amount } }
 *
 *   Server → Client:
 *     { type: 'auth:ok',           data: { playerId } }
 *     { type: 'room:created',      data: { code } }
 *     { type: 'room:joined',       data: { code } }
 *     { type: 'room:state',        data: { code, hostId, gameRunning } }
 *     { type: 'room:players',      data: { players, hostId } }
 *     { type: 'room:playerJoined', data: { playerId, name, playerCount, maxPlayers } }
 *     { type: 'room:playerLeft',   data: { playerId, name, playerCount } }
 *     { type: 'room:hostChanged',  data: { hostId } }
 *     { type: 'room:gameStarted' }
 *     { type: 'room:list',         data: { rooms } }
 *     { type: 'room:error',        data: { message } }
 *     { type: 'room:destroyed' }
 *     { type: 'game:state',        data: { ...fullGameState } }
 *     { type: 'game:handStart',    data: { handNum } }
 *     { type: 'game:yourTurn',     data: { playerId, toCall, minRaise, maxRaise, pot } }
 *     { type: 'game:showdown',     data: { winners } }
 *     { type: 'game:handEnd',      data: { winners } }
 *     { type: 'error',             data: { message } }
 */

const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { RoomRegistry } = require('./room');
const { evaluateHand: evaluateForStats } = require('./game');

// ===== Config =====
const PORT = process.env.PORT || 3000;
const STATIC_DIR = path.join(__dirname, '..', 'public');

// ===== Leaderboard Stats =====
class StatsTracker {
  constructor() {
    this.stats = new Map(); // name -> stats
  }

  record(playerName, data) {
    if (!this.stats.has(playerName)) {
      this.stats.set(playerName, {
        name: playerName,
        handsPlayed: 0, handsWon: 0,
        totalWon: 0, totalLost: 0,
        biggestPot: 0, bestHand: '', bestHandRank: -1,
        allIns: 0, firstSeen: Date.now(), lastSeen: Date.now(),
      });
    }
    const s = this.stats.get(playerName);
    s.handsPlayed++;
    s.lastSeen = Date.now();
    if (data.won) {
      s.handsWon++;
      s.totalWon += data.amount;
      if (data.amount > s.biggestPot) s.biggestPot = data.amount;
    }
    if (data.handRank > s.bestHandRank) {
      s.bestHandRank = data.handRank;
      s.bestHand = data.handName;
    }
    if (data.allIn) s.allIns++;
  }

  getLeaderboard(sortBy = 'totalWon', limit = 20) {
    const list = [...this.stats.values()];
    list.sort((a, b) => (b[sortBy] || 0) - (a[sortBy] || 0));
    return list.slice(0, limit).map((s, i) => ({
      rank: i + 1,
      name: s.name,
      handsPlayed: s.handsPlayed,
      handsWon: s.handsWon,
      winRate: s.handsPlayed > 0 ? Math.round(s.handsWon / s.handsPlayed * 100) : 0,
      totalWon: s.totalWon,
      biggestPot: s.biggestPot,
      bestHand: s.bestHand || '-',
      allIns: s.allIns,
    }));
  }
}

const stats = new StatsTracker();

// ===== HTTP Server (serves static files) =====
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

const httpServer = http.createServer((req, res) => {
  let url = req.url.split('?')[0];
  if (url === '/') url = '/index.html';

  const filePath = path.join(STATIC_DIR, url);

  // Security: prevent directory traversal
  if (!filePath.startsWith(STATIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

// ===== WebSocket Server =====
const wss = new WebSocketServer({ server: httpServer });
const registry = new RoomRegistry();
const playerSockets = new Map(); // playerId -> ws

// Periodic cleanup of stale rooms
setInterval(() => registry.cleanup(), 60000);

wss.on('connection', (ws) => {
  let playerId = null;
  let currentRoom = null;

  // Send heartbeat
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ type: 'error', data: { message: '无效的消息格式' } }));
      return;
    }

    const { type, data = {} } = msg;

    switch (type) {
      // ===== Authentication =====
      case 'auth': {
        playerId = data.playerId || crypto.randomUUID();
        const name = data.name || `玩家${playerId.slice(0, 4)}`;
        playerSockets.set(playerId, ws);
        ws.playerId = playerId;
        ws.playerName = name;
        ws.send(JSON.stringify({ type: 'auth:ok', data: { playerId, name } }));
        break;
      }

      // ===== Room: List =====
      case 'room:list': {
        const rooms = registry.getRoomList();
        ws.send(JSON.stringify({ type: 'room:list', data: { rooms } }));
        break;
      }

      // ===== Room: Create =====
      case 'room:create': {
        if (!playerId) { ws.send(JSON.stringify({ type: 'error', data: { message: '请先认证' } })); break; }

        if (currentRoom) registry.leaveRoom(playerId);

        const name = data.name || ws.playerName;
        const room = registry.createRoom(playerId, name, ws, data.options);
        currentRoom = room;

        // Wire up stats reporting
        room.onStatsReport = (game) => {
          const HAND_NAMES = ['高牌','一对','两对','三条','顺子','同花','葫芦','四条','同花顺','皇家同花顺'];
          for (const gp of game.players) {
            const won = game.winners.some(w => w.id === gp.id);
            const winData = game.winners.find(w => w.id === gp.id);
            let handRank = -1, handName = '';
            if (gp.hand.length === 2 && game.community.length >= 3 && !gp.folded) {
              try {
                const ev = evaluateForStats([...gp.hand, ...game.community]);
                handRank = ev.rank;
                handName = ev.name;
              } catch {}
            }
            stats.record(gp.name, {
              won,
              amount: won ? (winData?.amount || 0) : 0,
              handRank,
              handName,
              allIn: gp.lastAction === 'allin' || gp.allIn,
            });
          }
        };

        ws.send(JSON.stringify({ type: 'room:created', data: { code: room.code } }));
        room.broadcastPlayerList();
        break;
      }

      // ===== Room: Join =====
      case 'room:join': {
        if (!playerId) { ws.send(JSON.stringify({ type: 'error', data: { message: '请先认证' } })); break; }

        const code = (data.code || '').toUpperCase().trim();
        if (!code) { ws.send(JSON.stringify({ type: 'room:error', data: { message: '请输入房间号' } })); break; }

        // Leave current room if any
        if (currentRoom) registry.leaveRoom(playerId);

        const name = data.name || ws.playerName;
        const result = registry.joinRoom(code, playerId, name, ws);

        if (result.error) {
          ws.send(JSON.stringify({ type: 'room:error', data: { message: result.error } }));
        } else {
          currentRoom = result.room;
          ws.send(JSON.stringify({ type: 'room:joined', data: { code } }));
        }
        break;
      }

      // ===== Room: Spectate =====
      case 'room:spectate': {
        if (!playerId) { ws.send(JSON.stringify({ type: 'error', data: { message: '请先认证' } })); break; }

        const code = (data.code || '').toUpperCase().trim();
        if (!code) { ws.send(JSON.stringify({ type: 'room:error', data: { message: '请输入房间号' } })); break; }

        if (currentRoom) registry.leaveRoom(playerId);

        const name = data.name || ws.playerName;
        const result = registry.spectateRoom(code, playerId, name, ws);

        if (result.error) {
          ws.send(JSON.stringify({ type: 'room:error', data: { message: result.error } }));
        } else {
          currentRoom = result.room;
          ws.isSpectator = true;
          ws.send(JSON.stringify({ type: 'room:joined', data: { code, isSpectator: true } }));
        }
        break;
      }

      // ===== Stats: Get Leaderboard =====
      case 'stats:get': {
        const sortBy = data.sortBy || 'totalWon';
        const limit = data.limit || 20;
        const leaderboard = stats.getLeaderboard(sortBy, limit);
        ws.send(JSON.stringify({ type: 'stats:leaderboard', data: { leaderboard, sortBy } }));
        break;
      }

      // ===== Room: Leave =====
      case 'room:leave': {
        if (playerId && currentRoom) {
          registry.leaveRoom(playerId);
          currentRoom = null;
          ws.send(JSON.stringify({ type: 'room:left', data: {} }));
        }
        break;
      }

      // ===== Room: Start =====
      case 'room:start': {
        if (!currentRoom) break;
        currentRoom.startGame(playerId);
        break;
      }

      // ===== Room: Bot Game =====
      case 'room:botGame': {
        if (!playerId) { ws.send(JSON.stringify({ type: 'error', data: { message: '请先认证' } })); break; }

        if (currentRoom) registry.leaveRoom(playerId);

        const name = data.name || ws.playerName;
        const difficulty = data.difficulty || 'medium';
        const room = registry.createRoom(playerId, name, ws);
        currentRoom = room;

        // Wire up stats reporting
        room.onStatsReport = (game) => {
          const HAND_NAMES_STATS = ['高牌','一对','两对','三条','顺子','同花','葫芦','四条','同花顺','皇家同花顺'];
          for (const gp of game.players) {
            const won = game.winners.some(w => w.id === gp.id);
            const winData = game.winners.find(w => w.id === gp.id);
            let handRank = -1, handName = '';
            if (gp.hand.length === 2 && game.community.length >= 3 && !gp.folded) {
              try {
                const ev = evaluateForStats([...gp.hand, ...game.community]);
                handRank = ev.rank;
                handName = ev.name;
              } catch {}
            }
            stats.record(gp.name, {
              won,
              amount: won ? (winData?.amount || 0) : 0,
              handRank,
              handName,
              allIn: gp.lastAction === 'allin' || gp.allIn,
            });
          }
        };

        ws.send(JSON.stringify({ type: 'room:created', data: { code: room.code, isBotGame: true } }));
        room.broadcastPlayerList();

        // Bot presets by difficulty
        const botConfigs = {
          easy: [
            { id: crypto.randomUUID(), name: '小萌', style: 'lap' },
            { id: crypto.randomUUID(), name: '阿呆', style: 'rock' },
            { id: crypto.randomUUID(), name: '菜鸟', style: 'lap' },
          ],
          medium: [
            { id: crypto.randomUUID(), name: '老张', style: 'tag' },
            { id: crypto.randomUUID(), name: '小李', style: 'lap' },
            { id: crypto.randomUUID(), name: '王哥', style: 'rock' },
          ],
          hard: [
            { id: crypto.randomUUID(), name: '赌神', style: 'tag' },
            { id: crypto.randomUUID(), name: '狂人', style: 'maniac' },
            { id: crypto.randomUUID(), name: '铁壁', style: 'tag' },
          ],
        };

        const bots = botConfigs[difficulty] || botConfigs.medium;
        room.startBotGame(bots);
        break;
      }

      // ===== Room: Ready =====
      case 'room:ready': {
        if (!currentRoom) break;
        currentRoom.setReady(playerId, !!data.ready);
        break;
      }

      // ===== Game: Action =====
      case 'game:action': {
        if (!currentRoom) break;
        currentRoom.handlePlayerAction(playerId, data);
        break;
      }

      // ===== Voice Chat Signaling =====
      case 'voice:join': {
        if (!currentRoom) break;
        // Notify all other players that this player joined voice
        currentRoom.routeVoiceSignal(playerId, 'voice:join', data);
        break;
      }
      case 'voice:leave': {
        if (!currentRoom) break;
        currentRoom.routeVoiceSignal(playerId, 'voice:leave', data);
        break;
      }
      case 'voice:offer': {
        if (!currentRoom) break;
        currentRoom.routeVoiceSignal(playerId, 'voice:offer', data);
        break;
      }
      case 'voice:answer': {
        if (!currentRoom) break;
        currentRoom.routeVoiceSignal(playerId, 'voice:answer', data);
        break;
      }
      case 'voice:ice-candidate': {
        if (!currentRoom) break;
        currentRoom.routeVoiceSignal(playerId, 'voice:ice-candidate', data);
        break;
      }

      default:
        ws.send(JSON.stringify({ type: 'error', data: { message: `未知消息类型: ${type}` } }));
    }
  });

  ws.on('close', () => {
    if (playerId) {
      // Notify others that this player left voice
      if (currentRoom) {
        currentRoom.routeVoiceSignal(playerId, 'voice:leave', {});
      }
      playerSockets.delete(playerId);
      if (currentRoom) {
        if (ws.isSpectator) {
          currentRoom.removeSpectator(playerId);
        } else {
          // removePlayer handles: game disconnect, broadcast, host reassignment, grace period
          currentRoom.removePlayer(playerId);
        }
      }
    }
  });

  ws.on('error', (err) => {
    console.error(`WebSocket error for ${playerId}:`, err.message);
  });
});

// Heartbeat: detect dead connections
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      console.log(`Terminating dead connection: ${ws.playerId}`);
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeatInterval));

// ===== Start =====
httpServer.listen(PORT, () => {
  console.log(`
  ┌─────────────────────────────────────────────┐
  │                                             │
  │   🃏  德州扑克 Online Server               │
  │                                             │
  │   HTTP:  http://localhost:${PORT}             │
  │   WS:    ws://localhost:${PORT}              │
  │                                             │
  │   Static files: ${STATIC_DIR}
  │                                             │
  └─────────────────────────────────────────────┘
  `);
});

module.exports = { httpServer, wss };
