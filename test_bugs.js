/**
 * Test: ready toggle, host transfer, start button visibility
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

function findMsg(client, type) {
  return client.messages.find(m => m.type === type);
}
function drain(client) { client.messages.length = 0; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getPlayersList(client) {
  // Find the most recent room:players in the buffer
  const allPlayers = client.messages.filter(m => m.type === 'room:players');
  if (allPlayers.length > 0) return allPlayers[allPlayers.length - 1].data;
  // Otherwise wait for one
  await sleep(300);
  const retry = client.messages.filter(m => m.type === 'room:players');
  return retry.length > 0 ? retry[retry.length - 1].data : null;
}

async function run() {
  console.log('\n=== Bug Fix Verification Test ===\n');

  // ===== BUG 1: Ready toggle =====
  console.log('--- Bug 1: Ready toggle ---');
  const host1 = await createClient('Host1');
  host1.send('room:create', { name: 'Host1' });
  await sleep(300);
  const c1 = await waitForMessage(host1, 'room:created');
  const code1 = c1.data.code;

  // Toggle ready ON
  drain(host1);
  host1.send('room:ready', { ready: true });
  await sleep(300);
  let pl = await getPlayersList(host1);
  let myData = pl ? pl.players.find(p => p.id === host1.id) : null;
  assert(myData && myData.ready === true, 'Ready ON works');

  // Toggle ready OFF
  drain(host1);
  host1.send('room:ready', { ready: false });
  await sleep(300);
  pl = await getPlayersList(host1);
  myData = pl ? pl.players.find(p => p.id === host1.id) : null;
  assert(myData && myData.ready === false, 'Ready OFF (cancel) works');

  host1.ws.close();
  await sleep(500);

  // ===== BUG 2: Host transfer =====
  console.log('\n--- Bug 2: Host transfer on leave ---');
  const hostA = await createClient('Alice');
  hostA.send('room:create', { name: 'Alice' });
  await sleep(200);
  const cA = await waitForMessage(hostA, 'room:created');
  const code2 = cA.data.code;

  const bob = await createClient('Bob');
  bob.send('room:join', { code: code2, name: 'Bob' });
  await sleep(300);
  await waitForMessage(bob, 'room:joined');

  // Verify Alice is host
  pl = await getPlayersList(bob);
  assert(pl.hostId === hostA.id, 'Alice is initial host');

  // Alice leaves the room
  hostA.send('room:leave');
  await sleep(500);

  // Bob should now be host — check BEFORE drain
  const hostChanged = bob.messages.find(m => m.type === 'room:hostChanged');
  assert(hostChanged && hostChanged.data.hostId === bob.id, 'Bob becomes host after Alice leaves');

  // Also verify via players list
  const lastPlayers = [...bob.messages].reverse().find(m => m.type === 'room:players');
  if (lastPlayers) {
    assert(lastPlayers.data.hostId === bob.id, 'room:players confirms Bob as host');
  }
  drain(bob);

  // ===== BUG 3: Start button for new host =====
  console.log('\n--- Bug 3: Start button visibility for new host ---');
  // Bob is now the host in code2. Add a third player.
  const carol = await createClient('Carol');
  carol.send('room:join', { code: code2, name: 'Carol' });
  await sleep(300);
  await waitForMessage(carol, 'room:joined');

  // Bob should see hostId = bob.id in room:players
  pl = await getPlayersList(bob);
  assert(pl && pl.hostId === bob.id, 'Bob still host after Carol joins');
  // Client-side: isHost = d.hostId === Net.playerId → true for Bob
  assert(pl.hostId === bob.id, 'isHost would be true for Bob → start button visible');

  // Carol should NOT be host
  pl = await getPlayersList(carol);
  assert(pl && pl.hostId === bob.id, 'Carol sees Bob as host');
  assert(pl.hostId !== carol.id, 'isHost would be false for Carol → start button hidden');

  // Test host transfer on disconnect (not just leave)
  console.log('\n--- Bonus: Host transfer on disconnect ---');
  const dave = await createClient('Dave');
  dave.send('room:join', { code: code2, name: 'Dave' });
  await sleep(300);
  await waitForMessage(dave, 'room:joined');
  drain(dave);

  // Bob (host) disconnects
  bob.ws.close();
  await sleep(500);

  // Dave or Carol should become host
  const daveHostChanged = dave.messages.find(m => m.type === 'room:hostChanged');
  const carolHostChanged = carol.messages.find(m => m.type === 'room:hostChanged');
  const transferWorked = daveHostChanged || carolHostChanged;
  assert(!!transferWorked, 'Host transfer triggered on disconnect');

  // Cleanup
  carol.ws.close();
  dave.ws.close();
  await sleep(300);

  // ===== Test: Host transfer with 3→1 players =====
  console.log('\n--- Edge case: Multiple leaves, last player becomes host ---');
  const h = await createClient('H');
  h.send('room:create', { name: 'H' });
  await sleep(200);
  const cH = await waitForMessage(h, 'room:created');
  const code3 = cH.data.code;

  const p1 = await createClient('P1');
  p1.send('room:join', { code: code3, name: 'P1' });
  await sleep(200);
  await waitForMessage(p1, 'room:joined');

  const p2 = await createClient('P2');
  p2.send('room:join', { code: code3, name: 'P2' });
  await sleep(200);
  await waitForMessage(p2, 'room:joined');
  drain(p2);

  // H (host) leaves → P1 or P2 becomes host
  h.send('room:leave');
  await sleep(300);
  const hc = p2.messages.find(m => m.type === 'room:hostChanged');
  assert(!!hc, 'Host transfer on first leave (3→2)');
  drain(p2);

  const newHostId = hc ? hc.data.hostId : null;
  
  // The new host leaves → last person should become host
  if (newHostId === p1.id) {
    p1.send('room:leave');
  } else {
    p2.send('room:leave');
  }
  await sleep(300);
  const hc2 = p2.messages.find(m => m.type === 'room:hostChanged') || 
              p1.messages.find(m => m.type === 'room:hostChanged');
  // At least one should have received it (unless p2 was the one who left)
  const remaining = newHostId === p1.id ? p2 : p1;
  const remainingHc = remaining.messages.find(m => m.type === 'room:hostChanged');
  assert(!!remainingHc, 'Host transfer on second leave (2→1), last player becomes host');

  // Cleanup
  h.ws.close(); p1.ws.close(); p2.ws.close();
  await sleep(300);

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

function waitForMessage(client, type, timeout = 3000) {
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

run().catch(err => { console.error('Test error:', err.message); process.exit(1); });
