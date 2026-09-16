/* 聚合过渡动画的逐帧诊断（不判 pass/fail，只出读数）。
   pass/fail 的判据在 probe-fill.js 的 4.10 段（6 条），这里负责把数字摊开。

   判据口径两条：
     ① 帧间位移 —— **扣掉相机运动**再统计。缩放会把整屏点一起甩动，
        而且甩动的幅度正比于「离锚点的距离」，所以「绝对位移」在缩放中毫无意义；
        逐轴取中位数当相机运动，残差才是「标注自己跳没跳」。
        同时只统计**两端都在视口内**的点对（屏幕外的位移没人看得见，
        算进去会把「从中国气泡散开」这种有意的长距离动画误判成跳变）。
     ② 收敛 —— 静止后 __tdt.anim() 必须给出 0 / 1 / 0。

   用法：
     node tdt-demo/probe-anim.js [outJson] [额外查询串]
     node tdt-demo/probe-anim.js out.json "&noanim"      # 对照组
   结果自己写 UTF-8 文件（控制台代码页会毁掉中文）。 */
const path = require('path');
const fs = require('fs');
const cdp = require(path.join(__dirname, '..', 'tools', 'lib', 'cdp.js'));

const OUT = process.argv[2] || path.join(__dirname, 'probe-anim.json');
const EXTRA = process.argv[3] || '';
const URL = 'http://127.0.0.1:8124/tdt-demo/index.html?fake&theme=night&at=105,35,201' + EXTRA;

const log = [];
function say(s) {
  log.push(String(s));
}

const SNAP = `(${function () {
  window.__vw = window.innerWidth;
  window.__vh = window.innerHeight;
  window.__pidSeq = 0;
  window.__rec = [];
  window.__recOn = true;
  const mkre = /translate3d\(([-\d.]+)px,\s*([-\d.]+)px/;
  (function loop() {
    if (!window.__recOn) return;
    const els = document.querySelectorAll('#overlay .mk');
    const arr = [];
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      if (!el.__pid) el.__pid = ++window.__pidSeq;
      const m = mkre.exec(el.style.transform || '');
      arr.push([el.__pid, m ? +m[1] : -99999, m ? +m[2] : -99999, el.textContent || '', +(el.style.opacity || 1)]);
    }
    window.__rec.push([performance.now(), arr]);
    requestAnimationFrame(loop);
  })();
  return 1;
}.toString()})()`;

const VIEW = `(${function () {
  const s = window.__tdt.state();
  const cl = window.__tdt.clusters();
  return {
    k: +s.k.toFixed(1),
    placed: s.placed,
    anim: window.__tdt.anim(),
    n: cl.length,
    labels: cl.map(function (c) {
      return c.label + '(' + c.n + ')';
    }),
  };
}.toString()})()`;

function analyze(rec, vw, vh) {
  const inView = (x, y) => x > -60 && x < vw + 60 && y > -60 && y < vh + 60;
  const dAll = [];
  const dIn = [];
  const rIn = [];
  let labelFlips = 0;
  let prev = null;
  const big = [];
  const med = (a) => {
    if (!a.length) return 0;
    const s = a.slice().sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  };
  for (const [ts, arr] of rec) {
    const cur = new Map();
    for (const [pid, x, y, label, op] of arr) cur.set(pid, { x, y, label, op });
    if (prev) {
      const raw = [];
      for (const [pid, v] of cur) {
        const p = prev.arr.get(pid);
        if (!p) continue;
        if (v.x <= -9000 || p.x <= -9000) continue;
        raw.push({ pid, p, v, dx: v.x - p.x, dy: v.y - p.y, d: Math.hypot(v.x - p.x, v.y - p.y) });
      }
      /* 关键口径：**逐轴中位数 = 相机整体运动**（缩放把整屏点一起甩动）。
         减去它得到「相对位移」—— 那才是标注自己跳没跳。
         不扣这一项，缩放过程中靠近锚点的点位移大就会被误读成跳变。 */
      const mdx = med(raw.map((r) => r.dx));
      const mdy = med(raw.map((r) => r.dy));
      for (const r of raw) {
        dAll.push(r.d);
        if (inView(r.p.x, r.p.y) && inView(r.v.x, r.v.y)) {
          dIn.push(r.d);
          const rd = Math.hypot(r.dx - mdx, r.dy - mdy);
          /* 只统计**两头都可见**的点对。池元素被回收再分配给另一个簇的那一帧，
             位移可以很大，但那时 alpha ≈ 0，屏幕上什么都看不见 ——
             算进来只会把「不可见的瞬移」误读成跳变（实测 max 817px 就是这么来的）。
             同理，判定「标签突变」也只在该元素真的可见时才有意义。 */
          if (r.v.op >= 0.5 && r.p.op >= 0.5) {
            rIn.push(rd);
            if (r.v.label !== r.p.label) labelFlips += 1;
            if (rd > 40) {
              big.push({
                ts: +ts.toFixed(0),
                resid: +rd.toFixed(1),
                abs: +r.d.toFixed(1),
                cam: [+mdx.toFixed(1), +mdy.toFixed(1)],
                label: r.v.label,
                from: [+r.p.x.toFixed(0), +r.p.y.toFixed(0)],
                to: [+r.v.x.toFixed(0), +r.v.y.toFixed(0)],
              });
            }
          }
        }
      }
    }
    prev = { ts, arr: cur };
  }
  const q = (a, p) => {
    if (!a.length) return null;
    const s = a.slice().sort((x, y) => x - y);
    return +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(2);
  };
  const dts = [];
  for (let i = 1; i < rec.length; i++) dts.push(rec[i][0] - rec[i - 1][0]);
  const dtsSorted = dts.slice().sort((a, b) => a - b);
  const qq = (a, p) => (a.length ? +a[Math.min(a.length - 1, Math.floor(a.length * p))].toFixed(1) : null);
  return {
    frames: rec.length,
    frameMsAvg: dts.length ? +(dts.reduce((a, b) => a + b, 0) / dts.length).toFixed(2) : null,
    frameMsP95: qq(dtsSorted, 0.95),
    frameMsMax: dts.length ? +Math.max.apply(null, dts).toFixed(1) : null,
    dAll: { p90: q(dAll, 0.9), p99: q(dAll, 0.99), max: dAll.length ? +Math.max.apply(null, dAll).toFixed(1) : null, n: dAll.length },
    dIn: { p50: q(dIn, 0.5), p90: q(dIn, 0.9), p99: q(dIn, 0.99), max: dIn.length ? +Math.max.apply(null, dIn).toFixed(1) : null, n: dIn.length },
    residIn: { p50: q(rIn, 0.5), p90: q(rIn, 0.9), p99: q(rIn, 0.99), max: rIn.length ? +Math.max.apply(null, rIn).toFixed(1) : null, n: rIn.length },
    labelFlips,
    bigSteps: big.length,
    bigTop: big.sort((a, b) => b.resid - a.resid).slice(0, 6),
  };
}

(async () => {
  const ch = cdp.launchChrome({ cdpPort: 9352, width: 1440, height: 900, dpr: 1 });
  let sess = null;
  const out = { url: URL };
  try {
    sess = await cdp.attach(9352, 'about:blank');
    await sess.navigate(URL);
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      const st = await sess.evaluate('(window.__tdt && __tdt.state().places) || 0');
      if (st > 0) break;
      await cdp.sleep(200);
    }
    await cdp.sleep(800);

    const vw = await sess.evaluate('window.innerWidth');
    const vh = await sess.evaluate('window.innerHeight');
    out.viewport = [vw, vh];

    out.base = await sess.evaluate(VIEW);
    say('【基线】k=' + out.base.k + ' 簇数=' + out.base.n + ' 动画=' + JSON.stringify(out.base.anim));
    say('标签: ' + out.base.labels.join(' '));

    /* ---------------- 1. 缩放（世界 → 5.8 倍，跨过 t = 0.5 的聚合粒度切换） ----------------
       倍率不能太小：k=201 → 643 时 chinaT 仍 < 0.5（国家级粒度），
       簇的成员构成根本没变，量不到「聚合 / 散开」这件事。
       5.8 倍把 k 从 201 推到约 1166，正好穿过 420~900 那条过渡带 ——
       「中国(61)」在这里分裂成十几个省气泡，那才是用户问的那个动作。 */
    /* 锚点必须落在**中国气泡自己身上**：世界视图下屏幕中心是几内亚湾
       （世界宽 1263px < 屏宽 1440px，被居中夹紧了），锚在屏幕中心放大
       会一路飞到欧洲去。取中国簇的原始屏幕位置当锚点，
       也就是「把光标放在中国上滚滚轮」—— 用户真实的做法。 */
    const anchor = await sess.evaluate(
      '(function(){var c=window.__tdt.clusters().filter(function(x){return x.label==="中国";})[0];return c?[c.sx,c.sy]:[720,450];})()'
    );
    say('中国气泡锚点: ' + JSON.stringify(anchor));
    out.anchor = anchor;

    const tZoom = await sess.evaluate(SNAP);
    void tZoom;
    await sess.evaluate('window.__tdt.zoomAt(5.8, ' + anchor[0] + ', ' + anchor[1] + ')');
    await cdp.sleep(1800);
    out.zoomIn = await sess.evaluate(VIEW);
    say('【放大后】k=' + out.zoomIn.k + ' 簇数=' + out.zoomIn.n + ' 动画=' + JSON.stringify(out.zoomIn.anim));
    say('标签: ' + out.zoomIn.labels.join(' '));

    await sess.evaluate('window.__tdt.zoomAt(1/5.8, ' + anchor[0] + ', ' + anchor[1] + ')');
    await cdp.sleep(1800);
    await sess.evaluate('window.__recOn = false');
    out.zoomBack = await sess.evaluate(VIEW);
    say('【缩回后】k=' + out.zoomBack.k + ' 簇数=' + out.zoomBack.n + ' 动画=' + JSON.stringify(out.zoomBack.anim));

    const recZoom = await sess.evaluate('window.__rec');
    out.zoom = analyze(recZoom, vw, vh);
    say('缩放: 绝对 p90=' + out.zoom.dIn.p90 + ' p99=' + out.zoom.dIn.p99 + ' max=' + out.zoom.dIn.max);
    say('缩放: 扣掉相机后 p50=' + out.zoom.residIn.p50 + ' p90=' + out.zoom.residIn.p90 + ' p99=' + out.zoom.residIn.p99 + ' max=' + out.zoom.residIn.max + ' (n=' + out.zoom.residIn.n + ')');
    say('缩放: 标签突变=' + out.zoom.labelFlips + ' 相对位移>40px 次数=' + out.zoom.bigSteps);
    out.zoom.bigTop.forEach((b, i) => say('  big#' + i + ' ' + JSON.stringify(b)));

    /* ---------------- 2. 拖动（零滞后 + 无进出场） ---------------- */
    await sess.evaluate(SNAP);
    const dragSamples = [];
    await sess.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 720, y: 470, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 24; i++) {
      await sess.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 720 + i * 8, y: 470, button: 'left', buttons: 1 });
      await cdp.sleep(16);
      if (i % 3 === 0) dragSamples.push(await sess.evaluate(VIEW));
    }
    await sess.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 912, y: 470, button: 'left', buttons: 0, clickCount: 1 });
    await cdp.sleep(400);
    await sess.evaluate('window.__recOn = false');
    const recDrag = await sess.evaluate('window.__rec');
    out.drag = analyze(recDrag, vw, vh);
    out.drag.samples = dragSamples.map((s) => ({ k: s.k, n: s.n, anim: s.anim }));
    say('拖动: 屏内 p50=' + out.drag.dIn.p50 + ' p90=' + out.drag.dIn.p90 + ' p99=' + out.drag.dIn.p99 + ' max=' + out.drag.dIn.max);
    say('拖动: 标签突变=' + out.drag.labelFlips);
    say('拖动采样动画态: ' + JSON.stringify(dragSamples.map((s) => s.anim)));
    out.dragAfter = await sess.evaluate(VIEW);
    say('拖动停止后: 动画=' + JSON.stringify(out.dragAfter.anim));

    /* ---------------- 3. 静止收敛（连等三帧都必须到位） ---------------- */
    await cdp.sleep(1200);
    const settle = [];
    for (let i = 0; i < 3; i++) {
      settle.push(await sess.evaluate('window.__tdt.anim()'));
      await cdp.sleep(120);
    }
    out.settle = settle;
    say('静止收敛三连: ' + JSON.stringify(settle));

    /* ---------------- 4. 程序化跳变不得触发动画 ---------------- */
    await sess.evaluate('window.__tdt.setCamera(116.4, 39.9, 3000)');
    await cdp.sleep(120);
    out.jump = await sess.evaluate('window.__tdt.anim()');
    say('setCamera 瞬时跳变后 120ms: ' + JSON.stringify(out.jump));
    await sess.evaluate('window.__tdt.setCamera(105, 35, 201)');
    await cdp.sleep(300);

    /* ---------------- 1b. 散开轨迹：新元素的**首帧位置** ----------------
       这里的判别法必须精确到帧，不能靠外部 60ms 轮询（会跳过诞生帧）：
       采样器挪进页面内，逐 rAF 记录每个 .mk 的 [pid, x, y, label, opacity]。
       pid 在「按 key 分配池元素」之后就是簇身份，所以「新 pid」= 新簇。

       判据（两条一起看才算数）：
         · 动画版：新元素首帧位置应当**贴着上一帧那个中国气泡**（距离≈0），
           之后逐帧飞向自己的目标 —— 这才是「散开」的轨迹；
         · 对照版（?noanim）：新元素首帧就落在目标位置，距离 = 该省到中国的真实距离。 */
    await sess.evaluate('window.__tdt.setCamera(105, 35, 201)');
    await cdp.sleep(500);
    await sess.evaluate(
      `(${function () {
        window.__kf = [];
        window.__kfOn = true;
        const re = /translate3d\(([-\d.]+)px,\s*([-\d.]+)px/;
        (function loop() {
          if (!window.__kfOn) return;
          const els = document.querySelectorAll('#overlay .mk');
          const arr = [];
          for (let i = 0; i < els.length; i++) {
            const el = els[i];
            if (!el.__pid) el.__pid = ++window.__pidSeq;
            const m = re.exec(el.style.transform || '');
            arr.push([el.__pid, m ? +m[1] : -99999, m ? +m[2] : -99999, el.textContent || '', +(el.style.opacity || 1)]);
          }
          window.__kf.push([Math.round(window.__tdt.state().k), arr]);
          requestAnimationFrame(loop);
        })();
        return 1;
      }.toString()})()`
    );
    await sess.evaluate('window.__tdt.clearBirths()');
    await sess.evaluate('window.__tdt.zoomAt(5.8, ' + anchor[0] + ', ' + anchor[1] + ')');
    await cdp.sleep(2000);
    await sess.evaluate('window.__kfOn = false');
    const kf = await sess.evaluate('window.__kf');
    /* 出生记录（引擎侧）：本次缩放期间「每个新簇从哪个上一帧簇长出来」。
       与上面那套 DOM 采样相互独立 —— 上面量的是「首帧落在哪」，
       这里量的是「引擎认为它属于谁」，两条都能被证伪。 */
    const births = (await sess.evaluate('__tdt.anim().births')) || [];
    out.birthsRaw = births;
    const withParent = births.filter((b) => b.from);
    const cross = withParent.filter((b) => b.fromRegion !== b.region);
    const noShare = withParent.filter((b) => b.shared < 1);
    const inPlace = births.filter((b) => !b.from);
    const cnFromCn = withParent.filter((b) => b.region === 'CN' && b.fromRegion === 'CN');
    out.birthRule = {
      n: births.length,
      withParent: withParent.length,
      /* 跨区域出生：**必须为 0**。旧版按几何最近选父簇，
         喀什（CN）会认迪拜（AE）当爹，这一项就是 1+。 */
      crossRegion: cross.length,
      crossSample: cross.slice(0, 4),
      /* 父簇不含子簇任何成员：**必须为 0**（无父的另行统计） */
      noShared: noShare.length,
      noSharedSample: noShare.slice(0, 4),
      /* 就地淡入（上一帧没有任何簇含过它，只可能是刚进视口） */
      inPlace: inPlace.length,
      inPlaceSample: inPlace.slice(0, 4).map((b) => b.key),
      cnFromCn: cnFromCn.length,
      prox: (await sess.evaluate('__tdt.anim().prox')) === true,
      pairs: withParent.slice(0, 10).map((b) => b.key + ' ← ' + b.from + ' [' + b.region + '←' + b.fromRegion + '] 共享' + b.shared + '/' + b.childN),
    };
    say('出生规则: 共 ' + out.birthRule.n + ' 个新簇，其中有父簇 ' + out.birthRule.withParent + '、就地淡入 ' + out.birthRule.inPlace);
    say('出生规则: 跨区域=' + out.birthRule.crossRegion + ' 父簇不含成员=' + out.birthRule.noShared + ' 中国←中国=' + out.birthRule.cnFromCn + ' (prox=' + out.birthRule.prox + ')');
    out.birthRule.pairs.forEach((p, i) => say('   #' + i + ' ' + p));
    out.birthRule.crossSample.forEach((b, i) => say('   ✗ 跨区域 #' + i + ' ' + JSON.stringify(b)));

    let birth = null;
    for (let i = 1; i < kf.length; i++) {
      const prev = kf[i - 1][1].filter((r) => r[1] > -9000);
      const prevMap = new Map(prev.map((r) => [r[0], r]));
      const news = kf[i][1].filter((r) => !prevMap.has(r[0]) && r[1] > -9000);
      if (news.length < 3) continue;
      const births = news.map((r) => {
        let best = Infinity;
        let bk = '';
        let ba = 1;
        for (const p of prev) {
          const d = Math.hypot(p[1] - r[1], p[2] - r[2]);
          if (d < best) {
            best = d;
            bk = p[3];
            ba = p[4];
          }
        }
        /* 再往后看 20 帧，量它一共走了多远（动画版应当明显 > 0） */
        let moved = 0;
        for (let j = i + 1; j < Math.min(kf.length, i + 21); j++) {
          const q = kf[j][1].find((z) => z[0] === r[0]);
          if (!q || q[1] <= -9000) break;
          moved = Math.hypot(q[1] - r[1], q[2] - r[2]);
        }
        return { label: r[3], firstD: +best.toFixed(1), near: bk, nearAlpha: ba, alpha: r[4], moved20: +moved.toFixed(1), at: [+r[1].toFixed(0), +r[2].toFixed(0)] };
      });
      birth = { frame: i, k: kf[i][0], n: news.length, births: births.sort((a, b) => b.firstD - a.firstD) };
      break;
    }
    out.birth = birth;
    if (birth) {
      say('首次成批出现: 第 ' + birth.frame + ' 帧 k=' + birth.k + '，新增 ' + birth.n + ' 个簇');
      birth.births.slice(0, 8).forEach((b) =>
        say('   ' + b.label + ' 首帧离「' + b.near + '」' + b.firstD + 'px，alpha=' + b.alpha + '，其后 20 帧共移动 ' + b.moved20 + 'px')
      );
    } else {
      say('首次成批出现: 未观测到');
    }
    await sess.evaluate('window.__tdt.setCamera(105, 35, 201)');
    await cdp.sleep(500);

    fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
  } catch (e) {
    say('ERROR ' + (e && e.stack ? e.stack : e));
  } finally {
    if (sess) sess.close();
    await ch.dispose();
    fs.writeFileSync(OUT.replace(/\.json$/, '') + '.log.txt', log.join('\n'), 'utf8');
    console.log('done -> ' + OUT);
    process.exit(0);
  }
})();
