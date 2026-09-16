/**
 * probe-key-web.js —— 网页版「密钥填一次就记住」的端到端验证
 * ----------------------------------------------------------------------------
 * 用户的原始报告是一句话：「现在地图API刷新后还是要重填」。
 *
 * 机制已经定位得很死：`readParams()` 原先只认地址栏的 `?tk=`，不读任何本地存储；
 * 而密钥框里那个「地址栏也带一份」默认**没有勾**。两条合起来 = 刷新必丢。
 * 本轮给网页版补了一条 localStorage 记忆（默认开，可关，`?nostore` 可整体停用）。
 * 这个探针就是给这条新链路配的证伪口 —— 不是「跑通了」，是「哪几条会红」。
 *
 * 验的是什么（每条都取能证伪的判据，不看体感）
 * ----------------------------------------------------------------------------
 *   A 干净 profile 首次访问：没有密钥、来源为 none、存储器里也没有残留
 *   B 走**真实 UI**填入（`keyInput` + `keyApply` 点击）：落到 localStorage、
 *     地址栏**不**被污染（「地址栏也带一份」默认未勾）、提示文案是「已记住」
 *   C **刷新后仍在**：来源必须变成 `store`（这是用户那句抱怨的直接反命题）
 *   D 反向锁：同一份存储、同一个浏览器，只把地址换成 `?nostore` → 必须读不到；
 *     且存储里的值**还在**（证明 C 是「读了」而不是「碰巧没丢」）
 *   E 地址栏优先：`?tk=` 压过存储器里的旧值，且不改写存储器
 *   F 取消勾选「记住密钥」：连旧的记录一起清掉，且**刷新后真的没有**
 *   G 嵌入视图（同源 iframe）一律不碰 localStorage —— 桌面端的权威是
 *     `<userData>/config.json`，而且它那边的源是随机端口，写进去也留不住
 *   H 密钥不只是个字符串：被拦下的瓦片请求 URL 上必须真的带着它
 *
 * 零配额：给的是**假密钥**（32 位十六进制，天地图不认），
 * 并用 CDP 的 Fetch 域把 `*.tianditu.gov.cn` 全部拦下、就地回一个 1×1 PNG。
 * 于是「有没有真去拉瓦片、带没带上密钥」依然可观测，但请求从没离开本机。
 *
 * 为什么 G 不是恒真：同一个 profile 里，**顶层**页面写入是成功的（判据 B 里
 * localStorage 确实拿到了值）。所以 G 的「没写进去」只可能来自嵌入判断本身。
 * 这一对必须并列看 —— 单看 G，一个整体坏掉的 localStorage 也能让它变绿。
 *
 * 跑法：node tdt-demo/probe-key-web.js [baseUrl]
 * 结果：tdt-demo/probe-key-web.json（UTF-8。控制台那段会被按 GBK 解，中文会乱）
 * ============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const cdp = require('../tools/lib/cdp.js');

const PORT = 9356;
const BASE = process.argv[2] || 'http://127.0.0.1:8124';
const PAGE = '/tdt-demo/index.html';
const OUT = path.join(__dirname, 'probe-key-web.json');

/** 32 位十六进制的**假**密钥：形态真、值不真。 */
const FAKE = '0123456789abcdef0123456789abcdef';
const OTHER = 'fedcba9876543210fedcba9876543210';

/** 1×1 PNG，用作被拦下的瓦片响应体。cdp.encodePNG 收的是 RGB 裸数据。 */
const PIXEL = cdp.encodePNG(1, 1, Buffer.from([0, 0, 0])).toString('base64');

const lines = [];
const log = (s) => { lines.push(s); };

let pass = 0;
const fails = [];
function check(name, ok, detail) {
  if (ok) { pass += 1; lines.push('  [PASS] ' + name + (detail ? '  ' + detail : '')); }
  else { fails.push(name); lines.push('  [FAIL] ' + name + (detail ? '  ' + detail : '')); }
}

/** CDP 的 send 没有超时，页面正在导航时会话可能既不 resolve 也不 reject。 */
const withTimeout = (p, ms) => Promise.race([p, cdp.sleep(ms)]);

/**
 * 导航到一个地址并等**新文档**就绪。
 *
 * 为什么要先埋一个标记：`Page.navigate` 返回时旧文档还在跑，
 * 这时 `!!window.__tdt` 立刻为真 —— 直接轮询它就会抢在跳转前读到**上一页**的状态，
 * 于是「刷新后密钥还在」这种判据会拿旧页面的答案给自己打分。
 * 埋一个旧文档才有、新文档必然没有的标记，就能精确地等到换页完成。
 */
async function goto(s, url) {
  await s.evaluate('window.__probeTag = 1; true');
  await s.navigate(url);
  const t0 = Date.now();
  for (;;) {
    if (Date.now() - t0 > 30000) throw new Error('等待新文档就绪超时: ' + url);
    await cdp.sleep(150);
    let ok = false;
    try {
      ok = await withTimeout(
        s.evaluate('(!window.__probeTag) && !!(window.__tdt && window.__tdt.state)'),
        4000,
      );
    } catch (_) { ok = false; }
    if (ok === true) {
      /* 起手一个稳定小歇：readParams 在脚本载入时跑，但首帧请求要再等一拍 */
      await cdp.sleep(400);
      return;
    }
  }
}

/** 一次读全：页面状态 + 本机存储器 + 当前地址。 */
const READ = `(() => {
  const t = window.__tdt;
  if (!t) return null;
  const st = t.state();
  let ls = null;
  try { ls = localStorage.getItem('tdt.tk.v1'); } catch (e) { ls = 'ERR:' + e.name; }
  return { tk: st.tk, tkSrc: st.tkSrc, storeOff: st.storeOff, ls: ls, url: location.href };
})()`;

/** 走真实 UI 填密钥。saveChecked 传 null 就沿用 HTML 里的默认勾选态。 */
function applyViaUi(tk, saveChecked) {
  /* null = 不碰这个勾（验默认态）；true/false = 显式改，验开关本身 */
  const setSave = saveChecked === null ? '' : 'save.checked = ' + String(saveChecked) + ';';
  return `(() => {
    const inp = document.getElementById('keyInput');
    const save = document.getElementById('keySave');
    ${setSave}
    inp.value = ${JSON.stringify(tk)};
    document.getElementById('keyApply').click();
    let ls = null;
    try { ls = localStorage.getItem('tdt.tk.v1'); } catch (e) { ls = 'ERR'; }
    const st = window.__tdt.state();
    return {
      tk: st.tk, tkSrc: st.tkSrc, ls: ls,
      toast: document.getElementById('toast').textContent,
      url: location.href,
      saveChecked: save.checked,
      rememberChecked: document.getElementById('keyRemember').checked,
    };
  })()`;
}

(async () => {
  const b = cdp.launchChrome({ cdpPort: PORT, url: BASE + PAGE, width: 1280, height: 820 });
  let s = null;
  const out = { base: BASE, port: PORT, fake: FAKE, other: OTHER };
  try {
    s = await cdp.attach(PORT, PAGE, 30000);

    /* 把天地图全拦下来 —— 零配额的关键，同时留下「密钥有没有真的带上」的证据 */
    const net = { paused: 0, withFake: 0, withOther: 0, sample: [] };
    await s.send('Fetch.enable', { patterns: [{ urlPattern: '*://*.tianditu.gov.cn/*' }] });
    s.on('Fetch.requestPaused', (p) => {
      net.paused += 1;
      const u = p.request.url;
      if (u.indexOf('tk=' + FAKE) >= 0) net.withFake += 1;
      if (u.indexOf('tk=' + OTHER) >= 0) net.withOther += 1;
      if (net.sample.length < 3) net.sample.push(u.slice(0, 220));
      s.send('Fetch.fulfillRequest', {
        requestId: p.requestId,
        responseCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: 'image/png' },
          { name: 'Cache-Control', value: 'no-store' },
        ],
        body: PIXEL,
      }).catch(() => {});
    });

    /* ---------------------------------------------------------------- A */
    lines.push('【A】干净 profile 首次访问 —— 不该有任何密钥残留');
    await goto(s, BASE + PAGE);
    const a = await s.evaluate(READ);
    out.A = a;
    check('A1 首次无密钥', a && a.tk === false, JSON.stringify(a));
    check('A2 来源为 none', !!a && a.tkSrc === 'none', 'tkSrc=' + (a && a.tkSrc));
    check('A3 存储器为空', !!a && a.ls === null, 'ls=' + JSON.stringify(a && a.ls));
    check('A4 未开 nostore 缝', !!a && a.storeOff === false, 'storeOff=' + (a && a.storeOff));

    /* 顺手断言 HTML 里的默认勾选态 —— 判据 B 的口径依赖它 */
    const defs = await s.evaluate(`({
      save: document.getElementById('keySave').checked,
      remember: document.getElementById('keyRemember').checked,
    })`);
    out.defaults = defs;
    check('A5 「记住密钥」默认勾上', defs.save === true, JSON.stringify(defs));
    check('A6 「地址栏也带一份」默认不勾', defs.remember === false, JSON.stringify(defs));

    /* ---------------------------------------------------------------- B */
    lines.push('');
    lines.push('【B】走真实 UI 填入（点 keyApply）');
    const bres = await s.evaluate(applyViaUi(FAKE, null));
    out.B = bres;
    check('B1 页面认了密钥', bres.tk === true && bres.tkSrc === 'manual', JSON.stringify({
      tk: bres.tk, tkSrc: bres.tkSrc,
    }));
    check('B2 落到 localStorage', bres.ls === FAKE, 'ls=' + JSON.stringify(bres.ls));
    check('B3 地址栏没被污染', bres.url.indexOf('tk=') < 0, bres.url);
    check('B4 提示文案是「已记住」', bres.toast === '密钥已记住，正在拉取瓦片', JSON.stringify(bres.toast));

    /* 密钥真的上了请求 */
    await cdp.sleep(900);
    out.netAfterApply = { paused: net.paused, withFake: net.withFake, sample: net.sample.slice() };
    check('B5 瓦片请求带着这个密钥', net.withFake > 0,
      'withFake=' + net.withFake + ' paused=' + net.paused + ' 例=' + JSON.stringify(net.sample[0] || null));

    /* ---------------------------------------------------------------- C */
    lines.push('');
    lines.push('【C】刷新（地址栏不带 tk）—— 这才是用户抱怨的那一步');
    await goto(s, BASE + PAGE);
    const c = await s.evaluate(READ);
    out.C = c;
    check('C1 刷新后密钥还在', !!c && c.tk === true, JSON.stringify(c && { tk: c.tk, url: c.url }));
    check('C2 来源是 store（不是地址栏）', !!c && c.tkSrc === 'store', 'tkSrc=' + (c && c.tkSrc));

    /* ---------------------------------------------------------------- D */
    lines.push('');
    lines.push('【D】反向锁：同一份存储，只换地址为 ?nostore —— 必须读不到');
    await goto(s, BASE + PAGE + '?nostore');
    const d = await s.evaluate(READ);
    out.D = d;
    check('D1 nostore 下读不到密钥', !!d && d.tk === false, JSON.stringify(d && { tk: d.tk, tkSrc: d.tkSrc }));
    check('D2 nostore 确实生效（storeOff）', !!d && d.storeOff === true, 'storeOff=' + (d && d.storeOff));
    check('D3 存储里的值还在（是「不读」不是「丢了」）', !!d && d.ls === FAKE, 'ls=' + JSON.stringify(d && d.ls));

    /* 再填一次：nostore 下不该写 */
    const d2 = await s.evaluate(applyViaUi(OTHER, null));
    out.D2 = d2;
    check('D4 nostore 下也不写', d2.ls === FAKE, 'ls=' + JSON.stringify(d2.ls));
    check('D5 nostore 下提示不说「已记住」', d2.toast === '密钥已应用，正在拉取瓦片', JSON.stringify(d2.toast));

    /* ---------------------------------------------------------------- E */
    lines.push('');
    lines.push('【E】地址栏优先：?tk= 压过存储器');
    await goto(s, BASE + PAGE + '?tk=' + OTHER);
    const e = await s.evaluate(READ);
    out.E = e;
    check('E1 来源是 url', !!e && e.tkSrc === 'url', 'tkSrc=' + (e && e.tkSrc));
    check('E2 页面认了密钥', !!e && e.tk === true, JSON.stringify(e && { tk: e.tk }));
    await cdp.sleep(900);
    out.netAfterUrlTk = { withOther: net.withOther, withFake: net.withFake };
    check('E3 请求带的是地址栏那一份', net.withOther > 0,
      'withOther=' + net.withOther + ' withFake=' + net.withFake);
    check('E4 地址栏那份没被写回存储器', e.ls === FAKE, 'ls=' + JSON.stringify(e.ls));

    /* ---------------------------------------------------------------- F */
    lines.push('');
    lines.push('【F】取消勾选「记住密钥」—— 旧的记录要一起清掉');
    await goto(s, BASE + PAGE);                       /* 先回到 store 正常生效的样子 */
    const f0 = await s.evaluate(READ);
    check('F0 前置：store 里还是 FAKE', f0.ls === FAKE && f0.tkSrc === 'store',
      'ls=' + JSON.stringify(f0.ls) + ' tkSrc=' + f0.tkSrc);
    const f = await s.evaluate(applyViaUi(OTHER, false));
    out.F = f;
    check('F1 存储器被清空', f.ls === null, 'ls=' + JSON.stringify(f.ls));
    check('F2 本次仍生效（清的是「记住」，不是「用」）', f.tk === true, JSON.stringify({ tk: f.tk }));
    check('F3 提示不承诺记住', f.toast === '密钥已应用，正在拉取瓦片', JSON.stringify(f.toast));
    await goto(s, BASE + PAGE);
    const f2 = await s.evaluate(READ);
    out.F2 = f2;
    check('F4 刷新后真的没有了（说明清理是实的）', !!f2 && f2.tk === false,
      JSON.stringify(f2 && { tk: f2.tk, ls: f2.ls }));

    /* ---------------------------------------------------------------- G */
    lines.push('');
    lines.push('【G】嵌入视图（同源 iframe）一律不碰 localStorage');
    /* 此刻顶层页面自己也没有密钥，先把存储器清干净再挂 iframe */
    await s.evaluate(`(() => { try { localStorage.removeItem('tdt.tk.v1'); } catch (e) {} return true; })()`);
    await s.evaluate(`(() => {
      const f = document.createElement('iframe');
      f.id = 'probeFrame';
      f.setAttribute('style', 'position:fixed;left:0;top:0;width:640px;height:480px;z-index:9999');
      f.src = ${JSON.stringify(PAGE)};
      document.body.appendChild(f);
      return true;
    })()`);

    /* 等 iframe 里的新文档就绪（同样靠 __probeTag：iframe 是全新文档，天然没有） */
    let frameReady = false;
    for (let i = 0; i < 100 && !frameReady; i += 1) {
      await cdp.sleep(150);
      try {
        frameReady = await withTimeout(s.evaluate(
          `(() => { const w = document.getElementById('probeFrame').contentWindow;
             return !!(w && w.__tdt && w.__tdt.state); })()`,
        ), 4000) === true;
      } catch (_) { frameReady = false; }
    }
    check('G0 嵌入视图已就绪', frameReady === true);
    await cdp.sleep(300);

    /* 先点 btnKey 打开密钥框 —— 「记住密钥」那一行的隐藏与文案改写都在 openKeybox 里 */
    const g0 = await s.evaluate(`(() => {
      const w = document.getElementById('probeFrame').contentWindow;
      const d = w.document;
      d.getElementById('btnKey').click();
      const row = d.getElementById('keySave').closest('.keybox__row');
      const hint = d.querySelector('.keybox__hint');
      return { rowHidden: row.hidden, hint: hint ? hint.textContent : null };
    })()`);
    out.G0 = g0;
    check('G1 「记住密钥」那一行被收起', g0.rowHidden === true, JSON.stringify(g0.rowHidden));
    check('G2 文案改口说「客户端会替你记住」',
      !!g0.hint && g0.hint.indexOf('客户端会替你记住') >= 0,
      JSON.stringify(g0.hint));

    const g = await s.evaluate(`(() => {
      const w = document.getElementById('probeFrame').contentWindow;
      const d = w.document;
      d.getElementById('keyInput').value = ${JSON.stringify(FAKE)};
      d.getElementById('keySave').checked = true;      /* 故意勾上：真被拦住才该看不见效果 */
      d.getElementById('keyApply').click();
      const st = w.__tdt.state();
      return { tk: st.tk, tkSrc: st.tkSrc, toast: d.getElementById('toast').textContent };
    })()`);
    const outerLs = await s.evaluate(`(() => { try { return localStorage.getItem('tdt.tk.v1'); } catch (e) { return 'ERR'; } })()`);
    out.G = Object.assign({}, g, { outerLs: outerLs });
    check('G3 内层页面认了密钥', g.tk === true && g.tkSrc === 'manual', JSON.stringify({ tk: g.tk, tkSrc: g.tkSrc }));
    check('G4 外层 localStorage 仍然是空的', outerLs === null, 'ls=' + JSON.stringify(outerLs));
    check('G5 内层提示不承诺「已记住」', g.toast === '密钥已应用，正在拉取瓦片', JSON.stringify(g.toast));

    out.netTotal = { paused: net.paused, withFake: net.withFake, withOther: net.withOther };

    /* ------------------------------------------------------------- 判定 */
    lines.push('');
    lines.push('—— 合计 ' + pass + ' 绿 / ' + fails.length + ' 红 ——');
    if (fails.length) lines.push('失败: ' + fails.join(', '));

    const verdict = {
      firstNoKey: out.A && out.A.tk === false,
      firstSrcNone: out.A && out.A.tkSrc === 'none',
      firstStoreEmpty: out.A && out.A.ls === null,
      defaultSaveChecked: out.defaults && out.defaults.save === true,
      defaultRememberUnchecked: out.defaults && out.defaults.remember === false,

      applySrcManual: out.B && out.B.tk === true && out.B.tkSrc === 'manual',
      applyWroteStore: out.B && out.B.ls === FAKE,
      applyNoUrlLeak: !!out.B && out.B.url.indexOf('tk=') < 0,
      applyToastRemembered: out.B && out.B.toast === '密钥已记住，正在拉取瓦片',
      tileCarriesKey: !!out.netAfterApply && out.netAfterApply.withFake > 0,

      reloadTkKept: out.C && out.C.tk === true,
      reloadSrcStore: out.C && out.C.tkSrc === 'store',

      nostoreReadsNothing: out.D && out.D.tk === false && out.D.storeOff === true,
      nostoreKeepsStore: out.D && out.D.ls === FAKE,
      nostoreWritesNothing: out.D2 && out.D2.ls === FAKE,

      urlWins: out.E && out.E.tkSrc === 'url' && out.E.tk === true,
      urlNotWrittenBack: out.E && out.E.ls === FAKE,
      urlKeyOnWire: !!out.netAfterUrlTk && out.netAfterUrlTk.withOther > 0,

      uncheckClears: out.F && out.F.ls === null,
      uncheckStillApplies: out.F && out.F.tk === true,
      uncheckReloadGone: out.F2 && out.F2.tk === false,

      embedNoStoreWrite: out.G && out.G.outerLs === null,
      embedRowHidden: out.G0 && out.G0.rowHidden === true,
      embedToastAppliedOnly: out.G && out.G.toast === '密钥已应用，正在拉取瓦片',
      embedTkWorks: out.G && out.G.tk === true && out.G.tkSrc === 'manual',
    };
    out.verdict = verdict;
    out.failed = Object.keys(verdict).filter((k) => !verdict[k]);
    out.pass = out.failed.length === 0;
  } catch (err) {
    out.error = String((err && err.stack) || err);
    lines.push('');
    lines.push('!! 异常中断：' + out.error);
  } finally {
    if (s) s.close();
    await b.dispose();
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
    fs.writeFileSync(path.join(__dirname, 'probe-key-web.txt'), lines.join('\n') + '\n', 'utf8');
  }
})();
