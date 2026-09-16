/**
 * 天地图实验线 · 照片资产可达性专项读数
 * ----------------------------------------------------------------------------
 * 背景：演示照片原先存了 PNG(51.5MB) + WebP(2.6MB) 两套，线上靠 Nginx 内容协商
 * （`.png` 的 URL 优先发同名 `.webp`）。把 `photo-data.js` 的 src 直接改成 webp 之后，
 * PNG 就成了纯冗余。删原件之前必须先证明 webp 这一套**能用**，且**页面真的在用**。
 *
 * 于是本探针取三组读数，全部来自运行时：
 *
 *   A. HTTP —— 逐个 fetch 18 个 webp 的 status。只证明「拿得到」。
 *   B. 解码 —— `new Image(); await decode()` 后读 naturalWidth。
 *              这一步才证明「能显示」—— HTTP 200 但扩展名/内容不符时，
 *              A 绿而 B 红，两者必须分开。
 *   C. DOM  —— 页面上真实渲染出来的缩略图数量 + 页面自身发出的资源请求状态。
 *              证明「页面确实在用它」，而不是「文件恰好在服务器上」。
 *
 * 另外把 PNG 的 status 一并记下来（只记录、不作判据）：归档之后应为 404。
 *
 * 结果自己写 UTF-8 JSON —— Windows 控制台会把中文按 GBK 解。
 *
 * 跑法：node tdt-demo/probe-photos.js [baseUrl]
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const cdp = require('../tools/lib/cdp.js');

const PORT = 9341;
const BASE = process.argv[2] || 'http://127.0.0.1:8124';
const OUT = path.join(__dirname, 'probe-photos.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const N = 18;

/* 阶段心跳。本机控制台拿不到 Node 的实时输出（且 `timeout`/`cat` 都不可用），
   探针一旦卡住就只剩「进程被 kill」这一个现象。所以每一步都自己落盘，
   卡在哪一步可以直接读文件，不用靠猜。 */
const STAGE = path.join(__dirname, 'probe-photos.stages.txt');
const t0 = Date.now();
function stage(name) {
  try {
    fs.appendFileSync(STAGE, '+' + String(Date.now() - t0).padStart(6) + 'ms  ' + name + '\n', 'utf8');
  } catch (_) {}
}
try {
  fs.writeFileSync(STAGE, '', 'utf8');
} catch (_) {}

/* 页面内探针。拆成三段独立的求值，原因有二：
   ① 长表达式一旦不返回，就只剩「进程被 kill」这一个现象，无法定位；
   ② 原本还想 fetch 一遍 PNG 作对照 —— 那会在页面里顺序下载 51 MB，
      既是无谓开销也是可疑的卡死源。归档之后改从文件系统核对更直接。 */
const P_WEBP_FETCH = `(async () => {
  const nums = Array.from({ length: ${N} }, (_, i) => String(i + 1).padStart(2, '0'));
  const out = [];
  for (const n of nums) {
    const url = 'assets/photo-' + n + '.webp';
    let status = 'ERR';
    try { const r = await fetch(url); status = r.status; } catch (e) {}
    out.push({ n: n, status: status });
  }
  return JSON.stringify(out);
})()`;

const P_WEBP_DECODE = `(async () => {
  const nums = Array.from({ length: ${N} }, (_, i) => String(i + 1).padStart(2, '0'));
  const out = [];
  for (const n of nums) {
    const url = 'assets/photo-' + n + '.webp';
    let ok = false;
    let nw = 0;
    try {
      const im = new Image();
      im.src = url;
      await im.decode();
      nw = im.naturalWidth;
      ok = nw > 0;
    } catch (e) {}
    out.push({ n: n, decoded: ok, naturalWidth: nw });
  }
  return JSON.stringify(out);
})()`;

const P_DOM = `JSON.stringify((function () {
  const imgs = Array.prototype.map.call(document.querySelectorAll('img'), function (e) {
    return { s: String(e.currentSrc || e.src).slice(0, 48), nw: e.naturalWidth, c: e.complete };
  });
  return {
    imgTotal: imgs.length,
    imgBlob: imgs.filter(function (x) { return /^blob:/.test(x.s); }).length,
    imgBroken: imgs.filter(function (x) { return x.c && x.nw === 0; }).length,
    canvasTotal: document.querySelectorAll('canvas').length,
    marks: document.querySelectorAll('.mk').length,
    pinNames: document.querySelectorAll('.pin__name').length,
  };
})())`;

(async () => {
  const out = { ok: false, url: '', errors: [], console: [], failed: [], pass: false, checks: {}, http: [], data: null };
  let chrome = null;
  let s = null;

  try {
    stage('launchChrome 前');
    chrome = cdp.launchChrome({ cdpPort: PORT, width: 1440, height: 900, dpr: 1 });
    stage('launchChrome 后');
    s = await cdp.attach(PORT, 'about:blank');
    stage('attach 后');

    s.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails || {};
      out.errors.push(String((d.exception && d.exception.description) || d.text || ''));
    });
    s.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error' || p.type === 'warning') {
        out.console.push(p.type + ': ' + (p.args || []).map((a) => a.value || a.description || '').join(' '));
      }
    });

    /* 记录页面自身发出的每一个 /assets/ 请求的状态码 —— DOM 之外的第二条证据 */
    const http = [];
    try {
      await s.send('Network.enable', {});
      s.on('Network.responseReceived', (p) => {
        const r = p.response || {};
        if (String(r.url || '').indexOf('/assets/') >= 0) {
          http.push({ url: String(r.url).replace(/^https?:\/\/[^/]+/, ''), status: r.status, mime: r.mimeType });
        }
      });
    } catch (e) {
      out.console.push('Network.enable 失败: ' + String(e && e.message));
    }

    const ev = (expr) => s.evaluate(expr);

    const URL = BASE + '/tdt-demo/index.html?fake&theme=paper&at=104,34,1172';
    out.url = URL;
    stage('navigate 前');
    await s.navigate(URL);
    stage('navigate 后');
    for (let i = 0; i < 80; i++) {
      const rs = await ev('document.readyState');
      if (rs === 'complete') break;
      await sleep(100);
    }
    stage('readyState=complete');
    await sleep(1500);
    stage('1.5s 稳定期结束');

    const fetchRows = JSON.parse(await ev(P_WEBP_FETCH));
    stage('A 组 fetch 返回');
    const decodeRows = JSON.parse(await ev(P_WEBP_DECODE));
    stage('B 组解码返回');
    const dom = JSON.parse(await ev(P_DOM));
    stage('C 组 DOM 返回');
    out.data = { webp: fetchRows.map((r, i) => ({ n: r.n, status: r.status, decoded: decodeRows[i].decoded, naturalWidth: decodeRows[i].naturalWidth })), dom: dom };
    await sleep(400);
    out.http = http;
    stage('HTTP 记录收集完毕');

    /* ---------------- 判据 ---------------- */
    const d = out.data;
    const webp200 = d.webp.filter((w) => w.status === 200).length;
    const webpDecoded = d.webp.filter((w) => w.decoded).length;
    const pagePhoto = out.http.filter((h) => /photo-\d+\./.test(h.url));
    const pageBad = pagePhoto.filter((h) => h.status >= 400);

    const checks = {
      webpAll200: webp200 === N,
      webpAllDecoded: webpDecoded === N,
      /* 页面自身的照片请求不得有 4xx/5xx —— 这条才绑住「页面真的在用 webp」 */
      pageNoBadPhoto: pageBad.length === 0,
      /* 渲染出的缩略图：blob 图或 canvas 至少得有一个来源 */
      thumbsRendered: d.dom.marks > 0 && (d.dom.imgBlob > 0 || d.dom.canvasTotal > 1),
      noBrokenImg: d.dom.imgBroken === 0,
      noExceptions: out.errors.length === 0,
    };

    for (const k of Object.keys(checks)) if (!checks[k]) out.failed.push(k);
    out.checks = checks;
    out.pass = out.failed.length === 0;
    out.ok = true;
    out.summary = {
      webp200: webp200 + '/' + N,
      webpDecoded: webpDecoded + '/' + N,
      pagePhotoRequests: pagePhoto.length,
      pagePhotoBad: pageBad.length,
      marks: d.dom.marks,
      imgBlob: d.dom.imgBlob,
      canvasTotal: d.dom.canvasTotal,
      imgBroken: d.dom.imgBroken,
      pinNames: d.dom.pinNames,
    };

    fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
    stage('判据写完，pass=' + out.pass);
    console.log('ok  pass=' + out.pass + '  failed=' + out.failed.length + '  webp=' + webpDecoded + '/' + N + '  errors=' + out.errors.length);
  } catch (e) {
    out.error = String((e && e.stack) || e);
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
    stage('异常: ' + out.error.split('\n')[0]);
    console.log('FAILED: ' + out.error);
  } finally {
    stage('finally 进入');
    try {
      if (s) s.close();
    } catch (_) {}
    try {
      if (chrome) await chrome.dispose();
    } catch (_) {}
    stage('finally 结束');
  }
  process.exit(out.pass ? 0 : 1);
})();
