/* 极简 CDP 驱动（零依赖，只用 Node 标准库 + 全局 WebSocket）。
   perf-probe.js / visual-diff.js 共用。

   为什么不用 puppeteer：
     本项目全部工具都是零依赖的（见 tools/serve.js 的说明），
     装一个 puppeteer 要拖进几十兆的浏览器包，还得联网。
     Node 22 自带 WebSocket，直连 CDP 就够了。

   注意：Node 18 没有全局 WebSocket，会在 launchChrome 里显式报错。 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

function findChrome() {
  const env = process.env.CHROME_PATH;
  if (env && fs.existsSync(env)) return env;
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('找不到 Chrome/Edge。可用 CHROME_PATH 环境变量指定可执行文件路径。');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 结束整棵浏览器进程树，并等它真的死透。
 *
 *  两个都要做，缺一个就删不掉 profile：
 *  1) Windows 上 `proc.kill()` 只终止拿到句柄的那一个进程。Chrome 还会另起
 *     renderer / gpu / utility 一串子进程，它们各自握着 profile 里的文件句柄，
 *     子进程没走，目录就删不掉。`taskkill /T` 才连子进程一起收。
 *  2) `kill` 只是**发信号就返回**，进程还在慢慢死。所以必须等 `exit` 事件。
 *     早年这里就是「kill 完立刻 rmSync」，而 `force: true` 把 EBUSY 一声不吭
 *     吞掉 —— 清理看着跑了，实际一次都没成功，临时目录攒到过 1.26GB。 */
async function killTree(proc) {
  if (!proc || !proc.pid) return;
  const exited = new Promise((res) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return res();
    proc.once('exit', res);
    return undefined;
  });
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch (_) { /* taskkill 不在 PATH 也不该让收尾挂掉 */ }
  } else {
    try { proc.kill('SIGKILL'); } catch (_) {}
  }
  await Promise.race([exited, sleep(5000)]);
}

/**
 * 起一个带调试端口的浏览器实例。
 * 每次都用独立的临时 profile —— 复用同一个 profile 会让「第二次运行」
 * 带着上一次的缓存与 localStorage，实测数据就不是同一件事了。
 */
function launchChrome(opts) {
  if (typeof WebSocket !== 'function') {
    throw new Error('当前 Node 没有全局 WebSocket（需要 Node 22+）');
  }
  const o = opts || {};
  const port = o.cdpPort || 9222;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pmcdp-' + process.pid + '-'));
  const args = [
    o.headful ? '--new-window' : '--headless=new',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile,
    '--window-size=' + (o.width || 1440) + ',' + (o.height || 900),
    '--force-device-scale-factor=' + (o.dpr || 1),
    /* 截图逐像素比对要求渲染确定：固定色彩配置、关掉次像素抗锯齿，
       否则同一份代码两次跑出来的文字边缘都可能不一样。 */
    '--force-color-profile=srgb',
    '--disable-lcd-text',
    '--proxy-server=direct://',
    '--proxy-bypass-list=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--disable-background-networking',
    '--mute-audio',
    '--hide-scrollbars',
    o.url || 'about:blank',
  ];
  const proc = spawn(findChrome(), args, { stdio: 'ignore' });
  return {
    proc,
    profile,
    async dispose() {
      await killTree(proc);
      for (let i = 0; i < 12; i += 1) {
        try { fs.rmSync(profile, { recursive: true, force: true }); return; } catch (_) { await sleep(400); }
      }
      /* 删不掉不致命（在系统临时目录里），但必须出声。
         静默失败正是这套目录涨到 GB 级却没人发现的原因。 */
      console.warn('临时 profile 未能删除，请手工清理：' + profile);
    },
  };
}

/** 等页面 target 出现并连上，返回一个会话对象 */
async function attach(port, urlMatch, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 25000);
  let wsUrl = null;
  while (Date.now() < deadline) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/json/list');
      const list = await r.json();
      const page = list.find((t) => t.type === 'page' && (!urlMatch || t.url.indexOf(urlMatch) >= 0));
      if (page && page.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
    } catch (_) { /* 浏览器还没起来 */ }
    await sleep(200);
  }
  if (!wsUrl) throw new Error('等待 CDP target 超时（' + port + '）');

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('CDP WebSocket 连接失败'));
  });

  let seq = 0;
  const pending = new Map();
  /* CDP 事件（没有 id 的消息）的订阅表。Tracing 这类方法的结果不是返回值，
     而是一串异步事件（Tracing.dataCollected / Tracing.tracingComplete），
     没有这条通道就拿不到它们。 */
  const listeners = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message));
      else p.resolve(m.result);
      return;
    }
    if (m.method && listeners.has(m.method)) {
      for (const fn of listeners.get(m.method)) {
        try { fn(m.params); } catch (_) { /* 订阅者的异常不该弄死连接 */ }
      }
    }
  };

  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    });

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error('页面内异常: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
    }
    return r.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');

  return {
    send,
    evaluate,
    /** 订阅 CDP 事件。返回取消订阅的函数。 */
    on(method, fn) {
      if (!listeners.has(method)) listeners.set(method, new Set());
      listeners.get(method).add(fn);
      return () => listeners.get(method).delete(fn);
    },
    close() { try { ws.close(); } catch (_) {} },
    /** 截当前视口，返回 { w, h, ch, data } 的原始像素 */
    async screenshotRaw() {
      const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      return decodePNG(Buffer.from(r.data, 'base64'));
    },
    async screenshotPNG() {
      const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      return Buffer.from(r.data, 'base64');
    },
    async navigate(url) {
      await send('Page.navigate', { url });
    },
  };
}

/* ------------------------------------------------------------------ PNG 解码
   只解 Chrome 截图会产出的形态：8bit、非隔行、colorType 0/2/6。
   这一段是为了逐像素比对 —— 直接比 PNG 字节也能判「是否完全相同」，
   但一旦不同就想知道「差在哪、差多少」，那就必须解到像素。 */
function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let pos = 8;
  let w = 0;
  let h = 0;
  let colorType = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      if (data[8] !== 8) throw new Error('只支持 8bit PNG，实际 ' + data[8]);
      colorType = data[9];
      if (data[12] !== 0) throw new Error('不支持隔行 PNG');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if (!ch) throw new Error('不支持的 colorType ' + colorType);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let rp = 0;
  for (let y = 0; y < h; y += 1) {
    const ft = raw[rp++];
    const cur = out.subarray(y * stride, (y + 1) * stride);
    raw.copy(cur, 0, rp, rp + stride);
    rp += stride;
    if (ft === 0) continue;
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    if (ft === 1) {
      for (let i = ch; i < stride; i += 1) cur[i] = (cur[i] + cur[i - ch]) & 255;
    } else if (ft === 2) {
      if (!prev) continue;
      for (let i = 0; i < stride; i += 1) cur[i] = (cur[i] + prev[i]) & 255;
    } else if (ft === 3) {
      for (let i = 0; i < stride; i += 1) {
        const a = i >= ch ? cur[i - ch] : 0;
        const b = prev ? prev[i] : 0;
        cur[i] = (cur[i] + ((a + b) >> 1)) & 255;
      }
    } else if (ft === 4) {
      for (let i = 0; i < stride; i += 1) {
        const a = i >= ch ? cur[i - ch] : 0;
        const b = prev ? prev[i] : 0;
        const c = prev && i >= ch ? prev[i - ch] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        cur[i] = (cur[i] + pr) & 255;
      }
    } else {
      throw new Error('未知的 PNG 滤波类型 ' + ft);
    }
  }
  return { w, h, ch, data: out };
}

/* ------------------------------------------------------------ PNG 编码
   要把差异画出来看，就必须有个编码器。只做「8bit、真彩、不隔行」这一种，
   够用且不容易写错 —— 唯一需要小心的是 CRC 与滤波字节。 */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** rgbs: Buffer(w*h*3) → PNG Buffer */
function encodePNG(w, h, rgbs) {
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y += 1) {
    raw[y * (w * 3 + 1)] = 0; /* filter: none */
    rgbs.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; /* truecolor */
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 截一块区域。scale 为整数倍放大（最近邻），坐标可越界，越界处填黑。
 *
 *  输出尺寸**必须取整**。w/h 常常来自 getBoundingClientRect（CSS 像素带小数），
 *  乘上 dpr 与 scale 之后仍带小数 —— 那时 `Buffer.alloc(w*s*h*s*3)` 会得到一个
 *  非整数长度，Uint8Array 向下取整，于是缓冲区比「按行读」的模式短一截：
 *  末尾若干像素越界，读出来是 undefined，一路变成 NaN。
 *  NaN 不会报错，它只是让所有比较都返回 false —— 症状是「图明明有内容，
 *  量出来却一片空白」。这个坑害过一次副标题分隔符的像素核查：整列着墨算成 0。
 *  整数入参行为不变（Math.round 对整数是恒等）。
 *
 *  返回的对象必须带 `ch: 3` —— 裁剪结果一律按 3 通道写入，而调用方会像
 *  对待 decodePNG 的结果一样用 `img.ch` 去索引像素。少了这个字段，
 *  `(y * w + x) * undefined` 就是 NaN，读出来全是 undefined，
 *  再经亮度计算变成 NaN —— 同样不报错，只让所有比较静默返回 false。
 *  上面那条「必须取整」和这条「必须带 ch」是同一次踩坑的两半。 */
function crop(img, x0, y0, w, h, scale) {
  const s = Math.max(1, Math.round(scale || 1));
  const W = Math.max(0, Math.round(w * s));
  const H = Math.max(0, Math.round(h * s));
  const out = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y += 1) {
    const sy = y0 + Math.floor(y / s);
    for (let x = 0; x < W; x += 1) {
      const sx = x0 + Math.floor(x / s);
      const o = (y * W + x) * 3;
      if (sx < 0 || sy < 0 || sx >= img.w || sy >= img.h) continue; /* 黑 */
      const p = (sy * img.w + sx) * img.ch;
      out[o] = img.data[p];
      out[o + 1] = img.data[p + 1];
      out[o + 2] = img.data[p + 2];
    }
  }
  return { w: W, h: H, ch: 3, data: out };
}

/** 两帧逐像素比对。返回差异统计；identical 为 true 时才是「真的没变」。 */
function diffPixels(a, b) {
  if (a.w !== b.w || a.h !== b.h) {
    return { identical: false, sizeMismatch: true, aSize: [a.w, a.h], bSize: [b.w, b.h] };
  }
  const n = a.w * a.h;
  let differing = 0;
  let maxDelta = 0;
  let sumDelta = 0;
  let worst = null;
  const perChannel = [0, 0, 0, 0];
  for (let i = 0; i < n; i += 1) {
    const pa = i * a.ch;
    const pb = i * b.ch;
    let d = 0;
    for (let c = 0; c < Math.min(a.ch, b.ch); c += 1) {
      const dd = Math.abs(a.data[pa + c] - b.data[pb + c]);
      if (dd) perChannel[c] += 1;
      if (dd > d) d = dd;
    }
    if (d) {
      differing += 1;
      sumDelta += d;
      if (d > maxDelta) {
        maxDelta = d;
        worst = [i % a.w, Math.floor(i / a.w)];
      }
    }
  }
  return {
    identical: differing === 0,
    total: n,
    differing,
    ratio: +(differing / n).toFixed(8),
    maxDelta,
    meanDeltaOnDiff: differing ? +(sumDelta / differing).toFixed(3) : 0,
    perChannel,
    worstPixel: worst,
  };
}

/** 在 ±r 的整数像素窗口里找「让两张图最像」的平移量。
 *
 *  为什么需要它：两张图有 10% 的像素不同、且差异弥散全屏时，
 *  有两种截然不同的可能 ——
 *    (a) 内容被整体挪了半个像素（线条边缘全变，但挪回去就重合）；
 *    (b) 内容真的不一样（少画了东西、颜色不同）。
 *  两者的「差异像素数」可以一模一样，修法却完全相反。
 *  扫一遍小窗口就能把这两种分开：若在某个非零偏移处差异骤降，
 *  就是 (a)，且那个偏移就是错位量。
 *
 *  抽样统计（每 3 个像素取 1 个，差异阈值 8）—— 目的是分辨模式，不是精算。 */
function bestShift(a, b, r) {
  const R = r || 3;
  if (a.w !== b.w || a.h !== b.h) return null;
  const step = 3;
  let best = null;
  let atZero = null;
  for (let dy = -R; dy <= R; dy += 1) {
    for (let dx = -R; dx <= R; dx += 1) {
      let diff = 0;
      let n = 0;
      for (let y = Math.max(0, dy); y < a.h + Math.min(0, dy); y += step) {
        for (let x = Math.max(0, dx); x < a.w + Math.min(0, dx); x += step) {
          const pa = (y * a.w + x) * a.ch;
          const pb = ((y - dy) * b.w + (x - dx)) * b.ch;
          let d = 0;
          for (let c = 0; c < Math.min(a.ch, b.ch); c += 1) {
            const dd = Math.abs(a.data[pa + c] - b.data[pb + c]);
            if (dd > d) d = dd;
          }
          if (d > 8) diff += 1;
          n += 1;
        }
      }
      const ratio = diff / n;
      if (dx === 0 && dy === 0) atZero = +ratio.toFixed(5);
      if (!best || ratio < best.ratio) best = { dx, dy, ratio: +ratio.toFixed(5), samples: n };
    }
  }
  if (best) best.atZero = atZero;
  return best;
}

/** 估两张图之间的**亚像素**平移量（单位：截图像素）。
 *
 *  为什么整数平移不够：地图上满是细线、斜向网纹与文字边，
 *  整体错开 0.4 个像素就足以让每个边缘像素都变一点 ——
 *  差异像素数能到 10%，而整数平移一格都挪不动（挪一格反而更差）。
 *  这时「差异多少像素」完全区分不出「错位」与「画错了」，
 *  必须把那个小数位量出来：真错位会给出一个 0.2~0.6 的值，
 *  内容真的不同则给出的值会乱跳、且残差依然很大。
 *
 *  做法：取中心区域，算「A 与 B 平移 (sx,sy) 后」的绝对差之和（SAD），
 *  先在整数格上找最小值，再在 x、y 两个方向各用三点抛物线插值到小数。 */
function subpixelShift(a, b, range) {
  const R = range || 5;
  const CH = Math.min(a.ch, b.ch);
  if (a.w !== b.w || a.h !== b.h) return null;
  const m = 4; /* 四周留边，平移后仍在图内 */
  const step = 4; /* 抽样步长：这一步决定耗时的平方级增长，够分辨即可 */
  const sad = (sx, sy) => {
    let s = 0;
    let n = 0;
    for (let y = m; y < a.h - m; y += step) {
      for (let x = m; x < a.w - m; x += step) {
        const pa = (y * a.w + x) * CH;
        const pb = ((y - sy) * b.w + (x - sx)) * CH;
        for (let c = 0; c < CH; c += 1) s += Math.abs(a.data[pa + c] - b.data[pb + c]);
        n += 1;
      }
    }
    return n ? s / n : Infinity;
  };
  let best = null;
  for (let sy = -R; sy <= R; sy += 1) {
    for (let sx = -R; sx <= R; sx += 1) {
      const v = sad(sx, sy);
      if (!best || v < best.v) best = { sx, sy, v };
    }
  }
  /* 抛物线插值：用最优点及其两侧邻居拟合顶点，得到小数位移。
     只在曲线上取到真极小（两侧都更高）时才用，否则退回整数结果。 */
  const sub = (cx, cy, axis) => {
    const v0 = sad(axis === 'x' ? cx - 1 : cx, axis === 'x' ? cy : cy - 1);
    const v1 = best.v;
    const v2 = sad(axis === 'x' ? cx + 1 : cx, axis === 'x' ? cy : cy + 1);
    const den = v0 - 2 * v1 + v2;
    if (!(den > 0) || !isFinite(v0) || !isFinite(v2)) return 0;
    const d = (0.5 * (v0 - v2)) / den;
    return Math.abs(d) <= 1 ? d : 0;
  };
  const fx = best.sx + sub(best.sx, best.sy, 'x');
  const fy = best.sy + sub(best.sx, best.sy, 'y');
  return {
    x: +fx.toFixed(3), y: +fy.toFixed(3),
    intX: best.sx, intY: best.sy,
    sadBest: +best.v.toFixed(3),
    sadZero: +sad(0, 0).toFixed(3),
  };
}

/* ------------------------------------------------- 差异区域图（文本）
   diffPixels 只回答「差了多少」，不回答「差在哪」。
   而定位一个几何缺陷，「差在哪」才是决定性的那一半 ——
   一个百分比从 0.3% 涨到 6%，可能是「边缘多了一条带」，
   也可能是「整块区域错位」，两者的修法完全不同。

   把画面切成 cells 个格子、逐格统计差异，再用字符密度画出来，
   一眼就能分辨这两类。 */
function diffRegions(a, b, cols, rows) {
  const C = cols || 24;
  const R = rows || 13;
  if (a.w !== b.w || a.h !== b.h) return null;
  const cells = new Array(C * R).fill(0);
  let n = 0;
  let x0 = a.w;
  let y0 = a.h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < a.h; y += 1) {
    const cy = Math.min(R - 1, Math.floor((y * R) / a.h));
    for (let x = 0; x < a.w; x += 1) {
      const pa = (y * a.w + x) * a.ch;
      const pb = pa;
      let d = 0;
      for (let c = 0; c < Math.min(a.ch, b.ch); c += 1) {
        const dd = Math.abs(a.data[pa + c] - b.data[pb + c]);
        if (dd > d) d = dd;
      }
      if (!d) continue;
      n += 1;
      const cx = Math.min(C - 1, Math.floor((x * C) / a.w));
      cells[cy * C + cx] += 1;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  /* 每格占全图的比例，用于选字符密度。 */
  const per = (a.w / C) * (a.h / R);
  const grid = [];
  for (let r = 0; r < R; r += 1) {
    let line = '';
    for (let c = 0; c < C; c += 1) {
      const v = cells[r * C + c] / per;
      line += v === 0 ? '.' : v < 0.02 ? ':' : v < 0.1 ? '+' : v < 0.35 ? '#' : v < 0.7 ? '%' : '@';
    }
    grid.push(line);
  }
  return {
    differing: n,
    bbox: x1 < 0 ? null : [x0, y0, x1, y1],
    grid,
    /* 四边各取 12% 的条带，看差异是不是集中在某一边 ——
       条带补图出错时的典型特征就是「可见的带里少了东西」。 */
    edges: (() => {
      const mw = Math.round(a.w * 0.12);
      const mh = Math.round(a.h * 0.12);
      let L = 0;
      let Rt = 0;
      let T = 0;
      let B = 0;
      for (let r = 0; r < R; r += 1) {
        for (let c = 0; c < C; c += 1) {
          const v = cells[r * C + c];
          if (!v) continue;
          const cxp = (c + 0.5) * (a.w / C);
          const cyp = (r + 0.5) * (a.h / R);
          if (cxp < mw) L += v;
          if (cxp > a.w - mw) Rt += v;
          if (cyp < mh) T += v;
          if (cyp > a.h - mh) B += v;
        }
      }
      return { left: L, right: Rt, top: T, bottom: B };
    })(),
  };
}

module.exports = {
  findChrome, launchChrome, attach, decodePNG, encodePNG, crop,
  diffPixels, diffRegions, bestShift, subpixelShift, sleep,
};
