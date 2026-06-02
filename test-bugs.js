const fs = require('fs');
const path = require('path');
const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const SCREENSHOT_DIR = path.join(__dirname, '..', 'dezhoupuke', 'test-screenshots');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function ss(page, name) {
  const fp = path.join(SCREENSHOT_DIR, `bug-${name}.png`);
  await page.screenshot({ path: fp });
  console.log(`  📸 ${name}`);
}

async function main() {
  const { default: puppeteer } = await import('puppeteer-core');
  const browser = await puppeteer.launch({
    executablePath: EDGE_PATH, headless: 'new',
    args: ['--no-sandbox', '--window-size=1280,900', '--disable-gpu'],
    defaultViewport: { width: 1280, height: 900 },
  });
  try {
    const page = await browser.newPage();
    page.on('pageerror', err => console.error('  ⚠ PAGE ERROR:', err.message));

    await page.goto('http://47.106.206.100:3000', { waitUntil: 'networkidle2', timeout: 15000 });
    await sleep(2000);

    // Navigate & start AI game
    await page.evaluate(() => {
      document.querySelectorAll('.action-card').forEach(c => {
        if (c.textContent.includes('新建房间')) c.click();
      });
    });
    await sleep(1500);
    await page.evaluate(() => { document.getElementById('botGameBtn')?.click(); });
    await sleep(1000);
    await page.evaluate(() => { document.getElementById('botGameBtn')?.click(); });
    await sleep(3000);

    // Wait for game + click start
    for (let i = 0; i < 10; i++) {
      await sleep(2000);
      const r = await page.evaluate(() => {
        if (document.querySelectorAll('.seat').length > 0) return 'ok';
        for (const b of document.querySelectorAll('button')) {
          if (b.textContent.includes('开始游戏')) { b.click(); return 'start'; }
        }
        return 'wait';
      });
      if (r === 'ok') break;
      if (r === 'start') await sleep(5000);
    }
    await ss(page, 'game-active');

    // === BUG CHECK 1: Are other players' cards face-down? ===
    console.log('\n--- Check 1: Card visibility ---');
    const cardCheck = await page.evaluate(() => {
      const seats = document.querySelectorAll('.seat');
      const myId = window.Net?.playerId;
      const results = [];
      seats.forEach((seat, i) => {
        const pid = seat.dataset.playerId;
        const isMe = pid === myId;
        const seatCards = seat.querySelector('.seat-cards');
        const myHand = seat.querySelector('.my-hand');
        const cardsEl = seatCards || myHand;
        if (!cardsEl) { results.push({ seat: i, isMe, hasCards: false }); return; }
        const cardEls = cardsEl.querySelectorAll('.card');
        const cardDetails = Array.from(cardEls).map(c => ({
          isBack: c.classList.contains('card-back') || c.querySelector('.card-back-inner') !== null,
          classes: c.className,
          text: c.textContent.trim().substring(0, 20),
        }));
        results.push({ seat: i, isMe, hasCards: true, cardCount: cardEls.length, cards: cardDetails });
      });
      return { myId, results };
    });
    console.log('My ID:', cardCheck.myId);
    cardCheck.results.forEach(r => {
      if (r.hasCards) {
        r.cards.forEach((c, ci) => {
          const status = c.isBack ? '🔒 FACE-DOWN' : '🔓 FACE-UP';
          console.log(`  Seat ${r.seat} (${r.isMe ? 'ME' : 'BOT'}) card ${ci}: ${status} [${c.text}]`);
          if (!r.isMe && !c.isBack) {
            console.log(`  ❌ BUG: Other player's card is face-up!`);
          }
        });
      } else {
        console.log(`  Seat ${r.seat} (${r.isMe ? 'ME' : 'BOT'}): no cards element`);
      }
    });

    // === BUG CHECK 2: Bet display near seats ===
    console.log('\n--- Check 2: Bet display ---');
    const betCheck = await page.evaluate(() => {
      const seats = document.querySelectorAll('.seat');
      return Array.from(seats).map((seat, i) => {
        const betEl = seat.querySelector('.seat-bet');
        const stackText = seat.querySelector('.seat-stack')?.textContent || '';
        return {
          seat: i,
          hasBet: !!betEl,
          betText: betEl?.textContent || '',
          stack: stackText,
          pid: seat.dataset.playerId,
        };
      });
    });
    betCheck.forEach(b => {
      console.log(`  Seat ${b.seat}: stack=${b.stack} bet=${b.hasBet ? b.betText : 'none'}`);
    });

    // === BUG CHECK 3: SB/BB markers ===
    console.log('\n--- Check 3: SB/BB markers ---');
    const markerCheck = await page.evaluate(() => {
      const blinds = document.querySelectorAll('.blind-btn');
      return Array.from(blinds).map(b => ({
        text: b.textContent,
        parentClass: b.parentElement?.className || '',
        pos: b.getBoundingClientRect(),
      }));
    });
    console.log(`  Found ${markerCheck.length} blind markers`);
    markerCheck.forEach(m => {
      console.log(`  ${m.text}: attached to ${m.parentClass.substring(0, 40)}`);
    });

    // === BUG CHECK 4: Interact trigger positioning ===
    console.log('\n--- Check 4: Interact triggers ---');
    const interactCheck = await page.evaluate(() => {
      const triggers = document.querySelectorAll('.interact-trigger');
      return Array.from(triggers).map((t, i) => {
        const seat = t.closest('.seat');
        const seatRect = seat?.getBoundingClientRect();
        const trigRect = t.getBoundingClientRect();
        return {
          index: i,
          seatClass: seat?.className || '',
          seatPos: seatRect ? { x: Math.round(seatRect.x), y: Math.round(seatRect.y) } : null,
          trigPos: { x: Math.round(trigRect.x), y: Math.round(trigRect.y) },
          visible: t.style.display !== 'none',
        };
      });
    });
    interactCheck.forEach(t => {
      console.log(`  Trigger ${t.index}: seat=(${t.seatPos?.x},${t.seatPos?.y}) trig=(${t.trigPos.x},${t.trigPos.y}) visible=${t.visible}`);
    });

    // === BUG CHECK 5: Play a full hand and check showdown ===
    console.log('\n--- Check 5: Play full hand ---');
    for (let round = 0; round < 12; round++) {
      const act = await page.evaluate(() => {
        const p = document.getElementById('actionPanel');
        if (p?.classList.contains('active')) {
          for (const b of p.querySelectorAll('.action-btn')) {
            if (b.textContent.includes('过牌')) { b.click(); return 'check'; }
            if (b.textContent.includes('跟注')) { b.click(); return 'call'; }
            if (b.textContent.includes('弃牌')) { b.click(); return 'fold'; }
          }
        }
        return 'waiting';
      });
      if (act !== 'waiting') {
        console.log(`  Round ${round}: ${act}`);
        await ss(page, `hand-r${round}-${act}`);
      }
      await sleep(2500);
    }
    await ss(page, 'hand-complete');

    // Check cards after hand ends (showdown or next hand)
    const postHand = await page.evaluate(() => {
      const phase = document.querySelector('.game-phase, #phaseLabel')?.textContent || '';
      const seats = document.querySelectorAll('.seat');
      return {
        phase,
        seats: Array.from(seats).map((seat, i) => {
          const seatCards = seat.querySelector('.seat-cards');
          if (!seatCards) return { seat: i, cards: 'none' };
          const cards = seatCards.querySelectorAll('.card');
          return {
            seat: i,
            cardCount: cards.length,
            faceUp: Array.from(cards).filter(c => !c.classList.contains('card-back') && !c.querySelector('.card-back-inner')).length,
            faceDown: Array.from(cards).filter(c => c.classList.contains('card-back') || c.querySelector('.card-back-inner')).length,
          };
        }),
      };
    });
    console.log(`  Phase: ${postHand.phase}`);
    postHand.seats.forEach(s => {
      if (typeof s.faceUp !== 'undefined') {
        console.log(`  Seat ${s.seat}: ${s.faceUp} face-up, ${s.faceDown} face-down`);
      }
    });

    // === BUG CHECK 6: Mobile viewport test ===
    console.log('\n--- Check 6: Mobile layout ---');
    await page.setViewport({ width: 375, height: 812, isMobile: true });
    await sleep(2000);
    await ss(page, 'mobile-view');

    console.log('\n✅ All checks complete!');
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await browser.close();
  }
}
main().catch(console.error);
