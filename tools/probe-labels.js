/**
 * 天地图实验线 · 「照片落哪 / 显示什么名」专项读数
 * ----------------------------------------------------------------------------
 * 回答一个在交接时必被追问的问题：
 *
 *   缩略图下面那行字，是**算出来的行政归属**，还是**数据里写死的字符串**？
 *   落省判定的数据又从哪里来？
 *
 * 取四组读数，全部来自运行时而非读代码推断：
 *
 *   A. assign()   —— 每个地点被划进哪个省（adcode）+ 是「落在环内」还是
 *                    「离环最近」兜底。这是落省判定的直接输出。
 *   B. clusters() —— 各视野下每一簇的 label、provs、cities、names、张数。
 *                    据此反推 label 是四级规则里的哪一级（**分类观测结果**，
 *                    不是把分级规则再实现一遍）。
 *   C. DOM        —— 直接读页面上 .pin__name 的文本，与 B 的 label 逐一对齐。
 *                    这一步才是「屏幕上真的显示了」的证据；B 只是模型。
 *   D. 汇总       —— 各视野下每一级各命中多少次、覆盖多少张照片。
 *
 * 视野取三档：世界（k=201，t<0.5）、全国（k=1172，t≥0.5）、
 * 京津冀（k=6000，省级以上）。三档跨过 t=0.5 这条粒度开关。
 *
 * 结果自己写 UTF-8 JSON —— Windows 控制台会把中文按 GBK 解。
 *
 * 跑法：node tdt-demo/probe-labels.js [baseUrl]
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const cdp = require('../tools/lib/cdp.js');

const PORT = 9339;
const BASE = process.argv[2] || 'http://127.0.0.1:8124';
const OUT = path.join(__dirname, 'probe-labels.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 三档视野：[标签, lng, lat, k] */
const VIEWS = [
  ['world_k201', 110, 25, 201],
  ['nation_k1172', 104, 34, 1172],
  ['jingjinji_k6000', 116.4, 39.2, 6000],
];

/**
 * 把 label 归类到四级规则的哪一级。
 * 纯**观测分类**：拿 label 去比对簇自己带出来的字段，谁相等算谁。
 * 顺序与 clusterLabel 的判定顺序一致，所以①优先。
 */
function classify(c) {
  const lab = c.label || '';
  if (!lab) return 'empty';
  if (c.names && c.names.length === 1 && c.names[0] === lab) return '1_place';
  if (c.cities && c.cities.length === 1 && c.cities[0] && c.cities[0] === lab) return '2_city';
  if (c.provShort && c.provShort === lab) return '3_prov';
  if (c.regionName && c.regionName === lab) return '4_region';
  /* 港澳联名的形态：「中国香港 / 中国澳门」 */
  if (c.msts && c.msts.length > 1 && / /.test(lab)) return '3p_mst_pair';
  return 'unclassified';
}

(async () => {
  const out = { ok: false, url: '', errors: [], console: [], views: {} };
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

    /* ?fake 用伪瓦片 —— 本探针只关心归属与标签，不需要真底图，也不消耗配额 */
    const URL = BASE + '/tdt-demo/index.html?fake&theme=paper&at=104,34,1172';
    out.url = URL;
    await s.navigate(URL);
    for (let i = 0; i < 80; i++) {
      const rs = await ev('document.readyState');
      if (rs === 'complete') break;
      await sleep(100);
    }
    await sleep(1500);

    const boot = await ev('typeof window.__tdt === "object" ? __tdt.state() : null');
    if (!boot) throw new Error('__tdt 未挂载');
    out.boot = boot;

    /* ---------------------------------------------- A. 落省判定 */
    const asg = await ev('JSON.stringify(__tdt.assign())');
    const log = JSON.parse(asg);
    out.assign = {
      total: log.length,
      viaIn: log.filter((r) => r[2] === 'in').length,
      viaNear: log.filter((r) => r[2] === 'near').length,
      viaNone: log.filter((r) => r[2] === 'none').length,
      /* 落到的 adcode → 该 adcode 下有几个地点。0 = 未归属（公海） */
      byAdcode: (() => {
        const m = {};
        for (const r of log) m[r[1]] = (m[r[1]] || 0) + 1;
        return m;
      })(),
      sample: log.slice(0, 12),
    };

    /* ---------------------------------------------- B/C/D. 三档视野 */
    for (const [name, lng, lat, k] of VIEWS) {
      await ev('__tdt.setCamera(' + lng + ',' + lat + ',' + k + ')');
      await sleep(700);

      const cls = JSON.parse(await ev('JSON.stringify(__tdt.clusters())'));
      /* ⚠️ 「可见」不能只看 width>0 —— 被 translate 到视口外的池元素照样有宽度，
         那样会把整池子的旧标签都算成「屏幕上出现了」。必须与视口矩形求交。 */
      const domNames = JSON.parse(
        await ev(
          "(function(){var W=innerWidth,H=innerHeight;var r=[];" +
            "var els=document.querySelectorAll('.pin__name');" +
            "for(var i=0;i<els.length;i++){var e=els[i],w=e.closest('.mk');if(!w)continue;" +
            "var b=w.getBoundingClientRect();" +
            "if(b.width<=0||b.height<=0)continue;" +
            "if(b.right<=0||b.bottom<=0||b.left>=W||b.top>=H)continue;" +
            "var t=e.textContent;if(t)r.push(t);}" +
            "return JSON.stringify(r);})()"
        )
      );

      const rows = cls.map((c) => ({
        label: c.label,
        level: classify(c),
        n: c.n,
        anchored: c.anchored,
        region: c.region,
        provs: c.provs,
        cities: c.cities,
        names: c.names,
      }));

      const tally = {};
      const tallyN = {};
      for (const r of rows) {
        tally[r.level] = (tally[r.level] || 0) + 1;
        tallyN[r.level] = (tallyN[r.level] || 0) + r.n;
      }

      /* 屏幕上的标签是否都能在模型里找到 —— 反向也要查：
         模型里可见的簇，屏幕上是否都有字。两侧差集都记下来。 */
      const labelSet = rows.map((r) => r.label);
      const uniqLabels = Array.from(new Set(labelSet));
      const domUniq = Array.from(new Set(domNames));

      out.views[name] = {
        cam: { lng: lng, lat: lat, k: k, t: cls.length ? (await ev('__tdt.fill()')).chinaT : null },
        clusterCount: rows.length,
        photoCount: rows.reduce((a, r) => a + r.n, 0),
        tally: tally,
        tallyPhotos: tallyN,
        /* 屏幕上出现了、但模型里没有的标签（多出来的）与反之（漏掉的） */
        domNotInModel: domUniq.filter((x) => uniqLabels.indexOf(x) < 0),
        modelNotInDom: uniqLabels.filter((x) => domUniq.indexOf(x) < 0),
        domSample: domUniq.slice(0, 14),
        rows: rows.slice(0, 26),
      };
    }

    /* ------------------------------------------------------------- 判据
       每条都能证伪。读不到的宁可报 false，不要写成恒真。 */
    const V = out.views;
    const tallyOf = (v, k) => ((v || {}).tally || {})[k] || 0;

    out.verdict = {
      noException: (out.errors || []).length === 0,

      /* 落省判定真的在跑，且没有地点被静默丢掉 */
      assignmentComplete: !!out.assign && out.assign.viaNone === 0 && out.assign.total > 0,
      /* 命中的省级行政区数 = 20（与填色探针的 filled=20 独立吻合）。
         写死 20 是有意的：它掉下来通常意味着省界数据或反算出了问题。 */
      provinceCoverage20: !!out.assign && Object.keys(out.assign.byAdcode).filter((k) => /^\d{6}$/.test(k)).length === 20,

      /* 屏幕上那行字 = 引擎算出来的 label。判据取**单向**：
         屏幕上出现的标签必须都能在模型里找到。
         （反方向不成立且不该成立 —— 模型含视口外的簇，它们照样被渲染。） */
      domLabelsAllFromModel:
        !!V.world_k201 && V.world_k201.domNotInModel.length === 0 &&
        !!V.nation_k1172 && V.nation_k1172.domNotInModel.length === 0 &&
        !!V.jingjinji_k6000 && V.jingjinji_k6000.domNotInModel.length === 0,

      /* 每个视野下，屏幕上都有标签真的渲染出来了（防「选择器失效 → 空集恒真」） */
      domLabelsNonEmpty:
        !!V.world_k201 && V.world_k201.domSample.length > 0 &&
        !!V.nation_k1172 && V.nation_k1172.domSample.length > 0 &&
        !!V.jingjinji_k6000 && V.jingjinji_k6000.domSample.length > 0,

      /* 省名**确实会被显示**：全国视图（t ≥ 0.5）下第③级必须命中且不止一个 */
      provinceNamesRendered: !!V.nation_k1172 && tallyOf(V.nation_k1172, '3_prov') >= 4,

      /* 合规反向锁：国家级粒度（t < 0.5）下不得出现省级裸名 */
      noBareProvAtCountry: !!V.world_k201 && tallyOf(V.world_k201, '3_prov') === 0,

      /* 一刀不切的守卫：标签不许出现无法归类的形态（分级规则改了会在这里现形） */
      noUnclassified:
        !!V.world_k201 && tallyOf(V.world_k201, 'unclassified') === 0 &&
        !!V.nation_k1172 && tallyOf(V.nation_k1172, 'unclassified') === 0 &&
        !!V.jingjinji_k6000 && tallyOf(V.jingjinji_k6000, 'unclassified') === 0,

      /* 三档视野跨过粒度开关：t 必须真的从 0 变到 1，
         否则「省名在 t≥0.5 才出现」这条根本没被验到 */
      crossedGranularity:
        !!V.world_k201 && V.world_k201.cam.t === 0 &&
        !!V.nation_k1172 && V.nation_k1172.cam.t === 1,
    };
    out.failed = Object.keys(out.verdict).filter((k) => !out.verdict[k]);
    out.pass = out.failed.length === 0;
    out.ok = out.pass;

    fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
    console.log('ok  pass=' + out.pass + '  failed=' + out.failed.length + '  errors=' + out.errors.length);
  } catch (e) {
    out.pass = false;
    out.failed = ['exception'];
    out.error = String((e && e.stack) || e);
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
    console.log('FAILED: ' + out.error);
  } finally {
    try {
      if (s) s.close();
    } catch (_) {}
    try {
      if (chrome) await chrome.dispose();
    } catch (_) {}
  }

  /* JSON 是判据的载体，退出码只是给脚本化调用（CI / 批量跑）一个信号。
     两者都要：只看退出码会丢掉「哪条挂了」，只看 JSON 则漏跑时静默通过。
     ⚠️ 必须放在 finally 之后 —— 提前 exit 会跳过 chrome 回收，留下孤儿进程。 */
  process.exit(out.pass ? 0 : 1);
})();
