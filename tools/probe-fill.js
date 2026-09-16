/**
 * 天地图实验线 · 密度填色 / hover / 本地照片导入 —— 验收探针
 * ----------------------------------------------------------------------------
 * 验十件事，每件都取「能证伪」的判据，不看体感：
 *
 *   1. 密度填色（两级）：省 + 国。几何是否载入、两侧计数是否对得上、
 *      5 档色阶是否真的不同、透明度是否半透明、是否与底图的 CSS filter 隔离。
 *      判据取**填色层自己的像素**（__tdt.sampleFill 直接读 getImageData）——
 *      它只反映被验的那一层，不含底图与标注的任何影响，比截图比对硬。
 *   2. 两级切换：世界视图（k≈201）中国整块同色、境外按国上色；
 *      全国视图（k≈1172）逐省分色。门槛 [420, 900] 必须落在两个 k 之间。
 *   3. 离岛合规（正向判据）：钓鱼岛 / 黄尾屿 / 赤尾屿必须被填。
 *      ⚠️ 上一版这里是反的 —— 见 README 与 memory 的「赤尾屿」纠正。
 *   4. 填色层 hover：**只动被悬停的那一块**（变深），其余色块逐像素不变；用
 *      **真实鼠标移动**（CDP Input）触发，不是人肉 dispatch 事件。
 *      pin 的 hover 放大同样在此验。
 *      判据里最硬的一条是 `hoverOutsideIdentical`：把悬停区的包围盒从整层像素
 *      里排除掉之后，前后哈希必须一致 —— 点采样证不了「别处没变」。
 *      配一条反向锁 `hoverDigestSensitive`，否则那个哈希恒定会让它恒真。
 *      另有回归锁：**不动鼠标只改相机**时，旧悬停区必须失效 ——
 *      否则高亮会赖在一个已经不是光标底下的区域上。
 *   5. 聚合按国界：同一簇里不得出现两个区域键 —— 这是「中国照片被并到日本」
 *      那个 bug 的直接证伪口，看截图看不出来。
 *      同类的还有一条时间线上的洞：市界**异步到货**后会整批重建地点对象，
 *      而 regionKey / provName / solo / mst 只有 computeFill() 会写。
 *      重建后漏跑它，「同区才合并」那道闸会退化成空操作、中国台湾的 solo
 *      合规红线一并失效，且只在用户放大触发市界加载之后才发生。
 *      4.5 的 `placeRebuildKeepsRegion` 守它，`&noreassign` 精确打红。
 *   6. 本地照片导入：**自造一张带 GPS EXIF 的 JPEG**（Node 侧拼 APP1 段），
 *      一路走通「文件选择器 → change → 解码 → EXIF → 上点位」。
 *      同时造一张没有 GPS 的，验「跳过并计数」这条分支。
 *   7. 标签分级：**放大后标签必须越来越具体**，不许一律写「中国」。
 *      规则由簇内成员的「同质程度」决定（同地点名 → 同城市 → 同省 → 国名），
 *      不设缩放阈值。判据 = 一条扫 7 个 k 的**不变量**
 *      （城市段唯一且非空 → 标签必须正好是那个城市名）+ 三个具体场景。
 *   8. 合规三条（2026-09-13 用户裁决后口径）：
 *      ① 中国台湾在**省级粒度**（t ≥ 0.5）维持 solo 单列、不参与距离合并；
 *        **国家级粒度**（t < 0.5）并入中国单簇 —— 避免「中国」与「中国台湾」
 *        同屏平级并列的观感；② 港澳合簇时**两个名字都得写出来**；
 *      ③ 省名走 `shortName`（「新疆维吾尔自治区」→「新疆」）。
 *      ⚠️ 上一版实验线违纪：`厦门 ×2 + 南平 + 中国台湾 ×2` 被合成了一个簇。
 *   9. 聚合粒度跟随填色粒度：`t ≥ 0.5`（填色已逐省分色）时聚合单位下沉到省，
 *      **同一簇跨两个省在结构上不可能**。这是「四川省显示成中国」的根因修复 ——
 *      病根不是标签不够聪明，而是聚合按国、填色按省，两者对不上。
 *      判据三条并列（结构 / 表现 / 机制）+ 一条反向锁 `worldStillMerged`
 *      （防止「用力过猛」把世界视图也切碎）。
 *  10. 国家级粒度下不得出现省级裸名（合规）：`t < 0.5` 时「中国」旁边不许
 *      单独浮着一个「新疆」。修法是**聚合 + 标签两层** —— 中国整体收成一个簇，
 *      且第③级（报省名）在该粒度下不可达。双向四条判据，见 4.9。
 *      ⚠️ 只做标签那一层会让 k=560 冒出七个「中国」气泡，比原来更费解。
 *
 * 结果自己写 UTF-8 JSON —— Windows 控制台代码页会把中文按 GBK 解。
 *
 * 跑法：node tdt-demo/probe-fill.js [baseUrl]
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const cdp = require('../tools/lib/cdp.js');

const PORT = 9336;
const BASE = process.argv[2] || 'http://127.0.0.1:8124';
const OUT = path.join(__dirname, 'probe-fill.json');
const SHOT_NATION = path.join(__dirname, 'probe-fill-nation.png');
const SHOT_LEVELS = path.join(__dirname, 'probe-fill-levels.png');
const SHOT_LOCAL = path.join(__dirname, 'probe-fill-local.png');
const SHOT_HOVER = path.join(__dirname, 'probe-fill-hover-prov.png');
const SHOT_HOVER_CN = path.join(__dirname, 'probe-fill-hover-china.png');
/* 标签分级的两张对照图：世界视图报国名、全国视图报城市名 */
const SHOT_LABEL_WORLD = path.join(__dirname, 'probe-fill-label-world.png');
const SHOT_LABEL_BJ = path.join(__dirname, 'probe-fill-label-beijing.png');
/* 港澳单列的合规证据：视野对准珠江口才看得清 */
const SHOT_HKMO = path.join(__dirname, 'probe-fill-label-hkmo.png');
/* 省级粒度下「不得跨省」的证据：中国全境，一屏看全所有省名标签 */
const SHOT_LABEL_PROVS = path.join(__dirname, 'probe-fill-label-provs.png');
/* 聚合过渡动画：跨粒度那一刻的中间帧（散开进行中） */
const SHOT_ANIM_MID = path.join(__dirname, 'probe-fill-anim-mid.png');
const TMP_JPEG = path.join(process.env.TEMP || process.env.TMP || '/tmp', 'tdt-gps.jpg');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ 造图工具
   在页面里拼一张带 GPS EXIF 的 JPEG：
     ① 用 canvas 产出一张**真实可解码**的 JPEG（这样后半段才是真链路）；
     ② 在 SOI 之后插一个自建的 APP1 段（Exif\0\0 + TIFF + IFD0 + ExifIFD + GPS IFD）。
   之所以非得自己拼：浏览器没有任何 API 能往图片里写 GPS，
   而这段字节正是最容易写错的部分（字节序、IFD 偏移、RATIONAL、长值走偏移）。
   IFD 布局（相对 TIFF 基点，即 "Exif\0\0" 之后）；withGps 时的定值：
     IFD0      =  8   2 项：0x8769→ExifIFD、0x8825→GPS IFD
     ExifIFD   = 38   1 项：0x9003 DateTimeOriginal
     GPS IFD   = 56   4 项：0x0001 纬度参考、0x0002 纬度、0x0003 经度参考、0x0004 经度
     日期 20B  = 110
     纬度 24B  = 130
     经度 24B  = 154
     合计 178B，APP1 段长 = 2 + 178 = 180
   exifNoGps 时 IFD0 只剩 1 项，其后各块整体前移 12B（偏移全部按公式推，不写死）。
*/
const FABRICATOR = String.raw`
function putDms(dv, off, v) {
  /* 度 / 分 / 秒。秒的算式是「分的小数部分 × 60」——
     写成 (v-d)*60-m 得到的是**分的小数**，读回来会差 ~150m 的定位，
     而且这个错误看起来像「EXIF 解析不准」，其实是造图时算错了。 */
  var d = Math.floor(v), mf = (v - d) * 60, m = Math.floor(mf), s = (mf - m) * 60;
  dv.setUint32(off, d, true); dv.setUint32(off + 4, 1, true);
  dv.setUint32(off + 8, m, true); dv.setUint32(off + 12, 1, true);
  dv.setUint32(off + 16, Math.round(s * 10000), true); dv.setUint32(off + 20, 10000, true);
}
function mkApp1(lat, lng, date, withGps) {
  /* IFD0 的项数随 withGps 变，后面所有块的位置都要跟着推 ——
     写死偏移正是这类构造最容易出错的地方。 */
  var T = 6, offIfd0 = 8;
  var nIfd0 = withGps ? 2 : 1;
  var offExif = offIfd0 + (2 + nIfd0 * 12 + 4);
  var offGps = offExif + (2 + 1 * 12 + 4);
  var offDate = offGps + (withGps ? 2 + 4 * 12 + 4 : 0);
  var offLat = offDate + 20, offLng = offLat + 24;
  /* 注意 +T：日期与度分秒块的偏移都是相对 TIFF 基点记的，
     而真正落盘的下标 = T + 偏移。这里漏掉 T 就会在最后一个块越界
     （DataView setUint32 直接抛 RangeError）。 */
  var total = T + (withGps ? offLng + 24 : offDate + 20);
  var buf = new Uint8Array(total);
  var dv = new DataView(buf.buffer);
  buf[0] = 0x45; buf[1] = 0x78; buf[2] = 0x69; buf[3] = 0x66; buf[4] = 0; buf[5] = 0;
  dv.setUint16(T, 0x4949, false);
  dv.setUint16(T + 2, 0x002a, true);
  dv.setUint32(T + 4, offIfd0, true);
  var e = T + offIfd0;
  dv.setUint16(e, nIfd0, true); e += 2;
  dv.setUint16(e, 0x8769, true); dv.setUint16(e + 2, 4, true); dv.setUint32(e + 4, 1, true); dv.setUint32(e + 8, offExif, true); e += 12;
  if (withGps) {
    dv.setUint16(e, 0x8825, true); dv.setUint16(e + 2, 4, true); dv.setUint32(e + 4, 1, true); dv.setUint32(e + 8, offGps, true); e += 12;
  }
  dv.setUint32(e, 0, true);
  e = T + offExif;
  dv.setUint16(e, 1, true); e += 2;
  dv.setUint16(e, 0x9003, true); dv.setUint16(e + 2, 2, true); dv.setUint32(e + 4, 20, true); dv.setUint32(e + 8, offDate, true); e += 12;
  dv.setUint32(e, 0, true);
  if (withGps) {
  e = T + offGps;
  dv.setUint16(e, 4, true); e += 2;
  dv.setUint16(e, 0x0001, true); dv.setUint16(e + 2, 2, true); dv.setUint32(e + 4, 2, true);
  buf[e + 8] = lat < 0 ? 0x53 : 0x4e; buf[e + 9] = 0; buf[e + 10] = 0; buf[e + 11] = 0; e += 12;
  dv.setUint16(e, 0x0002, true); dv.setUint16(e + 2, 5, true); dv.setUint32(e + 4, 3, true); dv.setUint32(e + 8, offLat, true); e += 12;
  dv.setUint16(e, 0x0003, true); dv.setUint16(e + 2, 2, true); dv.setUint32(e + 4, 2, true);
  buf[e + 8] = lng < 0 ? 0x57 : 0x45; buf[e + 9] = 0; buf[e + 10] = 0; buf[e + 11] = 0; e += 12;
  dv.setUint16(e, 0x0004, true); dv.setUint16(e + 2, 5, true); dv.setUint32(e + 4, 3, true); dv.setUint32(e + 8, offLng, true); e += 12;
  dv.setUint32(e, 0, true);
  }
  var ds = date.replace(/^(\d{4})-(\d{2})-(\d{2})/, '$1:$2:$3') + '\0';
  /* EXIF 原生格式是 'YYYY:MM:DD HH:MM:SS'（冒号），不是连字符。
     写成连字符的话解析器的正则匹配不上，日期会静默变成空串。 */
  for (var i = 0; i < 20; i++) buf[T + offDate + i] = i < ds.length ? ds.charCodeAt(i) : 0;
  if (withGps) {
    putDms(dv, T + offLat, Math.abs(lat));
    putDms(dv, T + offLng, Math.abs(lng));
  }
  var seg = new Uint8Array(4 + total);
  seg[0] = 0xff; seg[1] = 0xe1;
  seg[2] = ((total + 2) >> 8) & 0xff; seg[3] = (total + 2) & 0xff;
  seg.set(buf, 4);
  return seg;
}
window.__mkJpeg = async function (o) {
  var cv = document.createElement('canvas');
  cv.width = 96; cv.height = 72;
  var c = cv.getContext('2d');
  c.fillStyle = o.color || '#3f7fbf'; c.fillRect(0, 0, 96, 72);
  c.fillStyle = '#e9b04a'; c.fillRect(12, 10, 40, 30);
  var blob = await new Promise(function (r) { cv.toBlob(r, 'image/jpeg', 0.9); });
  var base = new Uint8Array(await blob.arrayBuffer());
  /* 三种典型照片，缺一种就有一整条分支永远验不到：
       {gps:true}       有 EXIF + 有 GPS IFD      → ok
       {exifNoGps:true} 有 EXIF + 无 GPS IFD      → noGps  ← 真实世界最主流（手机拍照没定位）
       {}               连 EXIF 段都没有          → noExif ← 平台导出剥离（微信/微博）
     之前只有第一和第三种，于是「有 EXIF 但没记位置」这条主流分支从未被测过。 */
  if (!o.gps && !o.exifNoGps) return new File([base], o.name, { type: 'image/jpeg' });
  var app1 = mkApp1(o.lat, o.lng, o.date, !!o.gps);
  var out = new Uint8Array(2 + app1.length + base.length - 2);
  out.set(base.subarray(0, 2), 0);
  out.set(app1, 2);
  out.set(base.subarray(2), 2 + app1.length);
  return new File([out], o.name, { type: 'image/jpeg' });
};
window.__b64 = async function (blob) {
  var b = new Uint8Array(await blob.arrayBuffer());
  var s = '';
  for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
};
`;

/* ------------------------------------------------------------ 期望的省级计数
   直接由 photo-data.js 数出来（ph001~ph063），境外演示数据不投给任何省。 */
const EXPECT_COUNT = {
  110000: 6, // 北京 故宫×3 天坛 南锣鼓巷 八达岭 颐和园 → 6
  310000: 5,
  330000: 6,
  510000: 6,
  530000: 5,
  350000: 4,
  460000: 4,
  370000: 4,
  610000: 3,
  650000: 3,
  500000: 2,
  630000: 2,
  540000: 2,
  450000: 2,
  150000: 2,
  430000: 1,
  230000: 1,
  810000: 2,
  820000: 1,
  710000: 2,
};

(async () => {
  const out = { ok: false, url: '', errors: [], console: [] };
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

    /* ?fake 用伪瓦片：验填色不需要真密钥，也免得网络抖动混进读数。
       k=1200 是特意选的：它一屏装得下台湾、南海与东京 —— 采样点若落在视口外，
       sampleFill 会返回 null（这是设计如此），但那样等于没验，所以先把视野摆好。 */
    /* argv[3] 是追加的查询串，用来跑**对照**：
         node probe-fill.js http://127.0.0.1:8124 "&noanim"
       加上 ?noanim 后过渡动画整体退化回「每帧即时吸附」（改动前的行为）。
       对照的意义：4.10 的两条正向判据（animActiveOnZoom / animSpawnNearPrev）
       必须在这一轮**变红** —— 若照样全绿，说明它们是恒真的，等于没写。 */
    const URL = BASE + '/tdt-demo/index.html?fake&theme=night&at=110,25,1200' + (process.argv[3] || '');
    out.url = URL;
    await s.navigate(URL);
    for (let i = 0; i < 80; i++) {
      const rs = await ev('document.readyState');
      if (rs === 'complete') break;
      await sleep(100);
    }
    await sleep(1400);

    /* ------------------------------------------------ 0. 页面起来了没 */
    const boot = await ev('typeof window.__tdt === "object" ? __tdt.state() : null');
    if (!boot) throw new Error('__tdt 未挂载');
    out.boot = boot;
    out.hasImporter = await ev('__tdt.hasImporter()');

    /* ------------------------------------------------ 1. 几何 + 计数 */
    const geo = await ev('__tdt.fill()');
    out.geo = {
      features: geo.features,
      rings: geo.rings,
      verts: geo.verts,
      geoMs: geo.geoMs,
      ringsTotal: geo.ringsTotal,
      unassigned: geo.unassigned,
      filled: geo.filled,
      ramp: geo.ramp,
      chinaTotal: geo.chinaTotal,
      chinaT: geo.chinaT,
      countries: geo.countries,
      ctryRings: geo.ctryRings,
      ctryVerts: geo.ctryVerts,
      ctryGeoMs: geo.ctryGeoMs,
      ctryFilled: geo.ctryFilled,
      ctryDrawn: geo.ctryDrawn,
      ctrySkippedWide: geo.ctrySkippedWide,
      ctryUnassigned: geo.ctryUnassigned,
    };
    out.provinces = geo.provinces
      .map((p) => ({ adcode: p.adcode, name: p.name, count: p.count, idx: p.idx, rings: p.rings, fill: p.fill }))
      .sort((a, b) => a.adcode - b.adcode);
    out.ctryList = geo.ctryList.slice().sort((a, b) => b.count - a.count);
    out.countCheck = Object.keys(EXPECT_COUNT).map((k) => {
      const got = out.provinces.find((p) => String(p.adcode) === k);
      return { adcode: +k, expect: EXPECT_COUNT[k], got: got ? got.count : null, ok: !!got && got.count === EXPECT_COUNT[k] };
    });
    out.countCheckFailed = out.countCheck.filter((c) => !c.ok).length;
    /* 国别这一级的计数也必须对得上：境外 30 张。 */
    out.ctryPhotoSum = out.ctryList.reduce((a, c) => a + c.count, 0);
    out.chinaPhotoSum = geo.chinaTotal;

    /* ------------------------------------------------ 2. 填色层像素
       采样点都取在省内部、离边界远，避开抗锯齿。五个「有照片」的点
       **特意覆盖 5 个不同档位**（湖南 1 张 idx0 → 北京 6 张 idx4），
       这样「颜色是否真的随张数变化」才有证据。
       另有三个必须为 0 的点：东海水面、南海海面、印度（无照片的境外国家）。

       ⚠️ **曾经这里有一个反了的判据。** 原先有一个采样点
       「台湾以东海面（脏环处，必须 alpha=0）」在 (124.5, 25.9)，
       要求那里必须完全透明。那个位置是**赤尾屿** —— 外交部公布
       25°55.3′N / 124°33.5′E，钓鱼岛附属岛屿的最东端。也就是说，
       那条判据当时在要求「中国领土必须不被填色」，方向是反的。
       它之所以一直「通过」，是因为当时确实用环过滤把它筛掉了：
       筛选逻辑（保留与命中环 bbox 相交的环）把 124.5/25.9 上那个
       离岛环判成了脏数据。现在改成**正向**判据：钓鱼岛、黄尾屿、
       赤尾屿都必须被填。 */
    const SPOTS = [
      { tag: '北京 6 张（idx4）', lng: 116.4, lat: 39.9, want: 'alpha>0', lv: 4 },
      { tag: '上海 5 张（idx3）', lng: 121.4, lat: 31.2, want: 'alpha>0', lv: 3 },
      { tag: '陕西 3 张（idx2）', lng: 108.6, lat: 34.5, want: 'alpha>0', lv: 2 },
      { tag: '重庆 2 张（idx1）', lng: 107.0, lat: 29.8, want: 'alpha>0', lv: 1 },
      { tag: '湖南 1 张（idx0）', lng: 111.2, lat: 27.5, want: 'alpha>0', lv: 0 },
      { tag: '甘肃（无照片，应完全透明）', lng: 103.5, lat: 36.5, want: 'alpha=0' },
      { tag: '江西（无照片，应完全透明）', lng: 115.3, lat: 27.6, want: 'alpha=0' },
      { tag: '台湾本岛（2 张）', lng: 120.9, lat: 23.86, want: 'alpha>0' },
      { tag: '赤尾屿（中国领土，必须 alpha>0）', lng: 124.5583, lat: 25.9217, want: 'alpha>0', lv: 1 },
      { tag: '东海水面（无中国领土处，必须 alpha=0）', lng: 126.0, lat: 29.0, want: 'alpha=0' },
      { tag: '南海（海面，必须 alpha=0）', lng: 114.0, lat: 15.0, want: 'alpha=0' },
      /* ⚠️ 这里原本是「境外（东京，不投省级，必须 alpha=0）」。
         那条判据在只有省级填色时成立，加了国别这一级之后就不成立了 ——
         东京现在**应该**被填上（日本 10 张 = idx4 琥珀）。留着它等于
         在要求「国别填色必须失效」，方向反了。改成正向判据。 */
      { tag: '东京（日本 10 张，国别 idx4）', lng: 139.7, lat: 35.7, want: 'alpha>0', lv: 4 },
      { tag: '印度（无照片，必须 alpha=0）', lng: 78.0, lat: 22.0, want: 'alpha=0' },
    ];
    out.viewport = await ev('({w: __tdt.size.w, h: __tdt.size.h, dpr: __tdt.size.dpr})');
    out.pixels = SPOTS.map((sp) => ({ tag: sp.tag, lng: sp.lng, lat: sp.lat, want: sp.want, lv: sp.lv, px: null }));
    for (let i = 0; i < SPOTS.length; i++) {
      out.pixels[i].screen = await ev('__tdt.project(' + SPOTS[i].lng + ',' + SPOTS[i].lat + ')');
      out.pixels[i].px = await ev('__tdt.sampleFill(' + SPOTS[i].lng + ',' + SPOTS[i].lat + ')');
    }
    out.pixels.forEach((p) => {
      p.alpha = p.px ? p.px[3] : null;
      p.rgb = p.px ? p.px.slice(0, 3) : null;
      p.pxOk = p.want === 'alpha=0' ? p.alpha === 0 : p.alpha > 0;
    });
    out.outOfView = out.pixels.filter((p) => p.px === null).map((p) => p.tag);

    /* 半透明判据：满强度档的 alpha 必须明显小于 255，且各档只差颜色不差 alpha */
    out.alphaAtFilled = out.pixels.filter((p) => p.alpha > 0).map((p) => p.alpha);
    out.semiTransparent = out.alphaAtFilled.length > 0 && out.alphaAtFilled.every((a) => a > 40 && a < 250);

    /* 档差判据：不同张数的省必须有不同颜色（量化到 8 一级，避开取整噪声） */
    const withPx = out.pixels.filter((p) => p.alpha > 0);
    out.distinctColors = new Set(withPx.map((p) => p.rgb.map((v) => Math.round(v / 8)).join(','))).size;

    /* 滤镜隔离判据：填色层读到的颜色必须**等于**色阶变量本身，
       而不是被 invert/grayscale 洗过的值。
       注意 canvas 的 getImageData 是反预乘的，alpha=140 时会还原出 ±2 的取整误差，
       所以这里给 ±4 的容差 —— 被滤镜洗过的话偏差是几十上百，容差不会误判。 */
    const rampCheck = await ev(`(() => {
      const cs = getComputedStyle(document.getElementById('app'));
      return [1,2,3,4,5].map(i => cs.getPropertyValue('--m-d' + i).trim());
    })()`);
    out.rampVars = rampCheck;
    const RAMP_RGB = rampCheck.map((h) => [1, 3, 5].map((i) => parseInt(h.substr(i, 2), 16)));
    const nearRamp = (rgb) => RAMP_RGB.some((r) => r.every((v, i) => Math.abs(v - rgb[i]) <= 4));
    out.rampUntouched = out.pixels
      .filter((p) => p.alpha > 0)
      .map((p) => ({ tag: p.tag, rgb: p.rgb, inRamp: nearRamp(p.rgb) }));

    /* 最强的一条判据：每个采样点的颜色必须**精确等于它那个档位的色阶值**。
       五个点分别覆盖 idx0~idx4，所以这一条同时证明了
       「分档公式对」+「色阶映射对」+「填色层没被滤镜动过」。
       判据用「5 个档位都出现过」，而不是「恰好 5 个点」——
       后来加了赤尾屿的采样点（也是 idx1），点数会变，档位覆盖才是要领。 */
    out.levelMap = out.pixels
      .filter((p) => p.lv != null && p.alpha > 0)
      .map((p) => ({
        tag: p.tag,
        lv: p.lv,
        rgb: p.rgb,
        want: RAMP_RGB[p.lv],
        ok: RAMP_RGB[p.lv].every((v, i) => Math.abs(v - p.rgb[i]) <= 4),
      }));
    out.levelMapLv = Array.from(new Set(out.levelMap.map((l) => l.lv))).sort();
    out.levelMapOk = out.levelMapLv.length === 5 && out.levelMap.every((l) => l.ok);

    /* 归属日志：每个地点判给了哪个省、是「落在省内」还是「判给最近省」 */
    out.assign = await ev('__tdt.assign()');
    out.assignNear = out.assign.filter((a) => a[2] === 'near').map((a) => a[0]);
    out.assignNone = out.assign.filter((a) => a[1] === 0).map((a) => a[0]);

    await ev('__tdt.setCamera(104, 34, 2200)');
    await sleep(400);
    fs.writeFileSync(SHOT_NATION, await s.screenshotPNG());

    /* ------------------------------------------------ 3. 缩放淡出 */
    out.fade = {};
    for (const k of [4000, 12000, 26000, 40000]) {
      await ev('__tdt.setCamera(104, 34, ' + k + ')');
      await sleep(320);
      const f = await ev('__tdt.fill()');
      out.fade[k] = { alpha: +f.alpha.toFixed(4), drawn: f.drawn };
    }
    await ev('__tdt.setCamera(104, 34, 2200)');
    await sleep(320);

    /* ------------------------------------------------ 4. hover 放大（真实鼠标） */
    const pin = await ev(`(() => {
      const ps = document.querySelectorAll('.stage__overlay .pin');
      for (const el of ps) {
        const r = el.getBoundingClientRect();
        if (r.width > 8 && r.height > 8 && r.left > 2 && r.top > 2 && r.right < innerWidth - 2 && r.bottom < innerHeight - 2)
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      return null;
    })()`);
    out.hover = { pinAt: pin };
    if (pin) {
      await mouse({ type: 'mouseMoved', x: 6, y: 6 });
      await sleep(120);
      out.hover.beforeClass = await ev('!!document.querySelector(".pin.is-hover")');
      await mouse({ type: 'mouseMoved', x: Math.round(pin.x), y: Math.round(pin.y) });
      await sleep(300);
      out.hover.afterClass = await ev('!!document.querySelector(".pin.is-hover")');
      out.hover.transform = await ev(`(() => {
        const e = document.querySelector('.pin.is-hover');
        return e ? getComputedStyle(e).transform : null;
      })()`);
      out.hover.zIndex = await ev(`(() => {
        const e = document.querySelector('.pin.is-hover');
        return e ? getComputedStyle(e).zIndex : null;
      })()`);
      await mouse({ type: 'mouseMoved', x: 6, y: 6 });
      await sleep(200);
      out.hover.afterLeave = await ev('!!document.querySelector(".pin.is-hover")');
    }

    /* =================== 4.1 两级切换：世界视图按国、全国视图按省 ===================

       k 是世界宽度的尺度（世界宽 2πk 像素）：
         「世界」按钮 → fitBox(WORLD) → k ≈ 201
         「全国」按钮 → fitBox(HOME)  → k ≈ 1172
       切换带 [[CH_LO_K, CH_HI_K]] = [420, 900] 必须落在这两个数之间 ——
       否则「全国视图下还是一整块中国」，省级填色等于被自己挡掉。
       所以这里**直接用按钮那条路算出来的 k**，不用随手取的数。 */
    const viewAt = async (k, lng, lat) => {
      await ev('__tdt.setCamera(' + lng + ',' + lat + ',' + k + ')');
      await sleep(430);
      /* 先把「此时是否有悬停」记下来，再清掉。
         **不清的代价是实测过的**：被悬停的那一块自己会被画深（颜色 + alpha 都变），
         而 (6,6) 那个位置在 k=1172 下正好落在新疆（3 张照片）上，
         于是世界视图的采样点读数会偏，看起来像「两级切换坏了」。
         这不是测量噪声，是测量口径错了 —— 所以基线必须是「无悬停」。
         （当时的原因更重：旧实现还会把其余区域压暗到 0.42 倍。那个机制已删，
          但清理仍然必要 —— 见上。） */
      const hv = await ev('__tdt.hover()');
      await ev('__tdt.resetHover()');
      await sleep(160);
      const f = await ev('__tdt.fill()');
      return { k: k, t: f.chinaT, alpha: +f.alpha.toFixed(4), pDrawn: f.drawn, cDrawn: f.ctryDrawn, hover: hv };
    };
    const px = (lng, lat) => ev('__tdt.sampleFill(' + lng + ',' + lat + ')');
    const pxMax = (lng, lat, r) => ev('__tdt.sampleFillMax(' + lng + ',' + lat + ',' + (r || 6) + ')');
    const sameRgb = (a, b) => !!a && !!b && a.slice(0, 3).join(',') === b.slice(0, 3).join(',');

    /* ---- 世界视图（k=201）：中国整块同色，境外按国上色 ---- */
    out.world = await viewAt(201, 104, 30);
    out.world.hn = await px(111, 27); // 湖南
    out.world.sc = await px(102, 29); // 四川
    out.world.jp = await px(138.0, 36.3); // 日本本州内陆
    out.world.mn = await px(101, 47); // 蒙古（无照片）
    out.worldJpHit = await ev('__tdt.hitAt(138.0,36.3)');
    out.worldChinaOneColor =
      out.world.t === 0 &&
      !!out.world.hn && !!out.world.sc &&
      out.world.hn[3] > 100 && out.world.sc[3] > 100 &&
      sameRgb(out.world.hn, out.world.sc);
    out.worldCtryFilled =
      !!out.world.jp && out.world.jp[3] > 100 &&
      !!out.worldJpHit && out.worldJpHit.kind === 'ctry' && out.worldJpHit.name === '日本' && out.worldJpHit.count === 10;
    out.worldCtryEmpty = !!out.world.mn && out.world.mn[3] === 0;

    /* ---- 全国视图（k=1172）：逐省分色 ---- */
    out.nation = await viewAt(1172, 111, 27);
    out.nation.hn = await px(111, 27);
    out.nation.sc = await px(102, 29);
    /* 湖南 1 张（idx0）、四川 6 张（idx4）—— 颜色必须不同才叫「分省」 */
    out.nationProvDiffers =
      out.nation.t === 1 &&
      !!out.nation.hn && !!out.nation.sc &&
      out.nation.hn[3] > 100 && out.nation.sc[3] > 100 &&
      !sameRgb(out.nation.hn, out.nation.sc);

    /* ---- 离岛：钓鱼岛 / 黄尾屿 / 赤尾屿必须被填（合规正向判据）----
       用窗口取最大 alpha 而不是单点：这些岛在 k=6000 时只有几个像素，
       单点很容易落在抗锯齿边缘上（实测拿到 8~18），
       那是「画了但采样点不好」，不是「没画」。 */
    out.islands = { view: await viewAt(6000, 123.5, 25.5) };
    out.islands.diaoyu = await pxMax(123.482, 25.7408, 6); // bbox 中心
    out.islands.huangwei = await pxMax(123.7007, 25.9295, 6);
    out.islands.chiwei = await pxMax(124.5583, 25.9217, 6);
    /* 阈值取 60，不取 100：黄尾屿 1.1km 在 k=6000 下只有 0.18 设备像素，
       画出来是**部分覆盖**的一小块，alpha 实测在 109~140 之间抖。
       而「完全没画」的读数恒为 0（窗口取最大也救不回来）。
       60 离 0 很远、离抖动下限还有余量，是这条判据真正的分界。 */
    out.islandsFilled =
      [out.islands.diaoyu, out.islands.huangwei, out.islands.chiwei].every((p) => !!p && p[3] >= 60);

    /* =================== 4.2 填色层的 hover：只动被悬停的那一块 ===================
       和 pin 的 hover 一样走**真实鼠标移动**，不是人肉 dispatch 事件。

       口径（用户拍板）：「hover 中的色块变，其他色块不要变」。三半判据，各自都能失败：
         ① 被悬停的湖南省：alpha 变高，**并且 RGB 变深**；
         ② 别的有照片的省（四川）采样点逐字节相同；
         ③ 悬停区包围盒**之外**的整层像素哈希完全一致。
       ③ 是这里的关键 —— 「其余不变」这句话的全部证据在没被点到的那些像素上，
       点采样证不了它。用 __tdt.fillDigest(ex) 把悬停区排除掉再比前后。

       ⚠️ 为什么必须带反向锁（digestExcludeElsewhere）：一个恒定的哈希会让 ③ 恒真。
       所以同时算一个「排除别处、把悬停区**留在**哈希里」的指纹 —— 它前后必须不同。
       没有这一条，③ 可能只是「这个读数根本不动」。 */
    out.fillHover = {};
    await viewAt(1172, 111, 27);
    const ptHn = JSON.parse(await ev('JSON.stringify(__tdt.project(111,27))'));
    const ptSc = JSON.parse(await ev('JSON.stringify(__tdt.project(102,29))'));
    /* 两个包围盒都取 160×160：k=1172 下湖南约 90×80 CSS 像素，装得下还有富余。
       宁可取大 —— 取小了会把「悬停区边缘蹭到一点」误算成「别处变了」，
       判据假红；取大只牺牲一点敏感度，不会假绿。 */
    const boxAt = (pt) => [Math.round(pt.x) - 80, Math.round(pt.y) - 80, 160, 160];
    const EX_HN = boxAt(ptHn); // 排除被悬停的湖南
    const EX_SC = boxAt(ptSc); // 反向锁：排除四川，湖南仍留在哈希里
    out.fillHover.ex = { hn: EX_HN, sc: EX_SC };

    await mouse({ type: 'mouseMoved', x: 6, y: 6 }); // (6,6) 在新疆，不覆盖湖南四川
    await sleep(220);
    out.fillHover.base = {
      hn: await px(111, 27),
      sc: await px(102, 29),
      tip: await ev('__tdt.tip()'),
      outside: await ev('__tdt.fillDigest(' + JSON.stringify(EX_HN) + ')'),
      lock: await ev('__tdt.fillDigest(' + JSON.stringify(EX_SC) + ')'),
    };

    await mouse({ type: 'mouseMoved', x: Math.round(ptHn.x), y: Math.round(ptHn.y) });
    await sleep(420);
    out.fillHover.hit = await ev('__tdt.hover()');
    out.fillHover.after = { hn: await px(111, 27), sc: await px(102, 29) };
    out.fillHover.tip = await ev('__tdt.tip()');
    out.fillHover.outsideAfter = await ev('__tdt.fillDigest(' + JSON.stringify(EX_HN) + ')');
    out.fillHover.lockAfter = await ev('__tdt.fillDigest(' + JSON.stringify(EX_SC) + ')');
    out.fillHoverShot = true;
    fs.writeFileSync(SHOT_HOVER, await s.screenshotPNG());

    const bHn = out.fillHover.base.hn;
    const bSc = out.fillHover.base.sc;
    const aHn = out.fillHover.after.hn;
    const aSc = out.fillHover.after.sc;
    const lum = (p) => (p ? p[0] + p[1] + p[2] : -1);
    const same = (a, b) => !!a && !!b && a.join(',') === b.join(',');

    out.hoverLifts = !!bHn && !!aHn && aHn[3] > bHn[3] * 1.4;
    /* 「变深」要单独判。只查 alpha 是不够的：上一版是「提亮 + 压暗其余」，
       被悬停区的 alpha 同样会变高、判据照样绿 —— 而那正是用户不要的方向。 */
    out.hoverDeepens = !!bHn && !!aHn && lum(aHn) < lum(bHn);
    out.hoverRestUnchanged = same(bSc, aSc);
    /* ③ 悬停区之外整层像素一致。n 必须 > 0 —— 空区域上「哈希相同」是废话。 */
    out.hoverOutsideIdentical =
      !!out.fillHover.base.outside && !!out.fillHover.outsideAfter &&
      out.fillHover.base.outside.n > 0 && out.fillHover.outsideAfter.n > 0 &&
      out.fillHover.base.outside.h === out.fillHover.outsideAfter.h;
    /* 反向锁：同一个指纹，换成排除四川（湖南留在哈希里）→ 前后**必须**不同。
       这一条绿，才说明上面那条不是因为读数根本不动才绿的。 */
    out.hoverDigestSensitive =
      !!out.fillHover.base.lock && !!out.fillHover.lockAfter &&
      out.fillHover.base.lock.n > 0 &&
      out.fillHover.base.lock.h !== out.fillHover.lockAfter.h;
    out.hoverRegionHit =
      !!out.fillHover.hit && out.fillHover.hit.kind === 'prov' && out.fillHover.hit.name === '湖南省' && out.fillHover.hit.count === 1;
    out.hoverTipText = !!(out.fillHover.tip && out.fillHover.tip.on && /湖南省/.test(out.fillHover.tip.text) && /1\s*张照片/.test(out.fillHover.tip.text));

    /* ---- 世界视图：中国整块作为一个命中目标 ---- */
    await viewAt(201, 104, 30);
    const ptCn = JSON.parse(await ev('JSON.stringify(__tdt.project(104,30))'));
    await mouse({ type: 'mouseMoved', x: Math.round(ptCn.x), y: Math.round(ptCn.y) });
    await sleep(420);
    out.hoverChinaWhole = await ev('__tdt.hover()');
    out.hoverChinaOk =
      !!out.hoverChinaWhole && out.hoverChinaWhole.kind === 'china' && out.hoverChinaWhole.name === '中国' && out.hoverChinaWhole.count === 63;
    fs.writeFileSync(SHOT_HOVER_CN, await s.screenshotPNG());

    /* ---- 移到没有照片的国家：不该有任何反应 ---- */
    const ptMn = JSON.parse(await ev('JSON.stringify(__tdt.project(101,47))'));
    await mouse({ type: 'mouseMoved', x: Math.round(ptMn.x), y: Math.round(ptMn.y) });
    await sleep(420);
    out.hoverEmpty = await ev('__tdt.hover()');
    out.hoverEmptyTip = await ev('__tdt.tip()');
    out.hoverEmptyQuiet = out.hoverEmpty === null && out.hoverEmptyTip.on === false;

    /* =================== 4.3 聚合按国界：同簇不得跨国 ===================
       用户报的现象：世界视图下中国的照片被并进了日本的簇，簇名显示「东京」。
       原因是 k≈300 时北京与东京只差 136px，落在 3×3 邻格里。
       现在合并要求区域键相同，跨国误并从结构上不可能发生。
       判据直接查「每一簇里出现过的区域集合」，只看截图看不出来。 */
    await viewAt(300, 104, 25);
    const cls = await ev('__tdt.clusters()');
    out.clusters = cls.map((c) => ({
      region: c.region,
      regions: c.regions,
      cities: c.cities,
      provs: c.provs,
      label: c.label,
      n: c.n,
      places: c.places,
    }));
    /* 判据要能证伪。**空串也算不合格** —— 上一版这里是「从簇成员反推区域键」，
       而簇成员是照片记录、身上没有区域键，反推出来永远是 ['']，
       长度恰好是 1，于是这条判据恒真：一个假通过。
       现在 regions 由 clusterize() 直接维护，并要求「恰好一个键」
       且「这个键非空、且等于簇自己的区域键」。 */
    out.clusterMixed = out.clusters.filter(
      (c) => !c.regions || c.regions.length !== 1 || !c.regions[0] || c.regions[0] !== c.region
    );
    out.noCrossRegion = out.clusters.length > 0 && out.clusterMixed.length === 0;
    /* 日本那一簇的张数必须正好是日本自己的 10 张 —— 多一张就说明并进了中国的 */
    const jpCls = out.clusters.filter((c) => c.region === 'JP');
    out.jpClusterN = jpCls.reduce((a, c) => a + c.n, 0);
    out.jpClusterOk = jpCls.length > 0 && out.jpClusterN === 10;
    /* 世界视图下中国那一簇**必须仍报「中国」**：它跨 20+ 个城市，就该粗。
       ⚠️ 上一版这里是「所有多地点中国簇都必须报中国」—— 那条规则本身
       就是本轮要推翻的东西：放大后「北京·故宫 + 北京·天坛 + …」也报「中国」。
       判据跟着规则一起改，否则它会锁住一个错误的旧行为。 */
    const cnCls = out.clusters.filter((c) => c.region === 'CN');
    out.cnClusterLabels = cnCls.map((c) => c.label + '(' + c.n + ')');
    const cnBig = cnCls.slice().sort((a, b) => b.n - a.n)[0];
    out.cnBigCluster = cnBig ? { label: cnBig.label, n: cnBig.n, cities: cnBig.cities.length } : null;
    out.cnBigSaysChina = !!cnBig && cnBig.label === '中国' && cnBig.cities.length > 1;
    /* 单地点簇仍报地名 —— 不然「三亚」会变成「中国」，反而丢了信息 */
    const single = out.clusters.filter((c) => c.places.length === 1);
    out.singleLabelKeepsPlace = single.length > 0 && single.every((c) => c.label === c.places[0]);

    /* ============ 4.4 换视野后旧的悬停必须失效（回归锁）============
       复现路径：把真实鼠标停在湖南省上建立悬停，然后**完全不动鼠标**改相机。
       如果 hover 只在 mouseMoved 时才解算，旧湖南省会一直挂着 ——
       高亮赖在一个已经不是光标底下的区域上。
       这条锁现在比以前**更重要**，不是为了那个已经删掉的「压暗其余」：
       当时它把 4.1 的 alpha 读数从 140 改成 59、差点被误读成「两级切换坏了」；
       而现在的表现更隐蔽 —— 只是「某块的颜色一直偏深」，肉眼几乎看不出来。
       这个 bug 是真实发生过的，这里把它钉死。 */
    await viewAt(1172, 111, 27);
    const ptHn2 = JSON.parse(await ev('JSON.stringify(__tdt.project(111,27))'));
    await mouse({ type: 'mouseMoved', x: Math.round(ptHn2.x), y: Math.round(ptHn2.y) });
    await sleep(420);
    out.staleHover = { before: await ev('__tdt.hover()') };
    await ev('__tdt.setCamera(90, 24, 1172)'); // 只改相机，不动鼠标
    await sleep(520);
    out.staleHover.after = await ev('__tdt.hover()');
    out.staleHover.tip = await ev('__tdt.tip()');
    /* 相机挪到大西南，原屏幕点这时落在印度/孟加拉湾上（都没有照片）
       → 必须变成「没有悬停」，气泡也必须收掉。 */
    out.staleHoverCleared =
      !!out.staleHover.before &&
      out.staleHover.before.name === '湖南省' &&
      out.staleHover.after === null &&
      out.staleHover.tip.on === false;

    /* 复位相机与鼠标，别把状态留给后面的用例 */
    await viewAt(1172, 111, 27);
    await mouse({ type: 'mouseMoved', x: 6, y: 6 });
    await sleep(260);

    /* ============ 4.5 标签分级：放大后必须越来越具体 ============
       用户原话：「最小的时候按国界划分……但是当我放大，这个时候照片就要
       显示具体的地理位置，而不是还显示『中国』两字。」
       旧规则只有一条「成员数 > 1 就报区域名」，而中国的区域名恒为「中国」，
       于是 k=1172 时「北京·故宫 + 北京·天坛 + 北京·南锣鼓巷 + …」那一簇
       也写着「中国」—— 实测确实如此。
       现在的 clusterLabel() 按簇内成员的**同质程度**分级，不设缩放阈值：
         去重后只剩一个地点名 → 报完整地名；城市段全同 → 报城市；
         同属一省 → 报省名；否则 → 报国名。
       判据分两层：先扫 7 个 k 验**与视野无关的不变量**，再验三个具体场景。 */
    const LADDER = [201, 400, 700, 1172, 2000, 4000, 8000];
    out.ladder = [];
    out.ladderBad = [];
    for (const k of LADDER) {
      await viewAt(k, 106, 33);
      const ls = await ev('__tdt.clusters()');
      /* 不变量：**多地点簇**若城市段唯一且非空 → 标签必须正好是那个城市名。
         这一条与缩放无关，任何 k 下都该成立，所以它比场景判据更难蒙对。
         ⚠️ 必须排除 n=1 的单地点簇：那时报完整地名（「迪拜·哈利法塔」）
         比降级成城市名（「迪拜」）**更具体**，是分级里更高的那一级。
         第一版没排除，于是把一批正确的读数报成了违规 —— 判据自己写错，
         和「假通过」是同一类错误，只是方向相反。 */
      const bad = ls.filter(
        (c) => c.names.length > 1 && c.cities.length === 1 && c.cities[0] && c.label !== c.cities[0]
      );
      out.ladder.push({ k: k, n: ls.length, labels: ls.map((c) => c.label + '(' + c.n + ')') });
      if (bad.length) {
        out.ladderBad.push({ k: k, bad: bad.map((c) => ({ label: c.label, city: c.cities[0], n: c.n })) });
      }
    }
    out.cityLabelExact = out.ladderBad.length === 0;

    /* 场景一：世界视图下中国那一簇跨 20+ 城市 → **仍报「中国」**（不许细化） */
    await viewAt(201, 106, 33);
    fs.writeFileSync(SHOT_LABEL_WORLD, await s.screenshotPNG());
    const w201 = await ev('__tdt.clusters()');
    const cn201 = w201.filter((c) => c.region === 'CN').sort((a, b) => b.n - a.n)[0];
    out.worldViewCn = cn201 ? { label: cn201.label, n: cn201.n, cities: cn201.cities.length } : null;
    out.worldKeepsCountry = !!cn201 && cn201.label === '中国' && cn201.cities.length > 1;

    /* 场景二：全国视图下北京那一簇 → **必须报「北京」**，且不得是「中国」 */
    await viewAt(1172, 116.4, 39.9);
    fs.writeFileSync(SHOT_LABEL_BJ, await s.screenshotPNG());
    const n1172 = await ev('__tdt.clusters()');
    const bj = n1172.filter((c) => c.cities.length === 1 && c.cities[0] === '北京')[0];
    out.nationBeijing = bj ? { label: bj.label, n: bj.n, places: bj.places } : null;
    out.nationBeijingSaysCity = !!bj && bj.label === '北京' && bj.label !== '中国';
    /* 全国视图下「城市段唯一却报国名」的簇数必须为 0 —— 这是用户抱怨的原始形态 */
    out.nationNoOverCoarse =
      n1172.filter((c) => c.cities.length === 1 && c.cities[0] && c.label === '中国').length === 0;

    /* 场景三：同省不同市 → 报省名（比国名具体，比城市名诚实）。
       省名必须走 shortName（「山东省」→「山东」，「新疆维吾尔自治区」→「新疆」），
       所以拿引擎导出的 provShort 做参照，而不是拿原始省名 ——
       判据不去重新实现一遍缩写规则，否则它验的是自己。 */
    const provCls = n1172.filter(
      (c) => c.cities.length > 1 && c.provShort && c.label === c.provShort
    );
    out.sameProvSaysProv = provCls.length > 0;
    out.sameProvSamples = provCls.map((c) => c.label + '(' + c.n + ')');

    /* ============ 4.6 合规：台湾单列 / 港澳双名 / 省名缩写 ============
       这三条不是本轮用户提的，是照着主线（`photo-map.js` 的 clusterLabel）
       核对时发现的落差。**上一版实验线违纪**：`厦门·鼓浪屿 + 厦门·环岛路 +
       南平·武夷山 + 中国台湾·日月潭 + 中国台湾·台北` 被合成了一个簇 ——
       等于把中国台湾并进了大陆的簇里，违反项目技术底线第 4 条。
       港澳同理：两地相距约 60km，全国尺度下必然重叠，可以合并成一格，
       但**两个名字都得写出来**，否则分级逻辑会把其中一个精简掉。 */
    await viewAt(1172, 106, 33);
    const comp = await ev('__tdt.clusters()');
    /* ① 台湾的簇里只能有台湾。solo 簇若混进任何别的省就是违纪。 */
    out.taiwanClusters = comp.filter((c) => c.solo).map((c) => c.label + '(' + c.n + ')');
    out.taiwanSoloViolation = comp
      .filter((c) => c.solo && !(c.provs.length === 1 && c.provs[0] === '台湾省'))
      .map((c) => ({ label: c.label, provs: c.provs, places: c.places }));
    out.taiwanSolo = out.taiwanClusters.length > 0 && out.taiwanSoloViolation.length === 0;
    /* ② 港澳合簇时两个名字都要在标签里。
       但「该双名」只指**簇内省份恰好就是港澳这两个**的簇 ——
       世界视图下中国会合成一个含港澳的巨簇，那不是「港澳簇」。
       视野对准珠江口取样，这样一对准就必然捕捉到港澳簇（不会因视野而空集）。 */
    await viewAt(1172, 114, 24);
    fs.writeFileSync(SHOT_HKMO, await s.screenshotPNG());
    const hkView = await ev('__tdt.clusters()');
    const hkmo = hkView.filter((c) => c.msts.length > 1 && c.provs.length === c.msts.length);
    out.hkmoLabels = hkmo.map((c) => c.label + '(' + c.n + ')');
    /* ⚠️ 必须带 `hkmo.length > 0`：空集上 every() 恒真，又是一个假通过。
       （这个坑上一轮刚踩过一次，见 4.3 的 regionSet。） */
    out.hkmoBothShown = hkmo.length > 0 && hkmo.every((c) => c.label === '中国香港 / 中国澳门');
    /* 反向锁：**不该双名的时候不许双名**。第一版没有这条，于是世界视图下
       那个跨 27 城的中国巨簇被港澳规则劫持，55 张照片标签写成了
       「中国香港 / 中国澳门」。是 `worldKeepsCountry` 先把它抓出来的。 */
    /* 两处一起查：世界视图（w201，那里有含港澳的中国巨簇）与全国视图（comp）。
       只查一个视野会漏 —— 巨簇只出现在世界尺度上。 */
    out.hkmoOverreach = comp
      .concat(w201)
      .filter((c) => c.label.indexOf('中国香港') >= 0 && c.provs.length !== 2)
      .map((c) => c.label + '(' + c.n + ' / provs=' + c.provs.length + ')');
    out.noHkMoOverreach = out.hkmoOverreach.length === 0;
    /* ③ 省名不得残留「省 / 自治区 / 特别行政区」后缀 */
    out.rawProvLabels = comp
      .filter((c) => /(省|自治区|特别行政区)$/.test(c.label))
      .map((c) => c.label);
    out.noRawProvSuffix = out.rawProvLabels.length === 0;

    /* ============ 4.7 聚合粒度跟随填色粒度：省级粒度下不得跨省 ============
       用户原话：「在这个视图下既然已经显示了像拉萨、新疆、呼伦贝尔、哈尔滨，
       这种情况都已经是省或者直辖市维度了，对吧？但现在像四川省，它直接显示的
       还是『中国』；陕西省也显示的是『中国』；北京的这几张照片显示的也是
       『中国』。」还追问：「看一下这几张照片是不是在同一个维度里。」
       还提了一个方案：「重庆跟湖南合在了一起，我们就按数量最多来决定显示哪个。」

       实测：**是同一个维度的问题，但根因不是标签不够聪明。**
       这一屏（k=1172）有 4 个簇跨了省 ——
         上海+浙江(11)、四川+重庆(7)、四川+云南(6)、广西+湖南(3)，
       标签分级走到第④级「跨省 → 报区域名」，于是全部显示成「中国」。
       同屏的 北京/福建/海南/山东/西安/新疆/青海/拉萨/呼伦贝尔 都是单省簇，
       标签正常 —— 所以那一屏看起来就是「一堆省名里混着五个『中国』」。

       病根是**聚合粒度与填色粒度对不上**：填色已经逐省分色（t=1），
       聚合却还按国家合并。修法是 unitOf() 在 t ≥ 0.5 时把聚合单位下沉到省
       adcode，于是「同一簇跨两个省」在结构上不可能。

       为什么不用「按数量最多的省来命名」：那只是把症状藏起来 ——
       一个含上海 5 张的簇顶着「浙江」的标签，点开却有两省的照片，
       而它脚下的填色是两种颜色。拆开是唯一诚实的做法。

       这一段的判据都**直接查簇的 unit / provs 集合**，不依赖
       「某个簇该叫什么名字」的判断 —— 比看标签长什么样硬。 */
    out.gran = [];
    for (const k of [900, 1172, 1600, 2400]) {
      await viewAt(k, 104, 34);
      const cs = await ev('__tdt.clusters()');
      const cn = cs.filter((c) => c.region === 'CN');
      out.gran.push({
        k: k,
        t: (await ev('__tdt.fill()')).chinaT,
        cn: cn.length,
        total: cs.length,
        /* 跨省的簇：provs 里有两个及以上非空省名。
           ⚠️ 必须排除港澳单位（unit='CN-MST'）：香港与澳门是**两个**省级行政区，
           相距约 60km，全国尺度下分开必然重叠、没法两边都放准 ——
           允许合并成一格，靠标签的双名规则把两个名字都写出来（合规要求）。
           第一版没排除，于是把这条正确的合并报成了违规（**假失败**，
           与「假通过」是同一类错误、方向相反）。 */
        crossProv: cn
          .filter((c) => c.unit !== 'CN-MST' && c.provs.filter(Boolean).length > 1)
          .map((c) => c.label + '(' + c.n + ' / ' + c.provs.join('+') + ')'),
        /* 港澳单位里的簇，必须恰好是港、澳两个省 —— 既不多（并进别的省）
           也不少（只剩一个），并且标签双名（后半条由 hkmoBothShown 验）。 */
        mstUnitBad: cn
          .filter((c) => c.unit === 'CN-MST')
          .filter((c) => !(c.provs.length === 2 && c.provs.indexOf('香港特别行政区') >= 0 && c.provs.indexOf('澳门特别行政区') >= 0))
          .map((c) => c.label + '(' + c.n + ' / ' + c.provs.join('+') + ')'),
        /* 报了「中国」的簇 */
        saysChina: cn.filter((c) => c.label === '中国').map((c) => c.n),
        /* unit 必须已经下沉（不再等于 'CN'）的簇数 */
        stillCountryUnit: cn.filter((c) => c.unit === 'CN').length,
      });
    }
    out.noCrossProvAtProv = out.gran.every((g) => g.crossProv.length === 0);
    out.mstUnitClean = out.gran.every((g) => g.mstUnitBad.length === 0);
    out.noChinaLabelAtProv = out.gran.every((g) => g.saysChina.length === 0);
    out.unitSunkAtProv = out.gran.every((g) => g.stillCountryUnit === 0);

    /* 反向锁：**不许用力过猛**。国家级粒度下（k=201）中国必须仍然整块合并 ——
       否则「最小时按国界划分」这条原始需求就被本次修改推翻了。
       两条都要：k=201 的 CN 簇数明显少于省级粒度，且确有 unit='CN' 的簇。 */
    await viewAt(201, 106, 33);
    const g201b = await ev('__tdt.clusters()');
    const cn201b = g201b.filter((c) => c.region === 'CN');
    out.gran201 = {
      cn: cn201b.length,
      merged: cn201b.filter((c) => c.unit === 'CN').length,
      labels: cn201b.map((c) => c.label + '(' + c.n + ')'),
    };
    out.worldStillMerged = cn201b.length < out.gran[1].cn && out.gran201.merged > 0;

    /* 用户点名的那几对：拆开后的实际标签，直接对着他的原话验 */
    await viewAt(1172, 104, 34);
    fs.writeFileSync(SHOT_LABEL_PROVS, await s.screenshotPNG());
    const gv = await ev('__tdt.clusters()');
    out.provViewLabels = gv
      .filter((c) => c.region === 'CN')
      .map((c) => c.label + '(' + c.n + ')');
    out.splitCases = {};
    for (const pair of [['上海', '杭州'], ['成都', '重庆'], ['丽江', '甘孜'], ['桂林', '张家界']]) {
      const ca = pair[0];
      const cb = pair[1];
      const both = gv.filter((c) => c.cities.indexOf(ca) >= 0 && c.cities.indexOf(cb) >= 0);
      out.splitCases[ca + '+' + cb] = {
        /* 同簇就是失败 —— 那正是「跨省合并」的定义 */
        same: both.map((c) => c.label + '(' + c.n + ')'),
        splitOk: both.length === 0,
        aLabel: ((gv.filter((c) => c.cities.indexOf(ca) >= 0)[0] || {}).label) || '',
        bLabel: ((gv.filter((c) => c.cities.indexOf(cb) >= 0)[0] || {}).label) || '',
      };
    }
    out.fourPairsSplit = Object.keys(out.splitCases).every((p) => out.splitCases[p].splitOk);

    /* ============ 4.8 每个标注都必须「够得到」（量 DOM 真实 rect） ============
       2026-09-13 二次裁决（用户原话）：「取消连线的做法，做 pin 点上的缩略图
       重叠，hover 到哪个缩略图，哪个缩略图就要在最上面。」重叠本身已被接受，
       避让挪位（连带牵引线 / 白点）已整体删除 —— pin 恒在簇锚点。
       这条判据随之换语义：**不许有任何标注被完全盖死**。完全被盖住的卡
       悬停不到、点不到、面板打不开 —— 重叠允许，够不到不允许。
       量法：对每个 .mk 的矩形撒点采样，统计不被任何「DOM 序靠后（画在
       上层）的矩形」盖住的采样点占比；要求每个标注可见占比 ≥ 4%
       （完全重合才是 0%，正常部分重叠远高于它）。 */
    const MEASURE_OVERLAP = `(() => {
      const boxes = [];
      document.querySelectorAll('.stage__overlay .mk').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4 || r.left < -900) return;
        const nm = el.querySelector('.pin__name');
        boxes.push({ label: nm ? nm.textContent : '', l: r.left, t: r.top, w: r.width, h: r.height });
      });
      /* 每个 box 撒 12×12 = 144 个点；只被「排在自己后面（画在上层）」
         的框盖住才算被盖 —— DOM 序就是绘制序。 */
      const N = 12;
      const visible = [];
      for (let i = 0; i < boxes.length; i++) {
        const a = boxes[i];
        let hit = 0;
        for (let py = 0; py < N; py++) {
          for (let px = 0; px < N; px++) {
            const x = a.l + (a.w * (px + 0.5)) / N;
            const y = a.t + (a.h * (py + 0.5)) / N;
            let covered = false;
            for (let j = i + 1; j < boxes.length && !covered; j++) {
              const b = boxes[j];
              if (x >= b.l && x <= b.l + b.w && y >= b.t && y <= b.t + b.h) covered = true;
            }
            if (!covered) hit++;
          }
        }
        visible.push({ label: a.label, ratio: hit / (N * N) });
      }
      const pairs = [];
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i], b = boxes[j];
          const ox = Math.min(a.l + a.w, b.l + b.w) - Math.max(a.l, b.l);
          const oy = Math.min(a.t + a.h, b.t + b.h) - Math.max(a.t, b.t);
          if (ox > 0.5 && oy > 0.5) {
            pairs.push({
              a: a.label, b: b.label, ox: +ox.toFixed(1), oy: +oy.toFixed(1),
              ratio: +((ox * oy) / Math.min(a.w * a.h, b.w * b.h)).toFixed(3),
            });
          }
        }
      }
      pairs.sort((p, q) => q.ratio - p.ratio);
      const worstVis = visible.length ? Math.min.apply(null, visible.map((v) => v.ratio)) : 1;
      const worstVisWho = visible.length
        ? visible.reduce((m, v) => (v.ratio < m.ratio ? v : m), visible[0]).label
        : '';
      return {
        n: boxes.length,
        worst: pairs.length ? pairs[0].ratio : 0,
        worstVis: +worstVis.toFixed(3),
        worstVisWho: worstVisWho,
        pairs: pairs.slice(0, 4),
      };
    })()`;
    out.overlap = [];
    /* 201 = 「世界」按钮那一屏（标注最少），900 = 省级粒度刚生效、
       长三角 + 台湾最挤的那一屏（实测就是它最危险），1172 = 「全国」按钮。 */
    for (const k of [201, 900, 1172, 1600, 2400, 4000]) {
      await viewAt(k, 104, 34);
      const m = await ev(MEASURE_OVERLAP);
      out.overlap.push({
        k: k,
        n: m.n,
        worst: m.worst,
        worstVis: m.worstVis,
        worstVisWho: m.worstVisWho,
        pairs: m.pairs.map((p) => p.a + ' x ' + p.b + ' = ' + (p.ratio * 100).toFixed(1) + '%'),
      });
    }
    /* 判据换语义（2026-09-13）：重叠已被用户裁决接受，锁的是
       「没有任何标注被完全盖死」。worstVis = 最差那个标注的可见采样点占比，
       4% ≈ 144 点里的 6 个 —— 正常部分重叠远高于它，完全重合才是 0。 */
    out.overlapWorst = out.overlap.reduce((m, o) => Math.max(m, o.worst), 0);
    out.worstVis = out.overlap.reduce((m, o) => Math.min(m, o.worstVis), 1);
    out.noBoxOverlap = out.worstVis >= 0.04;

    /* ============ 4.9 国家级粒度下不得出现省级裸名（合规） ============
       用户原话：「把中国和新疆并列的话，这个会不会有合规上的问题？……或者说，
       在这个视图下新疆就不显示了，等视图区域放大到一定大、比如说已经够显示出
       省份的视图大小时，就可以把新疆这部分给显示出来？」

       复核结论：世界视图（k≈201，t=0）里确实会看到「中国(55)」旁边单独浮着
       「新疆(3)」。成因**不是标签写错**，而是聚合被距离闸拆开了 ——
       `unitOf()` 已经把单位设成 'CN'（跨省可并），但合并还受第二道距离闸
       `CLUSTER_PX = 108` 约束，而 k=201 时中国横跨约 218px，新疆在国土最西端，
       离主簇太远并不过去，自成一簇；那个独立簇恰好只含一个省，
       标签分级第③级就给出了一个**裸省名**。

       那一刻填色把中国画成一整块单色、标注把中国报成一个国家，
       却有一个**省级行政区名**以同等视觉层级并列在旁。单看一个省名不违规
       （公开地图上到处都是），但在这个粒度上与国名并列，读起来像两个平级实体 ——
       这正是本项目一贯要避免的歧义（港澳台强制加「中国」前缀、台湾强制单列）。

       修法两层，缺一不可：
         ① **聚合**：t < 0.5 时中国整体收成一个簇。
            只压标签是不够的 —— 实测那样会让 k=560 出现**七个「中国」气泡**，
            比原来更费解（填色是一整块、标注七个同名，读者只会更困惑）。
         ② **标签**：t < 0.5 时第③级（报省名）不可达，回落国名。
            兜住退化情形：若某一省的照片是全部照片（例如只导入了新疆的），
            ①之后「一个簇就是一个省」，②才是真正拦住裸省名的那道闸。

       判据必须**双向**：只验「国家级不出现省名」的话，把标签一律压成国名
       也能全绿，那等于把省级视图一并废掉。 */
    out.granBand = [];
    for (const k of [160, 201, 260, 320, 420, 560]) {
      await viewAt(k, 104, 34);
      const gf = await ev('__tdt.fill()');
      const gcs = await ev('__tdt.clusters()');
      const gcn = gcs.filter((c) => c.region === 'CN');
      out.granBand.push({
        k: k,
        t: gf.chinaT,
        /* 中国境内、单省、且标签正好等于该省短名 → 就是「裸省名」 */
        bareProv: gcn
          .filter((c) => c.provs.filter(Boolean).length === 1 && c.label === c.provShort)
          .map((c) => c.label + '(' + c.n + ')'),
        /* 中国簇总数（**含台湾**）。国家级粒度下必须恰好 1 —— 一个国家一个簇，
           2026-09-13 起台湾也并入（用户裁决）：气泡只写「中国」，
           不许有第二个中国簇，更不许「中国台湾」与国名平级并列。 */
        cnAll: gcn.length,
        /* 国家级粒度下「台湾」字样不许出现在任何中国簇的标签上。
           只查 cnAll===1 不够 —— 万一标签写的是「中国台湾」，簇数照样是 1。 */
        twLabel: gcn
          .filter((c) => c.label.indexOf('台湾') >= 0)
          .map((c) => c.label + '(' + c.n + ')'),
        labels: gcn.map((c) => c.label + '(' + c.n + ')'),
      });
    }
    out.noBareProvAtCountry =
      out.granBand.length > 0 &&
      out.granBand.every((g) => g.t < 0.5 && g.bareProv.length === 0);
    /* 机制判据：中国**整体收成一个簇**（含台湾）。只看「没有裸省名」不够 ——
       把标签一律压成国名也能满足它，但那样一屏会出现好几个「中国」。 */
    out.cnOneAtCountry = out.granBand.length > 0 && out.granBand.every((g) => g.cnAll === 1);
    out.noTwLabelAtCountry = out.granBand.every((g) => g.twLabel.length === 0);

    /* 「照片没被藏起来」：世界视图整屏可见，93 张必须一张不少。
       这条专门防「为了消掉新疆那个气泡，干脆把那几张照片过滤掉」这种捷径修法 ——
       用户说的是「这个视图下新疆不显示」，指的是**名字**不出现，
       不是照片从图上消失。 */
    await viewAt(201, 104, 34);
    const allW = await ev('__tdt.clusters()');
    out.worldPhotoTotal = allW.reduce((a, c) => a + c.n, 0);

    /* 反向锁：省级粒度下**必须**能看到省名，否则等于把省级视图也废了 ——
       「一律压成国名」这条捷径必须被这条挡住。 */
    out.provBand = [];
    for (const k of [660, 1172, 1600]) {
      await viewAt(k, 104, 34);
      const pf = await ev('__tdt.fill()');
      const pcs = await ev('__tdt.clusters()');
      const pcn = pcs.filter((c) => c.region === 'CN');
      out.provBand.push({
        k: k,
        t: pf.chinaT,
        provLabels: pcn
          .filter((c) => c.provs.filter(Boolean).length === 1 && c.label === c.provShort)
          .map((c) => c.label),
      });
    }
    out.provLabelAtProvView =
      out.provBand.length > 0 &&
      out.provBand.every((g) => g.t >= 0.5 && g.provLabels.length > 0);
    /* 用户点名的那一个：省级视图下「新疆」必须真的出现 */
    out.xinjiangAtProvView = out.provBand.some((g) => g.provLabels.indexOf('新疆') >= 0);

    /* ================================== 4.10 聚合过渡动画（散开 / 收拢）

       用户的原话：照片缩放时会聚成一团、放大又散开，「能不能自然一点」。
       实现落在 tdt-map.js 的 5.5 节（对簇的**世界坐标**做指数趋近 + 稳定身份）。

       十条判据，两个方向都要占，缺一边就会留下一条恒真的缝：
         正向（动画真的在跑）——
           animActiveOnZoom  ：缓动缩放中必须读到「未就位」的簇；
           animSpawnNearPrev  ：新簇首帧必须贴着上一帧某个簇（散开的轨迹），
                                且它是淡入的（alpha < 1）。
           animBirthParentByMember   ：新簇的父簇必须**含着我这些照片**（成员归属），
                                       而不是「几何上离我最近的那个」；
           animBirthNeverCrossRegion ：出生的父簇不得跨区域 —— 喀什（CN）不许
                                       从迪拜（AE）里分裂出来；
           animBirthFromCnAggregate  ：世界 → 省级这一段里，「中国」那一个簇
                                       必须是那批省气泡的共同父簇（不许各认各的爹）；
           animMergeSameRegion ：收拢方向必须对称 —— 缩回去时每个淡出的簇
                                       滑向的也是同区域的簇（只堵散开等于没堵）。
         反向（动画不许漏进别的路径）——
           animSettledAtRest  ：静止后残差 0 / alpha 1 / dying 0；
           animSettledAfterZoom：缩放停下后同样收敛到 0 / 1 / 0；
           animQuietOnJump    ：setCamera 瞬时跳变后不留淡出中的簇
                                （探针自己全靠 setCamera 摆位，漏进来就会污染所有截图）；
           animQuietOnDrag    ：拖动全程不得有残余位移与淡入淡出
                                （标注必须与底图刚性同步，一滞后就是拖影）。
       只留正向 → 「动画被整个关掉」也全绿；只留反向 → 「动画根本没跑」也全绿。
       出生关系那三条还得靠 `?proxanim`（旧的「几何最近」规则）反向验证 ——
       在该规则下 crossRegion 实测 6、noShared 实测 20，判据精确变红。 */
    /* 「静止」读数必须等收敛之后再读。
       上一段以 setCamera 收尾，紧接着的一两帧里可能还有别的簇在淡入 ——
       判据要的是「静止后必须收敛」，不是「任何时刻都已经是静止的」。 */
    await sleep(700);
    out.anim = { rest: await ev('__tdt.anim()') };
    await viewAt(201, 106, 33);
    await sleep(500);
    const animAnchor = await ev(
      '(function(){var c=__tdt.clusters().filter(function(x){return x.label==="中国";})[0];return c?[c.sx,c.sy]:null;})()'
    );
    out.anim.anchor = animAnchor;

    /* 逐帧采样在**页面内**做：外部 100ms 轮询会跳过诞生帧，量不到首帧位置 */
    await ev(
      '(function(){window.__aseq=0;window.__af=[];window.__afOn=true;' +
        'var re=/translate3d\\(([-\\d.]+)px,\\s*([-\\d.]+)px/;' +
        '(function loop(){if(!window.__afOn)return;' +
        'var els=document.querySelectorAll("#overlay .mk");var arr=[];' +
        'for(var i=0;i<els.length;i++){var el=els[i];if(!el.__apid)el.__apid=++window.__aseq;' +
        'var m=re.exec(el.style.transform||"");' +
        'arr.push([el.__apid,m?+m[1]:-99999,m?+m[2]:-99999,+(el.style.opacity||1)]);}' +
        'var a=window.__tdt.anim();window.__af.push([a.minAlpha,a.dying,arr]);' +
        'requestAnimationFrame(loop);})();return 1;})()'
    );

    if (animAnchor) {
      /* 出生记录要单独统计这一段（日志自加载起累积） */
      await ev('__tdt.clearBirths()');
      await ev('__tdt.zoomAt(5.8,' + animAnchor[0] + ',' + animAnchor[1] + ')');
      /* 跨过 CH_LO_K=420 大约发生在缩放开始后 50ms（对数插值下 42% 进度），
         取 150ms 是为了让「已经跨过粒度、但淡入/飞行还没走完」那一小段落进画面。
         再晚就只剩稳定态，静图上与「无动画」没有区别。 */
      await sleep(150);
      fs.writeFileSync(SHOT_ANIM_MID, await s.screenshotPNG());
      await sleep(1600);
    }
    await ev('window.__afOn = false');
    const af = (await ev('window.__af')) || [];

    let sawUnsettled = 0;
    let spawn = null;
    for (let i = 1; i < af.length; i++) {
      if (af[i][0] < 0.99 || af[i][1] > 0) sawUnsettled += 1;
      const prev = af[i - 1][2].filter((r) => r[1] > -9000);
      const pm = new Map(prev.map((r) => [r[0], r]));
      const news = af[i][2].filter((r) => !pm.has(r[0]) && r[1] > -9000);
      if (news.length < 3) continue;
      let worst = 0;
      let maxAlpha = 0;
      for (const r of news) {
        let bd = Infinity;
        for (const p of prev) {
          const d = Math.hypot(p[1] - r[1], p[2] - r[2]);
          if (d < bd) bd = d;
        }
        if (bd > worst) worst = bd;
        if (r[3] > maxAlpha) maxAlpha = r[3];
      }
      spawn = { frame: i, n: news.length, worstD: +worst.toFixed(1), maxAlpha: +maxAlpha.toFixed(3) };
      break;
    }
    out.anim.frames = af.length;
    out.anim.sawUnsettled = sawUnsettled;
    out.anim.spawn = spawn;

    /* ---- 出生关系的判据（这一段锚定「世界视图 → 省级视图」，正是用户报的场景）----
       上面那套 DOM 采样只证明「新簇首帧贴着某个上一帧簇」；
       但**贴着谁**才是关键：旧版按几何最近选，于是新疆喀什（CN）认了
       迪拜（AE）当父簇 —— 放大展开时喀什从迪拜里分裂出来，跨国，逻辑不成立。
       正解是**成员归属**：父簇必须含着我这些照片。 */
    const births = (await ev('__tdt.anim().births')) || [];
    const withP = births.filter((b) => b.from);
    const cross = withP.filter((b) => b.fromRegion !== b.region);
    const noShare = withP.filter((b) => b.shared < 1);
    const inPlace = births.filter((b) => !b.from);
    const cnFromCn = withP.filter((b) => b.region === 'CN' && b.fromRegion === 'CN');
    out.anim.births = {
      n: births.length,
      withParent: withP.length,
      crossRegion: cross.length,
      crossSample: cross.slice(0, 4),
      noShared: noShare.length,
      inPlace: inPlace.length,
      cnFromCn: cnFromCn.length,
      pairs: withP.slice(0, 8).map((b) => b.key + '←' + b.from + '[' + b.region + '←' + b.fromRegion + ']'),
    };
    /* 非空守卫不能省：`?noanim` / `?proxanim` 下若一条记录都没有，
       every() 会在空集上恒真 —— 那正是「假通过」。 */
    out.animBirthParentByMember = withP.length >= 6 && noShare.length === 0 && inPlace.length <= 2;
    out.animBirthNeverCrossRegion = withP.length >= 6 && cross.length === 0;
    out.animBirthFromCnAggregate = cnFromCn.length >= 6;

    /* ---- 收拢方向必须对称：缩回去时，每个淡出的簇滑向的也是同区域的簇。
       只堵「散开不许跨国」不够 —— 「收拢滑进迪拜」是同一种错。
       日志已在上面被读走，这里重新清一次再缩回。 */
    await ev('__tdt.clearBirths()');
    await ev('__tdt.zoomAt(1 / 5.8,' + (animAnchor ? animAnchor[0] : 700) + ',' + (animAnchor ? animAnchor[1] : 430) + ')');
    await sleep(1800);
    const merges = (await ev('__tdt.anim().merges')) || [];
    const mCross = merges.filter((m) => m.toRegion && m.region && m.toRegion !== m.region);
    out.anim.merges = {
      n: merges.length,
      crossRegion: mCross.length,
      crossSample: mCross.slice(0, 4),
      pairs: merges.slice(0, 8).map((m) => m.key + '→' + m.to + '[' + m.region + '→' + m.toRegion + ']'),
    };
    out.animMergeSameRegion = merges.length >= 6 && mCross.length === 0;
    await sleep(250);
    out.anim.afterZoom = await ev('__tdt.anim()');
    out.animActiveOnZoom = sawUnsettled >= 2;
    out.animSpawnNearPrev = !!(spawn && spawn.n >= 3 && spawn.worstD <= 260 && spawn.maxAlpha < 0.99);
    out.animSettledAfterZoom =
      out.anim.afterZoom.maxResidualPx === 0 &&
      out.anim.afterZoom.minAlpha === 1 &&
      out.anim.afterZoom.dying === 0;

    /* 瞬时跳变：不留淡出中的簇（否则跳变后半秒的截图不可复现） */
    await ev('__tdt.setCamera(116.4,39.9,3000)');
    await sleep(150);
    out.anim.afterJump = await ev('__tdt.anim()');
    out.animQuietOnJump =
      out.anim.afterJump.dying === 0 &&
      out.anim.afterJump.maxResidualPx === 0 &&
      out.anim.afterJump.minAlpha === 1;

    /* 拖动：标注与底图必须刚性同步 —— 一旦对屏幕坐标做插值，这里立刻会红 */
    await viewAt(1172, 104, 34);
    const dragStates = [];
    await mouse({ type: 'mousePressed', x: 720, y: 470, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 16; i++) {
      await mouse({ type: 'mouseMoved', x: 720 + i * 8, y: 470, button: 'left', buttons: 1 });
      if (i % 3 === 0) dragStates.push(await ev('__tdt.anim()'));
    }
    await mouse({ type: 'mouseReleased', x: 848, y: 470, button: 'left', buttons: 0, clickCount: 1 });
    out.anim.drag = dragStates;
    out.animQuietOnDrag =
      dragStates.length > 0 &&
      dragStates.every((d) => d.maxResidualPx === 0 && d.minAlpha === 1 && d.dying === 0);
    await sleep(700);
    out.anim.final = await ev('__tdt.anim()');
    out.animSettledAtRest =
      out.anim.final.maxResidualPx === 0 && out.anim.final.minAlpha === 1 && out.anim.final.dying === 0;

    /* 复位相机与鼠标，别把状态留给后面的用例 */
    await viewAt(1172, 111, 27);
    await mouse({ type: 'mouseMoved', x: 6, y: 6 });
    await sleep(260);

    /* ============================ 4.11 地点位置：同名照片不许跨距离平均

       用户报的原话：「我在哈尔滨拍的被识别到了山东，在广州拍的全在山东省」。
       查下来根因既不在 EXIF 解析、也不在投影（两条都单独验过），而在**分组**：
       place 来自文件夹名，`D:/icloud/2018/xxx.jpg` 的 place 是「2018」—— 一个
       年份，不含任何地理信息。旧代码只按名字分组、再对坐标求算术平均，于是
       黑龙江 92 张 + 广东 53 张被平均到 (37.5, 121.8) —— **黄海海面上**，
       判给最近的省就是山东，图上成了「山东省 × 145 张」。位置全错，而画面
       看起来完全正常。这比「不合并」更糟：它像一个真实地点，却无照片出自那里。

       五条判据，两个方向都要占：
         placeSpreadBounded      ：**每个**地点的 spread（堆内最深的一张离堆心
                                   多远）都必须在闸内 —— 这条直接排除「幽灵点」，
                                   是核心；
         placeSplitAcrossDistance：同名但跨 2800km，必须拆成 ≥ 2 个地点；
         placeFarInRightProvince ：拆出来的两个点必须落在**黑龙江**与**广东**，
                                   且坐标对得上 —— 光验「拆开了」不够，
                                   拆到两个错的地方也是拆；
         placeSplitLabelsDistinct：拆开后两个点不许重名，否则用户分不清谁是谁；
         nearPhotosStayOnePlace  ：同名且挨着的照片必须仍是 1 个地点 ——
                                   反向锁，防「一律拆开」这种矫枉过正。
         placeRebuildKeepsRegion ：**异步重建之后，归属必须还在**。这一条守的不是
                                   「拆得对不对」，而是另一条时间线：市界是异步到货的，
                                   到货后 `ensureCity` 会整批重建地点对象，而
                                   `regionKey` / `provName` / `solo` / `mst` 只有
                                   `computeFill()` 会写。漏跑它这批字段全空 ——
                                   `clusterize` 的「同区才合并」闸退化成空操作、
                                   中国台湾的 solo 合规红线一并失效，而且
                                   **只在用户放大到触发市界加载之后**才发生。
                                   ⚠️ 这条漏了整整一轮：`assignLog` 不清空，
                                   「归属对不对」那组判据读的是上一次的旧记录，
                                   一直绿的。暴露它的是本判据读的
                                   `places()[].provName` —— 那个读的是重建后的新对象。

       三个测试缝把这几条全部打红，没有一条是恒真的：
         node tdt-demo/probe-fill.js … "&placesplit=999"   关掉空间闸
           → 精确红 4 条：placeSplitAcrossDistance / placeSpreadBounded /
              placeFarInRightProvince / placeSplitLabelsDistinct
              （此时「2018」故态复萌：n=145、spread=15.86°、判给山东省）
         node tdt-demo/probe-fill.js … "&placesplit=0"     一律拆开
           → 精确红 2 条：placeFarInRightProvince / nearPhotosStayOnePlace
              （6 张上海照片被拆成 6 个点）
         node tdt-demo/probe-fill.js … "&noreassign"       重建后不重跑归属
           → 精确红 2 条：placeFarInRightProvince / placeRebuildKeepsRegion
              （三个地点的 region 与 provName 同时变空串）
       三条缝的并集正好覆盖这六条，且每次都是**精确**命中、没有连带。
       下面的 out.placeDemo（演示相册自查）**只作档案读数、不进判据** ——
       演示数据的 place 本来就是真地名，placesplit 两条缝都不影响它，写成判据
       就是一条恒真的线，只会给人「这里有人在守」的错觉。 */
    const PLACE_GATE = 0.3; // 与 tdt-map.js 的 PLACE_SPLIT_DEG 同值
    const DOT = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';

    /* 先看当前相册（演示数据）自身有没有幽灵点 */
    const demoPlaces = await ev('__tdt.places()');
    out.placeDemo = demoPlaces;
    out.placeDemoNoGhost =
      demoPlaces.length > 0 && demoPlaces.every((p) => p.spread <= PLACE_GATE * 1.34);

    const placeAlbum = { photos: [] };
    for (let i = 0; i < 92; i++) {
      placeAlbum.photos.push({
        id: 'h' + i,
        place: '2018',
        wgs: [126.63 + (i % 7) * 0.008, 45.78 + (i % 5) * 0.006],
        src: DOT,
        date: '2018-01-05',
      });
    }
    for (let i = 0; i < 53; i++) {
      placeAlbum.photos.push({
        id: 'g' + i,
        place: '2018',
        wgs: [113.37 + (i % 7) * 0.008, 23.13 + (i % 5) * 0.006],
        src: DOT,
        date: '2018-06-05',
      });
    }
    /* 对照组：同名且彼此挨着的 6 张，必须仍然并成 1 个点 */
    for (let i = 0; i < 6; i++) {
      placeAlbum.photos.push({
        id: 'n' + i,
        place: '近邻测试',
        wgs: [121.47 + i * 0.001, 31.23 + i * 0.001],
        src: DOT,
        date: '2019-03-03',
      });
    }
    await ev('__tdt.setAlbum(' + JSON.stringify(placeAlbum) + ', "地点分组测试")');
    await sleep(500);
    const placeList = await ev('__tdt.places()');
    out.placeAlbum = { n: placeAlbum.photos.length, assign: await ev('__tdt.assign()'), places: placeList };
    const far = placeList.filter((p) => p.splitFrom === '2018');
    const near = placeList.filter((p) => p.name === '近邻测试');
    out.placeSplitAcrossDistance = far.length >= 2;
    out.placeSpreadBounded = placeList.length > 0 && placeList.every((p) => p.spread <= PLACE_GATE * 1.34);
    out.placeSplitLabelsDistinct = far.length >= 2 && new Set(far.map((p) => p.name)).size === far.length;
    out.nearPhotosStayOnePlace = near.length === 1 && near[0].n === 6;
    out.placeFarInRightProvince =
      far.length === 2 &&
      far.some((p) => p.provName === '黑龙江省' && Math.abs(p.lat - 45.79) < 0.2) &&
      far.some((p) => p.provName === '广东省' && Math.abs(p.lat - 23.14) < 0.2);

    /* 异步重建之后归属必须还在（机制见本段段头）。
       这个测试相册全在中国，所以口径可以收紧到「region 非空且 provName 非空」——
       境外的 provName 本来允许为空，但这里没有境外成员，用不着为它放宽。
       反向缝：`&noreassign` → 三个地点的两个字段同时变空串。 */
    out.placeRebuildKeepsRegion =
      placeList.length > 0 &&
      placeList.every((p) => p.region !== '' && p.provName !== '');

    /* 恢复演示相册，别把状态留给后面的用例 */
    await ev('__tdt.setAlbum(window.PHOTO_ALBUM, "天地图底图")');
    await sleep(400);

    /* ============ 4.12 池元素不许被两个活簇共用（「中国的图片都不见了」）

       用户报的原话：「最小视图下有一概率会导致中国的图片都不见了」。
       根因不在填色、不在聚合，而在**元素池的分配**：
       `animFree()` 只避让「本帧已占用」（animUsed）与「正在淡出」（animDyingRecs）。
       而活簇是**边遍历边登记**的 —— 排在 list 后面、还没轮到的那一簇，
       已经握着自己上一帧的 rec，但那个元素此刻既不在 animUsed 也不是淡出元素，
       于是被当成空闲发了出去。**两个活簇共用一个 DOM 节点，后写的赢。**
       list 按张数降序排 → 张数最多的簇最先被覆盖 → 用户看到的正是「中国气泡消失，
       但碰撞盒还在 boxes 里，邻座被挤开、还拉出一条指向空处的牵引线」。

       它是**概率性**的：共不共用取决于池的分配历史与当帧排序。实测反复点
       「世界 / 全国」往返，8 轮里 6 轮出现；静止态反而不一定出现 ——
       所以它躲过了此前所有「静下来再截图」的检查。复现办法就是反复切视野。

       三条判据里删掉了一条「DOM 不许出现两个一模一样的标签」，理由记在这里 ——
       它量的是**停用元素上的残留文字**，与画面无关：停用的池元素只是被挪到视口外
       （px = −9999），`rec.lab` 清了、`.pin__name` 的 textContent **不清**。
       于是 DOM 上带字的 .pin = 活簇 + 曾经用过该节点的簇。实测 nPool=36、live=14，
       DOM 上有 21 个带字的 .pin —— 差的那 7 个全是视口外的残留，一个都看不见。
       留下的两条都是**状态判据**，读的是 `__tdt.pins()` 的状态字段，不是 DOM 文本：
         poolOnePinPerCluster ：活簇数 == 占着元素的簇数。共用一个元素时它必然掉，
                                这是**机制**判据，无法蒙混；
         poolEveryClusterShown：簇表里每个标签，池里都得有一个元素在展示它。
                                这是**表现**判据，正是用户看到的那一幕（气泡没了）。
       反向缝 `&nopoolfix` 撤掉预占、退回旧的分配行为 → 两条精确变红（实测 8/8 轮）。

       ⚠️ 另一条不能写的判据：`__tdt.pins()` 遍历的是 pool，pool 里每个 rec 只出现
       一次，所以「pins 里有没有重复 id」**恒真**。踩过（见 README「被删的恒真判据」）。 */
    const DUP_CHECK = `(function(){
      const cl = __tdt.clusters();
      const pins = __tdt.pins();
      const live = pins.filter(function(p){ return p.state === 'live'; });
      const labs = live.map(function(p){ return p.label; });
      const liveLabels = cl.map(function(c){ return c.label; });
      const ov = document.getElementById('overlay');
      const dom = [];
      if (ov) {
        const els = ov.querySelectorAll('.pin');
        for (let i = 0; i < els.length; i++) {
          const nm = els[i].querySelector('.pin__name');
          const t = nm ? nm.textContent : '';
          if (t) dom.push(t);
        }
      }
      return {
        k: +__tdt.t2.k.toFixed(1),
        nClusters: cl.length, nLive: live.length, nPool: pins.length,
        missing: liveLabels.filter(function(t){ return labs.indexOf(t) < 0; }),
        dupDom: dom.filter(function(v,i){ return dom.indexOf(v) !== i; }),
        cn: cl.filter(function(c){ return c.region === 'CN'; })
              .map(function(c){ return c.label + '/' + c.n; }),
      };
    })()`;
    out.pool = { rounds: [] };
    for (let r = 0; r < 8; r++) {
      await ev('document.getElementById("btnWorld").click()');
      await sleep(1350);
      const w = await ev(DUP_CHECK);
      await ev('document.getElementById("btnHome").click()');
      await sleep(1350);
      const h = await ev(DUP_CHECK);
      out.pool.rounds.push({ r: r, world: w, home: h });
    }
    const poolRows = [];
    out.pool.rounds.forEach((p) => {
      poolRows.push(p.world, p.home);
    });
    out.poolOnePinPerCluster = poolRows.length === 16 && poolRows.every((x) => x.nLive === x.nClusters);
    out.poolEveryClusterShown = poolRows.every((x) => x.missing.length === 0);
    /* dupDom 只作**档案读数**：它是动画相位，不进判据（理由见上面的段落头） */
    out.poolDupDomArchive = poolRows.map((x) => x.dupDom).filter((d) => d.length);

    /* ============ 4.13 国家级「国家中心」锚点（「照片的指向了两地中间」）

       用户报的原话：「照片的指向了两地中间，会有歧义，从国家维度的视图，
       我建议这个点直接定位到一个国家的中心」。规则据此定为**位置跟标签走**：
       气泡上写「中国」就按中国的中心摆；写「巴黎·卢浮宫」仍按照片质心摆
       （那个位置本身就是信息）；写「中国香港 / 中国澳门」的不动（合规要求）。
       实现见 tdt-map.js 的 regionAnchor（面积质心 + 落域外逐环吸附）。

       六条判据，机制 / 位置 / 具体数 / 复现用户场景 / 反向锁 / 全量审计各一条：
         countryAnchorApplied  ：标签 == 国名的簇，锚点必须真的生效（机制）；
         countryAnchorInside   ：这些簇的落点必须在该国**境内**（位置）；
         cnAnchorInHeartland   ：中国锚点必须落在 95~112°E / 28~45°N
                                 （甘肃—宁夏—陕北一带）—— 这是具体的数，
                                 「在境内」太宽：落在喀什也在境内，但不像中国中心；
         spreadAlbumAnchored   ：4.11 那批跨 2800km 的合成照片，世界视图下
                                 「中国」簇必须仍在境内 —— 直接复现用户那张图；
         localLabelNotAnchored ：反向锁：省级视图下**所有**簇都不许被锚点搬走，
                                 防「一律摆到国家中心」这种矫枉过正；
         anchorAuditClean      ：全量审计 239 个区域（中国 + 238 国）的锚点零出界。

       反向缝 `&noanchor` 撤掉锚点 → 前四条精确变红（实测：冰岛的加权质心
       落在岛南侧海面、中国那批 145 张落回黄海），第五条第六条保持绿 ——
       前者是「应用层」的事，后者是算法自身的性质，两者本就该分开。 */
    await viewAt(201, 104, 30); // 世界视图（t=0，国家级粒度）
    await sleep(260);
    const namedRow = `(function(){
      const cl = __tdt.clusters();
      return cl.filter(function(c){
        return c.region && c.regionName && c.label === c.regionName;
      }).map(function(c){
        const g = __tdt.unproject(c.sx, c.sy);
        return { region: c.region, label: c.label, n: c.n, anchored: !!c.anchored,
          lng: +g.lng.toFixed(4), lat: +g.lat.toFixed(4),
          inside: __tdt.contains(c.region, g.lng, g.lat) };
      });
    })()`;
    const named = await ev(namedRow);
    out.anchorDemo = { named: named, audit: await ev('__tdt.anchorAudit()') };
    const cnRow = named.filter((c) => c.region === 'CN')[0] || null;
    out.countryAnchorApplied = named.length > 0 && named.every((c) => c.anchored === true);
    out.countryAnchorInside = named.length > 0 && named.every((c) => c.inside === true);
    out.cnAnchorInHeartland =
      !!cnRow && cnRow.anchored === true && cnRow.lng > 95 && cnRow.lng < 112 && cnRow.lat > 28 && cnRow.lat < 45;
    out.anchorAuditClean =
      !!out.anchorDemo.audit && out.anchorDemo.audit.ok === out.anchorDemo.audit.total && out.anchorDemo.audit.bad.length === 0;

    /* 复现用户那一批：黑龙江 92 + 广东 53 + 上海 6，世界视图下合成一个「中国」簇 */
    await ev('__tdt.setAlbum(' + JSON.stringify(placeAlbum) + ', "锚点复现")');
    await sleep(520);
    await viewAt(201, 104, 30);
    await sleep(260);
    const spreadNamed = await ev(namedRow);
    const spreadCn = spreadNamed.filter((c) => c.region === 'CN')[0] || null;
    out.anchorSpread = { named: spreadNamed, cn: spreadCn };
    out.spreadAlbumAnchored =
      !!spreadCn && spreadCn.label === '中国' && spreadCn.anchored === true && spreadCn.inside === true;

    /* 反向锁：省级视图（t≥0.5）下标签都是城市 / 省名，一个都不许被锚点搬走。
       注意不变量要写准 —— **不是**「这一屏里一个锚点都不许有」：
       境外没有 admin-1 数据，一簇跨国城市也会退化成国名（实测「日本」10 张
       在世界与全国两个视图下标签都是「日本」），此时按规则**就应当**锚定。
       真正的不变量是「锚定 ⇔ 标签就是国名」。另外要求屏上至少出现 3 个
       非国名标签，否则这条锁是空的。 */
    await ev('__tdt.setAlbum(window.PHOTO_ALBUM, "天地图底图")');
    await sleep(520);
    await viewAt(1172, 111, 27);
    await sleep(260);
    const provAnchored = await ev(`(function(){
      return __tdt.clusters().map(function(c){
        return { label: c.label, regionName: c.regionName, anchored: !!c.anchored };
      });
    })()`);
    out.anchorProvView = provAnchored;
    const localCount = provAnchored.filter((c) => c.label && c.label !== c.regionName).length;
    out.localLabelNotAnchored =
      provAnchored.length >= 8 &&
      localCount >= 3 &&
      provAnchored.every((c) => c.anchored !== true || c.label === c.regionName);

    /* 恢复演示相册，别把状态留给后面的用例 */
    await ev('__tdt.setAlbum(window.PHOTO_ALBUM, "天地图底图")');
    await sleep(420);

    /* ============ 4.14 配额闸门：动画期间只按**终点层级**请求瓦片

       天地图个人配额 10000 次/日。旧写法是「每帧按当前层级请求整屏覆盖」，
       而 `fitBox(WORLD, 520)` 把 k 从 1500 连续插到 103，z 依次经过 5→4→3→2→1，
       于是**每一级各请求一屏**。实测一次「切世界视图」发出 95~104 张，
       其中 z=2/3/4/5 那 90 张只在动画的几帧里露过面、此后再不复用 —— 纯浪费。
       真正的终点层 z=1 只要 **4 张**（整张世界地图在 z=1 就是 2×2 张）。

       闸门把请求改成「终点层级 + 终点视野」（终点视野在整段动画里固定，
       所以每帧算出同一批瓦片，只有第一帧真的发出请求）。实测 **95 → 4**。

       省下的钱要付一个代价：动画中当前层缺的瓦片改用**祖先层拉大**顶住
       （见 tdt-map.js 的 peekAncestor）。所以三条判据各守一面：
         quotaGateHeld    动画中点确实拦下了请求 —— 这是**机制**判据，
                          `?noquotagate` 撤掉闸门后它精确变红；
         quotaNoHole      动画中与静止后 `miss` 都是 0。这是**安全**判据 ——
                          屏幕上有几个格子既没有本层也没有祖先可画时会漏底，
                          那种帧一眼可见。它在任何缝下都必须是绿的；
         quotaSettleClean 静止后绘制层 == 请求层（闸门已放行，回到常规路径）。

       ⚠️ 终点**画面**的一致性不在这里判，而在 `tools/verify-quota-shots.js`：
       它把闸门开/关的两张终点截图逐像素比对（实测三轮全 0，含噪声底）。
       这里量的是「机制有没有生效」与「有没有留下空洞」，两者互不替代。 */
    await viewAt(1500, 104, 30);
    await sleep(320);
    const qGate0 = await ev('JSON.parse(JSON.stringify(__tdt.quota()))');
    await ev('document.getElementById("btnWorld").click()');
    await sleep(260); // 动画进行中（全程 520ms）
    const qGateMid = await ev('JSON.parse(JSON.stringify(__tdt.quota()))');
    await sleep(1900); // 动画结束 + 终点层补齐
    const qGateEnd = await ev('JSON.parse(JSON.stringify(__tdt.quota()))');
    out.quotaGate = { start: qGate0, mid: qGateMid, end: qGateEnd };

    out.quotaGateHeld = qGateMid.held > qGate0.held;
    out.quotaNoHole = qGateMid.miss === 0 && qGateEnd.miss === 0;
    out.quotaSettleClean = qGateEnd.z === qGateEnd.zWant && qGateEnd.miss === 0;

    /* 把视野交还给后面的用例 */
    await viewAt(1172, 111, 27);

    /* ------------------------------------------------ 5. EXIF：单元级 */
    await ev(FABRICATOR);
    out.exif = {};
    out.exif.unit = await ev(`(async () => {
      const f = await window.__mkJpeg({ gps: true, lat: 30.2489, lng: 120.142, date: '2024-05-06 08:30:00', name: 'unit.jpg' });
      const got = window.PhotoImport.readExif(await f.arrayBuffer());
      return { fileSize: f.size, got: got };
    })()`);
    out.exif.unitOk =
      !!out.exif.unit.got &&
      Math.abs(out.exif.unit.got.lng - 120.142) < 1e-4 &&
      Math.abs(out.exif.unit.got.lat - 30.2489) < 1e-4 &&
      out.exif.unit.got.date === '2024-05-06';

    out.exif.noGps = await ev(`(async () => {
      const f = await window.__mkJpeg({ gps: false, name: 'nogps.jpg' });
      return window.PhotoImport.readExif(await f.arrayBuffer());
    })()`);
    out.exif.noGpsOk = out.exif.noGps === null;

    /* EXIF 的出口分类：三种成因必须分开，不能都塌成 null。
       「1000 张里只有 20 张有坐标」被误读成「读码坏了」，根源就是它们
       当年共用一个返回值：不是 JPEG 与照片没记位置，用户分不出来。 */
    out.exif.why = await ev(`(async () => {
      const withGps = window.PhotoImport.probeExif(await (await window.__mkJpeg({ gps: true, lat: 30.2, lng: 120.1, date: '2024-05-06 08:30:00', name: 'w.jpg' })).arrayBuffer());
      const noGps = window.PhotoImport.probeExif(await (await window.__mkJpeg({ exifNoGps: true, date: '2024-05-06 08:30:00', name: 'n.jpg' })).arrayBuffer());
      const noExif = window.PhotoImport.probeExif(await (await window.__mkJpeg({ name: 'raw.jpg' })).arrayBuffer());
      const cv = document.createElement('canvas'); cv.width = 8; cv.height = 8;
      const pb = await new Promise(r => cv.toBlob(r, 'image/png'));
      const pngF = new File([pb], 'shot.png', { type: 'image/png' });
      const png = window.PhotoImport.probeExif(await pngF.arrayBuffer());
      return { withGps: withGps.why, noGps: noGps.why, noExif: noExif.why, png: png.why, pngKind: png.kind, pngSize: pngF.size };
    })()`);
    /* 四条出口逐一验，缺一条就有一条分支永远不被测到 */
    out.exif.whyOk =
      out.exif.why.withGps === 'ok' &&
      out.exif.why.noGps === 'noGps' &&
      out.exif.why.noExif === 'noExif' &&
      out.exif.why.png === 'notJpeg' &&
      out.exif.why.pngKind === 'png';

    /* ------------------------------------------------ 6. 导入管线（不经选择器） */
    out.pipeline = await ev(`(async () => {
      const a = await window.__mkJpeg({ gps: true, lat: 31.2304, lng: 121.4737, date: '2023-11-02 17:05:00', name: 'shanghai.jpg' });
      const b = await window.__mkJpeg({ gps: true, lat: 30.2489, lng: 120.142, date: '2023-11-05 09:10:00', name: 'hangzhou.jpg' });
      const c = await window.__mkJpeg({ exifNoGps: true, date: '2023-11-01 08:00:00', name: 'plain.jpg' });
      const res = await window.PhotoImport.buildAlbum([a, b, c], { byFolder: false });
      return {
        placed: res.placed, skipped: res.skipped, failed: res.failed,
        why: res.why, kinds: res.kinds,
        urls: res.urls.length,
        photos: res.photos.map(p => ({ place: p.place, date: p.date, exif: p.dateFromExif, wgs: p.wgs, src: String(p.src).slice(0, 5), prev: String(p.preview).slice(0, 5) })),
      };
    })()`);
    out.pipelineOk =
      out.pipeline.placed === 2 &&
      out.pipeline.skipped === 1 &&
      out.pipeline.failed === 0 &&
      out.pipeline.urls === 4 &&
      out.pipeline.photos.every((p) => p.src === 'blob:' && p.prev === 'blob:' && p.exif === true);
    /* 分类不许退化回一个数字：那张无 GPS 的必须记在 noGps 名下，
       而不是笼统地算进「跳过 N 张」。 */
    out.skipWhyOk = !!out.pipeline.why && out.pipeline.why.noGps === 1;

    /* ------------------------------------------------ 7. 真实用户路径：文件选择器 */
    const b64 = await ev(`(async () => {
      const f = await window.__mkJpeg({ gps: true, lat: 39.9042, lng: 116.4074, date: '2022-07-18 10:00:00', name: 'beijing.jpg' });
      return { b64: await window.__b64(f), name: f.name, size: f.size };
    })()`);
    fs.writeFileSync(TMP_JPEG, Buffer.from(b64.b64, 'base64'));
    out.tmpJpeg = { path: TMP_JPEG, size: b64.size, diskSize: fs.statSync(TMP_JPEG).size };

    const nodeRef = await s.send('Runtime.evaluate', {
      expression: 'document.getElementById("filePhotos")',
      returnByValue: false,
    });
    await s.send('DOM.setFileInputFiles', { files: [TMP_JPEG], objectId: nodeRef.result.objectId });
    await sleep(1200);
    /* 有的 Chromium 版本在这一步不会自动派发 change，补一次也不会有副作用
       （input.value 已被读取，重复 change 只会再解一遍同一张） */
    let after = await ev('__tdt.state()');
    if (after.album !== 1) {
      await ev('document.getElementById("filePhotos").dispatchEvent(new Event("change"))');
      await sleep(1500);
      after = await ev('__tdt.state()');
    }
    /* 判据要能证伪「计数对了但屏幕上看不见」这一种失败：
       只导一两张时，装框会把 k 推到 3 万量级，而密度填色在 FILL_ZERO_K
       以上 alpha 归零 —— 于是 filled === 1 却什么也不显示。
       所以除了计数，还必须**直接采填色层的像素**，并记下当时的 k。 */
    out.fileInput = {
      albumAfter: after.album,
      placesAfter: after.places,
      k: +after.k.toFixed(1),
      label: await ev('document.getElementById("brandMeta").textContent'),
      hint: await ev('document.getElementById("impHint").textContent'),
      camLngLat: [+after.lng.toFixed(3), +after.lat.toFixed(3)],
      fill: await ev('__tdt.fill()').then((f) => ({ filled: f.filled, provinces: f.provinces.map((p) => p.name + ':' + p.count) })),
      /* 1 张 → floor(log2(1)×1.6) = 0 → idx0 → #24476d，alpha 应 ≈ 0.55×255 ≈ 140 */
      pxAtPhoto: await ev('__tdt.sampleFill(116.4074, 39.9042)'),
    };
    /* 装框：单点会撑到很小的范围，相机必然靠近北京 */
    out.fileInputOk =
      after.album === 1 &&
      Math.abs(after.lng - 116.4074) < 0.6 &&
      Math.abs(after.lat - 39.9042) < 0.6 &&
      out.fileInput.fill.filled === 1;
    /* 更硬的一条：填色必须真的落在屏幕上 —— k 不超满强度阈值，
       且照片所在处的填色 alpha 接近 FILL_ALPHA（140）。 */
    out.importFillVisible =
      out.fileInput.k <= 9000 &&
      !!out.fileInput.pxAtPhoto &&
      out.fileInput.pxAtPhoto[3] >= 120;

    /* 缩略图**真的解出像素了吗**。
       这条抓的是 src 被拼坏 —— 本地照片的 src 是 blob URL，而 buildPhotos 里的
       assetUrl() 会给「不像绝对地址」的串补 '../'。原来它的白名单是
       `^(https?:|data:|/)`，漏了 blob:，于是 src 变成 `../blob:http://…`，
       气泡里全是破图（张数角标却正常）。
       只读 naturalWidth，**不能读前缀**：`../blob:…` 依然以 "blob:" 开头。
       取样只取屏幕内的 —— 池元素停用后不清理 src，算进来这条就永远红。 */
    for (let i = 0; i < 10; i++) {
      out.importThumb = await ev(`(function(){
        var els = document.querySelectorAll('.pin__thumb img');
        var arr = [];
        for (var i = 0; i < els.length; i++) {
          var im = els[i];
          var r = im.getBoundingClientRect();
          if (!(r.left > -60 && r.left < innerWidth && r.top > -60 && r.top < innerHeight)) continue;
          arr.push({ attr: String(im.getAttribute('src') || '').slice(0, 5), nw: im.naturalWidth });
        }
        return arr;
      })()`);
      if (out.importThumb.length && out.importThumb.every((t) => t.nw > 0)) break;
      await sleep(300);
    }
    fs.writeFileSync(SHOT_LOCAL, await s.screenshotPNG());

    /* ------------------------------------------------ 8. 回到演示数据 */
    await ev('document.getElementById("impReset").click()');
    await sleep(1400);
    out.reset = await ev('__tdt.state()');
    out.resetFill = await ev('__tdt.fill()').then((f) => ({ filled: f.filled, drawn: f.drawn }));
    out.resetOk = out.reset.album === 93 && out.resetFill.filled === 20;

    /* ------------------------------------------------ 9. 五档色阶各就各位
       注入 1/2/3/4/12 张的合成相册：idx = floor(log2(n)*1.6) = 0/1/2/3/4，正好五档。 */
    await ev(`__tdt.setAlbum({ photos: [
      { id: 's1', place: '一档', wgs: [116.40, 39.90], src: '' },
      { id: 's2a', place: '二档', wgs: [121.47, 31.23], src: '' },
      { id: 's2b', place: '二档', wgs: [121.48, 31.24], src: '' },
      { id: 's3a', place: '三档', wgs: [120.14, 30.25], src: '' },
      { id: 's3b', place: '三档', wgs: [120.15, 30.26], src: '' },
      { id: 's3c', place: '三档', wgs: [120.16, 30.27], src: '' },
      { id: 's4a', place: '四档', wgs: [104.05, 30.67], src: '' },
      { id: 's4b', place: '四档', wgs: [104.06, 30.68], src: '' },
      { id: 's4c', place: '四档', wgs: [104.07, 30.69], src: '' },
      { id: 's4d', place: '四档', wgs: [104.08, 30.70], src: '' },
      { id: 's5a', place: '五档', wgs: [100.23, 26.87], src: '' },
      { id: 's5b', place: '五档', wgs: [100.24, 26.88], src: '' },
      { id: 's5c', place: '五档', wgs: [100.25, 26.89], src: '' },
      { id: 's5d', place: '五档', wgs: [100.26, 26.90], src: '' },
      { id: 's5e', place: '五档', wgs: [100.27, 26.91], src: '' },
      { id: 's5f', place: '五档', wgs: [100.28, 26.92], src: '' },
      { id: 's5g', place: '五档', wgs: [100.29, 26.93], src: '' },
      { id: 's5h', place: '五档', wgs: [100.30, 26.94], src: '' },
      { id: 's5i', place: '五档', wgs: [100.31, 26.95], src: '' },
      { id: 's5j', place: '五档', wgs: [100.32, 26.96], src: '' },
      { id: 's5k', place: '五档', wgs: [100.33, 26.97], src: '' },
      { id: 's5l', place: '五档', wgs: [100.34, 26.98], src: '' }
    ] }, '分档测试')`);
    await sleep(1500);
    const lv = await ev('__tdt.fill()');
    out.levels = {
      provinces: lv.provinces.map((p) => ({ name: p.name, count: p.count, idx: p.idx, fill: p.fill })),
      alpha: +lv.alpha.toFixed(3),
    };
    out.levels.px = {};
    for (const [tag, lng, lat] of [['一档', 116.2, 40.2], ['二档', 121.4, 31.2], ['三档', 120.0, 29.2], ['四档', 103.9, 30.8], ['五档', 100.2, 26.9]]) {
      out.levels.px[tag] = await ev('__tdt.sampleFill(' + lng + ',' + lat + ')');
    }
    out.levels.distinct = new Set(
      Object.values(out.levels.px)
        .filter(Boolean)
        .map((p) => p.slice(0, 3).map((v) => Math.round(v / 8)).join(','))
    ).size;
    fs.writeFileSync(SHOT_LEVELS, await s.screenshotPNG());

    out.ok = out.errors.length === 0;
  } catch (e) {
    out.error = String((e && e.stack) || e);
    /* 出错也要落盘。否则异常被 finally 吞掉，控制台只剩 exit=1，
       中文报错还会被代码页按 GBK 解成乱码 —— 什么都看不到。
       踩过：一次 out.exif 未定义，就是因为异常吞在这里、判据段又二次崩溃。 */
    try { fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8'); } catch (_) {}
  } finally {
    try {
      if (s) s.close();
    } catch (_) {}
    try {
      if (chrome) await chrome.dispose();
    } catch (_) {}
  }

  /* ------------------------------------------------------------------ 判据
     每条都要能证伪。读不到的那条宁可报 false，不要写成恒真。

     ⚠️ 已删除 `seaEnvelopeDropped`。它原本要求 (124.5, 25.9) 的 alpha=0，
     而那是**赤尾屿**（中国领土），等于在要求「中国领土必须不被填色」。
     它当年能通过，是因为当时有环过滤把那个离岛环筛掉了 —— 那是缺陷不是特性。
     现在换成 4.1 里的 `islandsFilled` 正向判据。 */
  const px = out.pixels || [];
  const verdict = {
    noException: (out.errors || []).length === 0,
    geoLoaded: !!(out.geo && out.geo.features >= 30 && out.geo.verts > 5000),
    countsMatch: out.countCheckFailed === 0 && !!out.countCheck && out.countCheck.length === 20,
    onlyPhotoProvincesFilled: !!out.geo && out.geo.filled === 20,
    /* ---- 国别这一级（本轮新增）----
       countries ≈ 238（NE 50m 去掉中国及港澳台）；
       ctryFilled = 11 个有照片的境外国家；
       ctrySkippedWide = 1（南极洲跨 ±180°，环本身不是合法多边形，必须跳过）；
       ctryUnassigned = 0（境外 30 张全都落到某个国家，不许落进公海）。 */
    countryLevelOk:
      !!out.geo &&
      out.geo.countries >= 200 &&
      out.geo.ctryFilled === 11 &&
      out.geo.ctrySkippedWide === 1 &&
      out.geo.ctryUnassigned === 0,
    /* 两级计数必须闭合：境外 30 + 中国 63 = 93 */
    countrySumOk: out.ctryPhotoSum === 30 && out.chinaPhotoSum === 63,
    pixelsAsExpected: px.length === 13 && px.every((p) => p.pxOk),
    semiTransparent: out.semiTransparent === true,
    fiveLevelsMapped: out.levelMapOk === true,
    /* 每个地点都必须有归属（省 adcode 或 ISO 国码），不许静默丢失。
       上一版把「境外点判给最近省」当成兜底，所以有 28 个 adcode=0；
       现在有国别这一级，它们全都有 ISO，assignNone 必须归零。
       长度对着页面自己报的 places 数，不写死常量。 */
    noPlaceLost: !!(out.assign && out.boot && out.assign.length === out.boot.places && out.assignNone.length === 0),
    rampNotFiltered: !!(out.rampUntouched && out.rampUntouched.length > 0 && out.rampUntouched.every((r) => r.inRamp)),
    fadeWorks: !!(out.fade && out.fade[4000].alpha > 0.5 && out.fade[26000].alpha === 0 && out.fade[40000].alpha === 0),
    hoverAddsClass: !!(out.hover && out.hover.afterClass === true && out.hover.beforeClass === false),
    hoverScale110: !!(out.hover && /matrix\(1\.1/.test(String(out.hover.transform))),
    hoverRemovesOnLeave: !!(out.hover && out.hover.afterLeave === false),

    /* ---- 4.1 两级切换：世界按国 / 全国按省 ---- */
    worldChinaOneColor: out.worldChinaOneColor === true,
    worldCtryFilled: out.worldCtryFilled === true,
    worldCtryEmpty: out.worldCtryEmpty === true,
    nationProvDiffers: out.nationProvDiffers === true,
    /* 离岛合规的正向判据：钓鱼岛 / 黄尾屿 / 赤尾屿必须被填 */
    islandsFilled: out.islandsFilled === true,

    /* ---- 4.2 填色层 hover：只动被悬停的那一块，其余逐像素不变 ---- */
    hoverLifts: out.hoverLifts === true,
    /* 「变深」而不是「提亮」—— 只查 alpha 会漏掉方向反了这一类错 */
    hoverDeepens: out.hoverDeepens === true,
    hoverRestUnchanged: out.hoverRestUnchanged === true,
    /* 悬停区之外整层像素哈希一致 —— 「其他色块不要变」的正面证据 */
    hoverOutsideIdentical: out.hoverOutsideIdentical === true,
    /* 反向锁：换个排除窗口，指纹必须变化。否则上一条可能只是读数不动 */
    hoverDigestSensitive: out.hoverDigestSensitive === true,
    hoverRegionHit: out.hoverRegionHit === true,
    hoverTipText: out.hoverTipText === true,
    hoverChinaOk: out.hoverChinaOk === true,
    hoverEmptyQuiet: out.hoverEmptyQuiet === true,

    /* ---- 4.3 聚合按国界：同簇不得跨国 ---- */
    noCrossRegion: out.noCrossRegion === true,
    jpClusterOk: out.jpClusterOk === true,
    /* 世界视图下中国那一簇跨多城市 → 仍报「中国」（不是被细化掉） */
    cnBigSaysChina: out.cnBigSaysChina === true,
    singleLabelKeepsPlace: out.singleLabelKeepsPlace === true,
    /* 换视野后旧的悬停必须被重算，不能挂着 */
    staleHoverCleared: out.staleHoverCleared === true,

    /* ---- 4.5 标签分级：放大后必须越来越具体 ---- */
    /* 不变量（扫 7 个 k）：**多地点**簇城市段唯一且非空 → 标签必须正好是那个城市名 */
    cityLabelExact: out.cityLabelExact === true,
    /* 世界视图保持国名 —— 分级不等于「一律变细」 */
    worldKeepsCountry: out.worldKeepsCountry === true,
    /* 全国视图下北京那一簇必须报「北京」，不得是「中国」 */
    nationBeijingSaysCity: out.nationBeijingSaysCity === true,
    /* 全国视图下「同城却报国名」的簇数必须为 0 —— 用户抱怨的原始形态 */
    nationNoOverCoarse: out.nationNoOverCoarse === true,
    /* 同省不同市 → 报省名（且必须是 shortName 缩写过的） */
    sameProvSaysProv: out.sameProvSaysProv === true,

    /* ---- 4.6 合规：台湾省级单列 / 国家级并入 / 港澳双名 / 省名缩写 ----
       2026-09-13 用户裁决：台湾在省级粒度（t ≥ 0.5）维持 solo 单列，
       国家级粒度（t < 0.5）并入中国单簇 —— 避免「中国」与「中国台湾」
       在同一屏以平级实体并列的合规观感。 */
    /* 省级粒度：solo 簇里不许混进别的省 */
    taiwanSolo: out.taiwanSolo === true,
    /* 国家级粒度：台湾必须已并入 —— 不许 solo 簇、不许「台湾」字样上标签 */
    cnOneAtCountry: out.cnOneAtCountry === true,
    noTwLabelAtCountry: out.noTwLabelAtCountry === true,
    /* 港澳合簇时两个名字都得在标签里（不许精简成一个） */
    hkmoBothShown: out.hkmoBothShown === true,
    /* 反向锁：不该双名的时候不许双名（含港澳的中国巨簇仍须报「中国」） */
    noHkMoOverreach: out.noHkMoOverreach === true,
    /* 省名不得残留「省 / 自治区 / 特别行政区」后缀 */
    noRawProvSuffix: out.noRawProvSuffix === true,

    /* ---- 4.7 聚合粒度跟随填色：省级粒度下不得跨省 ----
       这一组是「四川省显示成中国」那个问题的直接证伪口。
       注意三条是**并列**的，缺一条都能让坏行为溜回去：
         ① 没有跨省的簇（结构）
         ② 没有报「中国」的簇（表现）
         ③ unit 真的下沉了（机制）—— 只看①②的话，
            把 CLUSTER_PX 调到 0 也能全绿，但那样世界视图会被切碎。
       再加一条反向锁 worldStillMerged，把那个「用力过猛」的出口堵上。 */
    noCrossProvAtProv: out.noCrossProvAtProv === true,
    /* 港澳单位的例外必须**只有**港、澳两个省级行政区（不多不少）——
       这是上一条放行它之后必须配的反向锁，否则它会变成一扇后门：
       别的省只要伪造 unit='CN-MST' 就能绕过「不得跨省」。 */
    mstUnitClean: out.mstUnitClean === true,
    noChinaLabelAtProv: out.noChinaLabelAtProv === true,
    unitSunkAtProv: out.unitSunkAtProv === true,
    worldStillMerged: out.worldStillMerged === true,
    /* 用户点名的四对（上海+杭州 / 成都+重庆 / 丽江+甘孜 / 桂林+张家界）必须拆开 */
    fourPairsSplit: out.fourPairsSplit === true,

    /* ---- 4.8 每个标注都必须「够得到」（量 DOM 真实 rect，不看截图）----
       重叠已被用户裁决接受（避让挪位与牵引线已删）；这条锁的是
       「没有任何标注被完全盖死」—— 最差可见采样占比 ≥ 4%。 */
    noBoxOverlap: out.noBoxOverlap === true,

    /* ---- 4.9 国家级粒度下不得出现省级裸名（合规）----
       「中国」与「新疆」并列那个问题的直接证伪口。双向四条：
        ① 国家级粒度下没有裸省名（表现）
        ② 国家级粒度下中国是一个簇（机制）
        ③ 93 张照片一张不少（防「过滤掉照片」这种捷径）
        ④ 省级粒度下省名必须回来（反向锁，防「一律压成国名」） */
    noBareProvAtCountry: out.noBareProvAtCountry === true,
    cnOneAtCountry: out.cnOneAtCountry === true,
    worldKeepsAllPhotos: out.worldPhotoTotal === 93,
    provLabelAtProvView: out.provLabelAtProvView === true,
    xinjiangAtProvView: out.xinjiangAtProvView === true,

    /* ---- 4.10 聚合过渡动画（散开 / 收拢） ---- */
    animActiveOnZoom: out.animActiveOnZoom === true,
    animSpawnNearPrev: out.animSpawnNearPrev === true,
    /* 出生关系三条：父簇必须含着我、不得跨区域、且国家级粒度下确实由
       「中国」那一个簇散开而来。只有前两条会一起被 ?proxanim 打红。 */
    animBirthParentByMember: out.animBirthParentByMember === true,
    animBirthNeverCrossRegion: out.animBirthNeverCrossRegion === true,
    animBirthFromCnAggregate: out.animBirthFromCnAggregate === true,
    animMergeSameRegion: out.animMergeSameRegion === true,
    animSettledAtRest: out.animSettledAtRest === true,
    animSettledAfterZoom: out.animSettledAfterZoom === true,
    animQuietOnJump: out.animQuietOnJump === true,
    animQuietOnDrag: out.animQuietOnDrag === true,

    /* ---- 4.11 地点位置：同名照片不许跨距离平均 ----
       五条判据守的是产品的核心能力。少任何一条都留一条缝：
       只验「拆开了」→ 拆到两个错的地方也全绿；只验 spread → 全都不拆也全绿
       （不拆时每堆当然都在闸内）；只验演示数据 → 换一个相册就失效。
       两个测试缝的并集正好把这五条全部打红，详见 4.11 段的说明。 */
    placeSplitAcrossDistance: out.placeSplitAcrossDistance === true,
    placeSpreadBounded: out.placeSpreadBounded === true,
    placeFarInRightProvince: out.placeFarInRightProvince === true,
    placeSplitLabelsDistinct: out.placeSplitLabelsDistinct === true,
    nearPhotosStayOnePlace: out.nearPhotosStayOnePlace === true,
    /* 异步重建（市界到货）之后归属必须还在 —— 唯一能打红它的是 `&noreassign` */
    placeRebuildKeepsRegion: out.placeRebuildKeepsRegion === true,

    /* ---- 4.12 池元素不许被两个活簇共用（「中国的图片都不见了」）----
       用户报的是一条**概率性**的 bug：最小视图下中国的照片有一定概率整簇消失。
       根因是元素池分配：还没轮到的活簇已经握着一个元素，而 animFree 不认它。
       两条判据守机制 / 表现，`&nopoolfix` 精确打红这两条。
       （「DOM 不许重名」那条被删了 —— 它是动画交叉淡入淡出的假阳性，理由见 4.12 段头。） */
    poolOnePinPerCluster: out.poolOnePinPerCluster === true,
    poolEveryClusterShown: out.poolEveryClusterShown === true,

    /* ---- 4.13 国家级「国家中心」锚点（「照片的指向了两地中间」）----
       规则：位置跟标签走。六条判据各守一面，`&noanchor` 精确打红前四条。 */
    countryAnchorApplied: out.countryAnchorApplied === true,
    countryAnchorInside: out.countryAnchorInside === true,
    cnAnchorInHeartland: out.cnAnchorInHeartland === true,
    spreadAlbumAnchored: out.spreadAlbumAnchored === true,
    localLabelNotAnchored: out.localLabelNotAnchored === true,
    anchorAuditClean: out.anchorAuditClean === true,

    /* ---- 4.14 配额闸门：动画期间只按终点层级请求 ----
       机制 / 安全 / 收敛各一条，`?noquotagate` 精确打红第一条。
       终点画面的一致性由 tools/verify-quota-shots.js 逐像素判（见 4.14 段头）。 */
    quotaGateHeld: out.quotaGateHeld === true,
    quotaNoHole: out.quotaNoHole === true,
    quotaSettleClean: out.quotaSettleClean === true,

    /* 防御式访问：出错时 out.exif 可能压根没建，直接在判据段二次崩溃
       会把真正的异常盖掉（踩过）。读不到就报 false，不要写成恒真。 */
    exifParsesGps: !!(out.exif && out.exif.unitOk === true),
    exifRejectsNoGps: !!(out.exif && out.exif.noGpsOk === true),
    /* 出口分类：不是 JPEG / 没记位置 / 有效，三种必须分得开。
       少了这两条，把 probeExif 重新塌回「返回 null」也能全绿 ——
       而那正是让用户误判「读码坏了」的那一版。 */
    exifWhyClassified: !!(out.exif && out.exif.whyOk === true),
    skipReasonSplit: out.skipWhyOk === true,
    importPipelineOk: out.pipelineOk === true,
    fileInputPathOk: out.fileInputOk === true,
    importFillVisible: out.importFillVisible === true,
    /* 点位缩略图必须解出像素，且 src 是**没被拼前缀的** blob: 。
       前缀检查单独不够（'../blob:…' 也以 blob: 开头），所以两条一起判。 */
    importThumbDecoded:
      !!out.importThumb &&
      out.importThumb.length > 0 &&
      out.importThumb.every((t) => t.nw > 0 && t.attr === 'blob:'),
    resetOk: out.resetOk === true,
    fiveLevelsDistinct: !!(out.levels && out.levels.distinct === 5),
  };
  out.verdict = verdict;
  out.failed = Object.keys(verdict).filter((k) => !verdict[k]);
  out.pass = out.failed.length === 0;
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
})();
