/**
 * 天地图实验线 · 瓦片拼接验收探针
 * ----------------------------------------------------------------------------
 * 验的是「换掉自绘底图」这件事本身对不对，与密钥无关：
 * 借测试缝 ?fake（data:SVG 伪造瓦片，每张印着自己的 z/x/y），把栅格底图这条
 * 链路里最容易出错的三件事钉死 ——
 *
 *   1. 层级选择：k 反推出的 z 是否落在合理区间，瓦片屏幕尺寸是否等于 2π·k/2^z
 *   2. 铺满：视口内不得露出海面底色（漏铺 = 瓦片索引范围算错）
 *   3. 拼缝：相邻瓦片之间不得露出底色细线（浮点误差的经典表现）
 *   另外顺带看：注记层是否真的叠在底图之上，而不是被后画的 vec 盖掉。
 *
 * 判读办法：把 CSS 滤镜与色罩临时摘掉再截图。滤镜会把浅色瓦片和深色海面
 * 一起压到同一个灰阶，两边的差别被抹平，什么也看不出来 ——
 * 摘掉之后瓦片是浅蓝 #dfe9f2、海面是近黑 #070b12，一眼可分。
 *
 * 跑法：node tdt-demo/probe-tiles.js [baseUrl]
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const cdp = require('../tools/lib/cdp.js');

const PORT = 9334;
const BASE = process.argv[2] || 'http://127.0.0.1:8124';
const OUT = path.join(__dirname, 'probe-tiles.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const out = { ok: false, cases: [], errors: [] };
  let chrome = null;
  let s = null;

  try {
    chrome = cdp.launchChrome({ cdpPort: PORT, width: 1440, height: 900, dpr: 1 });
    s = await cdp.attach(PORT, 'about:blank');
    s.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails || {};
      out.errors.push(String((d.exception && d.exception.description) || d.text || ''));
    });

    const ev = (expr) => s.evaluate(expr);

    /* 一次完整的「载入 → 等瓦片静止 → 摘滤镜 → 截图 → 统计」 */
    async function runCase(label, query, withNote) {
      await s.navigate(BASE + '/tdt-demo/index.html?' + query);
      for (let i = 0; i < 60; i++) {
        if ((await ev('document.readyState')) === 'complete') break;
        await sleep(100);
      }
      /* 等瓦片全部落地：tiles 不再增长且没有在途请求 */
      let last = -1;
      let stable = 0;
      for (let i = 0; i < 120; i++) {
        const st = await ev('__tdt.state()');
        if (st.tiles === last && st.inFlight === 0) {
          stable += 1;
          if (stable >= 4) break;
        } else stable = 0;
        last = st.tiles;
        await sleep(80);
      }

      /* 摘掉调色层与标注层，只留瓦片本身 */
      await ev(
        'document.getElementById("cv").style.filter="none";' +
          'document.getElementById("veil").style.display="none";' +
          'document.getElementById("overlay").style.display="none";' +
          'document.querySelector(".stage__grid").style.display="none";'
      );
      await sleep(400);

      const st = await ev('__tdt.state()');
      const png = await s.screenshotPNG();
      const shot = path.join(__dirname, 'probe-tiles-' + label + '.png');
      fs.writeFileSync(shot, png);

      const img = cdp.decodePNG(png);
      const px = (x, y) => {
        const i = (y * img.w + x) * img.ch;
        return [img.data[i], img.data[i + 1], img.data[i + 2]];
      };

      /* 统计：近黑 = 露出的海面底色；浅色 = 瓦片 */
      let dark = 0;
      let light = 0;
      let total = 0;
      const darkSpots = [];
      for (let y = 34; y < img.h - 34; y += 6) {
        for (let x = 34; x < img.w - 34; x += 6) {
          const p = px(x, y);
          total += 1;
          if (p[0] < 40 && p[1] < 40 && p[2] < 40) {
            dark += 1;
            if (darkSpots.length < 24) darkSpots.push([x, y]);
          } else if (p[0] > 170) light += 1;
        }
      }

      /* 接缝检测：假瓦片自带 2px 的 #7f9ec4 边框，海面是近黑。
         沿一条横线扫，出现「近黑」就说明两张瓦片之间漏了一道缝。 */
      const seamY = Math.round(img.h / 2);
      let seamRuns = 0;
      let run = 0;
      for (let x = 10; x < img.w - 10; x += 1) {
        const p = px(x, seamY);
        if (p[0] < 40 && p[1] < 40 && p[2] < 40) {
          run += 1;
        } else {
          if (run >= 2) seamRuns += 1;
          run = 0;
        }
      }

      /* 瓦片屏幕尺寸的理论值：tp = 2π·k / 2^z，用来反查 z 选得对不对 */
      const k = st.k;
      const worldPx = 2 * Math.PI * k;
      const zTheory = Math.round(Math.log2(worldPx / 256));
      const tpTheory = (2 * Math.PI * k) / Math.pow(2, st.z);

      out.cases.push({
        label: label,
        query: query,
        withNote: !!withNote,
        z: st.z,
        zTheory: zTheory,
        tilePxOnScreen: +tpTheory.toFixed(2),
        tilesCached: st.tiles,
        inFlight: st.inFlight,
        sampleDarkRatio: +(dark / total).toFixed(4),
        sampleLightRatio: +(light / total).toFixed(4),
        darkSpots: darkSpots.slice(0, 8),
        seamDarkRunsOnMidRow: seamRuns,
        shot: shot,
      });
      return out.cases[out.cases.length - 1];
    }

    await runCase('z5', 'fake=1&theme=night&at=110,30,1500', false);
    await runCase('world', 'fake=1&theme=night&at=104,34,220', false);
    await runCase('city', 'fake=1&theme=night&at=120.15,30.25,12000', false);
    await runCase('note', 'fake=1&theme=night&at=110,30,1500&note', true);

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
})();
