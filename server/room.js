/**
 * Room Manager - handles room lifecycle, player assignment, and game orchestration
 */

const { Game, START_STACK } = require('./game');
const crypto = require('crypto');

const ROOM_RESUME_TTL = 30 * 60 * 1000;

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

    this.players = new Map();
    this.spectators = new Map();
    this.game = null;
    this.gameRunning = false;
    this.handNum = 0;
    this.autoStartTimer = null;
    this.nextHandTimer = null;
    this.lastVacantAt = null;

    this.addPlayer(hostId, hostName, hostWs);
  }

  addPlayer(id, name, ws) {
    if (this.players.size >= this.maxPlayers) return false;
    if (this.players.has(id)) return false;

    this.lastVacantAt = null;
    this.spectators.delete(id);

    this.players.set(id, {
      id,
      name,
      ws,
      stack: this.startStack,
      ready: false,
      connected: true,
      _username: ws._username || null,
      avatar: ws._playerAvatar || 'A',
      avatarColor: ws._playerColor || null,
    });

    this.broadcast('room:playerJoined', {
      playerId: id,
      name,
      playerCount: this.players.size,
      maxPlayers: this.maxPlayers,
    });

    ws.send(JSON.stringify({
      type: 'room:state',
      data: { code: this.code, hostId: this.hostId, gameRunning: this.gameRunning },
    }));

    this.broadcastPlayerList();
    return true;
  }

  addSpectator(id, name, ws) {
    this.lastVacantAt = null;

    if (this.spectators.has(id)) {
      const spec = this.spectators.get(id);
      if (spec.ws && spec.ws !== ws && spec.ws.readyState === 1) {
        try { spec.ws.close(); } catch {}
      }
      spec.ws = ws;
      spec.name = name;
      spec.connected = true;
      spec._username = ws._username || spec._username || null;
      this.sendSpectatorState(id, ws);
      this.broadcastPlayerList();
      return true;
    }

    this.spectators.set(id, {
      id,
      name,
      ws,
      connected: true,
      _username: ws._username || null,
    });

    this.broadcast('room:spectatorJoined', {
      playerId: id,
      name,
      spectatorCount: this.spectators.size,
    });
    this.broadcastPlayerList();
    this.sendSpectatorState(id, ws);
    return true;
  }

  removeSpectator(id) {
    const spec = this.spectators.get(id);
    if (!spec) return;
    this.spectators.delete(id);
    this.broadcast('room:spectatorLeft', {
      playerId: id,
      name: spec.name,
      spectatorCount: this.spectators.size,
    });
    this.broadcastPlayerList();
    this._markVacantIfNeeded();
  }

  sendSpectatorState(id, ws) {
    ws.send(JSON.stringify({
      type: 'room:state',
      data: { code: this.code, hostId: this.hostId, gameRunning: this.gameRunning, isSpectator: true },
    }));

    const players = [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      stack: p.stack,
      ready: p.ready,
      connected: p.connected,
      avatar: p.avatar || 'A',
      avatarColor: p.avatarColor || null,
    }));
    const spectators = [...this.spectators.values()].map((s) => ({ id: s.id, name: s.name }));
    ws.send(JSON.stringify({ type: 'room:players', data: { players, spectators, hostId: this.hostId } }));

    if (this.game && this.gameRunning) {
      const state = this.game.getStateForSpectator();
      ws.send(JSON.stringify({ type: 'game:state', data: state }));
    }
  }

  disconnectPlayer(id) {
    const player = this.players.get(id);
    if (!player) return false;

    player.connected = false;

    if (this.game && this.gameRunning) {
      this.game.handleDisconnect(id);
    }

    this.broadcast('room:playerDisconnected', {
      playerId: id,
      name: player.name,
      playerCount: this.players.size,
    });
    this.broadcastPlayerList();
    this._markVacantIfNeeded();
    return true;
  }

  removePlayer(id) {
    const player = this.players.get(id);
    if (!player) return false;

    this.players.delete(id);

    if (this.game && this.gameRunning) {
      this.game.handleDisconnect(id);
    }

    this.broadcast('room:playerLeft', {
      playerId: id,
      name: player.name,
      playerCount: this.players.size,
    });

    if (this.hostId === id && this.players.size > 0) {
      const first = this.players.values().next().value;
      this.hostId = first.id;
      this.broadcast('room:hostChanged', { hostId: this.hostId });
      if (first.ws && first.ws.readyState === 1) {
        first.ws.send(JSON.stringify({
          type: 'room:state',
          data: { code: this.code, hostId: this.hostId, gameRunning: this.gameRunning },
        }));
      }
    }

    this.broadcastPlayerList();
    this._markVacantIfNeeded();
    return true;
  }

  handleReconnect(id, ws) {
    const player = this.players.get(id);
    if (!player) return false;

    if (player.ws && player.ws !== ws && player.ws.readyState === 1) {
      try { player.ws.close(); } catch {}
    }

    player.ws = ws;
    player.connected = true;
    player.name = ws.playerName || player.name;
    player._username = ws._username || player._username || null;
    player.avatar = ws._playerAvatar || player.avatar;
    player.avatarColor = ws._playerColor || player.avatarColor || null;
    this.lastVacantAt = null;

    ws.send(JSON.stringify({
      type: 'room:state',
      data: { code: this.code, hostId: this.hostId, gameRunning: this.gameRunning },
    }));
    this.broadcastPlayerList();

    if (this.game && this.gameRunning) {
      this.game.handleReconnect(id, ws);
    }

    return true;
  }

  restoreUserSession(username, ws) {
    if (!username) return null;

    for (const player of this.players.values()) {
      if (player._username === username) {
        this.handleReconnect(player.id, ws);
        return {
          room: this,
          playerId: player.id,
          name: player.name,
          isSpectator: false,
        };
      }
    }

    for (const spectator of this.spectators.values()) {
      if (spectator._username === username) {
        this.addSpectator(spectator.id, spectator.name, ws);
        return {
          room: this,
          playerId: spectator.id,
          name: spectator.name,
          isSpectator: true,
        };
      }
    }

    return null;
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

    const connected = [...this.players.values()].filter((p) => p.connected);
    if (connected.length < 2) {
      this.sendTo(starterId, 'room:error', { message: '至少需要 2 名玩家' });
      return;
    }

    this.gameRunning = true;

    const gamePlayers = connected.map((p) => ({
      id: p.id,
      name: p.name,
      stack: p.stack,
      connected: true,
      _username: p._username || null,
      avatar: p.avatar || 'A',
      avatarColor: p.avatarColor || null,
    }));

    this.game = new Game(gamePlayers, {
      sb: this.sb,
      bb: this.bb,
      startStack: this.startStack,
      shortDeck: this.shortDeck,
      allInOrFold: this.allInOrFold,
      gameMode: this.gameMode,
    });
    this.game.handNum = this.handNum;

    this.game.onBroadcast = (type, data) => {
      if (type === 'game:state') return;
      this.broadcast(type, data);
    };

    this.game.broadcastState = () => {
      for (const p of this.game.players) {
        if (p._ws && p.connected && p._ws.readyState === 1) {
          const state = this.game.getStateForPlayer(p.id);
          p._ws.send(JSON.stringify({ type: 'game:state', data: state }));
        }
      }

      if (this.spectators.size > 0) {
        const specState = this.game.getStateForSpectator();
        const msg = JSON.stringify({ type: 'game:state', data: specState });
        for (const spectator of this.spectators.values()) {
          if (spectator.ws && spectator.ws.readyState === 1) spectator.ws.send(msg);
        }
      }
    };

    this.game.onGameEnd = () => {
      for (const gp of this.game.players) {
        const rp = this.players.get(gp.id);
        if (rp) rp.stack = gp.stack;
      }
      this.handNum = this.game.handNum;
      this.gameRunning = false;

      if (this.game.winners.length > 0 && this.onStatsReport) {
        this.onStatsReport(this.game);
      }

      this.broadcast('game:waitingForNext', { nextHandDelay: 15 });
      this.nextHandTimer = setTimeout(() => {
        if (this.players.size >= 2) this.startGame(this.hostId);
      }, 15000);
    };

    for (const gp of this.game.players) {
      const rp = this.players.get(gp.id);
      if (rp) gp._ws = rp.ws;
    }

    this.broadcast('room:gameStarted', {});
    this.game.startHand();
  }

  handlePlayerAction(playerId, actionData) {
    if (!this.game || !this.gameRunning) return;
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
    for (const player of this.players.values()) {
      if (player.ws && player.ws.readyState === 1) player.ws.send(msg);
    }
    for (const spectator of this.spectators.values()) {
      if (spectator.ws && spectator.ws.readyState === 1) spectator.ws.send(msg);
    }
  }

  broadcastPlayerList() {
    const players = [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      stack: p.stack,
      ready: p.ready,
      connected: p.connected,
      avatar: p.avatar || 'A',
      avatarColor: p.avatarColor || null,
    }));
    const spectators = [...this.spectators.values()].map((s) => ({
      id: s.id,
      name: s.name,
    }));
    this.broadcast('room:players', { players, spectators, hostId: this.hostId });
  }

  _markVacantIfNeeded() {
    const hasConnectedPlayers = [...this.players.values()].some((p) => p.connected);
    const hasConnectedSpectators = [...this.spectators.values()].some((s) => s.connected);
    if (hasConnectedPlayers || hasConnectedSpectators) {
      this.lastVacantAt = null;
      return;
    }
    if (!this.lastVacantAt) this.lastVacantAt = Date.now();
  }

  destroy() {
    if (this.autoStartTimer) clearTimeout(this.autoStartTimer);
    if (this.nextHandTimer) clearTimeout(this.nextHandTimer);
    if (this.game && this.game.actionTimeout) clearTimeout(this.game.actionTimeout);
    this.broadcast('room:destroyed', {});
    this.players.clear();
    this.spectators.clear();
    this.game = null;
    if (this._registry) {
      this._registry.rooms.delete(this.code);
    }
  }
}

class RoomRegistry {
  constructor() {
    this.rooms = new Map();
    this.playerRoom = new Map();
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
    room._registry = this;
    this.rooms.set(code, room);
    this.playerRoom.set(hostId, code);
    return room;
  }

  joinRoom(code, playerId, playerName, ws) {
    const room = this.rooms.get(code);
    if (!room) return { error: '房间不存在' };

    if (room.players.has(playerId)) {
      room.handleReconnect(playerId, ws);
      this.playerRoom.set(playerId, code);
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

    if (room.spectators.has(playerId)) {
      room.addSpectator(playerId, playerName, ws);
      this.playerRoom.set(playerId, code);
      return { room };
    }

    const ok = room.addSpectator(playerId, playerName, ws);
    if (!ok) return { error: '无法观战' };
    this.playerRoom.set(playerId, code);
    return { room };
  }

  restoreUserSession(username, ws) {
    for (const room of this.rooms.values()) {
      const restored = room.restoreUserSession(username, ws);
      if (restored) {
        this.playerRoom.set(restored.playerId, room.code);
        return restored;
      }
    }
    return null;
  }

  leaveRoom(playerId) {
    const code = this.playerRoom.get(playerId);
    if (!code) return;
    const room = this.rooms.get(code);
    if (room) {
      if (room.spectators.has(playerId)) {
        room.removeSpectator(playerId);
      } else {
        room.removePlayer(playerId);
      }
      if (room.players.size === 0 && room.spectators.size === 0) {
        room.destroy();
      }
    }
    this.playerRoom.delete(playerId);
  }

  getRoomForPlayer(playerId) {
    const code = this.playerRoom.get(playerId);
    return code ? this.rooms.get(code) : null;
  }

  getRoomList() {
    return [...this.rooms.values()].map((room) => ({
      code: room.code,
      playerCount: room.players.size,
      spectatorCount: room.spectators.size,
      maxPlayers: room.maxPlayers,
      gameRunning: room.gameRunning,
      hostName: room.players.get(room.hostId)?.name || 'Unknown',
      gameMode: room.gameMode || 'classic',
    }));
  }

  cleanup() {
    for (const [code, room] of this.rooms) {
      const hasConnectedPlayers = [...room.players.values()].some((p) => p.connected);
      const hasConnectedSpectators = [...room.spectators.values()].some((s) => s.connected);

      if (hasConnectedPlayers || hasConnectedSpectators) {
        room.lastVacantAt = null;
        continue;
      }

      if (!room.lastVacantAt) {
        room.lastVacantAt = Date.now();
        continue;
      }

      if (Date.now() - room.lastVacantAt >= ROOM_RESUME_TTL) {
        room.destroy();
        this.rooms.delete(code);
      }
    }
  }
}

module.exports = { Room, RoomRegistry, ROOM_RESUME_TTL };
