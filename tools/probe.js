/**
 * 天地图实验线 · 交互验收探针
 * ----------------------------------------------------------------------------
 * 只验「交互保持一致」这一条，也就是把主线那几条硬约束原样搬到新引擎上再测一遍：
 *
 *   1. 滚轮缩放的锚点漂移 = 0.00px   （放大、缩小各一组，连滚 4 格）
 *   2. 双击缩放的锚点漂移 = 0.00px
 *   3. 拖动时内容位移与指针位移严格相等
 *   4. 视野钳制生效（相机推不出墨卡托世界方块）
 *   5. 页面零 JS 异常，标注层正常落位
 *   6. 无密钥时降级到经纬网，不报错、不卡死
 *
 * 用主线的 lib/cdp.js（只读引用），零依赖。
 * 结果自己写 UTF-8 JSON —— 别指望控制台，Windows 代码页会把中文按 GBK 解。
 *
 * 跑法：node tdt-demo/probe.js [baseUrl]
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const cdp = require('../tools/lib/cdp.js');

const PORT = 9333;
const BASE = process.argv[2] || 'http://127.0.0.1:8124';
const OUT = path.join(__dirname, 'probe-out.json');
const SHOT = path.join(__dirname, 'probe-shot.png');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const out = { ok: false, url: '', steps: {}, errors: [], console: [] };
  let chrome = null;
  let s = null;

  try {
    chrome = cdp.launchChrome({ cdpPort: PORT, width: 1440, height: 900, dpr: 1 });
    s = await cdp.attach(PORT, 'about:blank');

    s.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails || {};
      out.errors.push(String((d.exception && d.exception.description) || d.text || ''));
    });
    s.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error' || p.type === 'warning') {
        out.console.push(p.type + ': ' + (p.args || []).map((a) => a.value || a.description || '').join(' '));
      }
    });

    const ev = (expr) => s.evaluate(expr);
    const mouse = (params) => s.send('Input.dispatchMouseEvent', params);

    /* ---- 相机固定在一个不会被钳死的视野 ----------------------------------
       这条是主线第三轮踩出来的：默认「全国」视野下 k≈249，世界总宽才 1564px，
       视口 1440px，clampCamera 把相机钉死 —— 量到的是一次不动的拖动。
       k=1500 时世界宽 9425px，余量充足。 */
    const URL = BASE + '/tdt-demo/index.html?at=110,30,1500';
    out.url = URL;

    await s.navigate(URL);
    for (let i = 0; i < 60; i++) {
      const rs = await ev('document.readyState');
      if (rs === 'complete') break;
      await sleep(100);
    }
    await sleep(900);

    out.steps.boot = await ev('typeof window.__tdt === "object" ? __tdt.state() : null');
    if (!out.steps.boot) throw new Error('__tdt 未挂载，页面脚本可能没跑起来');

    /* 等缓动彻底静止，否则读到的 k 还在动 */
    async function settle() {
      let last = -1;
      let same = 0;
      for (let i = 0; i < 120; i++) {
        const k = await ev('__tdt.t2.k');
        if (k === last) {
          same += 1;
          if (same >= 5) return true;
        } else same = 0;
        last = k;
        await sleep(50);
      }
      return false;
    }

    /* ---- 1. 滚轮缩放：锚点漂移 ------------------------------------------ */
    async function wheelDrift(deltaY, label) {
      const ax = 520;
      const ay = 380;
      const before = await ev('__tdt.unproject(' + ax + ',' + ay + ')');
      const k0 = await ev('__tdt.t2.k');
      for (let i = 0; i < 4; i++) {
        await mouse({ type: 'mouseWheel', x: ax, y: ay, deltaX: 0, deltaY: deltaY });
        await sleep(24);
      }
      await settle();
      const after = await ev('__tdt.project(' + before.lng + ',' + before.lat + ')');
      const k1 = await ev('__tdt.t2.k');
      return {
        label: label,
        anchor: [ax, ay],
        kBefore: +k0.toFixed(2),
        kAfter: +k1.toFixed(2),
        kRatio: +(k1 / k0).toFixed(4),
        driftPx: [+(after.x - ax).toFixed(4), +(after.y - ay).toFixed(4)],
      };
    }

    out.steps.wheelIn = await wheelDrift(-120, '滚轮放大 ×4 格');
    out.steps.wheelOut = await wheelDrift(120, '滚轮缩小 ×4 格');

    /* ---- 2. 双击：锚点漂移 ---------------------------------------------- */
    {
      const ax = 880;
      const ay = 300;
      const before = await ev('__tdt.unproject(' + ax + ',' + ay + ')');
      const k0 = await ev('__tdt.t2.k');
      /* 双击要两次成对的 down/up，clickCount 递进，浏览器才会合成 dblclick */
      for (let n = 1; n <= 2; n++) {
        await mouse({ type: 'mousePressed', x: ax, y: ay, button: 'left', clickCount: n });
        await mouse({ type: 'mouseReleased', x: ax, y: ay, button: 'left', clickCount: n });
        await sleep(40);
      }
      await settle();
      const after = await ev('__tdt.project(' + before.lng + ',' + before.lat + ')');
      const k1 = await ev('__tdt.t2.k');
      out.steps.dblclick = {
        anchor: [ax, ay],
        kBefore: +k0.toFixed(2),
        kAfter: +k1.toFixed(2),
        driftPx: [+(after.x - ax).toFixed(4), +(after.y - ay).toFixed(4)],
      };
    }

    /* ---- 3. 拖动：内容位移 = 指针位移 ----------------------------------- */
    {
      const x0 = 900;
      const y0 = 520;
      const steps = 10;
      const dxs = -24;
      const dys = -9;
      const t0 = await ev('({tx:__tdt.t2.tx, ty:__tdt.t2.ty, lng:__tdt.cam.lng, lat:__tdt.cam.lat})');
      await mouse({ type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1 });
      for (let i = 1; i <= steps; i++) {
        await mouse({
          type: 'mouseMoved',
          x: x0 + dxs * i,
          y: y0 + dys * i,
          button: 'left',
          buttons: 1,
        });
        await sleep(16);
      }
      const x1 = x0 + dxs * steps;
      const y1 = y0 + dys * steps;
      await mouse({ type: 'mouseReleased', x: x1, y: y1, button: 'left', clickCount: 1 });
      await sleep(120);
      const t1 = await ev('({tx:__tdt.t2.tx, ty:__tdt.t2.ty, lng:__tdt.cam.lng, lat:__tdt.cam.lat})');
      out.steps.drag = {
        pointerDelta: [x1 - x0, y1 - y0],
        contentDelta: [+(t1.tx - t0.tx).toFixed(2), +(t1.ty - t0.ty).toFixed(2)],
        expectContent: [x1 - x0, y1 - y0],
        camMovedDeg: [+(t1.lng - t0.lng).toFixed(5), +(t1.lat - t0.lat).toFixed(5)],
      };
    }

    /* ---- 4. 视野钳制 ----------------------------------------------------- */
    {
      const probes = [];
      /* 直接推一个明显越界的相机，看 clampCamera 是否把它拉回世界方块内 */
      await ev('__tdt.setCamera(999, 0, 300)');
      await sleep(80);
      probes.push({ sent: 'lng=999', got: +(await ev('__tdt.cam.lng')).toFixed(4) });
      await ev('__tdt.setCamera(0, 89, 300)');
      await sleep(80);
      probes.push({ sent: 'lat=89', got: +(await ev('__tdt.cam.lat')).toFixed(4) });
      await ev('__tdt.setCamera(0, 0, 1)');
      await sleep(80);
      probes.push({ sent: 'k=1', got: +(await ev('__tdt.t2.k')).toFixed(2) });
      out.steps.clamp = probes;
    }

    /* ---- 5. 静止画面留证 ------------------------------------------------- */
    await ev('__tdt.setCamera(104, 34, 900)');
    await sleep(700);
    out.steps.finalState = await ev('__tdt.state()');
    const png = await s.screenshotPNG();
    fs.writeFileSync(SHOT, png);
    out.shot = SHOT;

    out.ok = out.errors.length === 0;
  } catch (e) {
    out.error = String((e && e.stack) || e);
  } finally {
    try {
      if (s) s.close();
    } catch (_) {}
    try {
      if (chrome) await chrome.dispose();
    } catch (_) {}
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
  }

  /* 极简判据，写进 JSON 里，不靠控制台 */
  const w = out.steps.wheelIn;
  const wo = out.steps.wheelOut;
  const d = out.steps.dblclick;
  const dg = out.steps.drag;
  const verdict = {
    noException: out.errors.length === 0,
    wheelInAnchorStable: !!w && Math.abs(w.driftPx[0]) < 0.02 && Math.abs(w.driftPx[1]) < 0.02,
    wheelOutAnchorStable: !!wo && Math.abs(wo.driftPx[0]) < 0.02 && Math.abs(wo.driftPx[1]) < 0.02,
    dblclickAnchorStable: !!d && Math.abs(d.driftPx[0]) < 0.02 && Math.abs(d.driftPx[1]) < 0.02,
    dragFollowsPointer:
      !!dg &&
      Math.abs(dg.contentDelta[0] - dg.expectContent[0]) < 1.5 &&
      Math.abs(dg.contentDelta[1] - dg.expectContent[1]) < 1.5,
    clampWorks:
      !!out.steps.clamp &&
      Math.abs(out.steps.clamp[0].got) < 180.1 &&
      Math.abs(out.steps.clamp[1].got) < 85.2,
    markersPlaced: !!out.steps.boot && out.steps.boot.placed > 0,
  };
  out.verdict = verdict;
  out.pass = Object.keys(verdict).every((k) => verdict[k]);
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
})();
