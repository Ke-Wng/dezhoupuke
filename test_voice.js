/**
 * Test WebRTC voice signaling through WebSocket
 */
const WebSocket = require('ws');

const URL = 'ws://localhost:3000';
let passed = 0, failed = 0;

function assert(cond, msg) {
  if (cond) { console.log(`  ✅ ${msg}`); passed++; }
  else { console.log(`  ❌ ${msg}`); failed++; }
}

function createClient(name) {
  return new Promise((resolve) => {
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
  });
}

function waitForMessage(client, type, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeout);
    const check = () => {
      const idx = client.messages.findIndex(m => m.type === type);
      if (idx >= 0) {
        clearTimeout(timer);
        const msg = client.messages.splice(idx, 1)[0];
        resolve(msg);
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
  console.log('\n=== Voice Chat Signaling Test ===\n');

  // 1. Create two players
  console.log('1. Creating two players...');
  const p1 = await createClient('Alice');
  const p2 = await createClient('Bob');
  assert(p1.playerId, `P1 authenticated: ${p1.playerId.slice(0,8)}`);
  assert(p2.playerId, `P2 authenticated: ${p2.playerId.slice(0,8)}`);

  // 2. P1 creates a room
  console.log('\n2. P1 creates room...');
  p1.send('room:create', { name: 'Alice' });
  const created = await waitForMessage(p1, 'room:created');
  const code = created.data.code;
  assert(code, `Room created: ${code}`);

  // 3. P2 joins the room
  console.log('\n3. P2 joins room...');
  p2.send('room:join', { code, name: 'Bob' });
  const joined = await waitForMessage(p2, 'room:joined');
  assert(joined.data.code === code, 'P2 joined successfully');
  await sleep(300);

  // 4. P1 sends voice:join
  console.log('\n4. Testing voice:join signaling...');
  p1.send('voice:join', { name: 'Alice' });
  
  // P2 should receive voice:join from P1
  const voiceJoin = await waitForMessage(p2, 'voice:join');
  assert(voiceJoin.data.fromId === p1.playerId, 'P2 received voice:join from P1');
  assert(voiceJoin.data.fromName === 'Alice', 'voice:join includes sender name');

  // 5. P2 sends voice:join back
  console.log('\n5. P2 joins voice...');
  p2.send('voice:join', { name: 'Bob' });
  const voiceJoin2 = await waitForMessage(p1, 'voice:join');
  assert(voiceJoin2.data.fromId === p2.playerId, 'P1 received voice:join from P2');

  // 6. Test voice:offer (P1 -> P2)
  console.log('\n6. Testing voice:offer signaling...');
  const fakeSDP = { type: 'offer', sdp: 'v=0\r\no=- 123 1 IN IP4 0.0.0.0\r\n...' };
  p1.send('voice:offer', { targetId: p2.playerId, sdp: fakeSDP });
  const offer = await waitForMessage(p2, 'voice:offer');
  assert(offer.data.fromId === p1.playerId, 'P2 received offer from P1');
  assert(offer.data.sdp.type === 'offer', 'Offer SDP forwarded correctly');

  // 7. Test voice:answer (P2 -> P1)
  console.log('\n7. Testing voice:answer signaling...');
  const fakeAnswer = { type: 'answer', sdp: 'v=0\r\no=- 456 1 IN IP4 0.0.0.0\r\n...' };
  p2.send('voice:answer', { targetId: p1.playerId, sdp: fakeAnswer });
  const answer = await waitForMessage(p1, 'voice:answer');
  assert(answer.data.fromId === p2.playerId, 'P1 received answer from P2');
  assert(answer.data.sdp.type === 'answer', 'Answer SDP forwarded correctly');

  // 8. Test voice:ice-candidate (P1 -> P2)
  console.log('\n8. Testing voice:ice-candidate signaling...');
  const fakeCandidate = { candidate: 'candidate:1 1 udp 2130706431 192.168.1.1 50000 typ host', sdpMid: '0', sdpMLineIndex: 0 };
  p1.send('voice:ice-candidate', { targetId: p2.playerId, candidate: fakeCandidate });
  const ice = await waitForMessage(p2, 'voice:ice-candidate');
  assert(ice.data.fromId === p1.playerId, 'P2 received ICE candidate from P1');
  assert(ice.data.candidate.candidate.includes('192.168.1.1'), 'ICE candidate data intact');

  // 9. Test voice:leave
  console.log('\n9. Testing voice:leave signaling...');
  p1.send('voice:leave', {});
  const voiceLeave = await waitForMessage(p2, 'voice:leave');
  assert(voiceLeave.data.fromId === p1.playerId, 'P2 received voice:leave from P1');

  // 10. Test auto voice:leave on disconnect
  console.log('\n10. Testing auto voice:leave on disconnect...');
  // P1 rejoins voice
  p1.send('voice:join', { name: 'Alice' });
  await waitForMessage(p2, 'voice:join');
  
  // P2 disconnects
  p2.ws.close();
  const autoLeave = await waitForMessage(p1, 'voice:leave', 5000);
  assert(autoLeave.data.fromId === p2.playerId, 'Auto voice:leave on disconnect works');

  // Cleanup
  p1.ws.close();
  await sleep(500);

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Test error:', err.message);
  process.exit(1);
});
