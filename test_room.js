/**
 * Test room lifecycle: grace period, disconnect handling, reconnection
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
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', data: { name } }));
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      messages.push(msg);
      if (msg.type === 'auth:ok') {
        resolve({ ws, playerId: msg.data.playerId, name, messages, send(type, data = {}) {
          ws.send(JSON.stringify({ type, data }));
        }});
      }
    });
    ws.on('error', reject);
  });
}

function waitForMessage(client, type, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeout);
    const check = () => {
      const idx = client.messages.findIndex(m => m.type === type);
      if (idx >= 0) {
        clearTimeout(timer);
        resolve(client.messages.splice(idx, 1)[0]);
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });
}

function drainMessages(client) {
  const msgs = [...client.messages];
  client.messages.length = 0;
  return msgs;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
  console.log('\n=== Room Lifecycle Test ===\n');

  // Test 1: Room survives after host disconnects
  console.log('1. Host creates room, then disconnects...');
  const host = await createClient('Host');
  host.send('room:create', { name: 'Host' });
  const created = await waitForMessage(host, 'room:created');
  const code = created.data.code;
  assert(code, `Room created: ${code}`);

  // Check room exists in list
  host.send('room:list');
  await sleep(300);
  let listMsg = host.messages.find(m => m.type === 'room:list');
  if (!listMsg) { drainMessages(host); host.send('room:list'); await sleep(300); listMsg = host.messages.find(m => m.type === 'room:list'); }
  assert(listMsg && listMsg.data.rooms.some(r => r.code === code), 'Room appears in public list');
  drainMessages(host);

  // Host disconnects
  console.log('   Host disconnects...');
  host.ws.close();
  await sleep(500);

  // Test 2: Room should still exist (grace period)
  console.log('\n2. Room should survive grace period (checking room list)...');
  const checker = await createClient('Checker');
  checker.send('room:list');
  await sleep(500);
  const list2 = checker.messages.find(m => m.type === 'room:list');
  const roomStillExists = list2 && list2.data.rooms.some(r => r.code === code);
  assert(roomStillExists, `Room ${code} still in list after host disconnect`);
  drainMessages(checker);

  // Test 3: New player can join the surviving room
  console.log('\n3. New player joins surviving room...');
  const p2 = await createClient('Player2');
  p2.send('room:join', { code, name: 'Player2' });
  await sleep(500);
  const joined = p2.messages.find(m => m.type === 'room:joined');
  assert(joined && joined.data.code === code, 'Player2 joined the surviving room');
  drainMessages(p2);

  // Test 4: When Player2 leaves, room enters grace period again
  console.log('\n4. Player2 explicitly leaves...');
  p2.send('room:leave');
  await sleep(300);
  const leftMsg = p2.messages.find(m => m.type === 'room:left');
  assert(!!leftMsg, 'Player2 received room:left confirmation');
  drainMessages(p2);

  // Room should still be in list (grace period)
  checker.send('room:list');
  await sleep(500);
  const list3 = checker.messages.find(m => m.type === 'room:list');
  const roomAfterLeave = list3 && list3.data.rooms.some(r => r.code === code);
  assert(roomAfterLeave, `Room ${code} still exists after last player leaves (grace period)`);
  drainMessages(checker);

  // Test 5: Another player joins during grace period
  console.log('\n5. New player joins during grace period...');
  const p3 = await createClient('Player3');
  p3.send('room:join', { code, name: 'Player3' });
  await sleep(500);
  const joined3 = p3.messages.find(m => m.type === 'room:joined');
  assert(joined3 && joined3.data.code === code, 'Player3 joined during grace period');
  drainMessages(p3);

  // Test 6: Multiple players - one disconnects, room survives
  console.log('\n6. Add Player4, then Player3 disconnects...');
  const p4 = await createClient('Player4');
  p4.send('room:join', { code, name: 'Player4' });
  await sleep(500);
  const joined4 = p4.messages.find(m => m.type === 'room:joined');
  assert(!!joined4, 'Player4 joined');
  drainMessages(p3);
  drainMessages(p4);

  // Player3 disconnects (not explicit leave)
  p3.ws.close();
  await sleep(500);

  // Room should still exist (Player4 is still there)
  checker.send('room:list');
  await sleep(500);
  const list5 = checker.messages.find(m => m.type === 'room:list');
  const roomAfterDisconnect = list5 && list5.data.rooms.some(r => r.code === code);
  assert(roomAfterDisconnect, 'Room survives with remaining player');

  // Player4 should see disconnect notification
  const disconnectNotice = p4.messages.find(m => m.type === 'room:playerLeft' || m.type === 'room:playerDisconnected');
  assert(!!disconnectNotice, 'Player4 notified of Player3 disconnect');
  drainMessages(p4);
  drainMessages(checker);

  // Cleanup
  p4.send('room:leave');
  await sleep(200);
  p4.ws.close();
  p2.ws.close();
  checker.ws.close();
  await sleep(500);

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Test error:', err.message);
  process.exit(1);
});
