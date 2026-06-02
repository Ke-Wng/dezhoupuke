/**
 * Test: Turn order — only current player receives yourTurn
 */
const WebSocket = require('ws');
const URL = 'ws://localhost:3000';
let passed = 0, failed = 0;

function assert(cond, msg) {
  if (cond) { console.log(`  PASS ${msg}`); passed++; }
  else { console.log(`  FAIL ${msg}`); failed++; }
}

function createClient(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const messages = [];
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', data: { name } })));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      messages.push(msg);
      if (msg.type === 'auth:ok') {
        resolve({ ws, id: msg.data.playerId, name, messages,
          send(type, data = {}) { ws.send(JSON.stringify({ type, data })); }
        });
      }
    });
    ws.on('error', reject);
  });
}

function drain(c) { c.messages.length = 0; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function waitFor(client, type, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout: ${type}`)), timeout);
    const check = () => {
      const idx = client.messages.findIndex(m => m.type === type);
      if (idx >= 0) { clearTimeout(timer); resolve(client.messages.splice(idx, 1)[0]); }
      else setTimeout(check, 50);
    };
    check();
  });
}

async function run() {
  console.log('\n=== Turn Order Test ===\n');

  // Create 3 players
  const p1 = await createClient('Alice');
  const p2 = await createClient('Bob');
  const p3 = await createClient('Carol');

  // P1 creates room
  p1.send('room:create', { name: 'Alice' });
  const created = await waitFor(p1, 'room:created');
  const code = created.data.code;
  console.log(`Room: ${code}`);

  // P2 joins
  p2.send('room:join', { code, name: 'Bob' });
  await waitFor(p2, 'room:joined');

  // P3 joins
  p3.send('room:join', { code, name: 'Carol' });
  await waitFor(p3, 'room:joined');
  await sleep(500);

  // P1 starts the game
  drain(p1); drain(p2); drain(p3);
  p1.send('room:start');
  await sleep(1500);

  // Check: Only ONE player should receive game:yourTurn
  console.log('1. Checking yourTurn is sent to exactly one player...');
  const yt1 = p1.messages.filter(m => m.type === 'game:yourTurn');
  const yt2 = p2.messages.filter(m => m.type === 'game:yourTurn');
  const yt3 = p3.messages.filter(m => m.type === 'game:yourTurn');

  const totalTurns = yt1.length + yt2.length + yt3.length;
  assert(totalTurns === 1, `Exactly 1 player received yourTurn (got ${totalTurns})`);

  // Identify whose turn it is
  let current, currentName;
  if (yt1.length === 1) { current = p1; currentName = 'Alice'; }
  else if (yt2.length === 1) { current = p2; currentName = 'Bob'; }
  else if (yt3.length === 1) { current = p3; currentName = 'Carol'; }
  assert(!!current, `Current player identified: ${currentName}`);

  // The current player's yourTurn should have their own playerId
  const turnMsg = current.messages.find(m => m.type === 'game:yourTurn');
  assert(turnMsg && turnMsg.data.playerId === current.id, 'yourTurn playerId matches current player');

  // 2. Current player calls — next player should get yourTurn
  console.log('\n2. Current player calls, checking next player gets turn...');
  drain(p1); drain(p2); drain(p3);
  const toCall = turnMsg.data.toCall;
  if (toCall > 0) {
    current.send('game:action', { action: 'call' });
  } else {
    current.send('game:action', { action: 'check' });
  }
  await sleep(1500);

  // Find who got the next yourTurn
  const next1 = p1.messages.filter(m => m.type === 'game:yourTurn');
  const next2 = p2.messages.filter(m => m.type === 'game:yourTurn');
  const next3 = p3.messages.filter(m => m.type === 'game:yourTurn');
  const nextTotal = next1.length + next2.length + next3.length;
  assert(nextTotal === 1, `After call, exactly 1 player gets yourTurn (got ${nextTotal})`);

  // The next player should NOT be the same as the current player
  let nextPlayer, nextName;
  if (next1.length === 1) { nextPlayer = p1; nextName = 'Alice'; }
  else if (next2.length === 1) { nextPlayer = p2; nextName = 'Bob'; }
  else if (next3.length === 1) { nextPlayer = p3; nextName = 'Carol'; }
  assert(nextPlayer && nextPlayer.id !== current.id, `Turn moved to different player: ${nextName}`);

  // 3. Non-current players should NOT see action panel
  console.log('\n3. Verifying non-current players don\'t receive yourTurn...');
  const others = [p1, p2, p3].filter(p => p !== nextPlayer);
  for (const other of others) {
    const otherTurns = other.messages.filter(m => m.type === 'game:yourTurn');
    assert(otherTurns.length === 0, `${other.name} did NOT receive yourTurn (correct)`);
  }

  // Cleanup
  p1.ws.close(); p2.ws.close(); p3.ws.close();
  await sleep(500);

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error('Error:', err.message); process.exit(1); });
