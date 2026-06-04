/**
 * Texas Hold'em Game Engine — Server-side authoritative
 * Handles all game logic: deck, hand evaluation, betting rounds, pot management
 */

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const RANK_VALUES = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14 };
const HAND_NAMES = ['高牌','一对','两对','三条','顺子','同花','葫芦','四条','同花顺','皇家同花顺'];
const gameLogger = require('./gameLogger');

const SB = 10;
const BB = 20;
const START_STACK = 2000;

// ===== Deck =====
function createDeck(shortDeck = false) {
  const d = [];
  const startRank = shortDeck ? 6 : 0; // Short deck: 6+ only
  for (let s = 0; s < 4; s++)
    for (let r = startRank; r < 13; r++)
      d.push({ suit: s, rank: r, rankStr: RANKS[r], suitStr: SUITS[s] });
  return d;
}

function shuffle(d) {
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

// ===== Hand Evaluation =====
function evaluateHand(cards) {
  const combos = getCombinations(cards, 5);
  let best = null;
  for (const combo of combos) {
    const r = evaluate5(combo);
    if (!best || compareEval(r, best) > 0) best = r;
  }
  return best;
}

function getCombinations(arr, k) {
  const result = [];
  function bt(start, current) {
    if (current.length === k) { result.push([...current]); return; }
    for (let i = start; i < arr.length; i++) {
      current.push(arr[i]);
      bt(i + 1, current);
      current.pop();
    }
  }
  bt(0, []);
  return result;
}

function evaluate5(cards) {
  const ranks = cards.map(c => RANK_VALUES[c.rankStr]).sort((a, b) => b - a);
  const suits = cards.map(c => c.suit);
  const isFlush = suits.every(s => s === suits[0]);
  const unique = [...new Set(ranks)].sort((a, b) => b - a);

  let isStraight = false, straightHigh = 0;
  if (unique.length >= 5) {
    for (let i = 0; i <= unique.length - 5; i++) {
      if (unique[i] - unique[i + 4] === 4) { isStraight = true; straightHigh = unique[i]; break; }
    }
    if (!isStraight && unique.includes(14) && unique.includes(5) && unique.includes(4) && unique.includes(3) && unique.includes(2)) {
      isStraight = true; straightHigh = 5;
    }
  }

  const counts = {};
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
  const groups = Object.entries(counts).map(([r, c]) => ({ rank: +r, count: c }));
  groups.sort((a, b) => b.count - a.count || b.rank - a.rank);

  if (isFlush && isStraight) {
    if (straightHigh === 14) return { rank: 9, values: [14], name: '皇家同花顺' };
    return { rank: 8, values: [straightHigh], name: '同花顺' };
  }
  if (groups[0].count === 4) return { rank: 7, values: [groups[0].rank, groups[1].rank], name: '四条' };
  if (groups[0].count === 3 && groups[1] && groups[1].count === 2) return { rank: 6, values: [groups[0].rank, groups[1].rank], name: '葫芦' };
  if (isFlush) return { rank: 5, values: ranks, name: '同花' };
  if (isStraight) return { rank: 4, values: [straightHigh], name: '顺子' };
  if (groups[0].count === 3) return { rank: 3, values: [groups[0].rank, ...groups.slice(1).map(g => g.rank)], name: '三条' };
  if (groups[0].count === 2 && groups[1] && groups[1].count === 2) return { rank: 2, values: [groups[0].rank, groups[1].rank, groups[2].rank], name: '两对' };
  if (groups[0].count === 2) return { rank: 1, values: [groups[0].rank, ...groups.slice(1).map(g => g.rank)], name: '一对' };
  return { rank: 0, values: ranks, name: '高牌' };
}

function compareEval(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  for (let i = 0; i < Math.min(a.values.length, b.values.length); i++) {
    if (a.values[i] !== b.values[i]) return a.values[i] - b.values[i];
  }
  return 0;
}

// ===== Game Class =====
class Game {
  constructor(players, options = {}) {
    this.sb = options.sb || SB;
    this.bb = options.bb || BB;
    this.startStack = options.startStack || START_STACK;
    this.shortDeck = options.shortDeck || false;
    this.allInOrFold = options.allInOrFold || false;
    this.gameMode = options.gameMode || 'classic';

    this.players = players.map((p, i) => ({
      id: p.id,
      name: p.name,
      seatIdx: i,
      stack: p.stack || this.startStack,
      hand: [],
      bet: 0,
      totalBet: 0,
      folded: false,
      allIn: false,
      lastAction: '',
      connected: p.connected !== false,
      _username: p._username || null,
      avatar: p.avatar || '🦊',
      avatarColor: p.avatarColor || null,
    }));
    this.deck = [];
    this.community = [];
    this.pot = 0;
    this.dealerIdx = Math.floor(Math.random() * this.players.length);
    this.currentIdx = 0;
    this.phase = 'idle';
    this.minRaise = this.bb;
    this.lastRaise = this.bb;
    this.roundBet = 0;
    this.actedCount = 0;
    this.handNum = 0;
    this.winners = [];
    this.refunds = [];
    this.actionTimeout = null;
    this.onBroadcast = null; // callback(type, data)
    this.onGameEnd = null;
  }

  // ===== Helpers =====
  activePlayers() { return this.players.filter(p => !p.folded && (p.stack > 0 || p.bet > 0) && p.connected); }
  inHandPlayers() { return this.players.filter(p => !p.folded && p.connected); }
  canActPlayers() { return this.players.filter(p => !p.folded && !p.allIn && p.connected); }

  nextIdx(from) {
    let idx = (from + 1) % this.players.length;
    let safety = 0;
    while ((this.players[idx].folded || this.players[idx].allIn || !this.players[idx].connected) && safety < 10) {
      idx = (idx + 1) % this.players.length;
      safety++;
    }
    return idx;
  }

  broadcast(type, data = {}) {
    if (this.onBroadcast) this.onBroadcast(type, data);
  }

  getState() {
    return {
      players: this.players.map(p => ({
        id: p.id, name: p.name, seatIdx: p.seatIdx,
        stack: p.stack, bet: p.bet, totalBet: p.totalBet,
        folded: p.folded, allIn: p.allIn, lastAction: p.lastAction,
        connected: p.connected,
        avatar: p.avatar || '🦊', avatarColor: p.avatarColor || null,
        // Only send hand cards to the owning player (handled per-client)
        hand: p.hand,
      })),
      community: this.community,
      pot: this.pot,
      dealerIdx: this.dealerIdx,
      sbIdx: this.sbIdx,
      bbIdx: this.bbIdx,
      currentIdx: this.currentIdx,
      phase: this.phase,
      roundBet: this.roundBet,
      handNum: this.handNum,
      winners: this.winners,
      refunds: this.refunds,
    };
  }

  // Get state filtered for a specific player (hide other players' cards)
  getStateForPlayer(playerId) {
    const state = this.getState();
    state.players = state.players.map(p => ({
      ...p,
      hand: p.id === playerId ? p.hand : (p.hand.length > 0 && this.phase === 'showdown' && !p.folded ? p.hand : p.hand.map(() => null)),
    }));
    return state;
  }

  // Get state for spectators (no hole cards, only showdown reveals)
  getStateForSpectator() {
    const state = this.getState();
    state.isSpectatorView = true;
    state.players = state.players.map(p => ({
      ...p,
      hand: (this.phase === 'showdown' && !p.folded) ? p.hand : p.hand.map(() => null),
    }));
    return state;
  }

  // ===== Game Flow =====
  startHand() {
    if (this.actionTimeout) clearTimeout(this.actionTimeout);

    this.handNum++;
    this.deck = shuffle(createDeck(this.shortDeck));
    this.community = [];
    this.pot = 0;
    this.winners = [];
    this.refunds = [];
    this.phase = 'preflop';
    this.lastRaise = this.bb;
    this.minRaise = this.bb;
    this.roundBet = 0;

    for (const p of this.players) {
      p.hand = [];
      p.bet = 0;
      p.totalBet = 0;
      p.folded = p.stack <= 0 || !p.connected;
      p.allIn = false;
      p.lastAction = '';
    }

    const playableCount = this.players.filter(p => p.stack > 0 && p.connected).length;
    if (playableCount < 2) {
      this.broadcast('game:error', { message: '需要至少2名玩家' });
      return;
    }

    // Move dealer clockwise
    this.dealerIdx = (this.dealerIdx + 1) % this.players.length;
    const sbIdx = this.nextIdx(this.dealerIdx);
    const bbIdx = this.nextIdx(sbIdx);
    this.sbIdx = sbIdx; // Save for later phases
    this.bbIdx = bbIdx; // Save for later phases

    // Start logging this hand (before blinds so they get recorded)
    gameLogger.startHand(this);

    this.postBlind(this.players[sbIdx], this.sb);
    this.postBlind(this.players[bbIdx], this.bb);

    // Deal
    for (let i = 0; i < 2; i++) {
      for (const p of this.players) {
        if (!p.folded) p.hand.push(this.deck.pop());
      }
    }

    // Record dealt hands in the logger
    if (gameLogger.currentHand) {
      for (const p of this.players) {
        if (p.hand && p.hand.length === 2) {
          gameLogger.currentHand.hands[p.id] = p.hand.map(c => c ? `${c.rankStr}${c.suitStr}` : null);
        }
      }
    }

    this.currentIdx = this.nextIdx(bbIdx);
    this.actedCount = 0;

    this.broadcast('game:handStart', { handNum: this.handNum });
    this.broadcastState();

    this.scheduleNextAction();
  }

  postBlind(player, amount) {
    const actual = Math.min(amount, player.stack);
    player.stack -= actual;
    player.bet = actual;
    player.totalBet += actual;
    this.pot += actual;
    this.roundBet = Math.max(this.roundBet, actual);
    if (player.stack === 0) player.allIn = true;
    const blindType = amount === this.sb ? '小盲' : '大盲';
    gameLogger.logAction(this, player, blindType, actual);
  }

  broadcastState() {
    for (const p of this.players) {
      if (p._ws && p.connected) {
        const state = this.getStateForPlayer(p.id);
        p._ws.send(JSON.stringify({ type: 'game:state', data: state }));
      }
    }
  }


  scheduleNextAction() {
    this.actionTimeout = setTimeout(() => this.processNextAction(), 500);
  }

  processNextAction() {
    const inHand = this.inHandPlayers();
    if (inHand.length <= 1) { this.endHand(); return; }

    const canAct = this.canActPlayers();
    if (canAct.length === 0) { this.advancePhase(); return; }

    const player = this.players[this.currentIdx];

    if (player.folded || player.allIn || !player.connected) {
      this.currentIdx = this.nextIdx(this.currentIdx);
      this.processNextAction();
      return;
    }


    // Request action from human player
    const toCall = this.roundBet - player.bet;
    const actionData = {
      playerId: player.id,
      toCall,
      minRaise: this.roundBet + this.minRaise,
      maxRaise: player.stack + player.bet,
      pot: this.pot,
      gameMode: this.gameMode,
      allInOrFold: this.allInOrFold,
    };

    // Send yourTurn ONLY to the current player (not broadcast)
    if (player._ws && player._ws.readyState === 1) {
      player._ws.send(JSON.stringify({ type: 'game:yourTurn', data: actionData }));
    }
  }

  handleAction(playerId, actionData) {
    if (this.actionTimeout) clearTimeout(this.actionTimeout);

    const player = this.players.find(p => p.id === playerId);
    if (!player || player.folded || player.allIn) return;
    if (this.players[this.currentIdx].id !== playerId) return; // Not their turn

    const toCall = this.roundBet - player.bet;
    const { action, amount } = actionData;

    // All-in-or-fold mode: only fold, check, or allin allowed
    if (this.allInOrFold) {
      if (action === 'call' || action === 'raise') {
        // Convert call/raise to allin
        return this.handleAction(playerId, { action: 'allin' });
      }
    }

    switch (action) {
      case 'fold':
        player.folded = true;
        player.lastAction = 'fold';
        gameLogger.logAction(this, player, '弃牌', 0);
        break;

      case 'check':
        if (toCall > 0) return this.scheduleNextAction(); // Invalid
        player.lastAction = 'check';
        gameLogger.logAction(this, player, '过牌', 0);
        break;

      case 'call': {
        const actual = Math.min(toCall, player.stack);
        player.stack -= actual;
        player.bet += actual;
        player.totalBet += actual;
        this.pot += actual;
        if (player.stack === 0) player.allIn = true;
        player.lastAction = player.allIn ? 'allin' : 'call';
        gameLogger.logAction(this, player, player.allIn ? 'ALL IN(跟注)' : '跟注', actual);
        break;
      }

      case 'raise': {
        const raiseAmount = Math.max(amount || 0, this.roundBet + this.minRaise);
        const toPay = Math.min(raiseAmount - player.bet, player.stack);
        if (toPay <= 0) return this.scheduleNextAction();
        player.stack -= toPay;
        player.bet += toPay;
        player.totalBet += toPay;
        this.pot += toPay;
        this.lastRaise = toPay;
        this.minRaise = Math.max(this.minRaise, toPay);
        this.roundBet = player.bet;
        if (player.stack === 0) { player.allIn = true; player.lastAction = 'allin'; }
        else player.lastAction = 'raise';
        this.actedCount = 0; // Others need to act again
        gameLogger.logAction(this, player, '加注', toPay, { raiseTo: player.bet });
        break;
      }

      case 'allin': {
        const amt = player.stack;
        player.bet += amt;
        player.totalBet += amt;
        this.pot += amt;
        player.stack = 0;
        player.allIn = true;
        player.lastAction = 'allin';
        if (player.bet > this.roundBet) {
          this.roundBet = player.bet;
          this.actedCount = 0;
        }
        gameLogger.logAction(this, player, 'ALL IN', amt);
        break;
      }

      default:
        return this.scheduleNextAction();
    }

    this.actedCount++;

    // Update current player first, then broadcast
    this.currentIdx = this.nextIdx(this.currentIdx);
    this.broadcastState();

    const inHand = this.inHandPlayers();
    if (inHand.length <= 1) { this.endHand(); return; }

    const canAct = this.canActPlayers();
    const allMatched = canAct.every(p => p.bet === this.roundBet);
    if (allMatched && this.actedCount >= canAct.length) {
      this.advancePhase();
    } else {
      this.scheduleNextAction();
    }
  }

  advancePhase() {
    for (const p of this.players) p.bet = 0;
    this.roundBet = 0;
    this.actedCount = 0;
    this.lastRaise = this.bb;
    this.minRaise = this.bb;

    const inHand = this.inHandPlayers();
    if (inHand.length <= 1) { this.endHand(); return; }

    const prevPhase = this.phase;
    if (this.phase === 'preflop') {
      this.phase = 'flop';
      this.deck.pop(); // Burn card
      this.community.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
    } else if (this.phase === 'flop') {
      this.phase = 'turn';
      this.deck.pop(); // Burn card
      this.community.push(this.deck.pop());
    } else if (this.phase === 'turn') {
      this.phase = 'river';
      this.deck.pop(); // Burn card
      this.community.push(this.deck.pop());
    } else if (this.phase === 'river') {
      this.showdown();
      return;
    }

    const canAct = this.canActPlayers();
    if (canAct.length <= 1) {
      gameLogger.logPhaseChange(this, this.phase);
      this.broadcastState();
      setTimeout(() => this.advancePhase(), 1000);
      return;
    }

    // Post-flop: start from small blind position (or next active if SB folded)
    this.currentIdx = this.nextIdx(this.dealerIdx);
    gameLogger.logPhaseChange(this, this.phase);
    this.broadcastState();
    setTimeout(() => this.processNextAction(), 1000);
  }

  showdown() {
    this.phase = 'showdown';
    const inHand = this.inHandPlayers();

    // Evaluate hands and sort best → worst
    const evals = inHand.map(p => ({
      player: p,
      eval: evaluateHand([...p.hand, ...this.community])
    }));
    evals.sort((a, b) => compareEval(b.eval, a.eval));

    // ===== Side pot calculation =====
    // 1) Collect all unique totalBet levels (including folded players)
    const allBets = new Set();
    for (const p of this.players) {
      if (p.totalBet > 0) allBets.add(p.totalBet);
    }
    const levels = [...allBets].sort((a, b) => a - b);

    // 2) Walk through layers, calculate each layer's pot
    let prevLevel = 0;
    const awards = {}; // playerId → total won

    const refunds = {};

    for (const level of levels) {
      const layerSize = level - prevLevel;
      if (layerSize <= 0) { prevLevel = level; continue; }

      // Every player with totalBet >= level contributes layerSize
      const contributors = this.players.filter(p => p.totalBet >= level);
      const layerPot = contributors.length * layerSize;
      if (layerPot <= 0) { prevLevel = level; continue; }

      // A layer funded by only one player is an unmatched bet return, not a won pot.
      if (contributors.length === 1) {
        const pid = contributors[0].id;
        refunds[pid] = (refunds[pid] || 0) + layerPot;
        prevLevel = level;
        continue;
      }

      // Eligible winners: in-hand (not folded) with totalBet >= level
      const eligible = evals.filter(e => e.player.totalBet >= level);
      if (eligible.length === 0) { prevLevel = level; continue; }

      // Best hand(s) among eligible
      const best = [eligible[0]];
      for (let i = 1; i < eligible.length; i++) {
        const cmp = compareEval(eligible[i].eval, eligible[0].eval);
        if (cmp === 0) best.push(eligible[i]);
        else break;
      }

      // Split layer pot equally among tied best
      const share = Math.floor(layerPot / best.length);
      let remainder = layerPot - share * best.length;

      for (let i = 0; i < best.length; i++) {
        const pid = best[i].player.id;
        const extra = (i === 0) ? remainder : 0; // remainder → first winner
        awards[pid] = (awards[pid] || 0) + share + extra;
      }

      prevLevel = level;
    }

    // 3) Apply winnings and build result
    this.winners = [];
    this.refunds = [];
    for (const [pid, amount] of Object.entries(refunds)) {
      if (amount <= 0) continue;
      const player = this.players.find(p => p.id === pid);
      if (!player) continue;
      player.stack += amount;
      this.refunds.push({ id: pid, name: player.name, amount });
    }

    for (const [pid, amount] of Object.entries(awards)) {
      if (amount <= 0) continue;
      const e = evals.find(e => e.player.id === pid);
      e.player.stack += amount;
      e.player.lastAction = 'winner';
      this.winners.push({
        id: pid, name: e.player.name,
        hand: e.eval.name, amount,
      });
    }

    // Sort winners by amount descending for display
    this.winners.sort((a, b) => b.amount - a.amount);

    this.broadcastState();
    this.broadcast('game:showdown', { winners: this.winners, refunds: this.refunds });
    gameLogger.logPhaseChange(this, 'showdown');
    gameLogger.logResult(this, this.winners);

    setTimeout(() => {
      this.broadcast('game:handEnd', { winners: this.winners, refunds: this.refunds });
      if (this.onGameEnd) this.onGameEnd();
    }, 3000);
  }

  endHand() {
    const inHand = this.inHandPlayers();
    if (inHand.length === 1) {
      const winner = inHand[0];
      winner.stack += this.pot;
      winner.lastAction = 'winner';
      this.winners = [{ id: winner.id, name: winner.name, hand: '其他人弃牌', amount: this.pot }];

      this.broadcastState();
      this.broadcast('game:handEnd', { winners: this.winners });
      gameLogger.logResult(this, this.winners);
      if (this.onGameEnd) this.onGameEnd();
    }
  }

  // Player disconnected
  handleDisconnect(playerId) {
    const player = this.players.find(p => p.id === playerId);
    if (!player) return;
    player.connected = false;

    // If it's their turn, auto-fold
    if (this.players[this.currentIdx]?.id === playerId && this.phase !== 'showdown' && this.phase !== 'idle') {
      this.handleAction(playerId, { action: 'fold' });
    }
  }

  handleReconnect(playerId, ws) {
    const player = this.players.find(p => p.id === playerId);
    if (!player) return;
    player.connected = true;
    player._ws = ws;

    // Send current state
    const state = this.getStateForPlayer(playerId);
    ws.send(JSON.stringify({ type: 'game:state', data: state }));

    // If it's their turn, prompt
    if (this.players[this.currentIdx]?.id === playerId && this.phase !== 'showdown' && this.phase !== 'idle') {
      const toCall = this.roundBet - player.bet;
      ws.send(JSON.stringify({ type: 'game:yourTurn', data: { playerId, toCall, minRaise: this.roundBet + this.minRaise, maxRaise: player.stack + player.bet, pot: this.pot }}));
    }
  }
}

module.exports = { Game, SB, BB, START_STACK, HAND_NAMES, evaluateHand };
