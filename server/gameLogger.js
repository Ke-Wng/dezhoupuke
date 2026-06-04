/**
 * Game Logger — records every hand's actions and state to a JSONL file.
 * Keeps the last MAX_HANDS hands. Each line = one complete hand record.
 */

const fs = require('fs');
const path = require('path');

const MAX_HANDS = 500;
const LOG_DIR = path.join(__dirname, '..', 'data');
const LOG_FILE = path.join(LOG_DIR, 'game-hands.jsonl');

class GameLogger {
  constructor() {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    this.currentHand = null;
  }

  // Called at startHand — begin a new hand record
  startHand(game) {
    this.currentHand = {
      handNum: game.handNum,
      timestamp: Date.now(),
      date: new Date().toISOString(),
      config: { sb: game.sb, bb: game.bb, startStack: game.startStack, mode: game.gameMode },
      dealer: { idx: game.dealerIdx, name: game.players[game.dealerIdx]?.name },
      sb: { idx: game.sbIdx, name: game.players[game.sbIdx]?.name, amount: game.sb },
      bb: { idx: game.bbIdx, name: game.players[game.bbIdx]?.name, amount: game.bb },
      players: game.players.map(p => ({
        id: p.id, name: p.name, seatIdx: p.seatIdx,
        stack: p.stack + p.bet, // original stack before blind
      })),
      hands: {},    // player id → [card1, card2]
      actions: [],  // chronological action log
      phases: {},   // phase → community cards
      result: null, // winner info
    };

    // Record dealt hands
    for (const p of game.players) {
      if (p.hand && p.hand.length === 2) {
        this.currentHand.hands[p.id] = p.hand.map(c => c ? `${c.rankStr}${c.suitStr}` : null);
      }
    }
  }

  // Called on every action (fold, check, call, raise, allin, blind)
  logAction(game, player, action, amount, extra = {}) {
    if (!this.currentHand) return;
    
    const entry = {
      phase: game.phase,
      player: player.name,
      playerId: player.id,
      seat: player.seatIdx,
      action: action,
      amount: amount || 0,
      // State after action
      state: {
        playerStack: player.stack,
        playerBet: player.bet,
        playerTotalBet: player.totalBet,
        pot: game.pot,
        roundBet: game.roundBet,
        currentIdx: game.currentIdx,
        inHand: game.inHandPlayers().map(p => p.name),
      },
      ...extra,
      time: Date.now(),
    };

    this.currentHand.actions.push(entry);
  }

  // Called when phase changes (flop, turn, river, showdown)
  logPhaseChange(game, phase) {
    if (!this.currentHand) return;
    this.currentHand.phases[phase] = {
      community: game.community.map(c => `${c.rankStr}${c.suitStr}`),
      pot: game.pot,
      players: game.players.map(p => ({
        name: p.name,
        stack: p.stack,
        bet: p.bet,
        totalBet: p.totalBet,
        folded: p.folded,
        allIn: p.allIn,
      })),
      time: Date.now(),
    };
  }

  // Called at showdown/endHand — finalize and save
  logResult(game, winners) {
    if (!this.currentHand) return;

    this.currentHand.result = {
      winners: winners.map(w => ({
        name: w.name, id: w.id, amount: w.amount, hand: w.hand,
      })),
      pot: game.pot,
      finalStacks: game.players.map(p => ({
        name: p.name, stack: p.stack, totalBet: p.totalBet,
        folded: p.folded,
      })),
      showdownHands: game.inHandPlayers().map(p => ({
        name: p.name,
        hand: p.hand.map(c => c ? `${c.rankStr}${c.suitStr}` : null),
        eval: this._evalHand(p, game),
      })),
      community: game.community.map(c => `${c.rankStr}${c.suitStr}`),
      time: Date.now(),
    };

    this._save();
  }

  _evalHand(player, game) {
    try {
      const { evaluateHand } = require('./game');
      const cards = [...player.hand, ...game.community].filter(c => c);
      if (cards.length >= 5) {
        const ev = evaluateHand(cards);
        return ev.name;
      }
      return null;
    } catch { return null; }
  }

  _save() {
    if (!this.currentHand) return;
    
    try {
      const line = JSON.stringify(this.currentHand) + '\n';
      fs.appendFileSync(LOG_FILE, line, 'utf8');
      this._trimFile();
    } catch (err) {
      console.error('[GameLogger] Save error:', err.message);
    }
    
    this.currentHand = null;
  }

  _trimFile() {
    try {
      if (!fs.existsSync(LOG_FILE)) return;
      const stat = fs.statSync(LOG_FILE);
      if (stat.size < MAX_HANDS * 500) return; // Rough estimate, skip if small
      
      const content = fs.readFileSync(LOG_FILE, 'utf8');
      const lines = content.trim().split('\n');
      
      if (lines.length > MAX_HANDS) {
        const trimmed = lines.slice(lines.length - MAX_HANDS).join('\n') + '\n';
        fs.writeFileSync(LOG_FILE, trimmed, 'utf8');
      }
    } catch (err) {
      console.error('[GameLogger] Trim error:', err.message);
    }
  }
}

module.exports = new GameLogger();
