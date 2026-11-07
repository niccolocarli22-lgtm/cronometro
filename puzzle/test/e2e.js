/*
 * End-to-end check of the app in headless Chromium:
 * opens the example, visits every view, uploads a synthetic scan (PNG with
 * DPI metadata) and confirms/rejects a suggested joint.
 *
 *   node puzzle/test/e2e.js [outDir]
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const out = process.argv[2] || path.join(__dirname, 'out');
fs.mkdirSync(out, { recursive: true });
const url = 'file://' + path.join(__dirname, '..', 'index.html');

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  // 1. make a synthetic scan PNG
  const gen = await browser.newPage();
  await gen.setContent('<html><body></body></html>');
  await gen.addScriptTag({ path: path.join(__dirname, '..', 'synth.js') });
  const pngB64 = await gen.evaluate(() => {
    const pz = PuzzleSynth.generatePuzzle({ cols: 8, rows: 6, seed: 5 });
    const list = pz.pieces.filter((p) => p.row >= 1 && p.row <= 4 && p.col >= 2 && p.col <= 6).slice(0, 20);
    const r = PuzzleSynth.renderScan(list, { dpi: 300, seed: 3, perturb: 0.05, shadow: 0.1 });
    return r.canvas.toDataURL('image/png').split(',')[1];
  });
  // add a pHYs chunk (300 dpi) after IHDR so the app reads the resolution
  const png = Buffer.from(pngB64, 'base64');
  const ihdrEnd = 8 + 4 + 4 + 13 + 4;
  const phys = Buffer.alloc(4 + 4 + 9 + 4);
  phys.writeUInt32BE(9, 0); phys.write('pHYs', 4, 'ascii');
  phys.writeUInt32BE(11811, 8); phys.writeUInt32BE(11811, 12); phys.writeUInt8(1, 16);
  const crcTable = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  let crc = 0xffffffff; for (const b of phys.subarray(4, 17)) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
  phys.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 17);
  const scanPath = path.join(out, 'scansione-prova.png');
  fs.writeFileSync(scanPath, Buffer.concat([png.subarray(0, ihdrEnd), phys, png.subarray(ihdrEnd)]));
  await gen.close();

  for (const vp of [{ name: 'phone', width: 390, height: 844 }, { name: 'desk', width: 1280, height: 900 }]) {
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
    page.on('pageerror', (e) => errors.push(vp.name + ': ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g/.test(m.text())) errors.push(vp.name + ' console: ' + m.text()); });
    const t0 = Date.now();
    await page.goto(url);
    await page.waitForSelector('.scan-card', { timeout: 30000 });
    console.log(vp.name, 'example ready in', Date.now() - t0, 'ms');
    const shot = async (n) => page.screenshot({ path: path.join(out, vp.name + '-' + n + '.png'), fullPage: false });
    await shot('1-scansioni');
    await page.goto(url + '#pezzi'); await page.waitForSelector('.pc'); await shot('2-pezzi');
    const firstNum = await page.$eval('.pc .pc-num', (e) => e.textContent.replace('#', ''));
    await page.goto(url + '#pezzo-' + firstNum); await page.waitForSelector('.sides'); await shot('3-pezzo');
    await page.goto(url + '#ricostruzione'); await page.waitForSelector('#board-svg'); await shot('4-ricostruzione');
    const before = await page.$eval('#status', (e) => e.textContent);
    await page.click('.next [data-act="confirm"]');
    await page.waitForTimeout(200);
    const after = await page.$eval('#status', (e) => e.textContent);
    console.log(vp.name, 'status', before, '->', after);
    await page.click('.next [data-act="reject"]');
    await page.waitForTimeout(200);
    await shot('5-dopo-risposte');
    await page.goto(url + '#guida'); await shot('6-guida');
    // overflow check
    for (const h of ['scansioni', 'pezzi', 'pezzo-' + firstNum, 'ricostruzione', 'guida']) {
      await page.goto(url + '#' + h);
      await page.waitForTimeout(150);
      const ov = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (ov > 0) errors.push(vp.name + ' horizontal overflow ' + ov + 'px on #' + h);
    }
    if (vp.name === 'phone') {
      // upload the synthetic scan
      await page.goto(url + '#scansioni');
      await page.setInputFiles('#file-scan', scanPath);
      await page.waitForFunction(() => location.hash.startsWith('#scansione-'), null, { timeout: 60000 });
      await page.waitForTimeout(300);
      await shot('7-scansione-caricata');
      const st = await page.$eval('#status', (e) => e.textContent);
      const meta = await page.$$eval('.warnlist li', (els) => els.map((e) => e.textContent));
      console.log('after upload:', st, meta);
      await page.goto(url + '#ricostruzione'); await page.waitForSelector('#board-svg'); await shot('8-ricostruzione-scansione');
      const sz = await page.$$eval('.stat b', (els) => els.map((e) => e.textContent));
      console.log('board stats', sz);
      // reload: data must persist in browser storage
      await page.reload();
      await page.waitForSelector('#status');
      await page.waitForTimeout(1500);
      console.log('after reload:', await page.$eval('#status', (e) => e.textContent));
    }
    await page.close();
  }
  await browser.close();
  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no errors');
})().catch((e) => { console.error(e); process.exit(1); });
