const fs = require('fs');
const path = require('path');

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const URL = 'http://47.106.206.100:3000';
const SCREENSHOT_DIR = path.join(__dirname, 'test-screenshots');
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function ss(page, name) {
  const fp = path.join(SCREENSHOT_DIR, `${name}.png`);
  await page.screenshot({ path: fp, fullPage: false });
  console.log(`  📸 ${name}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const { default: puppeteer } = await import('puppeteer-core');
  console.log('Launching Edge headless...');
  const browser = await puppeteer.launch({
    executablePath: EDGE_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--window-size=1280,900', '--disable-gpu'],
    defaultViewport: { width: 1280, height: 900 },
  });

  try {
    const page = await browser.newPage();
    page.on('pageerror', err => console.error('  ⚠ PAGE ERROR:', err.message));

    // === 1. Load page ===
    console.log('1. Loading page...');
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 15000 });
    await sleep(2000);
    await ss(page, '01-loaded');

    // === 2. Navigate to create room page ===
    console.log('2. Navigating to create room...');
    await page.evaluate(() => {
      const cards = document.querySelectorAll('.action-card');
      for (const c of cards) {
        if (c.textContent.includes('新建房间')) { c.click(); return; }
      }
    });
    await sleep(1500);
    await ss(page, '02-create-page');

    // === 3. Click 人机对战 FIRST time (shows difficulty options) ===
    console.log('3. Clicking AI battle (1st click - show options)...');
    await page.evaluate(() => {
      const btn = document.getElementById('botGameBtn');
      if (btn) btn.click();
    });
    await sleep(1000);
    await ss(page, '03-ai-options');

    // === 4. Click 人机对战 SECOND time (actually start game) ===
    console.log('4. Clicking AI battle (2nd click - start game)...');
    await page.evaluate(() => {
      const btn = document.getElementById('botGameBtn');
      if (btn) btn.click();
    });
    await sleep(3000);
    await ss(page, '04-ai-starting');

    // === 5. Wait for room to load, then click "开始游戏" ===
    console.log('5. Waiting for room and starting game...');
    for (let i = 0; i < 10; i++) {
      await sleep(2000);
      const result = await page.evaluate(() => {
        if (document.querySelectorAll('.seat').length > 0) return 'game_started';
        const btns = document.querySelectorAll('button');
        for (const b of btns) {
          if (b.textContent.includes('开始游戏')) { b.click(); return 'clicked_start'; }
        }
        const scr = document.querySelector('.screen.active');
        return 'waiting:' + (scr ? scr.id : 'none');
      });
      console.log(`  [${i*2}s] ${result}`);
      await ss(page, `05-wait-${i}`);
      if (result === 'game_started') break;
      if (result === 'clicked_start') { await sleep(5000); }
    }
    await ss(page, '06-game');

    // === 6. Check seats ===
    console.log('6. Checking seats...');
    const seats = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('.seat')).map((s, i) => ({
        i, cls: s.className, pid: s.dataset.playerId,
        info: !!s.querySelector('.seat-info'),
        cards: !!(s.querySelector('.seat-cards') || s.querySelector('.my-hand')),
        interact: !!s.querySelector('.interact-trigger'),
        x: Math.round(s.getBoundingClientRect().x),
        y: Math.round(s.getBoundingClientRect().y),
      }));
    });
    console.log(`  Found ${seats.length} seats`);
    seats.forEach(s => console.log(`  Seat ${s.i}: pid=${s.pid} info=${s.info} cards=${s.cards} interact=${s.interact} pos=(${s.x},${s.y})`));

    if (seats.length === 0) {
      console.log('  No seats. Checking page state...');
      const state = await page.evaluate(() => {
        const scr = document.querySelector('.screen.active');
        const table = document.getElementById('gameTable');
        return {
          activeScreen: scr ? scr.id : 'none',
          tableExists: !!table,
          tableChildren: table ? table.children.length : 0,
          allBtns: Array.from(document.querySelectorAll('button'))
            .map(b => b.textContent.trim()).filter(t => t.length > 0 && t.length < 20),
        };
      });
      console.log('  State:', JSON.stringify(state, null, 2));
    }

    // === 7. Flicker test ===
    if (seats.length > 0) {
      console.log('7. Flicker test (10s, 500ms interval)...');
      let prevIds = null, stable = 0, changed = 0;
      for (let i = 0; i < 20; i++) {
        await sleep(500);
        const ids = await page.evaluate(() =>
          Array.from(document.querySelectorAll('.seat')).map(s => s.dataset.playerId)
        );
        if (prevIds) {
          JSON.stringify(ids) === JSON.stringify(prevIds) ? stable++ : changed++;
        }
        prevIds = ids;
      }
      console.log(`  Stable: ${stable}, Changed: ${changed}`);
      console.log(changed === 0 ? '  ✅ No flickering!' : '  ⚠ Seats changed!');
    }

    // === 8. Play a few rounds ===
    console.log('8. Playing game...');
    for (let round = 0; round < 8; round++) {
      const act = await page.evaluate(() => {
        const p = document.getElementById('actionPanel');
        if (p && p.classList.contains('active')) {
          const btns = p.querySelectorAll('.action-btn');
          for (const b of btns) {
            if (b.textContent.includes('弃牌')) { b.click(); return 'fold'; }
            if (b.textContent.includes('过牌')) { b.click(); return 'check'; }
            if (b.textContent.includes('跟注')) { b.click(); return 'call'; }
          }
        }
        return 'waiting';
      });
      console.log(`  Round ${round}: ${act}`);
      await sleep(3000);
      if (act !== 'waiting') await ss(page, `08-${act}-${round}`);
    }
    await ss(page, '09-final');

    // === 9. Test emoji interact ===
    if (seats.length > 0) {
      console.log('9. Testing emoji interact...');
      const interactResult = await page.evaluate(() => {
        const trig = document.querySelector('.interact-trigger');
        if (trig) { trig.click(); return 'clicked'; }
        return 'not found';
      });
      console.log('  → ' + interactResult);
      await sleep(1000);
      const panel = await page.evaluate(() => {
        const p = document.getElementById('interactPanel');
        if (p && p.classList.contains('active')) {
          const r = p.getBoundingClientRect();
          return { visible: true, x: Math.round(r.x), y: Math.round(r.y) };
        }
        return { visible: false };
      });
      console.log('  Panel:', JSON.stringify(panel));
      await ss(page, '10-interact');
    }

    console.log('\n✅ Test complete!');
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await browser.close();
  }
}
main().catch(console.error);
