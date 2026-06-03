/**
 * Room Manager — handles room lifecycle, player assignment, and game orchestration
 */

const { Game, START_STACK } = require('./game');
const crypto = require('crypto');

// ===== Bot WebSocket Mock =====
class BotSocket {
  constructor() { this.readyState = 1; }
  send() { /* bots don't need to receive messages */ }
}

class Room {
  constructor(code, hostId, hostName, hostWs, options = {}) {
    this.code = code;
    this.hostId = hostId;
    this.createdAt = Date.now();
    this.maxPlayers = options.maxPlayers || 6;
    this.startStack = options.startStack || START_STACK;
    this.sb = options.sb || 10;
    this.bb = options.bb || 20;
    this.gameMode = options.gameMode || 'classic';
    this.shortDeck = options.shortDeck || false;
    this.allInOrFold = options.allInOrFold || false;

    this.players = new Map(); // id -> { id, name, ws, stack, ready }
    this.spectators = new Map(); // id -> { id, name, ws }
    this.game = null;
    this.gameRunning = false;
    this.autoStartTimer = null;
    this.nextHandTimer = null;
    this.destroyTimer = null; // Grace period timer for empty rooms

    // Add host
    this.addPlayer(hostId, hostName, hostWs);
  }

  addPlayer(id, name, ws) {
    if (this.players.size >= this.maxPlayers) return false;
    if (this.players.has(id)) return false;

    // Cancel destroy timer if room was empty
    if (this.destroyTimer) {
      clearTimeout(this.destroyTimer);
      this.destroyTimer = null;
    }

    // If was spectator, remove from spectators
    this.spectators.delete(id);

    this.players.set(id, {
      id, name, ws,
      stack: this.startStack,
      ready: false,
      connected: true,
      avatar: ws._playerAvatar || '🦊',
      avatarColor: ws._playerColor || null,
    });

    this.broadcast('room:playerJoined', {
      playerId: id, name,
      playerCount: this.players.size,
      maxPlayers: this.maxPlayers,
    });

    // Send current room state to the new player (fixes host rejoin bug)
    ws.send(JSON.stringify({
      type: 'room:state',
      data: { code: this.code, hostId: this.hostId, gameRunning: this.gameRunning }
    }));

    this.broadcastPlayerList();
    return true;
  }

  addBot(id, name, style) {
    if (this.players.size >= this.maxPlayers) return false;
    const botWs = new BotSocket();
    this.players.set(id, {
      id, name, ws: botWs,
      stack: this.startStack,
      ready: true,
      connected: true,
      isBot: true,
      botStyle: style,
    });

    this.broadcast('room:playerJoined', {
      playerId: id, name,
      playerCount: this.players.size,
      maxPlayers: this.maxPlayers,
      isBot: true,
    });
    this.broadcastPlayerList();
    return true;
  }

  addSpectator(id, name, ws) {
    if (this.spectators.has(id)) {
      // Reconnect
      const spec = this.spectators.get(id);
      spec.ws = ws;
      spec.connected = true;
      this.sendSpectatorState(id, ws);
      return true;
    }

    this.spectators.set(id, { id, name, ws, connected: true });

    this.broadcast('room:spectatorJoined', {
      playerId: id, name,
      spectatorCount: this.spectators.size,
    });
    this.broadcastPlayerList();

    // Send current state
    this.sendSpectatorState(id, ws);
    return true;
  }

  removeSpectator(id) {
    const spec = this.spectators.get(id);
    if (!spec) return;
    this.spectators.delete(id);
    this.broadcast('room:spectatorLeft', {
      playerId: id, name: spec.name,
      spectatorCount: this.spectators.size,
    });
    this.broadcastPlayerList();
  }

  sendSpectatorState(id, ws) {
    // Send room info
    ws.send(JSON.stringify({
      type: 'room:state',
      data: { code: this.code, hostId: this.hostId, gameRunning: this.gameRunning, isSpectator: true }
    }));
    // Send player list
    const players = [...this.players.values()].map(p => ({
      id: p.id, name: p.name, stack: p.stack, ready: p.ready, connected: p.connected,
      isBot: !!p.isBot, botStyle: p.botStyle || null,
      avatar: p.avatar || '🦊', avatarColor: p.avatarColor || null,
    }));
    const spectators = [...this.spectators.values()].map(s => ({ id: s.id, name: s.name }));
    ws.send(JSON.stringify({ type: 'room:players', data: { players, spectators, hostId: this.hostId } }));
    // If game running, send spectator game state
    if (this.game && this.gameRunning) {
      const state = this.game.getStateForSpectator();
      ws.send(JSON.stringify({ type: 'game:state', data: state }));
    }
  }

  removePlayer(id) {
    const player = this.players.get(id);
    if (!player) return;

    player.connected = false;
    this.players.delete(id);

    if (this.game && this.gameRunning) {
      this.game.handleDisconnect(id);
    }

    this.broadcast('room:playerLeft', {
      playerId: id, name: player.name,
      playerCount: this.players.size,
    });

    // Host reassignment MUST happen before broadcast and grace period check
    if (this.hostId === id && this.players.size > 0) {
      const first = this.players.values().next().value;
      this.hostId = first.id;
      // Send hostChanged to all (including new host)
      this.broadcast('room:hostChanged', { hostId: this.hostId });
      // Also send room:state to new host so their UI updates
      if (first.ws && first.ws.readyState === 1) {
        first.ws.send(JSON.stringify({
          type: 'room:state',
          data: { code: this.code, hostId: this.hostId, gameRunning: this.gameRunning }
        }));
      }
    }

    this.broadcastPlayerList();

    // Grace period: don't destroy immediately, wait 5 minutes for reconnection
    if (this.players.size === 0 && this.spectators.size === 0) {
      if (!this.destroyTimer) {
        this.destroyTimer = setTimeout(() => {
          if (this.players.size === 0 && this.spectators.size === 0) {
            this.destroy();
          }
        }, 300000); // 5 minutes
      }
      return true;
    }

    return true;
  }

  handleReconnect(id, ws) {
    const player = this.players.get(id);
    if (!player) return false;

    player.ws = ws;
    player.connected = true;

    // Send room state
    ws.send(JSON.stringify({
      type: 'room:state',
      data: { code: this.code, hostId: this.hostId, gameRunning: this.gameRunning }
    }));
    this.broadcastPlayerList();

    // If game is running, reconnect to game
    if (this.game && this.gameRunning) {
      this.game.handleReconnect(id, ws);
    }

    return true;
  }

  setReady(id, ready) {
    const player = this.players.get(id);
    if (!player || this.gameRunning) return;
    player.ready = ready;
    this.broadcastPlayerList();
  }

  startGame(starterId) {
    if (this.gameRunning) return;
    if (starterId !== this.hostId) return;

    const connected = [...this.players.values()].filter(p => p.connected);
    if (connected.length < 2) {
      this.sendTo(starterId, 'room:error', { message: '至少需要2名玩家' });
      return;
    }

    this.gameRunning = true;

    // Create game with connected players
    const gamePlayers = connected.map(p => ({
      id: p.id,
      name: p.name,
      stack: p.stack,
      connected: true,
      isBot: !!p.isBot,
      botStyle: p.botStyle || null,
      _username: p._username || null,
      avatar: p.avatar || '🦊',
      avatarColor: p.avatarColor || null,
    }));

    this.game = new Game(gamePlayers, {
      sb: this.sb, bb: this.bb, startStack: this.startStack,
      shortDeck: this.shortDeck, allInOrFold: this.allInOrFold,
      gameMode: this.gameMode,
    });

    // Wire up game callbacks
    this.game.onBroadcast = (type, data) => {
      // Broadcast to players (each gets their own filtered state for game:state)
      if (type === 'game:state') return; // handled separately in broadcastState
      this.broadcast(type, data);
    };

    // Override broadcastState to include spectators
    const origBroadcastState = this.game.broadcastState.bind(this.game);
    this.game.broadcastState = () => {
      // Send filtered state to each player
      for (const p of this.game.players) {
        if (p._ws && p.connected && p._ws.readyState === 1) {
          const state = this.game.getStateForPlayer(p.id);
          p._ws.send(JSON.stringify({ type: 'game:state', data: state }));
        }
      }
      // Send spectator state (no hole cards)
      if (this.spectators.size > 0) {
        const specState = this.game.getStateForSpectator();
        const msg = JSON.stringify({ type: 'game:state', data: specState });
        for (const [, s] of this.spectators) {
          if (s.ws && s.ws.readyState === 1) s.ws.send(msg);
        }
      }
    };

    this.game.onGameEnd = () => {
      for (const gp of this.game.players) {
        const rp = this.players.get(gp.id);
        if (rp) rp.stack = gp.stack;
      }
      this.gameRunning = false;

      // Report stats
      if (this.game.winners.length > 0 && this.onStatsReport) {
        this.onStatsReport(this.game);
      }

      this.broadcast('game:waitingForNext', { nextHandDelay: 15 });
      this.nextHandTimer = setTimeout(() => {
        if (this.players.size >= 2) this.startGame(this.hostId);
      }, 15000);
    };

    // Wire up player websockets
    for (const gp of this.game.players) {
      const rp = this.players.get(gp.id);
      if (rp) gp._ws = rp.ws;
    }

    this.broadcast('room:gameStarted', {});
    this.game.startHand();
  }

  startBotGame(bots) {
    // Add bots to room
    for (const bot of bots) {
      this.addBot(bot.id, bot.name, bot.style);
    }
    // Auto-start (host starts)
    setTimeout(() => this.startGame(this.hostId), 800);
  }

  handlePlayerAction(playerId, actionData) {
    if (!this.game || !this.gameRunning) return;
    // Spectators cannot perform actions
    if (this.spectators.has(playerId)) return;
    this.game.handleAction(playerId, actionData);
  }

  sendTo(playerId, type, data) {
    const player = this.players.get(playerId);
    if (player && player.ws && player.ws.readyState === 1) {
      player.ws.send(JSON.stringify({ type, data }));
    }
  }

  broadcast(type, data = {}) {
    const msg = JSON.stringify({ type, data });
    for (const [, p] of this.players) {
      if (p.ws && p.ws.readyState === 1) p.ws.send(msg);
    }
    // Also broadcast to spectators
    for (const [, s] of this.spectators) {
      if (s.ws && s.ws.readyState === 1) s.ws.send(msg);
    }
  }

  broadcastPlayerList() {
    const players = [...this.players.values()].map(p => ({
      id: p.id, name: p.name, stack: p.stack, ready: p.ready, connected: p.connected,
      isBot: !!p.isBot, botStyle: p.botStyle || null,
      avatar: p.avatar || '🦊', avatarColor: p.avatarColor || null,
    }));
    const spectators = [...this.spectators.values()].map(s => ({
      id: s.id, name: s.name,
    }));
    this.broadcast('room:players', { players, spectators, hostId: this.hostId });
  }

  destroy() {
    if (this.autoStartTimer) clearTimeout(this.autoStartTimer);
    if (this.nextHandTimer) clearTimeout(this.nextHandTimer);
    if (this.destroyTimer) clearTimeout(this.destroyTimer);
    if (this.game && this.game.actionTimeout) clearTimeout(this.game.actionTimeout);
    this.broadcast('room:destroyed', {});
    this.players.clear();
    this.spectators.clear();
    this.game = null;
    // Remove self from registry
    if (this._registry) {
      this._registry.rooms.delete(this.code);
    }
  }
}

// ===== Room Registry =====
class RoomRegistry {
  constructor() {
    this.rooms = new Map(); // code -> Room
    this.playerRoom = new Map(); // playerId -> roomCode
  }

  generateCode() {
    let code;
    do {
      code = crypto.randomBytes(3).toString('hex').toUpperCase();
    } while (this.rooms.has(code));
    return code;
  }

  createRoom(hostId, hostName, hostWs, options = {}) {
    const code = this.generateCode();
    const room = new Room(code, hostId, hostName, hostWs, options);
    room._registry = this; // Allow room to clean itself from registry on destroy
    this.rooms.set(code, room);
    this.playerRoom.set(hostId, code);
    return room;
  }

  joinRoom(code, playerId, playerName, ws) {
    const room = this.rooms.get(code);
    if (!room) return { error: '房间不存在' };

    // Check if player is reconnecting
    if (room.players.has(playerId)) {
      room.handleReconnect(playerId, ws);
      return { room };
    }

    if (room.players.size >= room.maxPlayers) return { error: '房间已满' };

    const ok = room.addPlayer(playerId, playerName, ws);
    if (!ok) return { error: '无法加入房间' };
    this.playerRoom.set(playerId, code);
    return { room };
  }

  spectateRoom(code, playerId, playerName, ws) {
    const room = this.rooms.get(code);
    if (!room) return { error: '房间不存在' };

    // Check if already a spectator (reconnect)
    if (room.spectators.has(playerId)) {
      room.addSpectator(playerId, playerName, ws);
      return { room };
    }

    const ok = room.addSpectator(playerId, playerName, ws);
    if (!ok) return { error: '无法观战' };
    this.playerRoom.set(playerId, code);
    return { room };
  }

  leaveRoom(playerId) {
    const code = this.playerRoom.get(playerId);
    if (!code) return;
    const room = this.rooms.get(code);
    if (room) {
      // Check if spectator
      if (room.spectators.has(playerId)) {
        room.removeSpectator(playerId);
        // Spectators don't trigger grace period — delete if empty
        if (room.players.size === 0 && room.spectators.size === 0) {
          this.rooms.delete(code);
        }
      } else {
        // removePlayer() starts the grace period timer if room becomes empty
        // Don't delete from registry here — let the grace period handle it
        room.removePlayer(playerId);
      }
    }
    this.playerRoom.delete(playerId);
  }

  getRoomForPlayer(playerId) {
    const code = this.playerRoom.get(playerId);
    return code ? this.rooms.get(code) : null;
  }

  getRoomList() {
    return [...this.rooms.values()].map(r => {
      const botCount = [...r.players.values()].filter(p => p.isBot).length;
      return {
        code: r.code,
        playerCount: r.players.size,
        spectatorCount: r.spectators.size,
        maxPlayers: r.maxPlayers,
        gameRunning: r.gameRunning,
        hostName: r.players.get(r.hostId)?.name || 'Unknown',
        hasBots: botCount > 0,
        botCount,
        gameMode: r.gameMode || 'classic',
      };
    });
  }

  // Cleanup stale rooms (called periodically)
  cleanup() {
    for (const [code, room] of this.rooms) {
      const hasConnected = [...room.players.values()].some(p => p.connected);
      if (!hasConnected) {
        room.destroy();
        this.rooms.delete(code);
      }
    }
  }
}

module.exports = { Room, RoomRegistry };
