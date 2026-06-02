/**
 * Texas Hold'em Game Engine — Server-side authoritative
 * Handles all game logic: deck, hand evaluation, betting rounds, pot management
 */

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const RANK_VALUES = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14 };
const HAND_NAMES = ['高牌','一对','两对','三条','顺子','同花','葫芦','四条','同花顺','皇家同花顺'];

const SB = 10;
const BB = 20;
const START_STACK = 2000;

// ===== Deck =====
function createDeck() {
  const d = [];
  for (let s = 0; s < 4; s++)
    for (let r = 0; r < 13; r++)
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
  constructor(players) {
    this.players = players.map((p, i) => ({
      id: p.id,
      name: p.name,
      seatIdx: i,
      stack: p.stack || START_STACK,
      hand: [],
      bet: 0,
      totalBet: 0,
      folded: false,
      allIn: false,
      lastAction: '',
      connected: p.connected !== false,
      isBot: !!p.isBot,
      botStyle: p.botStyle || null, // 'tag' | 'lap' | 'maniac' | 'rock'
    }));
    this.deck = [];
    this.community = [];
    this.pot = 0;
    this.dealerIdx = Math.floor(Math.random() * this.players.length);
    this.currentIdx = 0;
    this.phase = 'idle';
    this.minRaise = BB;
    this.lastRaise = BB;
    this.roundBet = 0;
    this.actedCount = 0;
    this.handNum = 0;
    this.winners = [];
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
        // Only send hand cards to the owning player (handled per-client)
        hand: p.hand,
      })),
      community: this.community,
      pot: this.pot,
      dealerIdx: this.dealerIdx,
      currentIdx: this.currentIdx,
      phase: this.phase,
      roundBet: this.roundBet,
      handNum: this.handNum,
      winners: this.winners,
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
    this.deck = shuffle(createDeck());
    this.community = [];
    this.pot = 0;
    this.winners = [];
    this.phase = 'preflop';
    this.lastRaise = BB;
    this.minRaise = BB;
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

    // Move dealer
    this.dealerIdx = this.nextIdx(this.dealerIdx - 1 + this.players.length);
    const sbIdx = this.nextIdx(this.dealerIdx);
    const bbIdx = this.nextIdx(sbIdx);

    this.postBlind(this.players[sbIdx], SB);
    this.postBlind(this.players[bbIdx], BB);

    // Deal
    for (let i = 0; i < 2; i++) {
      for (const p of this.players) {
        if (!p.folded) p.hand.push(this.deck.pop());
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
    if (player.stack === 0) player.allIn = true;
  }

  broadcastState() {
    for (const p of this.players) {
      if (p._ws && p.connected) {
        const state = this.getStateForPlayer(p.id);
        p._ws.send(JSON.stringify({ type: 'game:state', data: state }));
      }
    }
  }

  // ===== Bot AI Decision =====
  botDecide(player) {
    const toCall = this.roundBet - player.bet;
    const style = player.botStyle || 'tag';
    const hand = player.hand;
    const community = this.community;
    const activeCount = this.inHandPlayers().length;

    // Estimate hand strength via Monte Carlo simulation
    let strength = 0;
    if (community.length >= 3) {
      strength = this._simulateHandStrength(hand, community, activeCount, 80);
    } else {
      strength = this._ratePreflopHand(hand);
    }

    // Random factor for unpredictability
    const noise = (Math.random() - 0.5) * 0.12;
    const adj = Math.max(0, Math.min(1, strength + noise));

    let action, amount;

    switch (style) {
      case 'tag': // Tight-Aggressive
        if (adj > 0.82) { action = 'raise'; amount = Math.min(this.pot, player.stack); }
        else if (adj > 0.6) { action = toCall === 0 ? 'check' : 'call'; }
        else if (adj > 0.42 && toCall <= BB * 3) { action = toCall === 0 ? 'check' : 'call'; }
        else if (toCall === 0) { action = 'check'; }
        else { action = 'fold'; }
        break;

      case 'lap': // Loose-Passive (Calling Station)
        if (adj > 0.9 && Math.random() < 0.25) { action = 'raise'; amount = Math.min(this.pot, player.stack); }
        else if (adj > 0.28 || toCall <= BB * 2) { action = toCall === 0 ? 'check' : 'call'; }
        else if (toCall === 0) { action = 'check'; }
        else { action = 'fold'; }
        break;

      case 'maniac': // Loose-Aggressive
        if (adj > 0.45 || Math.random() < 0.28) {
          action = 'raise';
          amount = Math.min(Math.floor(this.pot * (1.5 + Math.random())), player.stack);
          if (adj > 0.75 && Math.random() < 0.12) action = 'allin';
        } else if (toCall === 0) { action = 'check'; }
        else if (adj > 0.2) { action = 'call'; }
        else { action = 'fold'; }
        break;

      case 'rock': // Tight-Passive
        if (adj > 0.85) { action = toCall === 0 ? 'check' : 'call'; }
        else if (adj > 0.5 && toCall <= BB * 2) { action = toCall === 0 ? 'check' : 'call'; }
        else if (toCall === 0) { action = 'check'; }
        else { action = 'fold'; }
        break;

      default:
        action = toCall === 0 ? 'check' : 'fold';
    }

    // Safety checks
    if (action === 'call' && toCall === 0) action = 'check';
    if (action === 'call' && toCall >= player.stack) action = 'allin';
    if (action === 'raise') {
      amount = Math.max(amount || 0, this.roundBet + this.minRaise);
      if (amount >= player.stack + player.bet) action = 'allin';
    }

    const delay = 800 + Math.random() * 1400;
    this.actionTimeout = setTimeout(() => {
      this.actionTimeout = null;
      this.handleAction(player.id, { action, amount });
    }, delay);
  }

  // Monte Carlo hand strength estimation
  _simulateHandStrength(hand, community, numOpponents, iterations) {
    const known = [...hand, ...community];
    const remaining = [];
    for (let s = 0; s < 4; s++)
      for (let r = 0; r < 13; r++)
        if (!known.some(c => c.suit === s && c.rank === r))
          remaining.push({ suit: s, rank: r, rankStr: RANKS[r], suitStr: SUITS[s] });

    let wins = 0, total = 0;
    const needed = 5 - community.length;

    for (let i = 0; i < iterations; i++) {
      const deck = shuffle([...remaining]);
      let di = 0;
      const fullComm = [...community];
      for (let j = 0; j < needed; j++) fullComm.push(deck[di++]);

      const myEval = evaluateHand([...hand, ...fullComm]);
      let best = true;
      for (let o = 0; o < numOpponents - 1; o++) {
        const oppHand = [deck[di++], deck[di++]];
        const oppEval = evaluateHand([...oppHand, ...fullComm]);
        if (compareEval(oppEval, myEval) > 0) { best = false; break; }
      }
      if (best) wins++;
      total++;
    }
    return total > 0 ? wins / total : 0;
  }

  // Simple preflop hand rating (0-1 scale)
  _ratePreflopHand(hand) {
    const r1 = RANK_VALUES[hand[0].rankStr];
    const r2 = RANK_VALUES[hand[1].rankStr];
    const high = Math.max(r1, r2);
    const low = Math.min(r1, r2);
    const suited = hand[0].suit === hand[1].suit;
    const pair = r1 === r2;

    let score = 0;
    if (pair) score = 0.5 + (high / 14) * 0.4;
    else {
      score = (high + low) / 28 * 0.55;
      if (suited) score += 0.08;
      if (high - low <= 2) score += 0.06;
      if (high >= 12 && low >= 10) score += 0.12;
      if (high === 14 && low >= 10) score += 0.1;
    }
    return Math.min(1, Math.max(0, score));
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

    // Bot players decide automatically
    if (player.isBot) {
      this.botDecide(player);
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
    };

    // Send yourTurn ONLY to the current player (not broadcast)
    if (player._ws && player._ws.readyState === 1) {
      player._ws.send(JSON.stringify({ type: 'game:yourTurn', data: actionData }));
    }

    // Auto-fold timeout (30 seconds)
    this.actionTimeout = setTimeout(() => {
      this.handleAction(player.id, { action: 'fold' });
    }, 30000);
  }

  handleAction(playerId, actionData) {
    if (this.actionTimeout) clearTimeout(this.actionTimeout);

    const player = this.players.find(p => p.id === playerId);
    if (!player || player.folded || player.allIn) return;
    if (this.players[this.currentIdx].id !== playerId) return; // Not their turn

    const toCall = this.roundBet - player.bet;
    const { action, amount } = actionData;

    switch (action) {
      case 'fold':
        player.folded = true;
        player.lastAction = 'fold';
        break;

      case 'check':
        if (toCall > 0) return this.scheduleNextAction(); // Invalid
        player.lastAction = 'check';
        break;

      case 'call': {
        const actual = Math.min(toCall, player.stack);
        player.stack -= actual;
        player.bet += actual;
        player.totalBet += actual;
        this.pot += actual;
        if (player.stack === 0) player.allIn = true;
        player.lastAction = player.allIn ? 'allin' : 'call';
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
        break;
      }

      default:
        return this.scheduleNextAction();
    }

    this.actedCount++;
    this.broadcastState();

    // Check round end
    this.currentIdx = this.nextIdx(this.currentIdx);
    const inHand = this.inHandPlayers();
    if (inHand.length <= 1) { this.endHand(); return; }

    const canAct = this.canActPlayers();
    const allMatched = canAct.every(p => p.bet === this.roundBet);
    if (allMatched && this.actedCount >= inHand.length) {
      this.advancePhase();
    } else {
      this.scheduleNextAction();
    }
  }

  advancePhase() {
    for (const p of this.players) p.bet = 0;
    this.roundBet = 0;
    this.actedCount = 0;
    this.lastRaise = BB;
    this.minRaise = BB;

    const inHand = this.inHandPlayers();
    if (inHand.length <= 1) { this.endHand(); return; }

    const prevPhase = this.phase;
    if (this.phase === 'preflop') {
      this.phase = 'flop';
      this.deck.pop();
      this.community.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
    } else if (this.phase === 'flop') {
      this.phase = 'turn';
      this.deck.pop();
      this.community.push(this.deck.pop());
    } else if (this.phase === 'turn') {
      this.phase = 'river';
      this.deck.pop();
      this.community.push(this.deck.pop());
    } else if (this.phase === 'river') {
      this.showdown();
      return;
    }

    this.broadcastState();

    const canAct = this.canActPlayers();
    if (canAct.length <= 1) {
      setTimeout(() => this.advancePhase(), 1000);
      return;
    }

    this.currentIdx = this.nextIdx(this.dealerIdx);
    setTimeout(() => this.processNextAction(), 1000);
  }

  showdown() {
    this.phase = 'showdown';
    const inHand = this.inHandPlayers();
    const evals = inHand.map(p => ({
      player: p,
      eval: evaluateHand([...p.hand, ...this.community])
    }));

    evals.sort((a, b) => compareEval(b.eval, a.eval));

    const winners = [evals[0]];
    for (let i = 1; i < evals.length; i++) {
      if (compareEval(evals[i].eval, evals[0].eval) === 0) winners.push(evals[i]);
      else break;
    }

    const share = Math.floor(this.pot / winners.length);
    this.winners = [];
    for (const w of winners) {
      w.player.stack += share;
      w.player.lastAction = 'winner';
      this.winners.push({ id: w.player.id, name: w.player.name, hand: w.eval.name, amount: share });
    }

    // Remainder goes to first winner
    const remainder = this.pot - share * winners.length;
    if (remainder > 0) winners[0].player.stack += remainder;

    this.broadcastState();
    this.broadcast('game:showdown', { winners: this.winners });

    setTimeout(() => {
      this.broadcast('game:handEnd', { winners: this.winners });
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
