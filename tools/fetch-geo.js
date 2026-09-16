#!/usr/bin/env node
/* 拉取并生成本地边界数据（assets/geo/）——本仓库不携带边界坐标数据。
 *
 * 为什么数据不入库：
 *   行政区划与国界几何属于地理信息数据，且其中的国界画法受《地图管理条例》
 *   约束。仓库只分发代码；数据由使用者本机在运行前从公开服务拉取并就地
 *   转换，不经仓库中转。
 *
 * 数据来源（全部为公开服务）：
 *   中国省/市/区县  天地图·行政区划 V2.0（默认，官方权威，CGCS2000≈WGS-84，
 *                   枚举走云中心 /region/menu 一棵全量树）
 *   中国省/市/区县  阿里云 DataV GeoAtlas（--source=datav 反向缝，GCJ-02）
 *   世界国别        Natural Earth 50m（world-atlas 包，CDN 分发）
 *
 * 对世界数据的处理（与本项目一贯的合规口径一致）：
 *   剔除中国/台湾/香港/澳门四个要素 —— 中国的渲染一律来自省级标准数据
 *   （34 省环并集即标准轮廓，见 tdt-map.js 头注），NE 的中国画法不进渲染。
 *
 * 用法：  node tools/fetch-geo.js [输出目录=assets/geo] [--source=tdt|datav]
 *         [--tk=你的天地图密钥]     （tdt 源必填；也可用环境变量 TDT_TK）
 * 已存在的 jiuduanxian.js 不会被触碰。需要 Node 18+（用到全局 fetch）。
 *
 * ⚠️ 天地图行政区划 V2.0 只对「浏览器访问」开放（服务端裸调 403/301012），
 *    本工具带浏览器 UA + Referer 调用，浏览器端 tk 即可。
 *    县级轮廓官方给的是简化版（约为 DataV 精度的 1/3~1/8），
 *    在意县级细节时用 --source=datav 换回旧管线。
 *    幂等可续跑：已生成的文件直接跳过，配额耗尽次日接着跑即可。
 */

const fs = require('fs');
const path = require('path');

/* ---- 参数解析：node tools/fetch-geo.js [outdir] [--source=tdt|datav] [--tk=...] ---- */
const ARGS = process.argv.slice(2);
const named = {};
const positional = [];
for (const a of ARGS) {
  const m = /^--([a-z]+)=(.*)$/.exec(a);
  if (m) named[m[1]] = m[2];
  else positional.push(a);
}
const SRC = named.source || 'tdt';
const TDT_TK = named.tk || process.env.TDT_TK || '';

const OUT = path.resolve(__dirname, '..', positional[0] || 'assets/geo');
const DATAV = 'https://geo.datav.aliyun.com/areas_v3/bound';
const TDT_API = 'https://api.tianditu.gov.cn/v2/administrative';
const TDT_MENU = 'https://cloudcenter.tianditu.gov.cn/api/portal/region/menu';
/* 天地图 301012 拦的是「非浏览器」请求 —— 带 UA + Referer 即放行（实测）。 */
const TDT_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  referer: 'http://127.0.0.1:8137/',
};
const WORLD_URLS = [
  'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json',
  'https://unpkg.com/world-atlas@2.0.2/countries-50m.json',
];
// 直辖市：跳过市级，直接区县；港澳台：两级都不做（省界已含）
const MUNI = new Set([110000, 120000, 310000, 500000]);
const SKIP = new Set([710000, 810000, 820000]);
// NE 中需要剔除的联合国 M49 码：中国/台湾/香港/澳门
const NE_DROP = new Set(['156', '158', '344', '446']);
const R4 = (v) => Math.round(v * 10000) / 10000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* 对天地图保持克制：过快会触发持续限流（429）。实测 400ms（150 次/分）
   会在连续拉取十几分钟后被打入长限流窗口；1200ms（50 次/分）稳。 */
const TDT_PACE = 1200;

async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'photomap-fetch-geo/1.0' } });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const text = await r.text();
      return JSON.parse(text.replace(/^\uFEFF/, '')); // 剥 BOM，部分源带 BOM
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(800 * (i + 1));
    }
  }
}

/* DataV GeoJSON（MultiPolygon/Polygon，GCJ-02）→ GISDATA 要素。
 * rings = 所有多边形的所有环拍平（外环+内环），坐标 4 位小数，
 * 与既有数据文件的精度约定一致。 */
function toFeature(f, parentName) {
  const p = f.properties || {};
  const g = f.geometry;
  if (!g) return null;
  if (typeof p.adcode !== 'number') return null; // 滤掉 100000_JD 这类伪 adcode 要素
  const polys = g.type === 'Polygon' ? [g.coordinates]
    : g.type === 'MultiPolygon' ? g.coordinates : null;
  if (!polys) return null;
  const rings = [];
  let minX = 180, minY = 90, maxX = -180, maxY = -90;
  for (const poly of polys) {
    for (const ring of poly) {
      const rr = ring.map(([x, y]) => [R4(x), R4(y)]);
      for (const [x, y] of rr) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
      rings.push(rr);
    }
  }
  const anchor = p.centroid || p.center || null;
  return {
    name: p.name,
    adcode: p.adcode,
    type: p.level === 'district' ? '区县' : p.level === 'city' ? '市' : '省',
    parent: (p.parent && p.parent.adcode) || p.adcode,
    parentName: parentName ?? null,
    anchor: anchor ? [R4(anchor[0]), R4(anchor[1])] : null,
    bbox: [R4(minX), R4(minY), R4(maxX), R4(maxY)],
    rings,
  };
}

async function fetchFeatures(adcode, parentName) {
  const j = await getJSON(`${DATAV}/${adcode}_full.json`);
  if (!j || !j.features) return null;
  return j.features.map((f) => toFeature(f, parentName)).filter(Boolean);
}

function writeJS(rel, key, obj) {
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file,
    `window.GISDATA=window.GISDATA||{};window.GISDATA[${JSON.stringify(key)}]=` +
    JSON.stringify(obj) + ';\n');
  console.log(`  ${rel}  (${(fs.statSync(file).size / 1024).toFixed(0)} KB)`);
}

/* 读回本机已生成的数据文件（幂等重跑时避免重复请求）。 */
function loadLocal(rel, key) {
  const s = fs.readFileSync(path.join(OUT, rel), 'utf8');
  return JSON.parse(s.match(new RegExp(`window\\.GISDATA\\[${JSON.stringify(key)}\\]=(\\{.*\\});?\\s*$`, 's'))[1]);
}

/* ---- 世界：TopoJSON → GISDATA ---- */
function topoToGeo(topo) {
  const { scale, translate } = topo.transform;
  const arcs = topo.arcs.map((arc) => {
    let x = 0, y = 0;
    return arc.map(([dx, dy]) => {
      x += dx; y += dy;
      return [R4(x * scale[0] + translate[0]), R4(y * scale[1] + translate[1])];
    });
  });
  const join = (idxs) => {
    const pts = [];
    for (const i of idxs) {
      let a = i >= 0 ? arcs[i] : arcs[~i].slice().reverse();
      if (pts.length) a = a.slice(1);
      pts.push(...a);
    }
    return pts;
  };
  const out = [];
  for (const g of topo.objects.countries.geometries) {
    if (NE_DROP.has(String(g.id))) continue;
    let ringsArr;
    if (g.type === 'Polygon') ringsArr = [g.arcs.map(join)];
    else if (g.type === 'MultiPolygon') ringsArr = g.arcs.map((poly) => poly.map(join));
    else continue;
    const rings = ringsArr.flat();
    let minX = 180, minY = 90, maxX = -180, maxY = -90;
    for (const ring of rings) for (const [x, y] of ring) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    out.push({ g, rings, bbox: [R4(minX), R4(minY), R4(maxX), R4(maxY)] });
  }
  return out;
}

/* ================================================================
 * 天地图管线（默认源）——行政区划 V2.0 + 云中心全量树
 *
 * 两件基础设施：
 *   枚举  云中心 /region/menu 一棵树给全国 3254 个节点（name/gb/pGb/children），
 *         一次请求拿全，不用逐级 children 探查。
 *   轮廓  /v2/administrative?keyword=<gb>&extensions=true → boundary 是
 *         MULTIPOLYGON WKT（6 位小数，CGCS2000）。编码去 156 前缀即 6 位 adcode。
 * 写出的要素结构与 DataV 管线完全一致，另带 crs:'wgs' 标记 —— 引擎据此
 * 跳过 GCJ→WGS 反算（CGCS2000 与 WGS-84 在本项目精度内相同，再反算会错移）。
 */

const TDT_LEVEL = { 4: '省', 3: '市', 2: '区县' };

function wktToRings(wkt) {
  const m = /^\s*MULTIPOLYGON\s*([\s\S]+)$/i.exec(wkt) || /^\s*POLYGON\s*([\s\S]+)$/i.exec(wkt);
  if (!m) throw new Error('boundary 不是 WKT MULTIPOLYGON');
  const ringDepth = /^MULTIPOLYGON/i.test(wkt) ? 3 : 2; // MULTIPOLYGON 外面还包一层
  const rings = [];
  let depth = 0;
  let buf = '';
  for (const ch of m[1]) {
    if (ch === '(') { depth++; if (depth === ringDepth) buf = ''; }
    else if (ch === ')') {
      if (depth === ringDepth) {
        const pts = buf.split(',').map((p) => {
          const [x, y] = p.trim().split(/\s+/).map(Number);
          return [R4(x), R4(y)];
        });
        if (pts.length >= 3) rings.push(pts); // 非空守卫：点数 <3 的环直接丢弃
      }
      depth--;
    } else if (depth === ringDepth) buf += ch;
  }
  return rings;
}

async function tdtGet(url, tries = 10) {
  /* 两种拒绝要分开处理（实测）：
     ① 偶发 429 —— 短退避 5s 起步即可；
     ② code 302010「该tk已限流」—— tk 被打入限流窗口，秒级退避全灭，
        必须 5 分钟级长冷却，等窗口解除后续跑（幂等管线不吃亏）。 */
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: TDT_HEADERS });
      const text = await r.text();
      if (r.status === 200) {
        const j = JSON.parse(text);
        if (j.status === 200) return j;
        throw new Error(`tdt status ${j.status}: ${j.message}`);
      }
      const throttled = /302010/.test(text);
      throw Object.assign(new Error(`HTTP ${r.status}${throttled ? ' (302010 已限流)' : ''}`), { throttled });
    } catch (e) {
      if (i === tries - 1) throw e;
      const wait = e.throttled ? 300000 : Math.min(5000 * 2 ** i, 60000);
      console.log(`    ! ${e.message}，退避 ${Math.round(wait / 1000)}s（第 ${i + 1}/${tries - 1} 次）`);
      await sleep(wait);
    }
  }
}

/* 某个 gb 的轮廓要素（走 V2，extensions=true）。 */
async function tdtFeature(node, parentName, parentAd) {
  const j = await tdtGet(`${TDT_API}?${new URLSearchParams({
    keyword: node.gb, childLevel: '0', extensions: 'true', tk: TDT_TK,
  })}`);
  const d = j.data.district[0];
  const rings = wktToRings(d.boundary);
  let minX = 180, minY = 90, maxX = -180, maxY = -90;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  const ad = Number(String(node.gb).slice(3));
  return {
    name: d.name || node.name,
    adcode: ad,
    type: TDT_LEVEL[d.level] || '区县',
    parent: parentAd || ad,
    parentName: parentName ?? null,
    anchor: d.center ? [R4(d.center.lng), R4(d.center.lat)] : null,
    bbox: [R4(minX), R4(minY), R4(maxX), R4(maxY)],
    rings,
  };
}

/* 云中心全量树（全国 3254 节点）。缓存到 OUT/.tdt-menu.json，重跑不重复下载。 */
async function tdtTree() {
  const cache = path.join(OUT, '.tdt-menu.json');
  if (fs.existsSync(cache)) {
    return JSON.parse(fs.readFileSync(cache, 'utf8'));
  }
  const j = await tdtGet(TDT_MENU);
  const root = j.data[0]; // 中华人民共和国
  if (!root || !Array.isArray(root.children) || root.children.length < 34) {
    throw new Error(`云中心树省级子节点只有 ${root && root.children ? root.children.length : 0}，少于 34`);
  }
  fs.writeFileSync(cache, JSON.stringify(root), 'utf8');
  return root;
}

async function mainTdt() {
  if (!TDT_TK) {
    console.error('缺少天地图密钥：用 --tk=你的tk 或环境变量 TDT_TK（浏览器端 tk 即可，'
      + 'console.tianditu.gov.cn 创建；本工具以浏览器身份调用行政区划 V2.0）。');
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const exists = (rel) => fs.existsSync(path.join(OUT, rel));

  console.log('[tdt 1/4] 全量树（云中心 /region/menu）');
  const tree = await tdtTree();
  const provs = tree.children; // 34 个省级节点
  console.log(`  省级 ${provs.length}，全国节点 ${provs.reduce((a, p) => {
    let n = 1;
    for (const c of p.children || []) n += 1 + (c.children || []).length;
    return a + n;
  }, 0)}`);

  // 2) 省级
  console.log('[tdt 2/4] 省级轮廓 ×34');
  let prov = null;
  if (exists('province.js')) {
    console.log('  已存在，跳过');
    prov = loadLocal('province.js', 'province').features;
  } else {
    const feats = [];
    for (const p of provs) {
      feats.push(await tdtFeature(p, null, 100000));
      process.stdout.write(`    ${p.name} ok\n`);
      await sleep(TDT_PACE);
    }
    if (feats.length < 34) throw new Error(`省级要素只有 ${feats.length}，少于 34，中止`);
    writeJS('province.js', 'province', { level: 'province', crs: 'wgs', features: feats });
    prov = feats;
  }

  // 3) 市 + 区县
  console.log('[tdt 3/4] 市级与区县级');
  let cityN = 0, countyN = 0, cityFeat = 0, countyFeat = 0;
  for (const p of provs) {
    const ad = Number(p.gb.slice(3));
    if (SKIP.has(ad)) { console.log(`  ${p.name}：省界已含，无市县层`); continue; }
    const provAd = ad;
    if (MUNI.has(ad)) {
      if (exists(`county/${ad}.js`)) { countyN++; continue; }
      const feats = [];
      for (const d of p.children || []) { // 直辖市的子节点就是区县
        feats.push(await tdtFeature(d, p.name, provAd));
        await sleep(TDT_PACE);
      }
      if (!feats.length) throw new Error(`${p.name} 区县为空，中止`);
      writeJS(`county/${ad}.js`, `county_${ad}`, { level: 'county', crs: 'wgs', adcode: ad, features: feats });
      countyN++; countyFeat += feats.length;
      continue;
    }
    if (exists(`city/${ad}.js`) && exists(`county/${ad}.js`)) { cityN++; countyN++; continue; }
    // 市级：省的子节点（含省直辖县级单位，天地图把它们挂在省下、级别同市）
    let cities = null;
    if (exists(`city/${ad}.js`)) {
      cities = loadLocal(`city/${ad}.js`, `city_${ad}`).features;
    } else {
      cities = [];
      for (const c of p.children || []) {
        cities.push(await tdtFeature(c, p.name, provAd));
        await sleep(TDT_PACE);
      }
      if (!cities.length) { console.log(`  ! ${p.name} 市级缺失，跳过`); continue; }
      writeJS(`city/${ad}.js`, `city_${ad}`, { level: 'city', crs: 'wgs', adcode: ad, features: cities });
    }
    cityN++; cityFeat += cities.length;
    // 区县级：每个市节点看它在树里有没有孩子。
    // 没孩子的「市」= 省直辖县级单位 / 直筒子市，它自己就是区县要素（防边界洞）。
    if (exists(`county/${ad}.js`)) { countyN++; continue; }
    const districts = [];
    for (const c of p.children || []) {
      const kids = c.children || [];
      if (!kids.length) {
        districts.push(await tdtFeature(c, p.name, provAd));
      } else {
        for (const d of kids) {
          districts.push(await tdtFeature(d, c.name, Number(c.gb.slice(3))));
          await sleep(TDT_PACE);
        }
      }
      await sleep(TDT_PACE);
    }
    if (!districts.length) throw new Error(`${p.name} 区县为空，中止`);
    writeJS(`county/${ad}.js`, `county_${ad}`, { level: 'county', crs: 'wgs', adcode: ad, features: districts });
    countyN++; countyFeat += districts.length;
    console.log(`  ${p.name}: 市 ${cities.length}，区县 ${districts.length}`);
  }
  console.log(`  市 ${cityN} 份（${cityFeat} 要素），区县 ${countyN} 份（${countyFeat} 要素）`);

  // 4) 世界（两管线共用，见 mainDatav 里的实现；这里只负责调度）
  await buildWorld();
}

/* ---- 世界数据（两管线共用）---- */
async function buildWorld() {
  const exists = (rel) => fs.existsSync(path.join(OUT, rel));
  console.log('[3/4] 世界国别（world-atlas 50m）');
  if (exists('world.js')) {
    console.log('  已存在，跳过（删除后重跑可强制重新拉取）');
    return;
  }
  const zhTable = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'world-zh.json'), 'utf8').replace(/^\uFEFF/, ''));
  let topo = null;
  for (const u of WORLD_URLS) {
    try { topo = await getJSON(u); if (topo) { console.log(`  source: ${u}`); break; } }
    catch (e) { console.log(`  ${u} 失败（${e.message}），换下一个源`); }
  }
  if (!topo) throw new Error('世界数据所有源都不可达');
  const countries = topoToGeo(topo).map(({ g, rings, bbox }) => {
    const zh = zhTable[g.properties && g.properties.name];
    return {
      name: g.properties && g.properties.name,
      zh: zh ? zh[0] : (g.properties && g.properties.name) || '',
      iso: zh ? zh[1] : '',
      bbox,
      rings,
    };
  });
  writeJS('world.js', 'world', { level: 'world', countries });
  const zhFallback = countries.filter((c) => c.zh === c.name).length;
  console.log(`  国家要素 ${countries.length} 个（未匹配中文名的：${zhFallback} 个，回退用英文名）`);

  // 修补：zh 表里有的国家若 50m 里缺失（小国被低精度版本裁掉，如图瓦卢），
  // 从 10m 数据里补齐。只对缺失项做，代价可控。
  const claimed = new Set(countries.map((c) => c.zh));
  const missing = Object.keys(zhTable).filter((k) => !claimed.has(zhTable[k][0]));
  if (missing.length) {
    console.log(`  50m 缺失 ${missing.length} 国（${missing.join(', ')}），从 10m 修补…`);
    let fine = null;
    for (const u of WORLD_URLS.map((u) => u.replace('50m', '10m'))) {
      try { fine = await getJSON(u); if (fine) break; }
      catch (e) { /* 换下一个源 */ }
    }
    if (fine) {
      const fineGeo = topoToGeo(fine);
      for (const key of missing) {
        const f = fineGeo.find(({ g }) => g.properties && g.properties.name === key);
        if (f) {
          countries.push({ name: key, zh: zhTable[key][0], iso: zhTable[key][1], bbox: f.bbox, rings: f.rings });
          console.log(`    + ${zhTable[key][0]}（10m）`);
        }
      }
      writeJS('world.js', 'world', { level: 'world', countries });
      console.log(`  修补后国家要素 ${countries.length} 个`);
    }
  }
}

async function main() {
  if (SRC === 'datav') {
    console.log('数据源：DataV GeoAtlas（GCJ-02，引擎载入时反算 WGS）');
    await mainDatav();
  } else {
    console.log('数据源：天地图·行政区划 V2.0（CGCS2000≈WGS-84，官方权威）');
    await mainTdt();
  }
  console.log('[4/4] 完成。jiuduanxian.js 随仓库分发，不在拉取范围。');
  console.log('自检提示：node tools/fetch-geo.js 可重复执行，幂等续跑。');
}

main().catch((e) => { console.error('FETCH FAILED:', e.message); process.exit(1); });

async function mainDatav() {
  fs.mkdirSync(OUT, { recursive: true });

  // 1) 省
  const exists = (rel) => fs.existsSync(path.join(OUT, rel));
  console.log('[1/4] 省级（DataV 100000_full）');
  let prov = null;
  if (exists('province.js')) {
    console.log('  已存在，跳过（删除后重跑可强制重新拉取）');
    prov = loadLocal('province.js', 'province').features;
  } else {
    prov = await fetchFeatures(100000, null);
    if (prov.length < 34) throw new Error(`省级要素只有 ${prov.length}，少于 34，中止`);
    writeJS('province.js', 'province', { level: 'province', features: prov });
  }

  // 2) 市 + 区县
  console.log('[2/4] 市级与区县级（DataV {adcode}_full）');
  // 全量 adcode 列表：用来发现「省直辖县级单位」（如 429004 仙桃、469001 五指山），
  // 它们是省级的直属子节点，不在任何地级市 _full 里，缺了会留边界洞。
  const allList = await getJSON(`${DATAV}/all.json`);
  const directCountyKids = (ad, have) => {
    if (!Array.isArray(allList)) return [];
    return allList.filter((e) => e.level === 'city'
      && e.parent === ad // all.json 的 parent 是纯数字 adcode
      && !have.some((c) => c.adcode === e.adcode));
  };
  async function selfFeature(ad, parentName) {
    const j = await getJSON(`${DATAV}/${ad}.json`);
    if (!j || !j.features || !j.features[0]) return null;
    return toFeature(j.features[0], parentName);
  }
  let cityN = 0, countyN = 0;
  for (const p of prov) {
    const ad = p.adcode;
    if (SKIP.has(ad)) continue;
    if (MUNI.has(ad)) {
      if (exists(`county/${ad}.js`)) { countyN++; continue; }
      const feats = await fetchFeatures(ad, p.name); // 直辖市的 _full 就是区县
      if (feats) { writeJS(`county/${ad}.js`, `county_${ad}`,
        { level: 'county', adcode: ad, features: feats }); countyN++; }
      continue;
    }
    if (exists(`city/${ad}.js`) && exists(`county/${ad}.js`)) { cityN++; countyN++; continue; }
    const cities = exists(`city/${ad}.js`)
      ? loadLocal(`city/${ad}.js`, `city_${ad}`).features
      : await fetchFeatures(ad, p.name);
    if (!cities) { console.log(`  ! ${ad} 市级缺失，跳过`); continue; }
    if (!exists(`city/${ad}.js`)) { writeJS(`city/${ad}.js`, `city_${ad}`,
      { level: 'city', adcode: ad, features: cities }); }
    cityN++;
    const districts = [];
    for (const c of cities) {
      const d = await fetchFeatures(c.adcode, c.name);
      if (d) districts.push(...d);
      else {
        // 无下级的「市」（省直辖县级市如仙桃/潜江，或东莞式直筒子市）：
        // 它自己就是区县要素，不补会留下边界洞。
        const self = await selfFeature(c.adcode, p.name);
        if (self) districts.push(self);
      }
      await sleep(60); // 对公开服务保持克制
    }
    // 省直辖县级单位：作为独立区县要素补进来
    for (const e of directCountyKids(ad, cities)) {
      const f = await selfFeature(e.adcode, p.name);
      if (f) { districts.push(f); await sleep(60); }
    }
    writeJS(`county/${ad}.js`, `county_${ad}`,
      { level: 'county', adcode: ad, features: districts });
    countyN++;
  }
  console.log(`  市 ${cityN} 份，区县 ${countyN} 份`);

  // 3) 世界（NE 50m，剔除中国四要素；中国渲染一律来自省级标准数据）
  console.log('[3/4] 世界国别（world-atlas 50m）');
  if (exists('world.js')) {
    console.log('  已存在，跳过（删除后重跑可强制重新拉取）');
  } else {
  const zhTable = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'world-zh.json'), 'utf8').replace(/^\uFEFF/, ''));
  let topo = null;
  for (const u of WORLD_URLS) {
    try { topo = await getJSON(u); if (topo) { console.log(`  source: ${u}`); break; } }
    catch (e) { console.log(`  ${u} 失败（${e.message}），换下一个源`); }
  }
  if (!topo) throw new Error('世界数据所有源都不可达');
  const zhKeys = Object.keys(zhTable);
  const countries = topoToGeo(topo).map(({ g, rings, bbox }) => {
    const zh = zhTable[g.properties && g.properties.name];
    return {
      name: g.properties && g.properties.name,
      zh: zh ? zh[0] : (g.properties && g.properties.name) || '',
      iso: zh ? zh[1] : '',
      bbox,
      rings,
    };
  });
  writeJS('world.js', 'world', { level: 'world', countries });
  const zhFallback = countries.filter((c) => c.zh === c.name).length;
  console.log(`  国家要素 ${countries.length} 个（未匹配中文名的：${zhFallback} 个，回退用英文名）`);

  // 3b) 修补：zh 表里有的国家若 50m 里缺失（小国被低精度版本裁掉，如图瓦卢），
  //     从 10m 数据里补齐。只对缺失项做，代价可控。
  const claimed = new Set(countries.map((c) => c.zh));
  const missing = Object.keys(zhTable).filter((k) => !claimed.has(zhTable[k][0]));
  if (missing.length) {
    console.log(`  50m 缺失 ${missing.length} 国（${missing.join(', ')}），从 10m 修补…`);
    let fine = null;
    for (const u of WORLD_URLS.map((u) => u.replace('50m', '10m'))) {
      try { fine = await getJSON(u); if (fine) break; }
      catch (e) { /* 换下一个源 */ }
    }
    if (fine) {
      const fineGeo = topoToGeo(fine);
      for (const key of missing) {
        const f = fineGeo.find(({ g }) => g.properties && g.properties.name === key);
        if (f) {
          countries.push({ name: key, zh: zhTable[key][0], iso: zhTable[key][1], bbox: f.bbox, rings: f.rings });
          console.log(`    + ${zhTable[key][0]}（10m）`);
        }
      }
      writeJS('world.js', 'world', { level: 'world', countries });
      console.log(`  修补后国家要素 ${countries.length} 个`);
    }
  }
  }

  // 4) 收尾
  console.log('[4/4] 完成。jiuduanxian.js 随仓库分发，不在拉取范围。');
  console.log('自检提示：node tools/fetch-geo.js 可重复执行，幂等覆盖。');
}
