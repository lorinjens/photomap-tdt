/* 为 README 拍 5 套配色截图：headless Chrome + CDP，零依赖。
 * 用法：node shots.js  （内部自起 serve.js:8975，拍完自收）
 * 产物：assets/shots/theme-<name>.jpg（JPEG q85，README 直接引用）
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const cdp = require('../tools/lib/cdp.js');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8975;
const TK = 'ad0462490f7d7e24e56c2e13b4d4b516'; // 本机拍图用，不入库（截图像素里不含 tk）
const THEMES = ['paper', 'night', 'ink', 'abyss', 'clay'];
const sleep = cdp.sleep;

const waitServer = (tries = 40) => new Promise((res, rej) => {
  const ping = (n) => {
    http.get({ host: '127.0.0.1', port: PORT, path: '/' }, (r) => { r.resume(); res(); })
      .on('error', () => { if (n <= 0) rej(new Error('serve 没起来')); else setTimeout(() => ping(n - 1), 250); });
  };
  ping(tries);
});

const waitPins = async (sess, timeoutMs = 35000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      /* pins 是方法（返回当前 pin 列表），不是数组——别用 .length 判 */
      const ok = await sess.evaluate('(()=>{try{return !!(window.__tdt && __tdt.pins && __tdt.pins() && __tdt.pins().length>0)}catch(e){return false}})()');
      if (ok) return true;
    } catch (_) {}
    await sleep(500);
  }
  return false;
};

(async () => {
  fs.mkdirSync(path.join(ROOT, 'assets', 'shots'), { recursive: true });
  const serve = spawn(process.execPath, [path.join(ROOT, 'tools', 'serve.js'), String(PORT)], {
    cwd: ROOT, env: { ...process.env, MAP_NO_OPEN: '1' }, stdio: 'ignore',
  });
  try {
    await waitServer();
    const log = [];
    for (const theme of THEMES) {
      const b = cdp.launchChrome({ cdpPort: 9223, width: 1280, height: 800, dpr: 1, url: `http://127.0.0.1:${PORT}/?theme=${theme}&tk=${TK}` });
      try {
        const sess = await cdp.attach(9223, '127.0.0.1:' + PORT);
        const ready = await waitPins(sess);
        await sleep(5000); // 等底图瓦片铺满
        const shot = await sess.send('Page.captureScreenshot', { format: 'jpeg', quality: 85, captureBeyondViewport: false });
        const file = path.join(ROOT, 'assets', 'shots', `theme-${theme}.jpg`);
        fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
        log.push(`${theme}: ready=${ready} ${(fs.statSync(file).size / 1024).toFixed(0)}KB`);
        sess.close();
      } finally { await b.dispose(); }
    }
    console.log(log.join('\n'));
  } finally { serve.kill(); }
})().catch((e) => { console.error('SHOTS FAILED:', e.message); process.exit(1); });
