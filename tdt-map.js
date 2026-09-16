/**
 * 相册地图 · 天地图底图实验线
 * ============================================================================
 * 本目录**自包含**：不引用父级（自绘线）的任何东西，整个 tdt-demo/ 可以原样搬走。
 * 随目录一起走的本地资产（天地图**都不提供**，逐项清单见 `TECH-STACK.md` 第 1 节）：
 *   photo-map.css      样式副本（原先与主线共用，隔离后不再自动同步）
 *   photo-data.js      演示照片数据（id / src / date / place / wgs）
 *   assets/geo/*.js    省界与国别面 —— 密度填色与「落哪个行政区」判定的数据前提
 *   assets/photo-*     演示照片本体
 *
 * 保留的东西（用户要求「交互保持一致」）：
 *   · 单相机 { lng, lat, k }，k 连续，无层级切换
 *   · 滚轮 / 双击 / 双指缩放走「锚点式目标视图」，锚点在任何一帧都精确不动
 *   · k 走对数缓动（时间常数 85ms），tx/ty 由 k 与锚点反推，不独立插值
 *   · 拖动只改相机、不改 k；位移阈值 4px 后才捕获指针
 *   · 双指手势合并到帧上结算，不在 pointermove 里算
 *   · 视野钳制在墨卡托世界方块内
 *   · 标注层是 DOM 覆盖层，字号与线宽恒为屏幕像素，不随缩放变化
 *
 * 换掉的东西：
 *   底图从「自绘矢量」换成「天地图 WMTS 栅格瓦片」。
 *   代价在 README 里列清楚了，最要紧的一条：栅格瓦片的图层样式是烘焙的，
 *   客户端改不了配色与显隐，只能用 CSS filter 做整体色相/明度重映射。
 *
 * 坐标系（这一条最容易搞错）：
 *   天地图用 CGCS2000，与 WGS-84 在本项目精度内一致 → **直接用照片的 wgs 原始值**。
 *   而 photo-map.js 的自绘引擎用的是 gcj（因为 DataV 底图数据是 GCJ-02）。
 *   两边取的不是同一个字段，这是对的，不要「统一」成一个。
 * ============================================================================
 */
(function () {
  'use strict';

  /* ========================================================== 0. 投影与常量 */

  const D2R = Math.PI / 180;

  /* 世界坐标 = Web Mercator（单位：弧度），y 取负号让「纬度越高 y 越小」。
     与 photo-map.js 完全同式，标注层的定位口径因此天然一致。 */
  const M = {
    x: (lng) => lng * D2R,
    y: (lat) => -Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2)),
    lng: (x) => x / D2R,
    lat: (y) => (2 * Math.atan(Math.exp(-y)) - Math.PI / 2) / D2R,
  };

  const HOME = [73.3, 3.2, 135.2, 53.7]; // w, s, e, n
  const WORLD = [-180, -85.0511, 180, 85.0511];
  const PIN_EDGE = 76; // 装框时左右留白，防止最东/最西那张点位的贴地放弃
  const K_MAX = 160000;
  const ZOOM_TAU = 85;
  const WORLD_BOX = { x0: -Math.PI, x1: Math.PI, y0: -Math.PI, y1: Math.PI };

  const THEME_LIST = [
    { id: 'night', name: '夜幕', a: '#070b12', b: '#e9b04a' },
    { id: 'ink', name: '墨', a: '#0b0c0e', b: '#f3f4f6' },
    { id: 'abyss', name: '深海', a: '#04121a', b: '#bef26d' },
    { id: 'clay', name: '陶土', a: '#100c09', b: '#f2c874' },
    { id: 'paper', name: '纸白', a: '#eef1f6', b: '#2f6ee0' },
  ];

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  /* ================================================================ 1. DOM */

  const appEl = document.getElementById('app');
  const stageEl = document.getElementById('stage');
  const cvEl = document.getElementById('cv');
  const fillEl = document.getElementById('fill');
  const fillTipEl = document.getElementById('fillTip');
  const overlayEl = document.getElementById('overlay');
  const themesEl = document.getElementById('themes');
  const panelEl = document.getElementById('panel');
  const toastEl = document.getElementById('toast');
  const loadingEl = document.getElementById('loading');
  const loadingText = document.getElementById('loadingText');
  const scaleTag = document.getElementById('scaleTag');
  const attrScale = document.getElementById('attrScale');
  const brandMeta = document.getElementById('brandMeta');
  const btnHome = document.getElementById('btnHome');
  const btnWorld = document.getElementById('btnWorld');
  const btnNote = document.getElementById('btnNote');
  const btnKey = document.getElementById('btnKey');
  const btnTheme = document.getElementById('btnTheme');
  const btnIn = document.getElementById('btnIn');
  const btnOut = document.getElementById('btnOut');
  const keybox = document.getElementById('keybox');
  const keyInput = document.getElementById('keyInput');
  const keyRemember = document.getElementById('keyRemember');
  const keySave = document.getElementById('keySave');
  const btnPhoto = document.getElementById('btnPhoto');
  const impbox = document.getElementById('impbox');
  const impHint = document.getElementById('impHint');
  const filePhotos = document.getElementById('filePhotos');
  const fileFolder = document.getElementById('fileFolder');

  const ctx = cvEl.getContext('2d');

  /* 密度填色层是**独立画布**，刻意不复用 cvEl。
     原因：底图画布挂着 CSS filter（见 tdt-extra.css 的调色层），
     filter 作用于元素的整个渲染结果 —— 密度色阶一旦画进去，
     会被 grayscale+invert 洗成灰白，5 档色阶全部消失。
     这是「海域底色被滤镜染成中灰」之外的第二个同类陷阱。 */
  const fctx = fillEl.getContext('2d');

  /* =============================================================== 2. 尺寸 */

  const size = { w: 0, h: 0, dpr: 1 };
  let dirty = true;
  /* 填色层单独一个脏标记：鼠标划过色块时只该重画填色层，
     不该把整张底图也跟着重栅格化一遍。 */
  let fillDirty = false;

  function resize() {
    const r = stageEl.getBoundingClientRect();
    size.w = Math.max(1, Math.round(r.width));
    size.h = Math.max(1, Math.round(r.height));
    size.dpr = Math.min(window.devicePixelRatio || 1, 2);
    cvEl.width = Math.round(size.w * size.dpr);
    cvEl.height = Math.round(size.h * size.dpr);
    fillEl.width = cvEl.width;
    fillEl.height = cvEl.height;
    dirty = true;
    /* 视口尺寸变化会带动 tx/ty 与 k 一起变，但那不是手势 ——
       下一帧强制吸附，别让标注自己滑一段（见 5.5 节的 ①）。 */
    animResync = true;
  }

  /* =============================================================== 3. 相机 */

  const cam = { lng: 104, lat: 34, k: 700 };
  const t2 = { k: 700, tx: 0, ty: 0 };

  let zoomView = null; // 缩放目标：{ k, ax, ay, wx, wy }
  let zoomTick = 0;
  let tween = null;

  function kMin() {
    /* 墨卡托把世界映射成正方形 [-π,π]²，要装下整个世界就需要
       k = min(视口宽, 视口高) / 2π，视口越小能缩得越小。 */
    return Math.max(60, (Math.min(size.w, size.h) / (2 * Math.PI)) * 0.78);
  }

  function viewFromCam(c) {
    const k = clamp(c.k, kMin(), K_MAX);
    return { k, tx: size.w / 2 - M.x(c.lng) * k, ty: size.h / 2 - M.y(c.lat) * k };
  }

  /* 视野钳制：在**世界坐标**里钳，不能在经纬度里钳 —— 墨卡托的 y 是非线性的，
     按纬度直接夹会在高纬处夹出偏差。缩到世界级时视口比世界还大，只能居中。 */
  function clampCamera() {
    const hw = size.w / 2 / cam.k;
    const hh = size.h / 2 / cam.k;
    const xa = WORLD_BOX.x0 + hw;
    const xb = WORLD_BOX.x1 - hw;
    const ya = WORLD_BOX.y0 + hh;
    const yb = WORLD_BOX.y1 - hh;
    const nx = xa > xb ? 0 : clamp(M.x(cam.lng), xa, xb);
    const ny = ya > yb ? 0 : clamp(M.y(cam.lat), ya, yb);
    cam.lng = M.lng(nx);
    cam.lat = M.lat(ny);
  }

  function panBy(dx, dy) {
    const tx2 = t2.tx + dx;
    const ty2 = t2.ty + dy;
    cam.lng = M.lng((size.w / 2 - tx2) / t2.k);
    cam.lat = M.lat((size.h / 2 - ty2) / t2.k);
    clampCamera();
    dirty = true;
  }

  /** 锚点式目标视图 → 仿射参数。锚点钉住 (wx,wy)→(ax,ay)，所以由 k 唯一决定 */
  function viewFromZoom(z) {
    return { k: z.k, tx: z.ax - z.wx * z.k, ty: z.ay - z.wy * z.k };
  }

  /* 缩放不立刻改相机，而是推进「目标视图」，由 stepZoom 缓动过去。
     两个关键点：
       1. k 以「上一次的目标」为基准累加（不是当前值），否则动画没跟上时
          连续滚动，每次都在一个落后的基准上乘，滚得越快被吃掉的越多。
       2. 锚点的世界坐标同样取「目标视图」。取当前视图是个陷阱：动画没走完时
          光标底下已经不是原来那个地点了，每次滚轮都在半路重新取样，
          实测连续滚 6 格能漂 70px。 */
  function zoomToAt(k2, ax, ay) {
    k2 = clamp(k2, kMin(), K_MAX);
    const base = zoomView ? viewFromZoom(zoomView) : viewFromCam(cam);
    if (k2 === base.k) return false;
    const wx = (ax - base.tx) / base.k;
    const wy = (ay - base.ty) / base.k;
    zoomView = { k: k2, ax, ay, wx, wy };
    zoomTick = 0;
    tween = null; // 连续缩放与定点缓动互斥
    dirty = true;
    return true;
  }

  function zoomBy(factor, sx, sy) {
    const ax = sx == null ? size.w / 2 : sx;
    const ay = sy == null ? size.h / 2 : sy;
    const baseK = zoomView ? zoomView.k : cam.k;
    zoomToAt(baseK * factor, ax, ay);
  }

  /* 每帧朝目标逼近一点。对 k 取对数，因为「视觉上匀速的缩放」对应 k 的等比变化。
     关键：tx/ty 不是独立插值的，而是由 k 和锚点反推 —— 两者在中间帧必须自洽，
     否则锚点会在动画中偏离（实测连滚 5 格，光标下的地点先左滑 19.5px 再荡回来）。 */
  function stepZoom(now) {
    if (!zoomView) return;
    const dt = clamp(now - (zoomTick || now), 1, 64);
    zoomTick = now;
    const a = 1 - Math.exp(-dt / ZOOM_TAU);

    const v = viewFromCam(cam);
    const nk = Math.exp(Math.log(v.k) + (Math.log(zoomView.k) - Math.log(v.k)) * a);
    const settled = Math.abs(Math.log(zoomView.k / nk)) < 3e-4;
    const k2 = settled ? zoomView.k : nk;

    const tx2 = zoomView.ax - zoomView.wx * k2;
    const ty2 = zoomView.ay - zoomView.wy * k2;

    cam.k = k2;
    cam.lng = M.lng((size.w / 2 - tx2) / k2);
    cam.lat = M.lat((size.h / 2 - ty2) / k2);

    /* 被边界拉住时锚点已经钉不住（那个世界点够不着了）。
       处理办法是「挪锚点的世界坐标、屏幕锚点不动」，把够不着的位移让给边界。
       注意千万不要顺手把 zoomView.k 改成 k2 —— 那是当前插值值不是目标，
       下一帧会拿它当基准、算出「已经到位」，缩放当场停死。 */
    const lng0 = cam.lng;
    const lat0 = cam.lat;
    clampCamera();
    if (cam.lng !== lng0 || cam.lat !== lat0) {
      zoomView.wx = M.x(cam.lng) + (zoomView.ax - size.w / 2) / k2;
      zoomView.wy = M.y(cam.lat) + (zoomView.ay - size.h / 2) / k2;
    }

    dirty = true;
    if (settled) {
      zoomView = null;
      zoomTick = 0;
    }
  }

  function animateTo(next, duration) {
    zoomView = null;
    tween = { t0: performance.now(), dur: duration, from: { lng: cam.lng, lat: cam.lat, k: cam.k }, to: next };
    dirty = true;
  }

  function stepTween(now) {
    if (!tween) return;
    const p = clamp((now - tween.t0) / tween.dur, 0, 1);
    const e = 1 - Math.pow(1 - p, 3);
    cam.lng = tween.from.lng + (tween.to.lng - tween.from.lng) * e;
    cam.lat = tween.from.lat + (tween.to.lat - tween.from.lat) * e;
    /* 缩放走对数插值，线性插值会让动画前快后慢得很怪 */
    cam.k = Math.exp(Math.log(tween.from.k) + (Math.log(tween.to.k) - Math.log(tween.from.k)) * e);
    dirty = true;
    if (p >= 1) tween = null;
  }

  function setCamera(next, duration) {
    next.k = clamp(next.k, kMin(), K_MAX);
    if (!duration) {
      tween = null;
      zoomView = null;
      cam.lng = next.lng;
      cam.lat = next.lat;
      cam.k = next.k;
      clampCamera();
      dirty = true;
      return;
    }
    animateTo(next, duration);
  }

  /** 装框：把一段经纬度盒子放进视口，四周各留 PIN_EDGE，防止边缘点位的贴地放弃被切 */
  function fitBox(box, duration) {
    const [w, s, e, n] = box;
    const wx0 = M.x(w);
    const wx1 = M.x(e);
    const wy0 = M.y(n); // 北的 y 更小
    const wy1 = M.y(s);
    const availW = Math.max(40, size.w - PIN_EDGE * 2);
    const availH = Math.max(40, size.h - PIN_EDGE * 2);
    const k = Math.min(availW / (wx1 - wx0), availH / (wy1 - wy0));
    setCamera({ lng: M.lng((wx0 + wx1) / 2), lat: M.lat((wy0 + wy1) / 2), k }, duration);
  }

  /* ========================================================= 4. 天地图瓦片 */
  /* 用的是标准 WMTS，TILEMATRIXSET=w 就是标准 Web Mercator XYZ —— 与本项目的
     世界坐标完全同构（世界宽 = 2π 弧度，y 向北为负）。所以瓦片定位不需要任何
     额外投影，直接用 M 换算即可，这是选天地图最省事的地方。

     刻意**不使用**天地图的 JS SDK：一是零依赖是本项目的底线，
     二是自己拿 WMTS 才能让瓦片跟着我们自己的连续相机走，而不是被 SDK 的
     整数 zoom 管着。 */

  const TILE_MIN_Z = 1;
  const TILE_MAX_Z = 18;
  const SUBDOMAINS = ['0', '1', '2', '3', '4', '5', '6', '7'];

  /* 子域**必须是瓦片的纯函数**，不能按请求顺序轮询。

     原来写的是 `SUBDOMAINS[TDT.rr++ % 8]` —— rr 是本页「未命中请求」的计数器。
     `tileUrl()` 只在 `wantTile()` 走到「缓存里没有、也不在途」那一刻才被调用，
     于是一张瓦片的 URL 取决于「它是本页第几个未命中的请求」：视口尺寸、开发者工具
     的开与关、起始视野、甚至上一次缓存命中了几个，都会让它整体漂移。

     为什么要命：天地图的响应头是 `cache-control: max-age=432000`（5 天），本来完全
     可缓存；但浏览器是按 **URL** 查缓存的。URL 一漂，它就在对着同一份字节去查一个
     从没存过的键。实测两种视口高度下、两边都出现的 40 张瓦片 **100% 换了 URL**
     （`tools/probe-tile-url-stability.js`）。表现就是「每打开一次页面就重付一次配额」，
     而缓存怎么配都像没用。

     改成对 (z,x,y) 取稳定散列 → URL 恒定。散列仍把请求摊到 8 个子域（连接并行度不变），
     同一张瓦片的 z/x/y 与内容也不变，所以**视觉零变化**。
     判据：`tools/probe-tile-url-stability.js` 的 `sameUrl` 应等于 `shared` 的 100%。 */
  /* ⚠️ 不要再顺手给这个散列加「低位混合」（`h ^= h >>> 15` 那种）。
     它看着朴素，但对「一屏 = 一块连续矩形」这个事实是**按构造**均匀的：`imul` 的低 3 位
     只由 x/y/z 各自的低 3 位决定（低位乘法没有进位扩散），于是 `h % 8 = g(x mod 8, y mod 8)`
     是个 8×8 周期格点 —— 覆盖只要在某一个方向跨满 8 格，8 个子域就各拿一次。
     实测（`tools/analyze-tile-subdomain.js`，穷举 8×8 种原点取最坏比值）：
       现状 1.00~1.14；**加一次低位混合后最坏 11.00**（1280×800，某子域拿了 11 倍）。
     结论：「更复杂」不等于更均匀 —— 加了反而毁掉周期性。 */
  function subFor(z, x, y) {
    const h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z + 1, 83492791)) >>> 0;
    return SUBDOMAINS[h % SUBDOMAINS.length];
  }

  const LAYERS = {
    vec: { path: 'vec_w', name: 'vec' },
    cva: { path: 'cva_w', name: 'cva' },
  };

  /* rr 已移除 —— 子域改由 subFor(z,x,y) 决定，见其注释。 */
  const TDT = { tk: '' };

  /* 测试缝 ?fake —— 用 data: SVG 伪造瓦片，每张印着自己真实的 z/x/y。
     没有密钥时要验证「层级选择 / 瓦片定位 / 拼缝 / 绘制顺序」这四件事，
     只能靠它：真瓦片要联网也要密钥，而这里要验的恰恰是换与不换时那套数学。 */
  let FAKE = false;

  function fakeTile(name, z, x, y) {
    const bg = name === 'cva' ? '#f3e3bb' : z % 2 ? '#dfe9f2' : '#d3e1ef';
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">' +
      '<rect width="256" height="256" fill="' + bg + '"/>' +
      '<rect x="1" y="1" width="254" height="254" fill="none" stroke="#7f9ec4" stroke-width="2"/>' +
      '<text x="10" y="32" font-family="monospace" font-size="24" fill="#3b5c86">' +
      z + '/' + x + '/' + y +
      '</text></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  function tileUrl(path, name, z, x, y) {
    if (FAKE) return fakeTile(name, z, x, y);
    /* 子域是 (z,x,y) 的纯函数 —— 同一张瓦片永远同一个 URL，上游 5 天缓存才用得上。
       不要改回 `TDT.rr++ % 8` 那种按请求顺序轮询，理由见 subFor 的注释。 */
    const s = subFor(z, x, y);
    return (
      'https://t' + s + '.tianditu.gov.cn/' + path + '/wmts' +
      '?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0' +
      '&LAYER=' + name + '&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles' +
      '&TILEMATRIX=' + z + '&TILEROW=' + y + '&TILECOL=' + x +
      '&tk=' + TDT.tk
    );
  }

  const FAILED = { failed: true };
  const tileImg = new Map(); // key -> HTMLImageElement | FAILED
  const tileReq = new Map(); // key -> 1（在途）

  const keyOf = (layer, z, x, y) => layer + '/' + z + '/' + x + '/' + y;

  let loadedOnce = false;
  let netErrors = 0;

  function wantTile(layer, z, x, y) {
    if (!TDT.tk && !FAKE) return;
    const key = keyOf(layer, z, x, y);
    if (tileImg.has(key) || tileReq.has(key)) return;
    tileReq.set(key, 1);
    tileAsked += 1; // 读数口 __tdt.quota() 用它（声明见第 5 节配额闸门）
    const img = new Image();
    /* 刻意不设 crossOrigin：天地图瓦片不保证回 CORS 头，设了会直接加载失败。
       我们不需要读像素，只要拿它当 drawImage 的图源。 */
    img.decoding = 'async';
    img.onload = () => {
      tileReq.delete(key);
      tileImg.set(key, img);
      netErrors = 0;
      if (!loadedOnce) {
        loadedOnce = true;
        hideLoading();
      }
      dirty = true;
    };
    img.onerror = () => {
      tileReq.delete(key);
      /* 负缓存：失败的瓦片记下来，避免每帧反复重试同一个 URL */
      tileImg.set(key, FAILED);
      netErrors += 1;
      if (!loadedOnce && netErrors >= 4) {
        loadedOnce = true;
        hideLoading();
        showNoKey('瓦片拉取失败，已退回网格底图 —— 多半是 tk 无效或域名未加白名单');
      }
      dirty = true;
    };
    img.src = tileUrl(LAYERS[layer].path, LAYERS[layer].name, z, x, y);
  }

  const peekTile = (layer, z, x, y) => tileImg.get(keyOf(layer, z, x, y)) || null;

  /* ================================================================ 5. 绘制 */

  let noteOn = false; // 注记层（cva_w）默认关闭，见 README「为什么默认不加载注记」

  function drawGraticule() {
    ctx.save();
    ctx.strokeStyle = 'rgba(140, 175, 225, 0.16)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    for (let lng = -180; lng <= 180; lng += 15) {
      const x = M.x(lng) * t2.k + t2.tx;
      if (x < -1 || x > size.w + 1) continue;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, size.h);
      ctx.stroke();
    }
    for (let lat = -75; lat <= 75; lat += 15) {
      const y = M.y(lat) * t2.k + t2.ty;
      if (y < -1 || y > size.h + 1) continue;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(size.w, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  let curZ = 0;
  let curZWant = 0; // 本帧实际**请求**的层级（闸门打开时 = 动画终点层）
  let curMiss = 0; // 本帧「本层与祖先都拿不到」的格数 —— 动画后会短暂 > 0，静止后必须回 0

  /* ---------------------------------------------------------------- 配额闸门
     **动画/缩放进行中，瓦片只按「终点层级」请求；中间经过的层级一张都不发。**

     为什么这是纯赚的：`fitBox(WORLD, 520)` 把 k 从 1500 连续插到 201，z 会依次
     经过 5 → 4 → 3 → 2。旧写法「每帧按当前 z 请求整屏覆盖」，于是四级各请求一屏。
     实测一次「切世界视图」发出 **104 张**，其中 z=1/3/4/5 共 88 张只在动画的
     几帧里露过面、此后再不复用；真正的终点层 z=2 只要 **16 张**。

     闸门打开时：请求走 `zWant`（终点层），绘制仍走当前层 `z`。当前层缺的瓦片
     向上找祖先 —— `zWant` 恰好就是当前层的祖先，于是动画中看到的是
     「终点层的图被暂时拉伸」，而不是空洞。瓦片到货会 `dirty = true` 触发重绘。

     闸门只在 `pendingK()` 非 0（tween / zoomView 在动）时生效。手动拖动、
     双击、瞬时跳变（`setCamera(..., 0)`）都是 `tween = null && zoomView = null`，
     走原路径 —— 拖动产生的新瓦片是真实需要的，不能拦。

     测试缝 `?noquotagate`：关掉闸门，退回旧的「每帧按当前层请求」。 */
  let quotaGate = true;
  let tileAsked = 0; // 累计发起的瓦片请求数（≈ 实付配额）
  let tileFallback = 0; // 累计「本层没有、用祖先顶住」的格次
  const heldKeys = new Set(); // 被闸门拦下的唯一瓦片（= 直接省下的配额）

  /** 相机正在动时的目标 k（tween 终点 / 缩放终点）。没在动返回 0。 */
  function pendingK() {
    if (tween) return tween.to.k;
    if (zoomView) return zoomView.k;
    return 0;
  }

  /** 相机正在动时的**终点视野** {lng, lat, k}；没在动返回 null。
      请求覆盖必须按它算，不能按当前帧视野 —— 原因见 draw() 内注释。 */
  function pendingView() {
    if (tween) return tween.to;
    if (zoomView) {
      const v = viewFromZoom(zoomView);
      return {
        k: v.k,
        lng: M.lng((size.w / 2 - v.tx) / v.k),
        lat: M.lat((size.h / 2 - v.ty) / v.k),
      };
    }
    return null;
  }

  /** k → 瓦片层级。取 round 让瓦片尺度倍数落在 1/√2 ~ √2 之间 ——
      往大取（ceil）更清晰但瓦片数量翻倍，往小取会明显发虚。 */
  const zOfK = function (k) {
    return clamp(Math.round(Math.log2((2 * Math.PI * k) / 256)), TILE_MIN_Z, TILE_MAX_Z);
  };

  /** 把屏幕矩形在 zz 层覆盖到的瓦片全部要一遍（带经度环绕与 y 越界裁剪）。 */
  function requestCover(layer, zz, wx0, wx1, wy0, wy1) {
    const nz = 1 << zz;
    const twz = (2 * Math.PI) / nz;
    const a = Math.floor((wx0 + Math.PI) / twz);
    const b = Math.floor((wx1 + Math.PI) / twz);
    const c = Math.floor((wy0 + Math.PI) / twz);
    const d = Math.floor((wy1 + Math.PI) / twz);
    if ((b - a + 1) * (d - c + 1) > 400) return;
    const y0 = Math.max(0, c);
    const y1 = Math.min(nz - 1, d);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = a; cx <= b; cx++) {
        wantTile(layer, zz, ((cx % nz) + nz) % nz, cy);
      }
    }
  }

  /** 本层没有瓦片时向上找祖先：动画期间终点层已到货、当前层还没请求，
      把粗图拉大顶几帧，比留一个空洞好。`wrapped` 已在 [0, n) 内，右移即可。 */
  function peekAncestor(layer, z, x, y) {
    for (let d = 1; z - d >= TILE_MIN_Z; d++) {
      const img = peekTile(layer, z - d, x >> d, y >> d);
      if (img && img !== FAILED) return { img: img, d: d };
    }
    return null;
  }

  function draw() {
    ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h); // 清成透明，露出画布的 CSS 底色（--m-ocean）

    const k = t2.k;
    const tx = t2.tx;
    const ty = t2.ty;

    if (!TDT.tk && !FAKE) {
      curZ = 0;
      curMiss = 0;
      drawGraticule();
      return;
    }

    /* z 由 k 反推，取整规则见 zOfK 的注释。 */
    const z = zOfK(k);
    curZ = z;

    const n = 1 << z; // 每边瓦片数
    const tw = (2 * Math.PI) / n; // 一张瓦片的世界坐标边长
    const tp = tw * k; // 一张瓦片在屏幕上的边长

    const wx0 = (0 - tx) / k;
    const wx1 = (size.w - tx) / k;
    const wy0 = (0 - ty) / k;
    const wy1 = (size.h - ty) / k;

    const cx0 = Math.floor((wx0 + Math.PI) / tw);
    const cx1 = Math.floor((wx1 + Math.PI) / tw);
    const cy0 = Math.floor((wy0 + Math.PI) / tw);
    const cy1 = Math.floor((wy1 + Math.PI) / tw);

    /* 极端 k 下的保险丝：宁可这一帧不画，也不要卡死主线程。
       正常视口下这个数在 20~80 之间。 */
    const count = (cx1 - cx0 + 1) * (cy1 - cy0 + 1);
    if (count > 400) {
      curZWant = 0;
      curMiss = 0;
      drawGraticule();
      return;
    }

    const list = noteOn ? ['vec', 'cva'] : ['vec'];
    let drawn = 0;
    let fell = 0;
    let miss = 0;

    /* 请求层级：闸门打开且相机在动 → 只请求**终点层 + 终点视野**。
       中间层级的请求在这里被整体跳过，就是省下来的那部分配额。 */
    let zWant = z;
    let vWant = null;
    if (quotaGate) {
      const pk = pendingK();
      if (pk) {
        zWant = zOfK(pk);
        vWant = pendingView();
      }
    }
    curZWant = zWant;
    /* ⚠️ `held` 只能看「相机在不在动」，不能写成 `zWant !== z`。
       写成后者会漏掉一种情况：动画进行到当前层恰好等于终点层时（切全国的
       后半程 z 已经是 4、终点也是 4），`zWant !== z` 变成 false，于是本层
       恢复按**当前帧视野**逐格请求 —— 而那一帧的视野比终点大得多（k=460 vs
       900），一屏要 40 格。实测「切全国」因此从 16 张涨到 40 张。 */
    const held = !!vWant;
    if (held) {
      /* ⚠️ 覆盖必须按**终点视野**算，不能按当前帧视野。
         按当前帧算的话，动画的每一帧都在按当时（还没走到位）的视野求覆盖，
         各帧互不相同、去重失效 —— 实测「切全国」反而从 16 张涨到 240 张。
         终点视野在整段动画里是固定的，于是每帧算出同一批瓦片，
         只有第一帧真正发出请求，其余帧全部命中 tileImg / tileReq。 */
      const wtx = size.w / 2 - M.x(vWant.lng) * vWant.k;
      const wty = size.h / 2 - M.y(vWant.lat) * vWant.k;
      const ax0 = (0 - wtx) / vWant.k;
      const ax1 = (size.w - wtx) / vWant.k;
      const ay0 = (0 - wty) / vWant.k;
      const ay1 = (size.h - wty) / vWant.k;
      for (let li = 0; li < list.length; li++) {
        requestCover(list[li], zWant, ax0, ax1, ay0, ay1);
      }
    }

    /* 两层分开循环：先把 vec 铺满，再整体叠 cva。
       如果混在一个循环里逐格画，后面的 vec 会盖掉前面已经画好的 cva。 */
    for (let li = 0; li < list.length; li++) {
      const layer = list[li];
      for (let cy = cy0; cy <= cy1; cy++) {
        if (cy < 0 || cy >= n) continue;
        const sy = (-Math.PI + cy * tw) * k + ty;
        for (let cx = cx0; cx <= cx1; cx++) {
          const wrapped = ((cx % n) + n) % n; // 经度环绕
          const sx = (-Math.PI + cx * tw) * k + tx;
          const own = peekTile(layer, z, wrapped, cy);

          if (!own) {
            if (held) {
              /* 动画中：本层不发请求。记下这张「本来要花掉的配额」，
                 只在它确实还没有（不在缓存、也不在途）时记一次。 */
              const hk = keyOf(layer, z, wrapped, cy);
              if (!tileImg.has(hk) && !tileReq.has(hk)) heldKeys.add(hk);
            } else {
              wantTile(layer, z, wrapped, cy);
            }
          }

          if (own && own !== FAILED) {
            /* +0.5px 是消缝用的：浮点误差会让相邻瓦片之间露出一条底色线，
               放大后尤其明显。多出的半像素被下一张盖住，看不见。 */
            ctx.drawImage(own, sx, sy, tp + 0.5, tp + 0.5);
            drawn += 1;
            continue;
          }

          /* 本层没有（未到货 / 失败）→ 用祖先顶住。动画期间 zWant 比 z 粗，
             这一支就是「终点层的图被暂时拉伸」，避免整屏空洞。 */
          const anc = peekAncestor(layer, z, wrapped, cy);
          if (!anc) {
            miss += 1;
            continue;
          }
          const span = 256 >> anc.d;
          const mask = (1 << anc.d) - 1;
          ctx.drawImage(
            anc.img,
            (wrapped & mask) * span,
            (cy & mask) * span,
            span,
            span,
            sx,
            sy,
            tp + 0.5,
            tp + 0.5
          );
          drawn += 1;
          fell += 1;
        }
      }
    }

    tileFallback += fell;
    curMiss = miss;
    if (drawn === 0) drawGraticule();
  }

  /* ============================================================== 6. 标注层 */

  const PHOTOS = []; // 地点：{ name, list[], lng, lat, wx, wy }

  /* photo-data.js 里的 src 写作 'assets/photo-XX.png'，基准是**本目录** ——
     自包含之后不必再往父级退一级，原样返回即可。

     ⚠️ 白名单**不许枚举 scheme**。曾经写的是 `^(https?:|data:|/)`，漏了 `blob:` ——
     而本地导入的照片，点位缩略图恰好是 blob URL（photo-import.js 用
     `URL.createObjectURL` 造的两档小图）。它被当成相对路径拼上了目录前缀，
     于是落到一个不存在的路径 → 气泡里全是破图，而张数角标正常（EXIF 与聚合都没毛病），
     看上去像「缩略图坏了」而不是「URL 拼错了」。
     判据：`tools/verify-import-thumbs.js`（读 naturalWidth，不读前缀 —— 见该文件头注）。
     现在认 scheme 本身：任何 `xxx:` 开头的一律当绝对 URL 原样放行。 */
  /* 测试缝：`?oldasset` 制造与旧白名单**同样的失败** —— 把 `blob:` 当相对路径
     拼一个不存在的目录。自包含之后正确前缀是空串，没法再用 '../' 复现，
     所以缝改成显式构造。存在的唯一理由是反向验证：判据 `importThumbDecoded`
     必须在这条缝下变红，否则它抓不住这个 bug。正常访问取不到。
     声明放在这里（而不是跟其它缝一起）是因为 assetUrl 在上面，
     要避开 TDZ —— 缝标志晚于函数声明初始化，调用早于初始化就会抛。 */
  let legacyAssetUrl = false;

  function assetUrl(src) {
    const s = String(src == null ? '' : src);
    if (!s) return '';
    if (legacyAssetUrl) return /^blob:/.test(s) ? 'broken/' + s : s;
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s; // blob: / data: / http(s): / file:
    if (s.charAt(0) === '/') return s; // 绝对路径，别加前缀
    return s;
  }

  /* 同一个名字之下，两张照片相距超过这个跨度就不再并成一个点。
     单位是度（纬度方向），经度方向按 cos(lat) 折算；0.3° ≈ 33km，
     一次出行的尺度 —— 比它近的算「同一个地方」。
     测试缝 `?placesplit=<度>` 可覆盖它：`&placesplit=0` 等于「一律拆开」
     （用来证明 nearPhotosStayOnePlace 不是恒真的）。 */
  let PLACE_SPLIT_DEG = 0.3;

  /**
   * 点是否**严格落在**某个省内。境外 / 水面 / 近岸缝隙一律返回 null。
   *
   * ⚠️ 单独用它给地点起名是不够的：行政区面**只画陆地**，港内与海岛近岸的点会
   * 落在所有环之外（实测「中国香港·维港」离香港边界 0.73km 仍在环外）。所以它
   * 必须与 `nearestProvince()` 组成「严格 → 最近」两级来用 —— 见 `labelAt()`。
   *
   * 反过来说，**不能只用** `nearestProvince()`：它对公海上的点也会返回「最近的
   * 中国省」，拿它给境外照片起名会标出一个毫不相干的省份（东京会被标成吉林）。
   */
  function provinceContaining(wx, wy) {
    for (let i = 0; i < PROV.length; i++) {
      const f = PROV[i];
      if (wx < f.bbox[0] || wx > f.bbox[2] || wy < f.bbox[1] || wy > f.bbox[3]) continue;
      for (let j = 0; j < f.rings.length; j++) {
        const r = f.rings[j];
        if (wx < r.x0 || wx > r.x1 || wy < r.y0 || wy > r.y1) continue;
        if (pointInPts(r.pts, wx, wy)) return f;
      }
    }
    return null;
  }

  /**
   * 点是否**严格落在**某个地级市内。与 provinceContaining 同构、同口径：
   * 严格包含，不用「最近」兜底 —— 兜底会把海上的点判给最近的陆地市。
   *
   * 返回 null 有两种情况，调用方必须分得清：
   *   ① 该省的数据还没到（`CITY` 里没有这个 key）→ 应触发加载，本帧先用省名；
   *   ② 数据到了，但点不在任何市里（数据缝隙 / 省界与市界不重合）→ 直接退省名，
   *      不要重复触发加载，否则会陷入「加载完又加载」。
   */
  function cityContaining(provAdcode, wx, wy) {
    const feats = CITY.get(provAdcode);
    if (!feats) return null;
    for (let i = 0; i < feats.length; i++) {
      const f = feats[i];
      if (wx < f.bbox[0] || wx > f.bbox[2] || wy < f.bbox[1] || wy > f.bbox[3]) continue;
      for (let j = 0; j < f.rings.length; j++) {
        const r = f.rings[j];
        if (wx < r.x0 || wx > r.x1 || wy < r.y0 || wy > r.y1) continue;
        if (pointInPts(r.pts, wx, wy)) return f;
      }
    }
    return null;
  }

  /**
   * 点是否**严格落在**某个区县内。与 `cityContaining` 逐字同构 ——
   * 换的只是数据表。同构是刻意的：两级之间任何一处口径分叉，
   * 都会让「标签说这是天河区、填色却算进番禺」这种事出现，且看不出来。
   */
  function countyContaining(provAdcode, wx, wy) {
    const feats = COUNTY.get(provAdcode);
    if (!feats) return null;
    for (let i = 0; i < feats.length; i++) {
      const f = feats[i];
      if (wx < f.bbox[0] || wx > f.bbox[2] || wy < f.bbox[1] || wy > f.bbox[3]) continue;
      for (let j = 0; j < f.rings.length; j++) {
        const r = f.rings[j];
        if (wx < r.x0 || wx > r.x1 || wy < r.y0 || wy > r.y1) continue;
        if (pointInPts(r.pts, wx, wy)) return f;
      }
    }
    return null;
  }

  /**
   * 一个点该报什么地名 —— 被空间闸拆开的地点**唯一**的标签来源。
   *
   * 三级，且与 `computeFill()` 的归属**同口径**。这一点是硬要求：两处口径若不
   * 一致，同一个点就会出现「标签写着中国香港、填色却把它算进广东」的自相矛盾，
   * 而且从界面上看不出来。
   *   ① 严格落在某省 → 有市界数据就报市名，没有就报省名
   *   ② 不在任何省内 → 报**最近的中国省**（上限 35km，见 NEAR_CAP）
   *   ③ 连最近省都够不着 → 「境外」
   *
   * 为什么必须有第 ② 级：行政区面**只画陆地**，港内 / 海岛近岸 / 湖面上的点会
   * 落在所有环之外。演示数据里的「中国香港·维港」就卡在这个缝隙里 ——
   * 实测离香港边界 **0.73km**、离广东省 **24.44km**。不兜底它会被报成「境外」，
   * 而**把中国香港报成境外是合规问题，不是精度问题**。
   *
   * 已知取舍：35km 的上限意味着离中国国界 35km 以内的境外点会被算进某个省
   * （边境城镇）。这与 computeFill 的既有口径一致 —— 「境外城镇被算进邻省」
   * 只是近似不准，「中国领土被报成境外」是错。
   *
   * 反例对照（实测）：东京浅草寺离最近的中国省 1114km，远超上限 → 「境外」✓。
   *
   * **返回 `{ name, city, prov }`，两个名字必须分开。**
   * `name` 是最具体的一级（区县 → 市 → 省 → 「境外」），气泡上写的就是它；
   * `city` 是市一级的名字，只喂给 `clusterLabel()` 的第②级。合成一个字符串
   * 必有一处是错的：低倍率下几个区县并成一簇时要报「广州」，而单点要报
   * 「天河区」—— 同一个值喂两处做不到。
   */
  /* 区县数据的 `parentName` 在「没有地级市」的那几档是字面量「不统计」
     （4 个直辖市 + 海南/新疆的省直辖县级行政区划，实测 2842 个要素里
     parentName 无一是空，但会出现这个词）。它不是名字，必须挡掉，
     否则气泡上会写「不统计」。挡掉之后退回省名 —— 对直辖市而言
     省名**就是**市名（「北京市」→「北京」），没有损失。 */
  const PARENT_NONE = { 不统计: 1 };
  function labelAt(wx, wy) {
    const pv = PROV.length ? provinceContaining(wx, wy) || nearestProvince(wx, wy) : null;
    if (!pv) return { name: '境外', city: '', prov: '', district: '' };
    const pvShort = shortName(pv.name);
    /* 逐级下钻：**区县 → 市 → 省**。每一级都要求「有数据 + 严格落在里面」
       才采用，且每一级都会触发自己的懒加载；数据没到就用上一级，
       到货后重建会把它替换掉 —— 用户看到的是一次「广州 → 天河区」的升级，
       而不是一个空标签，也不是一个可能错的更下一级。
       这与 `computeFill()` 的「严格 → 最近」两级是同一套口径。 */
    const co = countyAt(pv.adcode, wx, wy);
    if (co) {
      const dn = shortName(co.name);
      const pn = co.parentName || '';
      return {
        name: dn,
        city: pn && !PARENT_NONE[pn] ? shortName(pn) : pvShort,
        prov: pv.name,
        /* 单独留一份「有没有下钻到区县」的证据：`name` 可能被重名序号改掉
           （「天河区 2」），而判据要看的是原始的那一级名字。 */
        district: dn,
      };
    }
    const ct = cityAt(pv.adcode, wx, wy);
    if (ct) {
      const cn2 = shortName(ct.name);
      return { name: cn2, city: cn2, prov: pv.name, district: '' };
    }
    return { name: pvShort, city: pvShort, prov: pv.name, district: '' };
  }

  /**
   * `labelAt()` 用的市 / 区县两级取要素。两件事被收进这里，是为了让
   * 「懒加载 + 严格包含」这一对动作在两级之间**只有一处实现** ——
   * 写两遍就会有其中一遍忘掉 `ensure*` 触发，症状是标签永远停在上一级
   * 而页面上完全看不出来（那一级本来也是个合法名字）。
   *
   * 返回 null 的三种含义，调用方一视同仁地退到上一级：
   *   ① 测试缝把它关了（`?nocity` / `?nocounty`）
   *   ② 该省没有这一级的数据（`CITY_OK` / `COUNTY_OK` 不含它）
   *   ③ 数据没到（本轮刚发起加载）或点不在任何单元里（数据缝隙）
   */
  function cityAt(provAdcode, wx, wy) {
    if (!cityLabels || !CITY_OK.has(provAdcode)) return null;
    if (!CITY.has(provAdcode)) {
      ensureCity(provAdcode);
      return null;
    }
    return cityContaining(provAdcode, wx, wy);
  }

  function countyAt(provAdcode, wx, wy) {
    if (!countyLabels || !COUNTY_OK.has(provAdcode)) return null;
    if (!COUNTY.has(provAdcode)) {
      ensureCounty(provAdcode);
      return null;
    }
    return countyContaining(provAdcode, wx, wy);
  }

  /**
   * 这个相册名是不是「自动生成的」—— 即与地理无关、不能当地名用？
   *
   * 判据是**反向的**：不去判断「它像不像地名」（那需要一张地名表，且永远不全），
   * 只判断「它像不像机器 / 系统给的默认名」。默认保留用户的命名 ——
   * 「都江堰」「香格里拉」「深圳湾公园」都不是市名，但都是好标签，
   * 误杀它们的代价比漏掉一个怪名字大得多。
   *
   * 命中即判为自动名，此时标签改用 labelAt() 算出的地理名。命中的几类：
   *   未命名 / 新建文件夹 / 我的照片    系统默认名
   *   旅行 / 日常 / 商务 / 出差        相册语义，但说明不了「在哪儿」
   *   IMG_0001 / DSC_0001 / 截屏      相机与截图文件名
   *   2024 / 2024-05-01 / 20240501    纯日期与年份，最典型的一种
   *   abc / tmp / test                极短纯 ASCII，命名不出自人手
   *
   * 表里是**整串**匹配（^...$），所以「梅里雪山」不会因为含「雪山」被误伤。
   *
   * ⚠️ 这是启发式，不是判据，一定有漏网。要收紧或放宽，改这一个函数即可。
   */
  const AUTO_ALBUM_NAME =
    /^(未命名|无名|无标题|未标题|新建文件夹|新建相册|新建文文件夹|我的照片|手机照片|相机胶卷|相册|图片|照片|图像|视频|影片|截图|截屏|录屏|下载|文档|桌面|素材|备份|待整理|待分类|杂项|其他|临时|旅行|旅游|出行|日常|生活|随手拍|随拍|记录|活动|聚会|美食|风景|人像|家庭|朋友|工作|摄影|商务|出差|会议|团建|婚礼|毕业|毕业季|运动|健身|宠物|宝宝|孩子|夜景|城市|乡村|海边|雪山|花草|猫|狗)$/i;
  const AUTO_FILE_NAME =
    /^(img|dsc|dscn|dji|gopr|mvimg|screenshot|photo|image|pic|vid|mov|clip)[-_ ]?\d+$/i;
  function looksAutoName(s) {
    const t = String(s == null ? '' : s).trim();
    if (!t) return true;
    if (AUTO_ALBUM_NAME.test(t)) return true;
    if (AUTO_FILE_NAME.test(t)) return true;
    if (/^\d+$/.test(t)) return true; // 纯数字
    if (/^(19|20)\d\d([-_.]\d{1,2}){0,2}$/.test(t)) return true; // 年份 / 年月日
    if (/^[\x20-\x7e]{1,4}$/.test(t)) return true; // 极短纯 ASCII
    return false;
  }

  /**
   * 重建地点集合。可传入任意相册 —— 演示数据或用户本地照片走同一条路，
   * 区别只在 album.photos 里的 wgs / place 是谁给的。
   *
   * **一个地点 = 一个名字 + 一片邻近的地方**，不是「名字相同的一群照片」。
   *
   * 为什么必须加上后面那半句：`place` 来自文件夹名或文件名，它是**用户给相册
   * 起的名字**，未必是地名。`D:/icloud/2018/IMG_x.jpg` 的 place 是「2018」——
   * 一个年份，不含任何地理信息。只按名字分组、再对坐标求算术平均的后果是：
   * 黑龙江的 92 张与广东的 53 张被平均到 (37.5, 121.8) —— **黄海海面上**，
   * 离得最近的省是山东。地图上于是显示「山东省 × 145 张」。
   * 这比「不合并」更糟：它看起来像一个真实地点，却没有任何照片在那里拍过，
   * 而「照片落在哪儿」正是这个产品的核心能力。
   *
   * 所以同名之下还要过一道空间闸：闸内并成一个点（原点不变），
   * 闸外各自成点。同名被拆开时标签补上所在省名（「2018 · 黑龙江」），
   * 否则两个点重名，用户分不清哪个是哪个。
   *
   * @param album { photos: [{ place, wgs, src, date }] }
   * @param label 顶栏副标题（'天地图底图' / '本地照片'）
   */
  function buildPhotos(album, label) {
    album = album || { photos: [] };
    /* 市界是异步到货的，到货后要按**同一个相册**重建（见 ensureCity）。
       只存引用、不拷贝 —— 相册对象在生命周期里不被就地修改。 */
    lastAlbum = album;
    lastLabel = label;
    const photos = album.photos || [];
    PHOTOS.length = 0; // 就地清空：PHOTOS 被闭包到处引用，不能换引用
    brandMeta.textContent = (label || '天地图底图') + ' · ' + photos.length + ' 张';

    /* 第一遍：按名字收拢；名字之下再按邻近分堆。
       分堆用「离堆的**锚点**最近、且在闸内就并入」的贪心 —— O(照片数 × 堆数)，
       堆数是个位数量级，比两两比较便宜得多。
       锚点 = 建堆那一刻第一张照片的坐标，**之后永不移动**。
       旧版量「离当前堆心」—— 堆心是成员累积平均，每并进一张就挪一点；
       一列沿线的照片便会链式串成一堆横跨上百公里（每张都离"当时的堆心"够近，
       离真正的堆却越来越远），实测「哈尔滨」文件夹的 19 张被平均到五常一带，
       气泡却还写着哈尔滨 —— 用户报的「定位飘了」。锚点不动，链式在结构上
       不可能发生：离首张 100km 的照片永远进不了这个堆。 */
    const byPlace = new Map();
    for (const raw of photos) {
      if (!raw.wgs) continue;
      /* 建一份副本再改 src —— 不去回头改只读数据源里的对象 */
      const p = Object.assign({}, raw, { src: assetUrl(raw.src) });
      const key = p.place || '未命名';
      let subs = byPlace.get(key);
      if (!subs) {
        subs = [];
        byPlace.set(key, subs);
      }
      const lng = p.wgs[0];
      const lat = p.wgs[1];
      let best = null;
      let bd = Infinity;
      for (const s of subs) {
        /* 经度差按 cos(纬度) 折算 —— 否则高纬度处 1° 经度会被当成与 1° 纬度
           一样远，这个闸在北方会松得离谱。 */
        const dLng = (lng - s.aLng) * Math.cos(s.aLat * D2R);
        const d = Math.hypot(lat - s.aLat, dLng);
        if (d < bd) {
          bd = d;
          best = s;
        }
      }
      if (best && bd <= PLACE_SPLIT_DEG) {
        best.lng += lng;
        best.lat += lat;
        best.n += 1;
        best.list.push(p);
      } else {
        /* aLng/aLat 是闸门锚点（首张，不动）；lng/lat 是成员坐标的**和**，
           第二遍除以 n 得堆心 —— 堆心仍是真实照片的平均位置（展示用）。 */
        subs.push({ aLng: lng, aLat: lat, lng: lng, lat: lat, n: 1, list: [p] });
      }
    }

    /* 第二遍：每堆变成一个地点，并量出堆内散布（判据要用）。 */
    const usedLabel = new Map(); // 名字 → 已用过的标签，拆开后避免两个点重名
    for (const [place, subs] of byPlace) {
      const split = subs.length > 1;
      for (const s of subs) {
        s.lng /= s.n;
        s.lat /= s.n;
        /* 墨卡托投影前移到建点时算好，不再每帧调一次 M.x/M.y */
        const wx = M.x(s.lng);
        const wy = M.y(s.lat);

        /* 堆内最深的一张离堆心多远。这是「有没有把远处的东西平均进来」
           唯一可读的证据，探针拿它比对闸值。 */
        let spread = 0;
        for (const q of s.list) {
          const dLng = (q.wgs[0] - s.lng) * Math.cos(s.lat * D2R);
          const d = Math.hypot(q.wgs[1] - s.lat, dLng);
          if (d > spread) spread = d;
        }

        /* 地名的兜底来源是**地理位置**，不是 place。

           `place` 是相册 / 文件夹名，用户那边的取值可能是「新建文件夹」
           「2024」「IMG_0001」这类与地理无关的字符串。拿它当地名，图上就会
           浮出一堆无意义的字，而且两个相隔千里的点会顶着同一个垃圾名。

           但不能反过来「一律弃用 place」—— 它经常是**真地名**：
           「都江堰」「香格里拉」都不是市名（分别属成都、迪庆），一律换成 geo
           等于把好名字换成生僻的行政区名，信息反而更少。演示相册里就有这两个。

           所以判据是**反向的**：默认保留用户的命名，只挡掉「一眼是自动生成」
           的那些（looksAutoName）。两头都不伤：
             「新建文件夹」「2024」「IMG_0001」→ 换成 geo
             「都江堰」「香格里拉」「北京·故宫」→ 原样保留
           而 geo 与 computeFill() 同口径 —— 填色说这个点属于哪儿，兜底标签就报哪儿。

           境外是例外：本地没有境外的 admin-1 数据，geo 恒为「境外」，
           此刻无论如何都退回 place —— 把「东京·浅草」换成「境外」是把信息换成噪声。

           ⚠️ 这是启发式，不是判据。漏网的怪名字会照原样显示；
           要收紧只改 `looksAutoName` 一处。 */
        /* ⚠️ 只在**真的要用** geo 时才去算它。labelAt 会触发市界 / 区县界的
           懒加载（见 ensureCity / ensureCounty），而它们是按省拉文件的 ——
           每个点都算一遍，一个散布全国的相册就会平白多拉十几个省的数据。
           演示相册 86 个点、名字全是地名、没有任何拆分，本来一个省都不需要。
           需要 geo 的只有两种情形：① 被空间闸拆开的点；② 名字是自动生成的。
           区县界比市界重一个量级（单省 22~636 KB），这条约束因此更要紧。 */
        const auto = looksAutoName(place);
        const geo = split || auto ? labelAt(wx, wy) : null;
        const hasGeo = !!geo && geo.name !== '' && geo.name !== '境外';
        const keepPlace = !!place && !auto;
        /* 未拆开时尊重用户的命名 —— 「都江堰」「香格里拉」「北京·故宫」都是好标签，
           换成行政区名反而更陌生。只有「一眼是自动生成」的名字（新建文件夹 /
           2024 / IMG_0001）不算命名，这时改用 geo。 */
        /* ⚠️ `name` 与 `city` 从此**不是同一个值**：`name` 取最具体的一级
           （可能是区县名「天河区」），`city` 恒取市名（「广州」）。
           混用会把区县名当成城市名喂进 `clusterLabel()` 的第②级 ——
           低倍率下几个区县并成一簇时，气泡上就会写「天河区」，
           而那时该报的是「广州」。两个字段的分工见 `labelAt()` 的注释。 */
        let name = keepPlace ? place : hasGeo ? geo.name : place || '';
        let city = keepPlace ? String(place).split('·')[0] : hasGeo ? geo.city : '';

        if (split) {
          /* 拆开之后规矩就不同了：同一个相册名摊在几个点上，它们只会互相分不清
             （那正是「广东」「广东 2」「广东 3」问题的另一面）。geo 是这些点
             唯一有信息量的标签，所以拆开时名字与城市一律以 geo 为准。
             重名才加序号 —— 有了区县级 geo 之后这一条应该**很少**被走到：
             同一个市内被拆开的点会分别报出「天河区」「番禺区」，
             而不是「广州 1」「广州 2」。序号仍然留着兜底（区县数据缺失、
             或两个点落在同一个区县里时它还是唯一的区分手段），
             判据 `splitLabelKeepsNumbering` 锁住它没被删掉。 */
          if (hasGeo) {
            name = geo.name;
            city = geo.city;
          }
          let seen = usedLabel.get(place);
          if (!seen) {
            seen = new Set();
            usedLabel.set(place, seen);
          }
          let lab = name;
          let n = 2;
          while (seen.has(lab)) lab = name + ' ' + n++;
          seen.add(lab);
          name = lab;
        }

        PHOTOS.push({
          name: name,
          city: city,
          /* 区县一级的名字（没下钻到区县时为空串）。`name` 可能被重名序号改掉，
             所以判据要用这个干净字段来判「到底下钻了没有」。 */
          district: hasGeo ? geo.district || '' : '',
          list: s.list,
          lng: s.lng,
          lat: s.lat,
          wx: wx,
          wy: wy,
          /* 诊断字段：堆内散布（度）、它从哪个名字里拆出来的，
             以及**它原本的相册名**。splitFrom 只在被拆开时非空，
             所以「名字有没有被 geo 替换掉」这件事必须另有一个恒有值的字段
             才测得出来（见 __tdt.places）。 */
          spread: spread,
          splitFrom: split ? place : '',
          place: place,
        });
      }
    }
  }

  const CLUSTER_PX = 108;

  /* 守恒记账（clusterize 每帧写）。见 clusterize 尾部与 __tdt.conservation。 */
  const clusterStat = { culled: 0, clustered: 0 };

  /**
   * 聚合单位键：**粒度与填色、与 hover 命中完全一致**（三者共用同一个 `t`）。
   *
   *   t < 0.5   填色还是「一个国家一个色」→ 单位 = 'CN'，省内照常合并，
   *             该报「中国」就报「中国」（世界视图要的正是这个）
   *   t ≥ 0.5   填色已经逐省分色 → 单位 = 省 adcode，
   *             于是「同一簇跨两个省」在结构上不可能
   *
   * 为什么必须有这一条：在这之前单位只有区域键（中国 = 'CN'），
   * 于是全国视图下 上海+浙江、四川+重庆、四川+云南、广西+湖南 各自并成一簇。
   * 标签分级走到第④级「跨省 → 报区域名」，于是**四川省显示成「中国」**、
   * 陕西省显示成「中国」、北京那几张也显示成「中国」——
   * 明明同一屏上已经有拉萨 / 新疆 / 呼伦贝尔这种省级标签，却混着五个「中国」。
   * 修法不是「挑个更聪明的名字」，而是**根本不该跨省合并**：
   * 填色已经按省分色了，聚合却还按国并，两者对不上才是病根。
   *
   * 港澳是特例：两个 MUST_SHOW 地区**共用一个单位键**。全国尺度下它们相距
   * 仅约 60km，k=1172 时不到 15px，分开必然重叠、没法两边都放准；
   * 合并后靠 `clusterLabel` 的双名规则把两个名字都写出来（合规要求）。
   *
   * 境外没有 admin-1 数据：t < 0.5 时单位是国家（世界视图一国一簇）；
   * t ≥ 0.5 起**按城市分单位** —— 与中国「过界即按省分」同帧同规则。
   * 旧版境外单位恒为国家，美国簇要等 CLUSTER_PX 距离撑破才散开，
   * 过渡期比中国长一截，观感就是「放大后 pin 突然不见了」（气泡原地破裂，
   * 成员飞向远处的真实位置）。改成城市单位后，破簇时机与中国逐帧对齐，
   * 同城多张仍聚成一簇（城市名相同才同单位；无城市名的照片退回国家单位）。
   *
   * （`chinaT` 定义在 6.5 节，函数声明会提升，这里调用是安全的。）
   */
  function unitOf(p, t) {
    if (p.regionKey !== 'CN') {
      if (t < 0.5) return p.regionKey || '';
      return (p.regionKey || '') + '-' + (p.mst ? 'MST-' : '') + (p.city || '');
    }
    if (t < 0.5) return 'CN';
    if (p.mst) return 'CN-MST';
    return 'CN-' + (p.provId || 0);
  }

  /* 把 src 里还没出现过的元素追加到 dst（保持插入顺序）。
     合并簇时用它做集合并集 —— 与「一开始就合成一个簇」完全等价，
     因为加权平均与集合并都满足结合律，先分组再合并不会改变结果。
     语义上刻意**保留空串**：与 clusterize 里那条增量 push 的写法一致
     （`indexOf(p.city || '') < 0`），免得两处对「空值算不算成员」的口径打架。 */
  function appendUnique(dst, src) {
    if (!dst || !src) return;
    for (let i = 0; i < src.length; i++) {
      if (dst.indexOf(src[i]) < 0) dst.push(src[i]);
    }
  }

  /* 屏幕网格聚合：以 108px 为格，点只跟 3×3 邻格里的簇比距离。
     不是全表扫描，也不是「同一格就合并」—— 后者会让格线两侧的点
     明明挨着却分成两个，或者同格里相距 100px 的两个点被硬并成一个。

     **合并要过两道键。**
     ① 区域键（regionKey）：跨国不合并。这是后加的，起因是世界视图下一个
        真实的错 —— k≈300 时北京与东京只差 136px，落进同一个 3×3 邻格，
        中国的 63 张被并进了日本的簇，簇名取「东京」，看起来就是
        「中国的照片变成了日本」。区域键不同就不考虑合并，跨国误并从结构上
        不可能发生（键在 computeFill() 里写好：中国 = 'CN'，境外 = ISO）。
     ② 单位键（unitOf）：跨省不合并，但**只在填色已经逐省分色时**才收紧。
        理由见 unitOf 上面那段。 */
  function clusterize(k, tx, ty) {
    const buckets = new Map();
    const out = [];
    /* 张数多的先落位：大簇的位置更「有代表性」，小簇让开它更合理 */
    const order = PHOTOS.slice().sort((a, b) => b.list.length - a.list.length);
    /* 粒度只取决于 k，循环外算一次 */
    const t = chinaT(k);
    /* 守恒记账：被视口剔除的照片数。与「进簇的照片数」相加必须恒等于
       相册总数 —— 「数量精准」这条产品红线的第一类读数（__tdt.conservation）。 */
    let culledN = 0;

    for (let i = 0; i < order.length; i++) {
      const p = order[i];
      const u = unitOf(p, t);
      const sx = p.wx * k + tx;
      const sy = p.wy * k + ty;
      /* 视口外剔除。多留 200px 余量，免得边缘点位的标注碰撞判定把邻居卷进来 */
      if (sx < -200 || sx > size.w + 200 || sy < -200 || sy > size.h + 200) {
        culledN += p.list.length;
        continue;
      }

      const gx = Math.floor(sx / CLUSTER_PX);
      const gy = Math.floor(sy / CLUSTER_PX);

      let best = null;
      let bestD = CLUSTER_PX;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const arr = buckets.get(gx + dx + ',' + (gy + dy));
          if (!arr) continue;
          for (let j = 0; j < arr.length; j++) {
            const c = arr[j];
            /* 两道键都相同才比距离：跨国（region）与跨省（unit）都不许合并 */
            if (c.region !== p.regionKey || c.unit !== u) continue;
            /* 中国台湾不参与任何**距离制**合并（两岸之间、与港澳之间都不合）。
               注意这只挡本循环 —— 国家级粒度（t < 0.5）下方的「整国收成一簇」
               块会把台湾并进中国单簇（2026-09-13 用户裁决），那是粒度语义，
               不是距离合并。 */
            if (p.solo || c.solo) continue;
            const d = Math.abs(c.sx - sx) + Math.abs(c.sy - sy);
            if (d < bestD) {
              bestD = d;
              best = c;
            }
          }
        }
      }

      if (best) {
        /* 锚点固定：簇的位置钉在**张数最多的成员堆**的堆心 —— 那是一个
           真实有照片的地方。旧版取加权质心：成员集合随缩放级别变，质心
           跟着挪，pin 在两级缩放之间指在两地之间 —— 「哈尔滨」簇被东北
           其他堆稀释后落到五常一带，气泡却写着哈尔滨（用户报的定位飘移）。
           遍历按张数降序，创建簇的堆必然 ≥ 被并的堆，所以这里实际上恒取
           「创建堆」的锚点；比较只是把这条规矩写成可读、可证伪的形式。 */
        if (p.list.length > best.anchorN) {
          best.anchorN = p.list.length;
          best.wx = p.wx;
          best.wy = p.wy;
        }
        for (let j = 0; j < p.list.length; j++) best.list.push(p.list[j]);
        best.names.push(p.name);
        /* 记下「吸收关系」：p 这个簇被 best 吞掉了。
           过渡动画要用它 —— 被吞掉的那个气泡不原地消失，而是滑向 best 再淡出，
           否则「聚合」会在图上留下一块块空洞。 */
        if (!best.absorbed) best.absorbed = [];
        best.absorbed.push(p.name);
        /* 簇内出现过的全部区域键。合并本来就要求同区（上面那条 continue），
           所以正常情况下长度恒为 1 —— 记成集合是为了让它**可被证伪**：
           探针直接查这个集合，而不是从 c.region 反推（反推是恒真的）。 */
        if (best.regionSet.indexOf(p.regionKey || '') < 0) best.regionSet.push(p.regionKey || '');
        /* 标签分级用的三个集合，同样增量维护 —— 不做「每帧把簇内成员重扫一遍」，
           那在折叠簇上就是每帧几十×几十次字符串比较。 */
        if (best.nameSet.indexOf(p.name) < 0) best.nameSet.push(p.name);
        /* 港澳单列要用的 adcode 集合 */
        if (p.mst && best.mstSet.indexOf(p.mst) < 0) best.mstSet.push(p.mst);
        if (best.citySet.indexOf(p.city || '') < 0) best.citySet.push(p.city || '');
        if (best.provSet.indexOf(p.provName || '') < 0) best.provSet.push(p.provName || '');
        best.sx = best.wx * k + tx;
        best.sy = best.wy * k + ty;
      } else {
        const c = {
          wx: p.wx,
          wy: p.wy,
          sx: sx,
          sy: sy,
          /* 锚点权重：本簇位置所钉住的那个堆的张数。合并时只有更大的堆
             才能接管位置（见上面那段）—— 保证 pin 永远落在真实堆心上。 */
          anchorN: p.list.length,
          list: p.list.slice(),
          names: [p.name],
          priority: p.list.length,
          /* 稳定身份：创建这个簇的那张照片的地名。
             PHOTOS 按 place 分组、place 唯一，所以它在一帧内唯一。
             合并时保留「大簇」的 key（遍历按张数降序，best 必然不晚于 p），
             于是「谁吞并了谁」有确定的方向 —— 动画的起点选择依赖这一点。 */
          key: p.name,
          /* 区域键与区域中文名都记在簇上：标签规则要用它 */
          region: p.regionKey || '',
          regionName: p.regionName || '',
          regionSet: [p.regionKey || ''],
          /* 聚合单位键。同簇内恒相同（上面那条 continue），
             记下来是为了让「跨省没跨省」**可被证伪** —— 探针直接查这个字段。 */
          unit: u,
          /* 标签分级的三个集合（见 clusterLabel） */
          nameSet: [p.name],
          citySet: [p.city || ''],
          provSet: [p.provName || ''],
          /* 台湾单列 / 港澳单列（合规） */
          solo: !!p.solo,
          mstSet: p.mst ? [p.mst] : [],
        };
        out.push(c);
        const key = gx + ',' + gy;
        let arr = buckets.get(key);
        if (!arr) {
          arr = [];
          buckets.set(key, arr);
        }
        arr.push(c);
      }
    }

    /* --------------------------------------------------------------------
       t < 0.5（国家级粒度）：**中国整体收成一个簇**。
    
       为什么需要这一步 —— 它是「中国」与「新疆」并列那个问题的真正根因。
    
       `unitOf()` 在 t < 0.5 时把单位设成 'CN'（跨省可并），但合并还受**第二道
       距离闸** `CLUSTER_PX = 108` 的约束，而 k=201 时中国横跨约 218px、
       k=160 时约 270px —— 全都超过 108。于是新疆（在国土最西端）离主簇太远，
       并不过去，自成一簇；那个独立簇恰好只含一个省，标签分级第③级
       就给出了一个**裸省名**。
    
       实测（改之前）：k=160~420 稳定出现「中国(55~58)」+「新疆(3)」；
       只压标签不合并的话，k=560 会变成**七个「中国」气泡**（因为同一时刻
       填色是一整块单色、标注全报国名，七个一模一样的名字反而更费解）。
    
       所以修法必须落在聚合层：**国家级粒度下，一个国家就是一个簇**。
       这与填色（一国一色）、hover（整块命中）、标签（国名）四者粒度对齐 ——
       跟上一轮「聚合按国、填色按省，两者对不上」是同一类病，方向相反。
    
       **只对中国做。** 境外不参与：`t` 是中国「国 / 省」两级表示的开关，
       境外没有第二级（本线没有 admin-1 数据），拿中国的填色阈值去决定
       纽约与旧金山要不要合并是没有道理的。境外继续由距离闸决定，
       所以在世界视图下仍能看到「巴黎」「纽约」这类城市名。

       **台湾（solo）在这一级并入**（2026-09-13 用户裁决）。原版把 solo 排除在
       本块之外，结果世界视图下「中国(61)」旁边浮着「中国台湾·日月潭(1)」、
       「中国台湾·台北(1)」—— 省级前缀救不了粒度歧义：国名与地区名以同等
       视觉层级并列，读起来仍像两个平级实体，这正是要避免的合规观感。
       国家级粒度下「一个国家一个簇」必须**含台湾**：气泡只写「中国」，
       台湾的照片计入总数。省级粒度（t ≥ 0.5）的 solo 单列不受影响 ——
       那一级填色逐省分色、标注报省名，台湾单列才有信息量、也不产生并列歧义。

       港澳（mst）本来就不被本块排除：它们并入巨簇后走第 ⓪ 条的双名判据，
       判据里 `provSet.length === mstSet.length` 在巨簇上恒不成立，
       自然回落国名「中国」，行为不变。
       -------------------------------------------------------------------- */
    if (t < 0.5) {
      let big = null;
      for (let i = 0; i < out.length; i++) {
        const c = out[i];
        if (c.region !== 'CN') continue;
        if (!big) {
          big = c;
          continue;
        }
        /* 加权合并：权重是照片张数，于是位置自然偏向照片最密的那一片，
           不会因为新疆那 3 张就把整个气泡拽到地图中央。 */
        const n0 = big.list.length;
        const n1 = c.list.length;
        const tot = n0 + n1;
        big.wx = (big.wx * n0 + c.wx * n1) / tot;
        big.wy = (big.wy * n0 + c.wy * n1) / tot;
        for (let j = 0; j < c.list.length; j++) big.list.push(c.list[j]);
        appendUnique(big.names, c.names);
        /* 国家级合并是「整簇被吞」而不是「地点逐个并入」，
           所以吸收关系记的是 c.key（下面动画层按 key 找起点）。 */
        if (!big.absorbed) big.absorbed = [];
        big.absorbed.push(c.key);
        appendUnique(big.regionSet, c.regionSet);
        appendUnique(big.nameSet, c.nameSet);
        appendUnique(big.citySet, c.citySet);
        appendUnique(big.provSet, c.provSet);
        appendUnique(big.mstSet, c.mstSet);
        c.mergedAway = true;
      }
      if (big) {
        /* solo 身份按「整簇是否纯台湾」重算：正常路径 big 是大陆簇（solo
           本来就是 false）；退化路径 —— 视口里只有台湾 —— big 是台湾 solo 簇，
           它吸收另一个台湾 solo 簇后仍纯台湾，保持 solo；一旦混进大陆成员，
           就不再是「台湾单列」的形态，必须清掉，否则「solo 簇里只许有台湾省」
           这条探针判据会被一个脏 solo 簇打红。 */
        big.solo = big.provSet.length === 1 && big.provSet[0] === '台湾省';
        big.sx = big.wx * k + tx;
        big.sy = big.wy * k + ty;
        /* 就地重建：留下 big 与所有未被并入的簇 */
        const keep = out.filter(function (c) {
          return !c.mergedAway;
        });
        out.length = 0;
        for (let i = 0; i < keep.length; i++) out.push(keep[i]);
      }
    }

    /* 位置跟标签走：**气泡上写的是国名时，位置取该国的标注锚点**。
       加权质心不保证落在国境内（黑龙江 + 广东 → 黄海海面），
       而「写着中国却指着两国之间那片水」正是用户报的那个歧义。
       只认「标签 == 区域名」这一种情形：写「巴黎·卢浮宫」的簇仍用它自己的
       质心（那个位置本身就是信息），写「中国香港 / 中国澳门」的也不动 ——
       港澳必须落在自己的位置上，这是合规要求，不能被锚点挪走。 */
    if (useAnchor) {
      for (let i = 0; i < out.length; i++) {
        const c = out[i];
        if (!c.regionName || c.regionName !== clusterLabel(c, t)) continue;
        const a = regionAnchor(c.region);
        if (!a) continue;
        c.wx = a.wx;
        c.wy = a.wy;
        c.anchored = true;
        c.sx = c.wx * k + tx;
        c.sy = c.wy * k + ty;
      }
    }

    /* 守恒记账落盘：本帧进簇的张数与被剔除的张数。读数口
       `__tdt.conservation()` 拿它对相册总数做恒等式（clustered + culled == total），
       探针在**每一个相机**下验它 —— 「放大一级照片少了几十张」这类事故
       从此有一条全缩放域扫描的报警线。 */
    clusterStat.culled = culledN;
    clusterStat.clustered = out.reduce(function (a, c) { return a + c.list.length; }, 0);
    return out;
  }

  /* ---- 省级名称的缩写。与主线 photo-map.js 的 SHORT_FIX 同口径，
     不能自创写法：「中国香港 / 中国澳门 / 中国台湾」是合规表述。 ---- */
  const SHORT_FIX = {
    内蒙古自治区: '内蒙古',
    广西壮族自治区: '广西',
    西藏自治区: '西藏',
    宁夏回族自治区: '宁夏',
    新疆维吾尔自治区: '新疆',
    香港特别行政区: '中国香港',
    澳门特别行政区: '中国澳门',
    台湾省: '中国台湾',
  };

  function shortName(name) {
    if (!name) return '';
    if (SHORT_FIX[name]) return SHORT_FIX[name];
    const s = name.replace(/(维吾尔自治区|壮族自治区|回族自治区|自治区|特别行政区|省|市)$/, '');
    return s || name;
  }

  /* 必须**单独标注**的两个地区（中国香港 / 中国澳门）。它们相距约 60km，
     全国尺度下必然重叠、无法两边都放准，所以允许合并成一格 ——
     但标签必须把两个名字都写出来，否则其中一个会被分级逻辑精简掉，
     等于从图上抹掉。这是合规问题，不是审美问题。（与主线同口径） */
  const MUST_SHOW_ADCODES = { 810000: 1, 820000: 1 };

  /* 中国台湾更严：**不参与任何合并**（含港澳）。合规红线，
     不能被布局算法拿去做交易。 */
  const SOLO_ADCODES = { 710000: 1 };

  function provNameOf(adcode) {
    for (let i = 0; i < PROV.length; i++) {
      if (PROV[i].adcode === adcode) return PROV[i].name;
    }
    return '';
  }

  /**
   * 簇的标签：**成员越同质，报得越具体**。四级，从细到粗：
   *
   *   ① 去重后只剩一个地点名  → 报完整地名（「北京·故宫」，badge 报张数）
   *   ② 城市段全相同          → 报城市名（「北京」）
   *   ③ 同属一个省（仅中国）  → 报省名（「浙江省」）
   *   ④ 其余                  → 报区域名（「中国」/「日本」/「大韩民国」）
   *
   * 为什么**不按缩放级别分档**：分档要挑阈值，而阈值挑错就会出
   * 「一簇明明全是北京、却报中国」这种错（这正是它上一版的毛病：
   * 规则只有一条「成员数 > 1 就报区域名」，而中国的区域名恒为「中国」）。
   * 本分级不挑阈值 —— 簇内成员是不是同一个城市，由数据自己回答，
   * 而缩放的放大天然会让簇内成员越来越同质，于是标签自然逐级变细。
   *
   * 顺带解决了一个原来的坑：世界视图下中国那一簇横跨 20+ 个城市，
   * 城市段各异、省份各异 → 落回第 ④ 级报「中国」，正是该有的样子。
   *
   * 但要看清第 ④ 级的**触发条件**：它只在「同一簇里真的跨了省」时出现。
   * t ≥ 0.5（填色逐省分色）时，聚合单位已经下沉到省（见 unitOf），
   * 中国境内的簇不可能跨省 —— 所以那会儿第 ④ 级对中国不可达。
   * 曾经可达，代价就是「四川省显示成中国」。
   *
   * ---------------------------------------------------------------------------
   * **第 ③ 级（报省名）只在 `t ≥ 0.5` 时可用** —— 这是合规约束，不是审美。
   *
   * 起因是一个真实的观感：世界视图（k=201，t=0）里中国那一片会看到
   * 「中国(55)」旁边单独浮着一个「新疆(3)」。成因不是标签写错，而是
   * **几何**：t < 0.5 时聚合单位是 'CN'（跨省可并），但新疆离主簇超过
   * `CLUSTER_PX = 108`，并不过去，于是自成一簇；而独立簇恰好只含一个省，
   * 第 ③ 级就给了个**裸省名**。
   *
   * 为什么这样是问题：那一刻填色正把中国画成**一整块单色**、标注正把中国
   * 报成**一个国家**，却有一个**省级行政区名**以同等视觉层级并列在旁。
   * 单看一个省名，公开地图上到处都是，谈不上违规；但在「国家级粒度」这一屏上，
   * 它与国名并列，读起来就是两个平级实体 —— 这正是本项目一贯要避免的歧义
   * （港澳台强制加「中国」前缀、台湾强制单列，都是为消灭同一类歧义；
   * 而「中国台湾」加了前缀、「新疆」没加，本身就是一个不一致）。
   *
   * 修法不是隐藏那一簇 —— 那会让 3 张照片从图上消失，既丢信息，
   * 也违背「照片按真实地理位置落点」。**保留位置，把标签降到与填色、
   * 与聚合单位同级的粒度**：t < 0.5 时报「中国」，t ≥ 0.5 时自动细化成「新疆」。
   *
   * 这也正是标准地图的做法：省名在省级视野出现，国家视野只报国名。
   *
   * 判据：`noBareProvAtCountry`（t<0.5 时不得出现裸省名）
   * + 反向锁 `provLabelAtProvView`（t≥0.5 时必须出现省名，防止压制过头）。
   */
  function clusterLabel(c, t) {
    if (!c) return '';
    /* ⓪ 港澳单列，**但只在「这一簇基本就是港澳」时**才用。
       判据：簇内出现过的省份，恰好就是那两个必须单列的地区。

       ⚠️ 这个限制是必须的，不是保守。世界视图下中国会合成一个跨 27 个城市的
       巨簇，里面**恰好包含香港和澳门**。若不加限制，那 55 张照片的标签会变成
       「中国香港 / 中国澳门」—— 荒谬，而且直接违背「最小的时候按国界划分」。
       港澳被并进别的省份时走常规分级（落到「中国」）：合规上没有任何损失，
       它们本来就都是中国，报「中国」比报「中国香港 / 中国澳门」更不含糊。

       顺序按 adcode 升序，于是香港在澳门之前（与主线同序）。 */
    if (
      c.mstSet &&
      c.mstSet.length > 1 &&
      c.provSet &&
      c.provSet.length === c.mstSet.length
    ) {
      return c.mstSet
        .slice()
        .sort()
        .map(provNameOf)
        .map(shortName)
        .filter(Boolean)
        .join(' / ');
    }
    if (c.nameSet && c.nameSet.length === 1) return c.nameSet[0];
    if (c.citySet && c.citySet.length === 1 && c.citySet[0]) return c.citySet[0];
    /* 省名走 shortName：「新疆维吾尔自治区」在图上是一行很长的字，缩写后是「新疆」；
       港澳台走到这里会得到「中国香港」这类合规写法。

       ⚠️ **只有 t ≥ 0.5 才能报省名。** 理由见函数头那段 ——
       t < 0.5 时填色还是「一国一色」、标注还是国名，此刻浮一个省级裸名
       与国名并列，读起来像两个平级实体。降到第 ④ 级报国名，与填色同粒度。

       这条只可能命中中国：境外的 provName 恒为空（本线没有 admin-1 数据），
       第 ③ 级本来就不可达，所以不需要额外判 region。 */
    if (t >= 0.5 && c.provSet && c.provSet.length === 1 && c.provSet[0]) {
      return shortName(c.provSet[0]);
    }
    return c.regionName || (c.nameSet && c.nameSet[0]) || '';
  }

  /* ---- 点位元素池：一帧里需要几个就用几个，多余的藏起来复用 ---- */

  const pool = [];

  /* 池元素的稳定编号。只给读数口 `__tdt.pins()` 用：探针要能判断
     「两个活簇有没有共用同一个元素」—— 那是「中国的照片全不见了」的根因，
     而从截图或簇表都看不出来。 */
  let recSeq = 0;

  function makePinEl() {
    const wrap = document.createElement('div');
    wrap.className = 'mk';
    const inner = document.createElement('div');
    inner.className = 'pin';
    const thumb = document.createElement('div');
    thumb.className = 'pin__thumb';
    const img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    const badge = document.createElement('span');
    badge.className = 'pin__count';
    thumb.appendChild(img);
    thumb.appendChild(badge);
    const name = document.createElement('div');
    name.className = 'pin__name';
    inner.appendChild(thumb);
    inner.appendChild(name);
    wrap.appendChild(inner);

    /* px/py/ps/pa 是「上一帧写进 style 的值」，用来跳过无变化的 DOM 写入。
       初始给 NaN / -1，保证第一帧一定会写。 */
    const rec = {
      id: ++recSeq,
      wrap,
      inner,
      img,
      badge,
      name,
      cur: null,
      sig: '',
      px: NaN,
      py: NaN,
      ps: -1,
      pa: -1,
      /* 本帧的角色：'live' 在展示某个活簇 / 'dying' 正在淡出 / 'idle' 空着。
         每帧由 layoutMarkers 重新标一次（见 5.5 节）。 */
      state: 'idle',
      lab: '',
      key: '',
      cnt: 0,
      /* 本帧是不是「只有缩略图」的退化形态（`.pin.is-noname`）。
         存一份是为了**跳掉没变化的类写入** —— 每帧都 toggle 会白白产生
         一次样式失效，而绝大多数帧这个值根本没变。 */
      noname: false,
      /* 指针是否悬在本元素上。悬停置顶（wrap.style.zIndex）由这里的
         真值驱动 —— 见下面 pointerenter / layoutMarkers 的分工。 */
      hovered: false,
    };
    inner.addEventListener('click', function (e) {
      e.stopPropagation();
      if (rec.cur) openPanel(rec.cur);
    });
    /* hover 放大 + **悬停置顶**。
       视觉（scale）在 photo-map.css 的 .pin.is-hover 里；置顶必须写
       `wrap.style.zIndex` —— `.mk` 带 will-change:transform，各自是独立的
       层叠上下文，`.pin` 内部的 z-index 抬不过兄弟标注（那个 z-index:5
       曾经只在同一上下文里有效，等于没用）。缩放挂在 .pin 内层、
       zIndex 挂在 .mk 外层，两处都不与每帧写的 translate3d 打架。 */
    inner.addEventListener('pointerenter', function () {
      rec.hovered = true;
      inner.classList.add('is-hover');
      wrap.style.zIndex = '10';
    });
    inner.addEventListener('pointerleave', function () {
      rec.hovered = false;
      inner.classList.remove('is-hover');
      wrap.style.zIndex = '';
    });
    overlayEl.appendChild(wrap);
    return rec;
  }

  /* 池元素改由 animFree() 按 key 分配（见 5.5 节），
     原来的 acquire(i) 按下标取元素已删除 —— 它正是「同一个 DOM 节点
     跨帧代表不同簇」的成因。 */

  /* 碰撞盒的**高度**是固定的：缩略图 44 + gap 4 + 标签 18.4
     （font-size 11.5 × line-height 1.25 = 14.4，加 .pin__name 上下 padding 各 2）
     ≈ 66.4，取 68 留一点余量。
     宽度**不能固定** —— 见 boxWOf。 */
  const BOX_H = 68;

  /* 盒宽的两端：下限 = 缩略图 44 + 右上角张数角标外扩 7；
     上限 = `.pin__name` 的 max-width（超了会省略号截断，盒子不再变宽）。 */
  const BOX_W_MIN = 51;
  const BOX_W_MAX = 140;

  /* 「只有缩略图」形态（`.pin.is-noname`）的盒高：角标上探 6px、
     贴地小三角下探 3.5px，44 + 6 + 3.5 ≈ 53.5，取 52（下探的三角形不占点击与视觉区）。
     藏掉地名之后盒子是**方形**的，比带名字时窄近 2/3 —— 这正是它救得回位置的原因。 */
  const BOX_H_MIN = 52;

  /**
   * 碰撞盒宽度：按标签文本估。
   *
   * 为什么不能用固定值：实测（量 `.pin__name` 的真实 rect）
   *   两字短名「北京」        → 44px（其实是缩略图宽度在撑）
   *   「呼伦贝尔」            → 58px
   *   「哈尔滨·冰雪大世界」    → 109.8px
   *   「中国香港 / 中国澳门」  → 117.4px
   * 固定 62 会把长标签低估一半：避让算法以为没撞，实际压住了邻居 ——
   * k=900 时港澳那个长标签压到桂林，量到 **12.3%** 的框面积重叠。
   *
   * 为什么不用 offsetWidth：布局只有一趟 —— 文字写完才量得到宽度，
   * 而那时定位已经做完了；补一趟测量会把每帧的强制重排变成两次
   * （这正是 MEMORY 里「DOM 先写后量」那条要避免的）。
   * 按字符估宽没有这个代价，而中文字宽是确定的：
   *   CJK = font-size = 11.5px（全角），半角与「·」约 6px，
   *   再加 `.pin__name` 左右 padding 各 6px。
   * 估偏大只是提前避让，估偏小才会出事 —— 所以半角按 6 取（实测约 4.5）。
   */
  function boxWOf(label) {
    let w = 12;
    for (let i = 0; i < (label || '').length; i++) {
      w += label.charCodeAt(i) > 0x2e80 ? 11.5 : 6;
    }
    return Math.max(BOX_W_MIN, Math.min(BOX_W_MAX, w));
  }

  /* ================================ 5.5 聚合过渡动画（散开 / 收拢）

     问题：clusterize() 每帧按当前 k 重算簇，元素位置直接跳到新值。
     实测（逐帧采 DOM 的 translate3d，世界视图 → 3.2 倍，共 227 帧）：
       帧间位移 p50 = 0px、p90 = 8.1px（正常手势位移），
       而 p99 冲到 815px、单帧最大 1770px；同帧内标签突变 72 次。
     p99 是 p90 的 100 倍 —— 这就是肉眼看到的「突然并成一团 / 突然炸开」。

     做法：**对簇的世界坐标做指数趋近**，而不是对屏幕坐标。
     为什么必须是世界坐标：屏幕位置 = wx·k + tx，平移只改 tx/ty、缩放只改 k。
     若对屏幕坐标插值，拖动时标注会滞后于底图（拖影）；对世界坐标插值则
     平移中 wx 不变、零滞后，缩放中 wx 缓慢滑向新质心 ——
     「滑到一起」这个动作天然叠在相机变换之上，不跟手势打架。

     三条边界，缺一不可：
     ① **程序化跳变不参与动画**。探针用 __tdt.setCamera() 瞬时换视野，
        启动时 fitBox(..., 0)、窗口 resize 同样是瞬时的。判据取
        「一帧内 |log2(k_now / k_prev)| > 0.5」（即缩放超过 1.41 倍）；
        真实手势每帧只走约 8%，绝不会误触。这条闸保证静止后的位置与
        「无动画版本」逐像素相同 —— 视觉回归才可能复现。
     ② **收敛后吸附**。指数趋近永不精确到达，误差会一直悬着，
        那会让「静止截图连开两次」读出差异。屏幕误差 < 0.25px 就令 state = 目标。
     ③ **身份要稳**。按簇的 key 分配 DOM 元素。旧实现按数组下标 acquire(i)，
        成员一变，同一个 DOM 节点就代表另一个簇 —— 图片与文字在同一帧里全换掉。
        那 72 次突变里大部分是这一条造成的，与位置无关。

     进出场的起点都按**成员归属**选，不按几何距离：
     新 key 从「上一帧含着我这些照片的那个簇」出发（animParentOf），
     消失的 key 滑向「吞掉它的那个簇」（clusterize 记下的 absorbed）。
     于是 t 跨过 0.5 时，省级气泡从中国气泡里飞出去、缩回时又收拢回来；
     而喀什不会从迪拜里飞出来 —— 上一帧它在中国那一个簇里，不在迪拜。 */

  const ANIM_TAU = 105; // 位置趋近时间常数（ms）
  const ANIM_FADE = 120; // 淡入 / 淡出时间常数（ms）
  const ANIM_SNAP_PX = 0.25; // 屏幕误差小于它就吸附到目标
  const ANIM_JUMP_LOG2 = 0.5; // 一帧内缩放倍率超过 2^0.5 → 判为程序化跳变

  const anim = new Map(); // key -> { key, wx, wy, a, rec, live, dying }
  const animDying = []; // 本帧要淡出的 state（复用数组，避免每帧分配）
  const animDyingRecs = new Set();
  const animUsed = new Set(); // 本帧占用的池元素
  const animAbsorb = new Map(); // 被吞掉的 key -> 吞掉它的 key
  const animKeep = new Set(); // jump 时筛「本帧还活着的 key」
  let animPrevKeys = []; // 上一帧的 key 快照（新 key 找起点用）
  let animPrevK = 0;
  let animPrevT = 0;
  let animReady = false;
  let animResync = false; // 由 resize() 置位：下一帧强制吸附
  /* 测试缝：`?noanim` 让过渡动画整体退化回「每帧即时吸附」，
     也就是改动前的行为。存在的理由是**对照实验**——
     要证明动画改善了帧间位移，必须能在同一口径下量到「没有动画」的那一版，
     而不是拿记忆里的旧数字。正常访问取不到它。 */
  let animOff = false;
  /* 测试缝：`?proxanim` 把「父簇怎么选」退回**几何最近**（旧行为）。
     它存在的唯一理由是反向验证 —— 「出生不许跨国」那条判据必须在旧规则下变红，
     否则它抓不住本轮修掉的这个 bug，等于没写。正常访问取不到。 */
  let animProx = false;
  /* 测试缝：`?nopoolfix` 撤掉「预占活簇已有元素」这一步，退回**旧的分配行为**
     （两个活簇可能共用一个 DOM 节点）。它存在的唯一理由是反向验证 ——
     判据 `pinNotShared` / `noDupPinLabel` / `cnClusterHasPin` 必须在这条缝下变红，
     否则它们抓不住这个 bug，等于没写。正常访问取不到。 */
  let poolReserve = true;
  /* 测试缝：`?noanchor` 撤掉「国家级气泡落在国家中心的锚点」，退回加权质心
     （旧行为）。用来证明 `countryAnchorInside` 不是恒真的 ——
     带上它之后，「中国」那一簇必须落到国境之外（黄海海面），判据变红。 */
  let useAnchor = true;
  /* 测试缝：`?nonameoff` 关掉「地名放不下就藏起来」（`.pin.is-noname`），
     退回旧行为 —— 排不下就**原位叠压**，两个气泡的地名压在一起。
     存在的唯一理由是反向验证：判据 `noOverlappingLabels` 必须在这条缝下
     变红，否则它只是在测一个恒真的东西。正常访问取不到。 */
  let nonameOn = true;

  /* --------------------------------------------------------------------------
     新簇的起点：**按成员归属**，不是按几何距离。

     旧版是「上一帧离它最近的簇」。世界视图下中国是一整个簇（t < 0.5 时的
     国家级合并），质心落在照片最密的那一片（东部）；而新疆喀什在国土最西端，
     到这个质心的几何距离，比到迪拜那个气泡的距离还远 —— 于是放大展开时
     **喀什的气泡是从迪拜里分裂出来的**。跨国，地理逻辑上不成立。

     正确的父簇判据是：**上一帧哪一个簇的成员里含着我这些照片**。
     喀什的照片上一帧在中国那一个簇里，所以它必须从中国气泡里飞出来。
     聚合方向本来就是这么做的（`absorbed` 记的是被谁吞），出生方向必须对称。
     -------------------------------------------------------------------------- */
  let prevOwner = null; // Map<地名, 上一帧持有它的簇 key>，每帧重建一次（O(地名数) ≈ 93）
  const animTally = new Map(); // 复用，避免每个新簇都新建一个 Map

  function animOwnerIndex() {
    if (prevOwner) return prevOwner;
    prevOwner = new Map();
    for (let i = 0; i < animPrevKeys.length; i++) {
      const st = anim.get(animPrevKeys[i]);
      /* 正在淡出的不接孩子 —— 它自己正往外走，拿它当起点会画出反向的轨迹 */
      if (!st || st.dying || !st.c) continue;
      const nm = st.c.names;
      for (let j = 0; j < nm.length; j++) prevOwner.set(nm[j], st.key);
    }
    return prevOwner;
  }

  /** 按「共享地名最多」挑父簇。全部是新照片（刚进视口）时回 null。 */
  function animParentOf(names, wx, wy) {
    if (animProx) {
      /* 测试缝 ?proxanim：恢复「几何最近」。用来证明下面那套判据真的能
         抓住跨国分裂 —— 判据若在旧规则下照样全绿，就是恒真的、等于没写。 */
      let best = null;
      let bd = Infinity;
      for (let i = 0; i < animPrevKeys.length; i++) {
        const st = anim.get(animPrevKeys[i]);
        if (!st || st.dying) continue;
        const dx = st.wx - wx;
        const dy = st.wy - wy;
        const d = dx * dx + dy * dy;
        if (d < bd) {
          bd = d;
          best = st;
        }
      }
      return best ? { st: best, shared: 0 } : null;
    }
    const idx = animOwnerIndex();
    animTally.clear();
    let bk = null;
    let bn = 0;
    for (let j = 0; j < names.length; j++) {
      const pk = idx.get(names[j]);
      if (pk === undefined) continue;
      const n = (animTally.get(pk) || 0) + 1;
      animTally.set(pk, n);
      if (n > bn) {
        bn = n;
        bk = pk;
      }
    }
    if (bk === null) return null;
    const st = anim.get(bk);
    return st && !st.dying ? { st: st, shared: bn } : null;
  }

  /* 出生记录：只增不删的环形日志，读数口导出去给探针验「父簇是谁」。
     上限 64 —— 整屏簇数上限同量级，够覆盖一次完整的散开。 */
  const animBirthLog = [];
  const animMergeLog = [];
  function animLogBirth(st, c, par) {
    if (animBirthLog.length >= 64) animBirthLog.splice(0, animBirthLog.length - 63);
    animBirthLog.push({
      key: c.key,
      /* 起点所属的簇（null = 上一帧没有任何簇含过这些照片，就地淡入） */
      from: par ? par.st.key : null,
      fromRegion: par && par.st.c ? par.st.c.region : '',
      region: c.region,
      /* 与父簇共享的地名数。判据「父簇必须含着我」就是它 ≥ 1。 */
      shared: par ? par.shared : 0,
      childN: c.names.length,
    });
  }
  /* 收拢方向的对称读数：正在淡出的簇滑向哪个簇。
     它与 births 必须**同区域**，否则「喀什滑进迪拜」和「喀什从迪拜飞出」
     是同一种错，只堵一边等于没堵。 */
  function animLogMerge(st, to) {
    if (animMergeLog.length >= 64) animMergeLog.splice(0, animMergeLog.length - 63);
    const d = anim.get(to);
    animMergeLog.push({
      key: st.key,
      to: to,
      region: st.c ? st.c.region : '',
      toRegion: d && d.c ? d.c.region : '',
    });
  }

  /** 取一个空闲池元素。正在淡出的元素不许被抢 —— 否则那个气泡会当场换脸。 */
  function animFree() {
    for (let i = 0; i < pool.length; i++) {
      const rec = pool[i];
      if (animUsed.has(rec) || animDyingRecs.has(rec)) continue;
      return rec;
    }
    const rec = makePinEl();
    pool.push(rec);
    return rec;
  }

  /** 推进一帧动画，并把平滑后的屏幕坐标写回 c.sx / c.sy（碰撞判定必须依据它）。 */
  function animStep(list, k, tx, ty, now) {
    const dt = animReady ? clamp(now - animPrevT, 1, 64) : 1000;
    animPrevT = now;
    const a = 1 - Math.exp(-dt / ANIM_TAU);
    const fa = 1 - Math.exp(-dt / ANIM_FADE);
    const jump =
      animOff || !animReady || animResync || Math.abs(Math.log2(k / animPrevK)) > ANIM_JUMP_LOG2;
    /* 「纯平移」：k 几乎没变。拖动时视口边缘的点会不断进 / 出集合，
       若也走「从上一帧最近簇飞过来」那套，拖一下就会看见气泡从几百像素外飞进屏幕
       （实测残差 467px、alpha 0.24）。平移不是聚合，不需要轨迹 —— 直接就位。 */
    const panOnly = animReady && Math.abs(Math.log2(k / animPrevK)) < 0.002;
    animPrevK = k;
    animReady = true;
    animResync = false;

    for (const st of anim.values()) st.live = false;

    /* 程序化跳变：上一帧的簇**直接丢弃**，不进淡出队列。
       否则跳变后约半秒内屏幕上会留一批 alpha < 1 的残影 ——
       「静止截图与无动画版本逐像素相同」这条就不再成立，
       而探针恰恰是用 setCamera() 摆好位置再截图的（实测踩过：跳变后 120ms
       仍有 13 个簇在 dying，虽然多数在视口外，但这是靠运气而非靠设计）。 */
    if (jump) {
      animKeep.clear();
      for (let i = 0; i < list.length; i++) animKeep.add(list[i].key);
      for (const key of Array.from(anim.keys())) {
        if (!animKeep.has(key)) anim.delete(key);
      }
    }

    /* 父簇索引必须在**改写任何 st.c 之前**建好：主循环一边跑一边把
       st.c 换成这一帧的簇，晚一步就会拿到本帧的成员表，把父子关系认反。
       代价 O(地名数) ≈ 93 次 Map.set，只在可能产生新簇的帧上做。 */
    prevOwner = null;
    if (!jump && !panOnly && !animProx) animOwnerIndex();

    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      let st = anim.get(c.key);
      if (!st) {
        st = { key: c.key, wx: c.wx, wy: c.wy, a: 1, rec: null, live: true, dying: false, fresh: false };
        if (!jump && !panOnly) {
          /* 父簇 = 上一帧**含有我这些照片**的那个簇（见 animParentOf）。
             没有父簇（照片刚进视口）就地淡入，不编造轨迹 ——
             旧版无论有没有关系都硬拽一个最近的，才会出现「喀什从迪拜飞出来」。 */
          const par = animParentOf(c.names, c.wx, c.wy);
          if (par) {
            st.wx = par.st.wx;
            st.wy = par.st.wy;
          }
          st.a = 0;
          /* 出生这一帧**不推进位置**：要让它精确与父簇重合。
             否则同一帧内先取起点、再走一步（a ≈ 0.15，目标又可能在几百像素外），
             出生瞬间就偏出几十像素 —— 实测正是这样：36~104px。 */
          st.fresh = true;
          animLogBirth(st, c, par);
        }
        anim.set(c.key, st);
      }
      st.live = true;
      st.dying = false;
      st.c = c;

      if (jump) {
        st.wx = c.wx;
        st.wy = c.wy;
        st.a = 1;
      } else if (st.fresh) {
        st.fresh = false;
        st.a += (1 - st.a) * fa;
      } else {
        st.wx += (c.wx - st.wx) * a;
        st.wy += (c.wy - st.wy) * a;
        st.a += (1 - st.a) * fa;
        const ex = (c.wx - st.wx) * k;
        const ey = (c.wy - st.wy) * k;
        if (ex * ex + ey * ey < ANIM_SNAP_PX * ANIM_SNAP_PX && st.a > 0.995) {
          st.wx = c.wx;
          st.wy = c.wy;
          st.a = 1;
        }
      }
      c.anim = st;
      /* 避让必须建立在**实际会显示出来的位置**上，否则动画期间会真重叠 */
      c.sx = st.wx * k + tx;
      c.sy = st.wy * k + ty;
    }

    /* 吸收关系：被吞掉的 key → 吞掉它的 key。每帧重建，规模 O(簇数)。 */
    animAbsorb.clear();
    for (let i = 0; i < list.length; i++) {
      const ab = list[i].absorbed;
      if (!ab) continue;
      for (let j = 0; j < ab.length; j++) animAbsorb.set(ab[j], list[i].key);
    }

    animDying.length = 0;
    animDyingRecs.clear();
    for (const st of anim.values()) {
      if (st.live) continue;
      /* 平移中「消失」只可能是移出了视口（剔除余量 200px，屏幕上看不见），
         不必淡出 —— 直接丢弃，于是拖动全程 dying 恒为 0。
         （Map 遍历中 delete 是规范允许的。） */
      if (panOnly) {
        anim.delete(st.key);
        continue;
      }
      animDying.push(st);
    }
    for (let i = 0; i < animDying.length; i++) {
      const st = animDying[i];
      /* 「刚进入淡出」才记一次，否则同一个簇的几十帧淡出会把日志挤满 */
      const first = !st.dying;
      st.dying = true;
      /* 有吸收者就滑过去再淡出 —— 原地消失会在图上留一块空洞 */
      const tk = animAbsorb.get(st.key);
      if (tk && !jump && !panOnly) {
        const dst = anim.get(tk);
        if (dst && dst.live) {
          st.wx += (dst.wx - st.wx) * a;
          st.wy += (dst.wy - st.wy) * a;
          if (first) animLogMerge(st, tk);
        }
      }
      st.a -= st.a * fa;
      if (st.rec) animDyingRecs.add(st.rec);
      if (st.a < 0.012) {
        st.a = 0;
        anim.delete(st.key);
      }
    }

    animPrevKeys = Array.from(anim.keys());
  }

  let lastShown = 0;

  function layoutMarkers(now) {
    const k = t2.k;
    const tx = t2.tx;
    const ty = t2.ty;
    /* 填色粒度（0 = 一国一色，1 = 逐省分色）。标签分级要用它 ——
       t < 0.5 时不得报省级裸名，否则会出现「中国」与「新疆」并列（见 clusterLabel）。 */
    const t = chinaT(k);
    const list = clusterize(k, tx, ty);
    /* 先把世界坐标平滑一遍，并把「实际会显示的位置」写回 c.sx / c.sy。
       顺序不能反 —— 排序与避让都要基于这个位置（见 5.5 节）。 */
    animStep(list, k, tx, ty, now);

    /* 落位顺序：**合规必须出现的点位优先**，其次才按张数。
       与主线 photo-map.js 同口径 —— 港澳台三地相距极近、必须同时在场，
       让它们先占位，比事后把别人挤走来补救干净得多。

       本线实测过的反例（k=900）：`福建(4 张)` 因为张数多先落位，
       `中国台湾·台北(1 张)` 随后被挤，**40 个候选位置全部撞车**
       （被 福建/上海/浙江/港澳/日月潭 五面合围），只能退回原位叠压 ——
       量到 22.2% 的框面积重叠。把顺序倒过来，让位的就换成福建。 */
    list.sort(function (a, b) {
      const pa = a.solo || (a.mstSet && a.mstSet.length) ? 1 : 0;
      const pb = b.solo || (b.mstSet && b.mstSet.length) ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return b.list.length - a.list.length;
    });

    const boxes = [];
    animUsed.clear();

    /* ---------------------------------------------------------------------
       **先预占「本帧活簇已经拥有的池元素」，再动手分配。**

       不预占会出一个很难看、也很难查的错：`animFree()` 只避让两样东西 ——
       本帧已被占用的（`animUsed`）与正在淡出的（`animDyingRecs`）。而活簇是
       **边遍历边登记**的：排在 `list` 后面、还没轮到的那个簇，它已经持有元素
       （`st.rec`），但这个元素此刻既不在 `animUsed` 里，也不是淡出元素 ——
       于是被 `animFree()` 当成空闲发给了别人。**两个活簇共用一个 DOM 节点。**

       共用之后谁输？两个簇都往同一个节点写 transform 与文字，**后写的赢**。
       而 `list` 是按张数降序排的（合规点优先，然后张数多的先落位），
       所以**张数最多的那个簇最先被覆盖** —— 它的气泡消失，可它的碰撞盒
       还在 `boxes` 里，于是邻座被它挤开、还拉出一条指向空处的牵引线。

       实测症状（用户报的）：`t < 0.5` 时中国收成一个簇、61 张，是最大的一个，
       于是「中国」那个气泡被覆盖掉 —— 画面上就是**中国的照片全不见了**，
       而填色还在（填色不经过这条路径），所以看着像「照片丢了」。
       反向读数在 `__tdt.pins()` 里：DOM 上会出现两个一模一样的标签。

       这个 bug 是概率性的：共不共用取决于池的分配历史与这一帧的排序，
       实测反复点「世界 / 全国」往返，8 轮里 6 轮出现。所以它躲过了
       「静止态截图」这一类检查 —— 静止态它未必出现，来回切几次才现形。
       --------------------------------------------------------------------- */
    for (let i = 0; i < list.length; i++) {
      const st = list[i].anim;
      if (poolReserve && st && st.rec) animUsed.add(st.rec);
    }

    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      const st = c.anim;
      /* **固定点**：pin 恒在簇锚点（= 最大成员堆的真实堆心），**任何**碰撞
         都不挪位 —— 2026-09-13 二次裁决（用户原话：「取消连线的做法，做
         pin 点上的缩略图重叠，hover 到哪个缩略图，哪个缩略图就要在最上面」）。

         上一版还给「结构上不许合并的对」（台湾 solo / 跨省 / 跨国）保留
         「推开 + 牵引线白点」：结果用户看到的是「位置没变（白点在），
         缩略图却随缩放移来移去」—— 避让位每级重算一遍，气泡就在 40 个
         候选位之间跳。合规要求的是**数据层不合并**（solo 单独成点），
         不是视觉上必须隔开；重叠交给 hover 置顶 + 藏名去消化。 */
      const cx = c.sx;
      const cy = c.sy;

      /* 标签先算出来 —— 碰撞要用它的**估宽**做盒子，不能等定位完再算。
         clusterLabel 是纯函数，提前调用不多花钱。
         第二个参数是填色粒度：t < 0.5 时它会把省级标签压回国名。 */
      const lead = clusterLabel(c, t);
      let wSelf = boxWOf(lead);
      let hSelf = BOX_H;
      let noname = false;

      /* 碰撞只判「这个位置上盒子压没压到别人」，不再搜索替代位置：
         两个框在 x 上分开需要 |Δx| ≥ 两者宽度的一半之和。 */
      const collide = function (wBox, hBox) {
        for (let j = 0; j < boxes.length; j++) {
          const b = boxes[j];
          if (Math.abs(b.x - cx) < (b.w + wBox) / 2 && Math.abs(b.y - cy) < (b.h + hBox) / 2) {
            return b;
          }
        }
        return null;
      };

      /* ------------------------------------------------------------------
         **带地名的形态压到别人 → 退化成「只有缩略图与角标」。**

         藏掉地名、把盒子缩到 BOX_W_MIN × BOX_H_MIN。盒子从「最长 140 宽」
         掉到 51 宽，多数碰撞就此消失 —— **位置比名字值钱**：名字藏起来
         仍是可逆的（hover 浮出来、点开面板也看得到），位置错了就是错了。
         连退化形态都压着（密集到缩略图相叠），就原位重叠 —— 用户已裁决。
         ------------------------------------------------------------------ */
      if (collide(wSelf, hSelf) && nonameOn) {
        noname = true;
        wSelf = BOX_W_MIN;
        hSelf = BOX_H_MIN;
      }
      boxes.push({ x: cx, y: cy, w: wSelf, h: hSelf, c: c });

      /* 按 key 取池元素：同一个簇跨帧拿到同一个 DOM 节点。
         旧实现 acquire(i) 按数组下标取 —— 成员一变，同一节点就代表另一个簇，
         图片与文字会在同一帧里被整体换掉。 */
      let rec = st.rec;
      if (!rec) {
        rec = animFree();
        st.rec = rec;
      }
      animUsed.add(rec);
      /* 登记本帧角色与身份，供读数口 `__tdt.pins()` 反查
         「哪个活簇占了哪个元素」。真值来源是同一处，不做二次推导。 */
      rec.state = 'live';
      rec.lab = lead;
      rec.key = c.key;
      rec.cnt = c.list.length;

      /* 退化形态的类切换。**只改类，不改文字** —— `rec.name.textContent`
         照常写着地名（下面 sig 那一段），藏起来的是显示，不是内容：
         hover 浮出来靠的就是这份文字还在。 */
      if (rec.noname !== noname) {
        rec.noname = noname;
        rec.inner.classList.toggle('is-noname', noname);
      }

      const al = st.a;
      /* 位置 + 淡入缩放。静止时（al = 1）写出的值与无动画版本逐字节相同：
         不加 scale 后缀、opacity 内联清空 —— 这是视觉可复现的前提。 */
      const s = al >= 1 ? 1 : 0.9 + 0.1 * al;
      if (rec.px !== cx || rec.py !== cy || rec.ps !== s) {
        rec.px = cx;
        rec.py = cy;
        rec.ps = s;
        rec.wrap.style.transform =
          'translate3d(' +
          cx +
          'px,' +
          cy +
          'px,0) translate(-50%,-50%)' +
          (s < 1 ? ' scale(' + s.toFixed(4) + ')' : '');
      }
      if (rec.pa !== al) {
        rec.pa = al;
        rec.wrap.style.opacity = al >= 1 ? '' : String(al);
      }

      /* 标签由 clusterLabel() 按簇内成员的「同质程度」分级，不按缩放分档：
         世界视图下中国那一簇跨 20+ 个城市 → 报「中国」（该有的样子）；
         放大到北京几个点聚一簇 → 报「北京」；再放大到只剩「北京·故宫」→ 报完整地名。
         上一版的规则只有「成员数 > 1 就报区域名」，于是放大后全中国任何
         多地点簇都写着「中国」—— 那正是要修掉的东西。

         补记：光改标签还不够。全国视图下「四川显示成中国」的真正成因是
         **跨省合并**（上海+浙江、四川+重庆、四川+云南、广西+湖南各成一簇），
         第④级于是被触发。已在 clusterize() 里用 unitOf() 把聚合单位下沉到省，
         所以现在走到第④级的只剩「同一簇内真的跨了省」—— 那只有
         t < 0.5 的国家级粒度下才会发生，报「中国」正是该有的样子。 */
      /* sig 里必须带 key：不同簇算出同一个「标签 + 张数」是可能的
         （比如两个都叫「北京·故宫」的 2 张簇），只比后两者会漏更新图片。 */
      const sig = c.key + '|' + lead + '|' + c.list.length;
      if (sig !== rec.sig) {
        rec.sig = sig;
        const first = c.list[0];
        if (rec.img.getAttribute('src') !== first.src) rec.img.setAttribute('src', first.src);
        rec.name.textContent = lead;
        rec.badge.textContent = String(c.list.length);
        rec.badge.hidden = c.list.length <= 1;
      }
      rec.cur = c;
    }

    /* 正在淡出的簇：不参与避让（否则会把存活的气泡挤走），也不可点。
       位置继续跟相机走，所以 w、淡出期间地图还能拖。 */
    for (let i = 0; i < animDying.length; i++) {
      const st = animDying[i];
      const rec = st.rec;
      if (!rec) continue;
      animUsed.add(rec);
      rec.state = 'dying';
      rec.cur = null;
      const x = st.wx * k + tx;
      const y = st.wy * k + ty;
      const al = st.a;
      const s = 0.9 + 0.1 * al;
      const off = x < -300 || x > size.w + 300 || y < -300 || y > size.h + 300;
      const nx = off ? -9999 : x;
      const ny = off ? -9999 : y;
      if (rec.px !== nx || rec.py !== ny || rec.ps !== s) {
        rec.px = nx;
        rec.py = ny;
        rec.ps = s;
        rec.wrap.style.transform = off
          ? 'translate3d(-9999px,-9999px,0)'
          : 'translate3d(' +
            x +
            'px,' +
            y +
            'px,0) translate(-50%,-50%) scale(' +
            s.toFixed(4) +
            ')';
      }
      if (rec.pa !== al) {
        rec.pa = al;
        rec.wrap.style.opacity = String(al);
      }
    }

    /* 这一帧用不到的池元素挪出屏幕。放在屏幕外而不是 display:none ——
       后者会让元素脱离合成层，下次用到时要重新提升，反而更贵。 */
    for (let i = 0; i < pool.length; i++) {
      const rec = pool[i];
      if (animUsed.has(rec)) continue;
      /* 本帧空着：先把角色标回 idle，再走「已经在屏外就不再重复写 style」
         那条短路。顺序不能反 —— 否则元素被停放之后，`state` 会一直停在
         上一次的角色上，读数口看到的就与实际不符。 */
      rec.state = 'idle';
      rec.lab = '';
      rec.key = '';
      rec.cnt = 0;
      if (rec.px === -9999) continue;
      rec.px = -9999;
      rec.py = -9999;
      rec.wrap.style.transform = 'translate3d(-9999px,-9999px,0)';
      rec.cur = null;
      if (rec.pa !== 0) {
        rec.pa = 0;
        rec.wrap.style.opacity = '';
      }
    }
    lastShown = list.length;
  }

  /* ============================================ 6.5 密度填色（国别 + 省级两级）

     用颜色表示「这个国家 / 这个省有多少张照片」。级到**国**与**省**，
     色块**半透明**，几何复用主线的 assets/geo/province.js（中国）
     与 assets/geo/world.js（他国）。

     五件事必须讲清楚，都是会真出错的地方：

     ① **三份几何，两套坐标系。** 本线的底图（天地图 CGCS2000 ≈ WGS-84）
        与点位都是 WGS-84，而数据源不是齐的：

          province.js         DataV，**GCJ-02** → 载入时反算成 WGS
          world.china         DataV，**GCJ-02** → 本线不用它（见 ③）
          world.countries     Natural Earth 50m，**WGS-84** → 原样用

        不反算会有 50~500m 偏移，k=16000 时约 17px，肉眼可见。

     ② **填色层是独立画布。** 底图那张挂着 CSS filter，画进去会被
        grayscale+invert 洗成灰白，5 档色阶全部消失。

     ③ **中国由省级几何代表，且省级并集就已经是标准轮廓。**
        实测：34 个省的环并集 bbox [73.5011, 3.8381, 135.0885, 53.5609]，
        与 world.china 的 [73.5024, 3.8236, 135.0957, 53.5633] 相差 0.015° 以内，
        海南省那 258 个环里含南海诸岛（最南 3.8381°N）。
        所以不需要再叠一份国级中国轮廓 —— 那反而会在过渡带露出两套边界。

     ④ **不要做「环过滤」。** 上一版按「命中的环 + 与命中环 bbox 相交的环」
        筛环，本意是躲开一个 472 km² 的「海域包络环」。**那个判断是错的**：
        台湾省 ring#37 的 bbox 中心 (124.51, 25.90) 与外交部公布的
        **赤尾屿** 25°55.3′N / 124°33.5′E（= 25.9217, 124.5583）吻合 ——
        它是中国领土（钓鱼岛附属岛屿最东端），不是脏数据。
        那次「修复」实际把钓鱼岛、黄尾屿、赤尾屿一起筛掉了，是合规缺陷。
        现在**全部环都填**，改为按屏幕尺寸做 LOD（亚像素环不画，见 ⑤）。

     ⑤ **环级 LOD。** 世界视图下南海那些礁盘只有零点几像素，画了也看不见，
        却要付出 900 多次路径构造。按「屏幕 bbox 两维都 < RING_MIN_PX」跳过：
        不丢任何**可见**的东西，只丢光栅化不出来 的。放大后它们自然回来。
  */

  /* 每个主题的 5 档色阶直接读 photo-map.css 的 --m-d1..d5 ——
     与主线共用同一套颜色，不另立一套。 */
  const RAMP = ['#3a5f8a', '#3f74a6', '#4f8fc0', '#7fb0d8', '#e9b04a'];
  let rampKey = '';

  /* 半透明：满强度 0.55。再高会盖住底图的地名与路网，再低就看不出档差。 */
  const FILL_ALPHA = 0.55;
  /* 缩放淡出：进到城市尺度后，整屏铺一层色就只是色偏，不再是信息。
     9000 以下满强度，26000 以上不画。两个数就是全部旋钮。 */
  const FILL_FULL_K = 9000;
  const FILL_ZERO_K = 26000;

  /* 中国的「国 → 省」切换带：k ≤ 420 时全省同色（读起来就是一个国家），
     k ≥ 900 时逐省分色，中间线性过渡。
     为什么是这两个数，而不是拍脑袋：k 是世界宽度（2πk 像素）的尺度，
       「世界」按钮 → fitBox(WORLD) → k ≈ 201
       「全国」按钮 → fitBox(HOME)  → k ≈ 1172（61.9° 经度摊进 1266px）
     所以切换带必须落在 201 与 1172 之间：世界视图下中国是一个色块，
     到全国视图时已经逐省分色。曾经把门槛放在 2500，结果全国视图下
     中国还是一整块 —— 省级填色等于被自己挡掉了。 */
  const CH_LO_K = 420;
  const CH_HI_K = 900;

  /* 环级 LOD 阈值（屏幕 px）。两个方向都小于它才跳过。
     取 0.6 而不是 1：钓鱼岛 3.6km、黄尾屿 1.3km，在 k=1200 时分别是
     0.68px 与 0.24px —— 阈值取 1 会把钓鱼岛这种「刚好看得见」的岛也丢掉。
     0.6px 以下的环不论画不画，屏幕上都不会有可分辨的差别。 */
  const RING_MIN_PX = 0.6;

  /* 亚像素环的**最小可见尺寸**（屏幕 px）。`pathShape()` 跳过一维都 < RING_MIN_PX
     的环，那些环改由 `minRingPath()` 补一个色块 —— 否则它们等于不存在。
     取 2.0：小于 2px 的方块在浅色底图上看不出来（南海的礁盘在 k=201 时
     只有 0.02~0.18px，放大 10 倍仍然不到 2px），而 2px 已经是肉眼能确定的
     「这里有一个点」。再大就会把星罗棋布的岛连成一片，读起来像色斑。
     ⚠️ 这是**放大最小尺寸**，不是放大坐标：色块的中心恒等于环的真实中心，
     所以位置仍然是真的（见 minRingPath 的注释）。 */
  const RING_MARK_PX = 2.0;

  /* 九段线的读数口。`segs` 是数据里真实的段数（应为 10），`drawn` 是
     本帧真的描了的段数 —— 两者要分开记，否则「段数对」会把
     「一段都没画出来」这种情形盖过去。 */
  const jiuStat = { segs: 0, drawn: 0, lit: false };
  /* 海南省的要素引用。九段线属它管，但线的颜色不跟它走（见 drawFill 那段）——
     这里留着它只是为了判断「hover 命中的是不是海南」。 */
  let CN_HN = null;

  /* hover 的「聚焦」强度 —— **只动被悬停的那一块**。
     ⚠️ 这里曾经有一个 HOVER_DIM（把其余色块压到 0.42）。已删，理由有两条：
       ① 用户的诉求是「hover 中的色块变，其他色块不要变」—— 压暗其余正好相反；
       ② 它的触发条件比看起来脆：相机一变光标底下就换了区域，旧悬停区继续挂着，
          整张图会毫无理由地暗一大片（那正是删掉它的直接由头）。
     方向是「深一点」，而不是提亮：
       往黑里混一点（HOVER_DEEP）**并且**提高不透明度（HOVER_UP）。
       两个都要 —— 底图是浅色瓦片，alpha 上去色块才真的显深；
       只调颜色在深色主题下会被底色吃掉，看不出反馈。 */
  const HOVER_UP = 1.62; // 乘在 alpha 上，0.55 → 0.89
  const HOVER_DEEP = 0.14; // 悬停区域往黑里混这么多

  const PROV = [];
  const CTRY = [];

  /* ---------------------------------------------------------------- 市界
   *
   * 市级几何按省懒加载（`assets/geo/city/<省 adcode>.js`，单个 22~129 KB）。
   * 用途只有一个：把一个**被空间闸拆开的地点**标到市，而不是标到省。
   *
   * 为什么需要它：`place` 是用户给相册起的名字（文件夹名 / 年份），不是地名。
   * 同一个 `place` 跨了几百公里就会被拆成多个点，而拆开后如果只能报到省，
   * 广东省内三个不同市的点会并列成「广东」「广东 2」「广东 3」—— 三个点
   * 看着像同一个地方的三份，却没有任何一处告诉用户它们其实是广州、深圳、汕头。
   * 报市名才是这些点唯一有信息量的标签。
   *
   * `CITY_OK` 是**数据的镜像**，不是策略白名单：它列出真正存在市界文件的省。
   * 缺的 7 个（4 个直辖市 + 台湾 + 港澳）恰好是「市 = 省级本身」，
   * 退化到省名就是市名，没有损失。这份名单与目录的一致性由
   * `tools/verify-city-list.js` 核验 —— 别手改，改目录后重跑那个脚本。
   */
  const CITY_OK = new Set([
    130000, 140000, 150000, 210000, 220000, 230000, 320000, 330000, 340000,
    350000, 360000, 370000, 410000, 420000, 430000, 440000, 450000, 460000,
    510000, 520000, 530000, 540000, 610000, 620000, 630000, 640000, 650000,
  ]);
  const CITY = new Map(); // 省 adcode → 市要素数组（坐标已 GCJ→WGS）
  const CITY_WANT = new Set(); // 已发起加载的省，防重复注入 script
  const CITY_BASE = 'assets/geo/city/';
  /* 供市界异步到货后重建。只有它俩会让 `buildPhotos` 被调用两次。 */
  let lastAlbum = null;
  let lastLabel = '';
  /* 测试缝 `?nocity` 关掉它 —— 见 readParams 里那条注释。 */
  let cityLabels = true;
  /* 测试缝 `?noreassign`：让市界到货后的重建跳过 `computeFill()`。
     只为「重建必须重跑归属」那条判据能被打红而存在，正常访问取不到。 */
  let reassignOff = false;

  /* ---------------------------------------------------------------- 区县界
   *
   * 与市界同构、同源、同样的懒加载方式（`assets/geo/county/<省 adcode>.js`）。
   * 存在的唯一理由：**再往下一级取标签**。
   *
   * 为什么需要它 —— 市界只解决到「广州」为止。同一个市里被空间闸拆开的
   * 多个点，算出来的 geo 全都一样，代码于是只能加序号，用户看到的是
   * 「广州 1」「广州 2」：他知道自己在广州，却不知道是哪一处。
   * 区县名（天河区 / 番禺区）是这一层唯一有信息量的标签。
   *
   * ⚠️ 与市界的**关键差别**：区县名进 `name`，市名进 `city`。
   *   - `name` 是气泡上那行字（单点簇直接用它）→ 越具体越好，用区县
   *   - `city` 是 `clusterLabel()` 第②级的判据 → 必须保持「市」的语义，
   *     否则低倍率下若干区县并成一簇时，会把区县名当成城市名报出来
   * 于是「低倍率看到广州、放大后拆成天河区 / 番禺区」是自动发生的，
   * **不需要任何缩放阈值** —— 与整个引擎「粒度连续」的口径一致。
   *
   * 名字一律过 `shortName()`：它只削 省 / 市 / 自治区 这类**级别后缀**，
   * 区 / 县 / 旗 原样保留 —— 后缀本身就是「这是哪一级」的信号。
   * 民族自治地方的叠名（「积石山保安族东乡族撒拉族自治县」）在**市界那边
   * 同样存在**（「恩施土家族苗族自治州」今天就会被报出来），不是新问题，
   * 这里不额外处理。
   *
   * `COUNTY_OK` 与 `CITY_OK` 一样是**数据的镜像**，不是策略白名单：
   * 它列出真正存在区县文件的省。缺的三个（台湾 / 香港 / 澳门）恰好是
   * 「区县 = 省级本身」，退化到省名没有损失。
   */
  const COUNTY_OK = new Set([
    110000, 120000, 130000, 140000, 150000, 210000, 220000, 230000, 310000,
    320000, 330000, 340000, 350000, 360000, 370000, 410000, 420000, 430000,
    440000, 450000, 460000, 500000, 510000, 520000, 530000, 540000, 610000,
    620000, 630000, 640000, 650000,
  ]);
  const COUNTY = new Map(); // 省 adcode → 区县要素数组（坐标已 GCJ→WGS）
  const COUNTY_WANT = new Set(); // 已发起加载的省，防重复注入 script
  const COUNTY_BASE = 'assets/geo/county/';
  /* 测试缝 `?nocounty` 关掉它 —— 与 `?nocity` 同一个用途：
     让「退到市名」这条回退路径可被复现。不加它，回退分支永远走不到。 */
  let countyLabels = true;

  /* ---------------------------------------------------------------- 九段线
   *
   * 十段短线（`assets/geo/jiuduanxian.js`，1.3 KB）。**合规要求，不能删。**
   * 数据源与省界是同一份（`xingzhengqu@2024/data/gcj02`），所以同样要
   * GCJ→WGS —— 与省界同口径，别顺手少做一步。
   *
   * 为什么必须自己再画一条：天地图底图**自带**九段线，但那是底图的像素，
   * 密度填色层管不到它。于是国家维度下中国整块变深时，南海那一片的线
   * 还是底图原来的灰，看上去就是「这块没被高亮」—— 用户报的正是它。
   * 我们这条是**叠加在高亮上的**，不是替代：底图那条始终还在。
   * 也正因为如此，「层不画」不等于「线缺失」，不构成合规风险。
   *
   * 线的颜色跟着填色走：九段线以内的岛礁行政上属海南省，所以
   * `t ≥ 1`（已逐省分色）时用**海南省的色阶**，`t < 1` 时用中国的整体色阶；
   * 被 hover 高亮时与中国色块同一个加深口径。
   */
  const JIU_BASE = 'assets/geo/jiuduanxian.js';
  const JIU = []; // { pts: Float32Array, x0, y0, x1, y1, cx, cy }
  let jiuWanted = false;
  /* 九段线的屏幕线宽（CSS px，恒定）。数据里每一段**本身就是一条 dash**，
     所以只能整段实描边 —— 再叠 `setLineDash` 会把每段切成碎块。
     取 3.0 而不是省界那种 1.1：它是叠加在底图自带的细线**之上**的高亮，
     细了看不出被点亮。 */
  const JIU_W = 3.0;
  /* 测试缝 `?nojiu` 关掉它 —— 用来把「九段线被点亮」那条判据打红，
     证明它不是在空集上恒真。 */
  let jiuOn = true;

  /* 每个地点被判给了哪个省 / 哪个国家，以及判定方式。
     这是排查「某张照片为什么没进密度统计」的唯一直接证据。 */
  const assignLog = [];
  const provStat = {
    features: 0,
    rings: 0,
    verts: 0,
    ms: 0,
    filled: 0,
    ringsTotal: 0,
    unassigned: 0,
    nearAssigned: 0,
    drawn: 0,
    alpha: 0,
    /* 本帧补了多少个「最小可见尺寸」色块（亚像素环）。南海诸岛能不能被看见
       完全取决于这个数 —— 它与 `rings` 的差就是「被 LOD 跳过、又没被补上」
       的环数，那正是用户报的那个 bug 的读数形态。 */
    markRings: 0,
  };
  const ctryStat = {
    features: 0,
    rings: 0,
    verts: 0,
    ms: 0,
    filled: 0,
    unassigned: 0,
    nearAssigned: 0,
    skippedWide: 0,
    drawn: 0,
    /* 同 provStat.markRings，只是他国那一侧 */
    markRings: 0,
  };
  /* 中国合计（省级求和）。世界视图下中国就是一个国家，用得上它。 */
  let chinaTotal = 0;

  function transformLat(x, y) {
    let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
    ret += ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * 2.0) / 3.0;
    ret += ((160.0 * Math.sin((y / 12.0) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30.0)) * 2.0) / 3.0;
    return ret;
  }

  function transformLng(x, y) {
    let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
    ret += ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * 2.0) / 3.0;
    ret += ((150.0 * Math.sin((x / 12.0) * Math.PI) + 300.0 * Math.sin((x / 30.0) * Math.PI)) * 2.0) / 3.0;
    return ret;
  }

  function gcjDelta(lng, lat) {
    const a = 6378245.0;
    const ee = 0.00669342162296594323;
    /* 境外不做偏移（标准实现的同一判据）。相册里有境外照片，这一条不能省。 */
    if (lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271) return [0, 0];
    let dLat = transformLat(lng - 105.0, lat - 35.0);
    let dLng = transformLng(lng - 105.0, lat - 35.0);
    const radLat = (lat / 180.0) * Math.PI;
    let magic = Math.sin(radLat);
    magic = 1 - ee * magic * magic;
    const sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / (((a * (1 - ee)) / (magic * sqrtMagic)) * Math.PI);
    dLng = (dLng * 180.0) / ((a / sqrtMagic) * Math.cos(radLat) * Math.PI);
    return [dLng, dLat];
  }

  /* GCJ-02 → WGS-84。正算的 delta 取在 WGS 点上，所以反算要迭代收敛；
     两轮足够（残差 < 0.5m，远小于半个像素），不必求解析解。 */
  function gcjToWgs(lng, lat) {
    let wlng = lng;
    let wlat = lat;
    for (let i = 0; i < 2; i++) {
      const d = gcjDelta(wlng, wlat);
      wlng = lng - d[0];
      wlat = lat - d[1];
    }
    return [wlng, wlat];
  }

  /* 与主线 photo-map.js 的 densityIndex 同式：对数分档（×1.6），
     否则个别热点会把整张图拉平。 */
  function densityIndex(count) {
    if (!count) return -1;
    return clamp(Math.floor((Math.log(count) / Math.log(2)) * 1.6), 0, 4);
  }

  /* 数据文件自带 crs 标记（生成器 fetch-geo.js 写入）：
     'wgs'（天地图 CGCS2000 管线）→ 坐标已是 WGS-84，**原样使用**；
     无标记（DataV 旧管线，GCJ-02）→ 载入时照旧反算。
     判据落在「数据文件自己声明了什么」上，不落在猜扩展名上。 */
  const toWgsOf = (g) => (g && g.crs === 'wgs')
    ? function (x, y) { return [x, y]; }
    : gcjToWgs;

  /** 载入省级几何：GCJ→WGS、建世界坐标、每环与每要素各留一个 bbox 供剔除 */
  function buildProvinceGeometry() {
    const t0 = performance.now();
    const g = window.GISDATA && window.GISDATA.province;
    const toWgs = toWgsOf(g);
    const src = (g && g.features) || [];
    for (const f of src) {
      const rings = [];
      let bx0 = Infinity;
      let by0 = Infinity;
      let bx1 = -Infinity;
      let by1 = -Infinity;
      for (const r of f.rings) {
        const n = r.length;
        if (n < 3) continue;
        const pts = new Float32Array(n * 2);
        let x0 = Infinity;
        let y0 = Infinity;
        let x1 = -Infinity;
        let y1 = -Infinity;
        for (let i = 0; i < n; i++) {
          const w = toWgs(r[i][0], r[i][1]);
          const x = M.x(w[0]);
          const y = M.y(w[1]);
          pts[i * 2] = x;
          pts[i * 2 + 1] = y;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
        rings.push({ pts, x0, y0, x1, y1 });
        if (x0 < bx0) bx0 = x0;
        if (x1 > bx1) bx1 = x1;
        if (y0 < by0) by0 = y0;
        if (y1 > by1) by1 = y1;
        provStat.rings += 1;
        provStat.verts += n;
      }
      if (!rings.length) continue;
      PROV.push({
        adcode: f.adcode,
        name: f.name,
        rings,
        bbox: [bx0, by0, bx1, by1],
        count: 0,
        fill: null,
      });
    }
    provStat.features = PROV.length;
    provStat.ms = Math.round(performance.now() - t0);
    /* 留一个海南省的引用：九段线属它管（三沙市），hover 判定要用到。
       注意**颜色不跟它走** —— 理由见 drawFill 里九段线那一段。 */
    CN_HN = PROV.find(function (f) { return f.adcode === 460000; }) || null;
  }

  /** 载入九段线：GCJ→WGS、逐段建世界坐标，每段各留一个 bbox 供视口剔除。
      与省界同一份数据源（xingzhengqu gcj02），所以**必须做同样的反算** ——
      少这一步在离岸几十公里处会差约 500m，虽然在本项目的缩放范围内看不出来，
      但口径分叉是更坏的事：它会在某次放大时突然变成可见的错位。
      `cx/cy` 留着备用（每段的中心），目前只有读数口在用。 */
  function buildJiuGeometry() {
    const g = window.GISDATA && window.GISDATA.jiuduanxian;
    const lines = (g && g.lines) || [];
    for (const seg of lines) {
      const n = seg.length;
      if (n < 2) continue;
      const pts = new Float32Array(n * 2);
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (let i = 0; i < n; i++) {
        const w = gcjToWgs(seg[i][0], seg[i][1]);
        const x = M.x(w[0]);
        const y = M.y(w[1]);
        pts[i * 2] = x;
        pts[i * 2 + 1] = y;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
      JIU.push({ pts, x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 });
    }
    jiuStat.segs = JIU.length;
  }

  /** 载入某省的市级几何。与 buildProvinceGeometry 同构 —— 同一份数据源，
      所以**必须做同样的 GCJ→WGS 反算**，否则点与市界会差约 500m，
      在「深圳 vs 东莞」这种十几公里宽的边界上就会开始判错市。
      返回 true 表示这次真的建成了（数据在 window.GISDATA 里），
      false 表示脚本没把数据带进来（换过一次文件名 / 加载失败）。 */
  function buildCityGeometry(adcode) {
    const g = window.GISDATA && window.GISDATA['city_' + adcode];
    if (!g || !g.features) return false;
    const toWgs = toWgsOf(g);
    const out = [];
    for (const f of g.features) {
      const rings = [];
      let bx0 = Infinity;
      let by0 = Infinity;
      let bx1 = -Infinity;
      let by1 = -Infinity;
      for (const r of f.rings) {
        const n = r.length;
        if (n < 3) continue;
        const pts = new Float32Array(n * 2);
        let x0 = Infinity;
        let y0 = Infinity;
        let x1 = -Infinity;
        let y1 = -Infinity;
        for (let i = 0; i < n; i++) {
          const w = toWgs(r[i][0], r[i][1]);
          const x = M.x(w[0]);
          const y = M.y(w[1]);
          pts[i * 2] = x;
          pts[i * 2 + 1] = y;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
        rings.push({ pts, x0, y0, x1, y1 });
        if (x0 < bx0) bx0 = x0;
        if (x1 > bx1) bx1 = x1;
        if (y0 < by0) by0 = y0;
        if (y1 > by1) by1 = y1;
      }
      if (!rings.length) continue;
      out.push({
        adcode: f.adcode,
        name: f.name,
        rings,
        bbox: [bx0, by0, bx1, by1],
      });
    }
    CITY.set(adcode, out);
    return true;
  }

  /** 载入某省的区县几何。与 `buildCityGeometry` 逐字同构 —— 同一份数据源、
      同样必须做 GCJ→WGS 反算。区别只有数据表与 key：
      `window.GISDATA['county_' + adcode]`。 */
  function buildCountyGeometry(adcode) {
    const g = window.GISDATA && window.GISDATA['county_' + adcode];
    if (!g || !g.features) return false;
    const toWgs = toWgsOf(g);
    const out = [];
    for (const f of g.features) {
      const rings = [];
      let bx0 = Infinity;
      let by0 = Infinity;
      let bx1 = -Infinity;
      let by1 = -Infinity;
      for (const r of f.rings) {
        const n = r.length;
        if (n < 3) continue;
        const pts = new Float32Array(n * 2);
        let x0 = Infinity;
        let y0 = Infinity;
        let x1 = -Infinity;
        let y1 = -Infinity;
        for (let i = 0; i < n; i++) {
          const w = toWgs(r[i][0], r[i][1]);
          const x = M.x(w[0]);
          const y = M.y(w[1]);
          pts[i * 2] = x;
          pts[i * 2 + 1] = y;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
        rings.push({ pts, x0, y0, x1, y1 });
        if (x0 < bx0) bx0 = x0;
        if (x1 > bx1) bx1 = x1;
        if (y0 < by0) by0 = y0;
        if (y1 > by1) by1 = y1;
      }
      if (!rings.length) continue;
      out.push({
        adcode: f.adcode,
        name: f.name,
        /* 区县要素自带市名（`parentName`）。留着它，`labelAt()` 命中区县时
           就不必再去查一次市界 —— 少一次包含判定，也少一次懒加载触发。
           ⚠️ 直辖市与省直辖县那一档的值是字面量「不统计」（生成器给的），
           由 `PARENT_NONE` 挡掉，见 labelAt。 */
        parentName: f.parentName || '',
        rings,
        bbox: [bx0, by0, bx1, by1],
      });
    }
    COUNTY.set(adcode, out);
    return true;
  }

  /**
   * 按需把某省的市界脚本拉进来。**只有在真的需要判定、且该省有数据时才发请求。**
   * 一屏拆开的地点通常只落在一两个省，所以实际只会拉 1~2 个文件（各 22~129 KB）。
   *
   * 到货后重跑 `buildPhotos` —— 这是全项目唯一一处「因异步资源到货而重建地点集合」
   * 的地方。重建是幂等的：第二次跑时 `CITY` 已有数据，标签直接就是市名。
   * 收敛保证：`CITY_WANT` / `CITY_OK` 各拦一道，每个省最多注入一次、最多重试一次。
   */
  function ensureCity(adcode) {
    if (CITY.has(adcode) || CITY_WANT.has(adcode) || !CITY_OK.has(adcode)) return;
    CITY_WANT.add(adcode);
    const s = document.createElement('script');
    s.src = assetUrl(CITY_BASE + adcode + '.js');
    s.onload = function () {
      CITY_WANT.delete(adcode);
      if (!buildCityGeometry(adcode)) {
        CITY_OK.delete(adcode); // 名单里有、文件里没有 → 当场降级，别反复试
        return;
      }
      if (lastAlbum) {
        buildPhotos(lastAlbum, lastLabel);
        /* 重建之后**必须**重跑归属。
           `buildPhotos` 是整体重建：它 new 出一批全新的地点对象，只带
           name/city/lng/lat/spread/list/wx/wy —— `regionKey` / `regionName` /
           `provId` / `provName` / `solo` / `mst` 都不在里面，那六个字段只有
           `computeFill()` 会写。

           漏掉这一步的后果不是「标签难看」那么轻：`clusterize()` 靠
           `p.regionKey` 判「同区才合并」，靠 `p.solo` 挡中国台湾参与任何合并，
           靠 `p.mst` 保证港澳两个名字都写出来。字段全空之后
           `c.region !== p.regionKey` 变成 `'' !== ''`（假），那道闸**整条失效** ——
           跨国可以合并、中国台湾可以被并走、港澳会被标签分级精简掉。
           而这一切只在**用户放大到触发市界加载之后**才发生，静态截图看不出来。
           （这条漏了整整一轮：`assignLog` 不清空，所以「归属对不对」那组判据
           读的是上一次的旧记录，一直绿的；暴露它的是读 `places()[].provName`
           那条 —— 那个读的是重建后的新对象。）
           测试缝 `?noreassign` 跳过这一步，专门用来把这个洞打回来。 */
        if (!reassignOff) computeFill();
      }
    };
    s.onerror = function () {
      CITY_WANT.delete(adcode);
      CITY_OK.delete(adcode); // 部署漏了这个文件也不该让页面卡在「永远等不到」
    };
    document.head.appendChild(s);
  }

  /**
   * 按需把某省的区县界脚本拉进来。与 `ensureCity` 逐字同构。
   *
   * 体积比市界大一个量级（单省 22~636 KB，全部 31 个约 8.9 MB），所以
   * **懒加载是硬要求而不是优化**：只有真的需要区县名（地点被空间闸拆开、
   * 或相册名是自动生成的）时才会走到这里，而且只拉点所在的那一两个省。
   * 演示相册 86 个地点全部手写地名、没有任何拆分 → 一个字节都不会下载。
   *
   * 与市界一样，到货后重建 `buildPhotos` 并紧跟 `computeFill()`
   * （那一步漏掉的后果见上面 ensureCity 里的长注释，同一处教训）。
   */
  function ensureCounty(adcode) {
    if (COUNTY.has(adcode) || COUNTY_WANT.has(adcode) || !COUNTY_OK.has(adcode)) return;
    COUNTY_WANT.add(adcode);
    let s = document.createElement('script');
    s.src = assetUrl(COUNTY_BASE + adcode + '.js');
    s.onload = function () {
      COUNTY_WANT.delete(adcode);
      if (!buildCountyGeometry(adcode)) {
        COUNTY_OK.delete(adcode); // 名单里有、文件里没有 → 当场降级，别反复试
        return;
      }
      if (lastAlbum) {
        buildPhotos(lastAlbum, lastLabel);
        if (!reassignOff) computeFill();
      }
    };
    s.onerror = function () {
      COUNTY_WANT.delete(adcode);
      COUNTY_OK.delete(adcode);
    };
    document.head.appendChild(s);
  }

  /**
   * 载入国别几何。他国是 Natural Earth 50m，**本来就是 WGS-84**，
   * 不做任何坐标反算 —— 这一点与 province.js 相反，别顺手统一。
   *
   * 唯一要当心的是跨 ±180° 的环：等距经纬度上一条边从 +179 连到 −179，
   * 投影后会横贯整幅图，填出一整条色带。实测 238 国里只有南极洲的
   * ring#2 是这样（而且要横到 -85° 以下，正常视野看不到），直接跳过。
   */
  function buildCountryGeometry() {
    const t0 = performance.now();
    const g = window.GISDATA && window.GISDATA.world;
    const src = (g && g.countries) || [];
    for (const c of src) {
      const rings = [];
      let bx0 = Infinity;
      let by0 = Infinity;
      let bx1 = -Infinity;
      let by1 = -Infinity;
      for (const r of c.rings) {
        const n = r.length;
        if (n < 3) continue;
        /* 先量经度跨度，横跨 180° 的环直接丢（投影后会变成一条带） */
        let mn = Infinity;
        let mx = -Infinity;
        for (let i = 0; i < n; i++) {
          const lo = r[i][0];
          if (lo < mn) mn = lo;
          if (lo > mx) mx = lo;
        }
        if (mx - mn > 180) {
          ctryStat.skippedWide += 1;
          continue;
        }
        const pts = new Float32Array(n * 2);
        let x0 = Infinity;
        let y0 = Infinity;
        let x1 = -Infinity;
        let y1 = -Infinity;
        for (let i = 0; i < n; i++) {
          const x = M.x(r[i][0]);
          const y = M.y(r[i][1]);
          pts[i * 2] = x;
          pts[i * 2 + 1] = y;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
        rings.push({ pts, x0, y0, x1, y1 });
        if (x0 < bx0) bx0 = x0;
        if (x1 > bx1) bx1 = x1;
        if (y0 < by0) by0 = y0;
        if (y1 > by1) by1 = y1;
        ctryStat.rings += 1;
        ctryStat.verts += n;
      }
      if (!rings.length) continue;
      CTRY.push({
        iso: c.iso || '',
        name: c.name,
        zh: c.zh || c.name,
        rings,
        bbox: [bx0, by0, bx1, by1],
        count: 0,
        fill: null,
      });
    }
    ctryStat.features = CTRY.length;
    ctryStat.ms = Math.round(performance.now() - t0);
  }

  /* ======================================================================
     国家级「标注锚点」：一个区域**内部**的、靠近区域中心的一个点。

     为什么需要 —— 气泡的位置原本只有一个来源：**按张数加权的质心**。
     在省级 / 城市级它读起来没问题（照片就在附近），但到了**国家级**
     （气泡上写的就是国名）它会落在国境之外：实测一个相册里同时有黑龙江
     与广东的照片，145 张的质心落在**黄海海面**上 —— 气泡指着渤海与朝鲜
     半岛之间的水面，既不是任何一片拍摄地，也不像一个国家标签。
     用户报的正是它：「照片的指向了两地中间，会有歧义」。

     规则一句话：**位置跟标签走。** 气泡上写「中国」，就按中国的中心摆；
     写「巴黎·卢浮宫」，就还按照片质心摆（那个位置本身就是信息）。

     算法取「面积质心 + 落域外就吸附」而不是 polylabel：
       - polylabel（离边界最远点）在形状上最稳，但对**视觉中心**不忠实 ——
         中国算出来会落在新疆 / 内蒙古的腹地（因为离边界最远的点在那里），
         而人心里「中国的中心」在甘肃青海一带。面积质心给出的是后者。
       - 面积质心对挪威、智利、美国这些国家都落在境内；对群岛国
         （印尼、菲律宾）会落进海里 —— 所以配一条**落域外就吸附到最近的
         境内格点**的兜底。锚点只在国家级用一次，代价可以忽略。

     三个必须的修正 —— 都不是洁癖，每一个都能被 `__tdt.anchorAudit()`
     的读数打出来（改之前 / 之后的实测都记在 README「十一之十一」）：

     ① **等面积加权，不用投影面积。** Mercator 把面积按 1/cos²φ 放大，
        高纬国家的权重被灌水：俄罗斯 / 加拿大 / 挪威的质心被拖向北极，
        美国被拖进加拿大 —— 实测旧法给美国算出 −118.5°E / 47.7°N
        （华盛顿州），正确解应当在堪萨斯一带。乘回 cos²φ 即可还原真实面积。

     ② **纬度直接平均，不平均投影 y。** 同理，投影 y 在高纬被拉伸；
        质心的纬度取各环真实纬度的加权平均，再反投影回 y。

     ③ **吸附阶段逐个环搜，不用区域并集 bbox。** 跨 ±180° 的国家
        （斐济 / 新西兰 / 基里巴斯 / 马绍尔 / 密克罗尼西亚 / 帕劳 /
        法属波利尼西亚 / 新喀里多尼亚… 实测 11 个）环的一半在 +179°、
        一半在 −179°，归一化 x 上分列地图两端。并集 bbox 因此横跨整幅世界
        地图，25×25 个格点全落进别的大洋，一个境内点都搜不到 ——
        这 11 个国**一个都拿不到锚点**。改法是先把各环按周期展开到
        「面积最大的那个环」附近（消除 ±180° 断裂），再逐环在自己的
        bbox 里搜最近点。
     ====================================================================== */
  const anchorCache = new Map();
  const regionPartsCache = new Map();
  let cnAnchorRings = null;
  /* 经度的周期。**单位是弧度，不是 1** —— 世界坐标是 Web Mercator（弧度制，
     见文件头 M 的定义），整圈经度 = 2π。踩过：先按归一化 [0,1) 写了周期 1，
     于是「跨 ±180° 的展开」把全中国每个环都平移了一整圈，
     中国的锚点算到了几内亚湾（−1.6°E），239 个国全部报 outside。 */
  const X_PERIOD = Math.PI * 2;

  /** 区域的全部环。中国 = 34 个省环的并集（去掉礁盘小环）；他国 = world.js 的该国环。 */
  function regionRings(key) {
    if (key === 'CN') {
      if (!cnAnchorRings) {
        const acc = [];
        for (let i = 0; i < PROV.length; i++) {
          const rs = PROV[i].rings;
          for (let j = 0; j < rs.length; j++) {
            const r = rs[j];
            /* 只留大环：海南那 258 个礁盘环对找锚点毫无帮助，却要多算百倍 */
            if (r.x1 - r.x0 < 0.01 || r.y1 - r.y0 < 0.01) continue;
            acc.push(r);
          }
        }
        cnAnchorRings = acc;
      }
      return cnAnchorRings.length ? cnAnchorRings : null;
    }
    for (let i = 0; i < CTRY.length; i++) {
      const c = CTRY[i];
      if ((c.iso || c.name) === key) return c.rings;
    }
    return null;
  }

  /* 一个环的：等面积质心、真实（等面积）权重。
     权重 = 投影环面积 × cos²φ —— Mercator 的面积放大系数恰好是 1/cos²φ，
     乘回去就是真实面积。φ 取该环质心所在的纬度。

     环面积退化（|a| 小到浮点噪声）直接返回 null：礁盘、单点环之类。 */
  function ringPart(r) {
    const p = r.pts;
    const n = p.length / 2;
    /* 鞋带公式：一次遍历同时得面积与一阶矩 */
    let a = 0;
    let mx = 0;
    let my = 0;
    for (let j = 0, k = n - 1; j < n; k = j++) {
      const xj = p[j * 2];
      const yj = p[j * 2 + 1];
      const xk = p[k * 2];
      const yk = p[k * 2 + 1];
      const cr = xk * yj - xj * yk;
      a += cr;
      mx += (xk + xj) * cr;
      my += (yk + yj) * cr;
    }
    if (!(Math.abs(a) > 1e-13)) return null;
    const cx = mx / (3 * a);
    const cy = my / (3 * a);
    const lat = M.lat(cy);
    const cl = Math.cos((lat * Math.PI) / 180);
    return { r: r, cx: cx, cy: cy, lat: lat, w: Math.abs(a) * cl * cl, off: 0 };
  }

  /* 区域 → 「环部件表」。每个部件带一个**周期偏移** off：
     把环整体平移整数个地图宽度，使它与「面积最大的那个环」（参考环）
     落在同一个经度周期里。对不跨 ±180° 的国家 off 恒为 0，行为与旧法一致；
     对跨 ±180° 的国家，这一步把断裂的两半重新拼回地理上挨着的位置。 */
  function regionParts(key) {
    if (regionPartsCache.has(key)) return regionPartsCache.get(key);
    const rings = regionRings(key);
    let res = null;
    if (rings && rings.length) {
      const arr = [];
      let refX = 0;
      let maxW = -1;
      for (let i = 0; i < rings.length; i++) {
        const q = ringPart(rings[i]);
        if (!q) continue;
        arr.push(q);
        if (q.w > maxW) {
          maxW = q.w;
          refX = q.cx;
        }
      }
      if (arr.length) {
        for (let i = 0; i < arr.length; i++) {
          /* off = 整数个「地图宽度」，直接存成 x 单位（弧度），
             后面三处（质心加权 / 逐环搜 / 折回判定）都在 x 单位下用它。 */
          arr[i].off = Math.round((refX - arr[i].cx) / X_PERIOD) * X_PERIOD;
        }
        res = arr;
      }
    }
    regionPartsCache.set(key, res);
    return res;
  }

  /* 点是否在区域内（evenodd 计数）。xU 是**展开后**的归一化 x，
     可以超出 [0,1) —— 每个环按自己的 off 折回来再判。 */
  function insideParts(parts, xU, y) {
    let n = 0;
    for (let i = 0; i < parts.length; i++) {
      const q = parts[i];
      const r = q.r;
      const x = xU - q.off;
      if (x < r.x0 || x > r.x1 || y < r.y0 || y > r.y1) continue;
      if (pointInPts(r.pts, x, y)) n += 1;
    }
    return (n & 1) === 1;
  }

  function regionAnchor(key) {
    if (anchorCache.has(key)) return anchorCache.get(key);
    const parts = regionParts(key);
    let res = null;
    if (parts && parts.length) {
      /* ① 质心：等面积加权；经度用展开值（跨 ±180° 的两半才算得对），
         纬度用真实纬度的加权平均（不平均投影 y）。 */
      let sx = 0;
      let sy = 0;
      let sw = 0;
      for (let i = 0; i < parts.length; i++) {
        const q = parts[i];
        sx += (q.cx + q.off) * q.w;
        sy += q.lat * q.w;
        sw += q.w;
      }
      if (sw > 0) {
        const cU = sx / sw; /* 展开后的投影 x（弧度） */
        const cLat = sy / sw; /* 度 */
        const yOfLat = M.y(cLat);
        if (insideParts(parts, cU, yOfLat)) {
          res = { wx: wrapX(cU), wy: yOfLat, exact: true };
        } else {
          /* ② 质心落在域外（群岛国、被海隔开的国）→ 吸附到最近的境内格点。
             逐环在自己 bbox 里搜，不能用「全区域并集 bbox」——
             跨 ±180° 的国家并集横跨整幅地图，格点全落进别的大洋（见头注③）。
             距离在经纬度上量，经度按质心纬度的 cos 压缩（否则高纬经度被高估）。 */
          const cLon = M.lng(cU);
          const kx = Math.cos((cLat * Math.PI) / 180);
          let bd = Infinity;
          let bLon = 0;
          let bLat = 0;
          let found = false;
          const N = 12;
          for (let i = 0; i < parts.length; i++) {
            const q = parts[i];
            const lon0 = M.lng(q.r.x0 + q.off);
            const lon1 = M.lng(q.r.x1 + q.off);
            const lat0 = M.lat(q.r.y1);
            const lat1 = M.lat(q.r.y0);
            for (let a = 0; a <= N; a++) {
              const lon = lon0 + ((lon1 - lon0) * a) / N;
              const xu = M.x(lon);
              for (let b = 0; b <= N; b++) {
                const lat = lat0 + ((lat1 - lat0) * b) / N;
                if (!insideParts(parts, xu, M.y(lat))) continue;
                const dx = (lon - cLon) * kx;
                const dy = lat - cLat;
                const d = dx * dx + dy * dy;
                if (d < bd) {
                  bd = d;
                  bLon = lon;
                  bLat = lat;
                  found = true;
                }
              }
            }
          }
          if (found) {
            res = { wx: wrapX(M.x(bLon)), wy: M.y(bLat), exact: false };
          }
        }
      }
    }
    anchorCache.set(key, res);
    return res;
  }

  /** 投影 x 折回单周期 [−π, π)。 */
  function wrapX(x) {
    let v = x + Math.PI;
    v -= Math.floor(v / X_PERIOD) * X_PERIOD;
    return v - Math.PI;
  }

  /** 点是否在该区域境内（严格，不带「最近」兜底）—— 读数口用它验锚点有没有出界。 */
  function regionContains(key, wx, wy) {
    const parts = regionParts(key);
    if (!parts || !parts.length) return false;
    /* 点可能落在与参考环相邻的周期上，三档都试一遍 */
    if (insideParts(parts, wx, wy)) return true;
    if (insideParts(parts, wx + X_PERIOD, wy)) return true;
    if (insideParts(parts, wx - X_PERIOD, wy)) return true;
    return false;
  }

  /** 射线法。返回值与填充用的 evenodd 同一套语义 —— 洞与嵌套岛自动正确。 */
  function pointInPts(p, x, y) {
    let inside = false;
    for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
      const xi = p[i];
      const yi = p[i + 1];
      const xj = p[j];
      const yj = p[j + 1];
      if (yi > y !== yj > y) {
        if (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
    }
    return inside;
  }

  /* 水面上的点要兜底。
     行政区面**只画陆地**，所以港内、海岛近岸、湖面上的坐标会落在所有环之外 ——
     实测演示数据里「中国香港·维港」与「三亚·天涯海角」就是这种：
     不兜底的话这两张会静默地从密度统计里消失（省计数少 1，且没有任何提示）。
     主线的口径是「判给最近的省」，这里照做，但设一个上限免得境外照片被硬塞进某个省。 */
  const NEAR_CAP = 0.006; // 世界坐标是弧度，0.006rad ≈ 35km

  function distToRing(p, x, y, cap) {
    let best = cap;
    for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
      const ax = p[j];
      const ay = p[j + 1];
      const bx = p[i];
      const by = p[i + 1];
      const da = (ax - x) * (ax - x) + (ay - y) * (ay - y);
      const db = (bx - x) * (bx - x) + (by - y) * (by - y);
      /* 先用两个端点的距离挡一层。绝大多数边连端点都远在 cap 之外，
         这样能省掉点到线段那一步的开方。 */
      if (da < best * best || db < best * best) {
        const dx = bx - ax;
        const dy = by - ay;
        const l2 = dx * dx + dy * dy;
        let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = ax + dx * t;
        const py = ay + dy * t;
        const d = Math.sqrt((px - x) * (px - x) + (py - y) * (py - y));
        if (d < best) best = d;
      }
    }
    return best;
  }

  /** 「判给最近的要素」。省与国共用这一份 —— 环的表示完全一样。 */
  function nearestShape(list, x, y) {
    let bestF = null;
    let bestD = Infinity;
    for (const f of list) {
      if (
        x < f.bbox[0] - NEAR_CAP ||
        x > f.bbox[2] + NEAR_CAP ||
        y < f.bbox[1] - NEAR_CAP ||
        y > f.bbox[3] + NEAR_CAP
      ) {
        continue;
      }
      for (const r of f.rings) {
        if (x < r.x0 - NEAR_CAP || x > r.x1 + NEAR_CAP || y < r.y0 - NEAR_CAP || y > r.y1 + NEAR_CAP) continue;
        const d = distToRing(r.pts, x, y, bestD);
        if (d < bestD) {
          bestD = d;
          bestF = f;
        }
      }
    }
    return bestD <= NEAR_CAP ? bestF : null;
  }

  function nearestProvince(x, y) {
    return nearestShape(PROV, x, y);
  }

  function nearestCountry(x, y) {
    return nearestShape(CTRY, x, y);
  }

  /* ------------------------------------------------------------- 颜色工具 */

  /** '#rrggbb' → [r,g,b]。只在换肤时调，不进热路径。 */
  function hexToRgb(s) {
    const v = parseInt(s.slice(1), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }

  /** 两色线性插值，t=0 取 a，t=1 取 b。返回数组，便于再叠一层提亮。 */
  function mixArr(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }

  /** 往黑里混（保持色相比例），用于 hover —— 「深一点」的那个「深」。 */
  function deepArr(a, t) {
    return mixArr(a, [0, 0, 0], t);
  }

  function cssRgb(a) {
    return 'rgb(' + (a[0] | 0) + ',' + (a[1] | 0) + ',' + (a[2] | 0) + ')';
  }

  /** 把色阶缓存成 rgb 数组，避免每帧重新解析色号。 */
  const RAMP_RGB = [[], [], [], [], []];

  /* 悬停描边用主题强调色，与色阶一起在换肤时刷新 —— 不另立一套颜色。 */
  let accentCss = '#e9b04a';
  function accentColor() {
    return accentCss;
  }

  /**
   * 中国的「国 → 省」过渡系数。0 = 全省同色（一个国家），1 = 逐省分色。
   * 用连续过渡而不是硬切：硬切在阈值处会整块跳色。
   */
  function chinaT(k) {
    if (k <= CH_LO_K) return 0;
    if (k >= CH_HI_K) return 1;
    return (k - CH_LO_K) / (CH_HI_K - CH_LO_K);
  }

  /* --------------------------------------------------------- hover 聚焦 */

  /* 当前悬停的区域。null 表示没有。结构见 hitFill()。 */
  let hoverRegion = null;
  /* 待命中的屏幕点（在 pointermove 里写，在 frame() 里算）。
     pointermove 的触发频率可以高于帧率，命中测试要做射线法，不能每来一个事件算一次。
     hoverMoved 是「自上次解算之后鼠标确实动过」的标记 —— 没有它的话，
     鼠标静止时每一帧都要把命中测试跑一遍。
     hoverCamSig 是「上次解算时的相机」。**只认 hoverMoved 是不够的**：
     滚轮缩放/程序改视野之后鼠标并没有动，但光标底下已经换了一个区域，
     旧的悬停区会一直挂着 —— 表现为「高亮赖在别的地方不走」。
     （曾经还会把其余色块一起压暗，那时更是「地图毫无理由地暗了一大片」；
      压暗已经删掉，但这个相机签名必须留着，否则高亮会停在一个错的区域上。） */
  let hoverPt = null;
  let hoverMoved = false;
  let hoverCamSig = '';

  /**
   * 填色层的命中测试。**只测有照片的区域** —— 没有照片的区块在视觉上
   * 只是「别国的底色」，对它做高亮没有信息量，反而会让鼠标到处都有反应。
   *
   * 粒度跟着填色走：中国在世界视图下是一个整体，就整块作为命中目标；
   * 放大到省级后（t ≥ 0.5）才逐省命中。这样「高亮的范围」与「看到的色块」
   * 永远一致 —— 否则世界视图下会高亮出一个 3px 的省，与肉眼所见不符。
   */
  function hitFill(x, y, t) {
    /* 省先测：中国境内没有他国，顺序只影响性能不影响正确性 */
    if (chinaTotal > 0) {
      let hitProv = null;
      for (const f of PROV) {
        if (x < f.bbox[0] || x > f.bbox[2] || y < f.bbox[1] || y > f.bbox[3]) continue;
        for (const r of f.rings) {
          if (x < r.x0 || x > r.x1 || y < r.y0 || y > r.y1) continue;
          if (pointInPts(r.pts, x, y)) {
            hitProv = f;
            break;
          }
        }
        if (hitProv) break;
      }
      if (!hitProv) hitProv = nearestProvince(x, y);
      if (hitProv) {
        if (t >= 0.5) {
          if (hitProv.count > 0) {
            return { kind: 'prov', ref: hitProv, name: hitProv.name, count: hitProv.count };
          }
        } else {
          return { kind: 'china', ref: null, name: '中国', count: chinaTotal };
        }
      }
    }
    for (const c of CTRY) {
      if (!c.count) continue;
      if (x < c.bbox[0] || x > c.bbox[2] || y < c.bbox[1] || y > c.bbox[3]) continue;
      for (const r of c.rings) {
        if (x < r.x0 || x > r.x1 || y < r.y0 || y > r.y1) continue;
        if (pointInPts(r.pts, x, y)) {
          return { kind: 'ctry', ref: c, name: c.zh, count: c.count };
        }
      }
    }
    return null;
  }

  function sameRegion(a, b) {
    if (!a || !b) return a === b;
    if (a.kind !== b.kind) return false;
    if (a.kind === 'china') return true;
    return a.ref === b.ref;
  }

  /* --------------------------------------------------- hover 气泡与解算 */

  let tipSig = '';
  let tipOn = false;

  function hideTip() {
    if (!tipOn && !tipSig) return;
    tipOn = false;
    tipSig = '';
    fillTipEl.classList.remove('is-on');
    /* 内容也清掉：否则读出口会拿到上一处的文案，
       看着像「隐藏了但还显示着」。 */
    fillTipEl.textContent = '';
  }

  /** 气泡里那个小色点用该区域的色阶色 —— 与地图上的色块对得上。 */
  function tipColor(h) {
    if (h.kind === 'china') return RAMP_RGB[densityIndex(chinaTotal)] || [233, 176, 74];
    return RAMP_RGB[densityIndex(h.count)] || [233, 176, 74];
  }

  function showTip(hit, pt) {
    if (!hit) {
      hideTip();
      return;
    }
    const sig = hit.name + '|' + hit.count;
    const first = sig !== tipSig;
    if (first) {
      tipSig = sig;
      const rgb = tipColor(hit);
      fillTipEl.innerHTML =
        '<i class="fill-tip__dot" style="background:' +
        cssRgb(rgb) +
        '"></i><b class="fill-tip__name">' +
        hit.name +
        '</b><span class="fill-tip__n">' +
        hit.count +
        ' 张照片</span>';
    }
    /* 靠右/靠下时翻到另一侧。用已知的 size，不读布局 —— 免得每帧强制重排。 */
    let x = pt.x + 14;
    let y = pt.y + 18;
    if (x + 168 > size.w) x = pt.x - 14 - 168;
    if (y + 34 > size.h) y = pt.y - 18 - 34;
    if (x < 4) x = 4;
    if (y < 4) y = 4;
    fillTipEl.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
    if (!tipOn) {
      tipOn = true;
      fillTipEl.classList.add('is-on');
    }
  }

  /* hover 的解算放在帧里，不放事件里：命中测试要做射线法，
     而 pointermove 的触发频率可以高于帧率。解的触发条件有**两个**：
     鼠标动过（hoverMoved），或者相机变了（hoverCamSig 不等）——
     后者见上面 hoverCamSig 的说明。
     （hoverPt / hoverMoved / hoverCamSig 三个状态上面已经声明过了。） */
  function resolveHover() {
    const sig = t2.k + ',' + t2.tx + ',' + t2.ty;
    if (!hoverMoved && sig === hoverCamSig) return;
    hoverMoved = false;
    hoverCamSig = sig;
    /* 填色都淡出到看不见了，就不该还有 hover 反馈 ——
       否则鼠标划过一片空白还会弹气泡。 */
    if (!hoverPt || fillAlpha(t2.k) < 0.004) {
      hideTip();
      if (hoverRegion) {
        hoverRegion = null;
        fillDirty = true;
      }
      return;
    }
    const wx = (hoverPt.x - t2.tx) / t2.k;
    const wy = (hoverPt.y - t2.ty) / t2.k;
    const hit = hitFill(wx, wy, chinaT(t2.k));
    if (!sameRegion(hit, hoverRegion)) {
      hoverRegion = hit;
      fillDirty = true;
    }
    showTip(hit, hoverPt);
  }

  function clearHover() {
    hoverPt = null;
    hoverMoved = false;
    hideTip();
    if (hoverRegion) {
      hoverRegion = null;
      fillDirty = true;
    }
  }

  function refreshRamp() {
    const id = appEl.dataset.theme || '';
    if (id === rampKey) return;
    rampKey = id;
    const cs = getComputedStyle(appEl);
    for (let i = 0; i < 5; i++) {
      const v = cs.getPropertyValue('--m-d' + (i + 1)).trim();
      if (v) RAMP[i] = v;
      RAMP_RGB[i] = hexToRgb(RAMP[i]);
    }
    const ac = cs.getPropertyValue('--m-accent').trim();
    if (ac) accentCss = ac;
    for (const f of PROV) f.fill = f.count > 0 ? RAMP[densityIndex(f.count)] : null;
    for (const c of CTRY) c.fill = c.count > 0 ? RAMP[densityIndex(c.count)] : null;
  }

  /**
   * 相册变了或换肤了都要重算：计数 → 上色。
   *
   * 归属分两级，按「省 → 国」的顺序判：
   *   ① 落在中国某个省里（或 35km 内最近的省）→ 中国，省级计数
   *   ② 否则落在某个国家里（或 35km 内最近的国家）→ 该国，国家级计数
   *
   * 顺序不能反：world.js 里中国被刻意剔除了，所以中国境内不会误判成他国；
   * 但反过来先判国家的话，沿海的点判到哪个国家都说不准。
   */
  function computeFill() {
    for (const f of PROV) {
      f.count = 0;
      f.fill = null;
    }
    for (const c of CTRY) {
      c.count = 0;
      c.fill = null;
    }

    let unassigned = 0;
    let nearAssigned = 0;
    let cUnassigned = 0;
    let cNearAssigned = 0;
    assignLog.length = 0;

    for (const p of PHOTOS) {
      /* ---- 一级：省 ---- */
      let hitF = null;
      for (const f of PROV) {
        if (p.wx < f.bbox[0] || p.wx > f.bbox[2] || p.wy < f.bbox[1] || p.wy > f.bbox[3]) continue;
        for (const r of f.rings) {
          if (p.wx < r.x0 || p.wx > r.x1 || p.wy < r.y0 || p.wy > r.y1) continue;
          if (pointInPts(r.pts, p.wx, p.wy)) {
            hitF = f;
            break;
          }
        }
        if (hitF) break;
      }
      /* 不在任何省内 → 判给最近的省（水面上的点走这条）。再远就真的不投了 */
      let via = 'in';
      if (!hitF) {
        hitF = nearestProvince(p.wx, p.wy);
        if (hitF) via = 'near';
      }
      if (hitF) {
        if (via === 'near') nearAssigned += 1;
        hitF.count += p.list.length;
        /* 归属写到地点上：聚合层要用它做「同区才合并」的判断 */
        p.regionKey = 'CN';
        p.regionName = '中国';
        p.provId = hitF.adcode;
        /* 省名留下来：标签分级在「同省不同市」时要报省名（见 clusterLabel）。
           只留 adcode 不够 —— 聚合层拿不到「浙江省」这三个字。 */
        p.provName = hitF.name || '';
        /* 合规标记：中国台湾不参与任何合并；中国香港/中国澳门必须单列标注 */
        p.solo = !!SOLO_ADCODES[hitF.adcode];
        p.mst = MUST_SHOW_ADCODES[hitF.adcode] ? hitF.adcode : 0;
        assignLog.push([p.name, hitF.adcode, via]);
        continue;
      }

      /* ---- 二级：国家 ---- */
      let hitC = null;
      for (const c of CTRY) {
        if (p.wx < c.bbox[0] || p.wx > c.bbox[2] || p.wy < c.bbox[1] || p.wy > c.bbox[3]) continue;
        for (const r of c.rings) {
          if (p.wx < r.x0 || p.wx > r.x1 || p.wy < r.y0 || p.wy > r.y1) continue;
          if (pointInPts(r.pts, p.wx, p.wy)) {
            hitC = c;
            break;
          }
        }
        if (hitC) break;
      }
      let cVia = 'in';
      if (!hitC) {
        hitC = nearestCountry(p.wx, p.wy);
        if (hitC) cVia = 'near';
      }
      if (!hitC) {
        /* 落到公海里（比如某个近海小岛的码头）。计数并记名，不静默丢 */
        unassigned += 1;
        cUnassigned += 1;
        p.regionKey = '';
        p.regionName = '';
        p.provId = 0;
        p.provName = '';
        p.solo = false;
        p.mst = 0;
        assignLog.push([p.name, 0, 'none']);
        continue;
      }
      if (cVia === 'near') {
        nearAssigned += 1;
        cNearAssigned += 1;
      }
      hitC.count += p.list.length;
      p.regionKey = hitC.iso || hitC.name;
      p.regionName = hitC.zh;
      p.provId = 0;
      /* 境外的省级我们不掌握（Natural Earth 的 admin-1 不在本线数据里），
         所以留空 —— 标签分级会跳过分级③，直接落到国名。
         城市段那一级仍然有效：东京的点聚一簇照样报「东京」。 */
      p.provName = '';
      p.solo = false;
      p.mst = 0;
      assignLog.push([p.name, hitC.iso, cVia]);
    }

    provStat.unassigned = cUnassigned;
    provStat.nearAssigned = nearAssigned;
    ctryStat.unassigned = cUnassigned;
    ctryStat.nearAssigned = cNearAssigned;

    let filled = 0;
    chinaTotal = 0;
    for (const f of PROV) {
      if (f.count > 0) {
        f.fill = RAMP[densityIndex(f.count)];
        filled += 1;
        chinaTotal += f.count;
      }
    }
    let cFilled = 0;
    for (const c of CTRY) {
      if (c.count > 0) {
        c.fill = RAMP[densityIndex(c.count)];
        cFilled += 1;
      }
    }
    provStat.filled = filled;
    ctryStat.filled = cFilled;
    provStat.ringsTotal = PROV.reduce((a, f) => a + f.rings.length, 0);
    /* 归属重算后旧的 hover 目标可能已经不再存在（比如那张照片被移走了），
       留着会指向一个 count=0 的形状，高亮一个空区域。 */
    hoverRegion = null;
    dirty = true;
  }

  function fillAlpha(k) {
    if (k <= FILL_FULL_K) return FILL_ALPHA;
    if (k >= FILL_ZERO_K) return 0;
    return (FILL_ALPHA * (FILL_ZERO_K - k)) / (FILL_ZERO_K - FILL_FULL_K);
  }

  /** 要素级视口剔除：整个形状都不在屏幕上就跳过 */
  function shapeOutside(s, k, tx, ty) {
    return (
      s.bbox[2] * k + tx < -8 ||
      s.bbox[0] * k + tx > size.w + 8 ||
      s.bbox[3] * k + ty < -8 ||
      s.bbox[1] * k + ty > size.h + 8
    );
  }

  /**
   * 把一个形状的所有环写进当前路径，返回写进去的环数。
   * 两道环级剔除：视口之外；以及屏幕尺寸小于 RING_MIN_PX 的亚像素环。
   * 后者只丢「光栅化不出来」的东西 —— 世界视图下少了 900 多次路径构造。
   */
  function pathShape(ctx, shape, k, tx, ty) {
    ctx.beginPath();
    let segs = 0;
    for (const r of shape.rings) {
      const x0 = r.x0 * k + tx;
      const x1 = r.x1 * k + tx;
      const y0 = r.y0 * k + ty;
      const y1 = r.y1 * k + ty;
      if (x1 < -4 || x0 > size.w + 4 || y1 < -4 || y0 > size.h + 4) continue;
      if (x1 - x0 < RING_MIN_PX && y1 - y0 < RING_MIN_PX) continue;
      const p = r.pts;
      ctx.moveTo(p[0] * k + tx, p[1] * k + ty);
      for (let i = 2; i < p.length; i += 2) {
        ctx.lineTo(p[i] * k + tx, p[i + 1] * k + ty);
      }
      ctx.closePath();
      segs += 1;
    }
    return segs;
  }

  /**
   * 给「被 `pathShape()` 跳过的亚像素环」补一个最小可见尺寸的色块。
   *
   * 为什么需要它 —— 用户报的那个 bug 的真身：`pathShape()` 的环级 LOD 把
   * 一维都小于 `RING_MIN_PX`(0.6px) 的环整条丢掉，而**南海诸岛的礁盘在
   * 国家维度下正好全部落在这个阈值之下**。实测 k=201（世界视图）时，
   * 西沙 · 永兴岛 / 黄岩岛 / 太平岛 / 永暑礁 / 曾母暗沙的填色层像素
   * alpha 全是 0 —— 也就是「画了，但一个像素都没落到屏幕上」。
   * 海南省 258 个环里有 257 个是这种，于是整个南海在视觉上等于不存在。
   *
   * 规则：**两个方向各自至少 `RING_MARK_PX`，已经比它大的保持原样。**
   *   - 各向同性放大到同一个尺寸会把「长条形的礁」画成方块，形状信息丢失
   *   - 只补小的那一维、大的那维原样，长条礁仍然是长条，只是有了厚度
   *   - 中心恒等于环的真实中心 ⇒ **位置是真的**，被放大的只有尺寸
   *     这与 `revealPoint` 那种避让不同：这里没有任何「挪位置」的成分
   *
   * 单独开一条路径（不并进 `pathShape` 的那条）是必须的：填充用的是
   * `evenodd`，两个子路径一旦相交就会互相挖空 —— 香港那种「小岛紧挨大岛」
   * 的地方会出现白色的洞。
   */
  function minRingPath(ctx, shape, k, tx, ty) {
    ctx.beginPath();
    let n = 0;
    for (const r of shape.rings) {
      const x0 = r.x0 * k + tx;
      const x1 = r.x1 * k + tx;
      const y0 = r.y0 * k + ty;
      const y1 = r.y1 * k + ty;
      if (x1 < -4 || x0 > size.w + 4 || y1 < -4 || y0 > size.h + 4) continue;
      /* ⚠️ 这里的判据必须与 `pathShape()` 的 `continue` **严格互补**：
         那边是「两维都 < RING_MIN_PX 就跳过」，这边就是「只要有一维 ≥
         RING_MIN_PX 就不补」。于是一个环要么被 pathShape 画出来、
         要么在这里被补上，**既不会两个都做（重画会加深色块），
         也不会两个都不做（那正是南海那个 bug）**。
         这条互补性由 `verify-nanhai.js` 的 `ringPartitionExact` 直接锁住。 */
      if (x1 - x0 >= RING_MIN_PX || y1 - y0 >= RING_MIN_PX) continue;
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      const rx = Math.max(x1 - x0, RING_MARK_PX) / 2;
      const ry = Math.max(y1 - y0, RING_MARK_PX) / 2;
      /* ⚠️⚠️ 这一行 `moveTo` 不能省，省掉就会在南海画出一块巨大的三角形假色块。
       *
       * `ellipse()` 与 `arc()` 一样，在路径已有「当前点」时**会先补一条从当前点
       * 到圆弧起点的直线**（HTML 规范里 arc/ellipse 的 "add a straight line from
       * the current point to the start point of the arc"）。本函数是
       * 「一次 beginPath + 连续 N 次 ellipse」，中间没有任何 moveTo —— 于是
       * **这些本应彼此独立的小圆点被直线首尾串成一张网**，`nonzero` 填充再把
       * 网住的整片区域填实。南海诸岛刚好散落在几万平方公里的海面上，
       * 串出来的就是一块以海南岛东北角为顶点、一直扇到曾母暗沙的三角形。
       *
       * 最小复现（tools/_tmp-ellipse-moveTo.js，三个 2px 小圆排成大三角）：
       *     有 moveTo → 墨迹 48px，三角中心透明
       *     无 moveTo → 墨迹 38245px，三角中心纯白
       * `arc` 与 `ellipse` 行为完全一致。
       *
       * 起点取 `(cx + rx, cy)` 是因为 `ellipse(..., 0, 0, 2π)` 的零角起点就在
       * 这个位置 —— 补到**同一个点**上，等于只开了一条新子路径，不产生任何线段，
       * 圆点的形状与位置一个像素都不变。
       *
       * 判据：tools/verify-nanhai.js 的 `markPinsAreDisjoint` 直接锁「N 个补块的
       * 墨迹总量 ≈ N × π·(RING_MARK_PX/2)²」，串网会让它暴涨两个数量级。 */
      ctx.moveTo(cx + rx, cy);
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      n += 1;
    }
    return n;
  }

  /**
   * 一帧的填色绘制。
   *
   * 三种变化都只改画布参数、不改几何：
   *   fillAlpha(k)  整体缩放淡出（进城市尺度后不再铺色）
   *   chinaT(k)     中国的「国 ↔ 省」过渡：0 全省同色，1 逐省分色
   *   hoverRegion   聚焦高亮：**只**把悬停的那一块画深一点，其余色块一个像素都不动
   *
   * 分两遍画：非悬停的先画，被悬停的最后画 —— 后者要压在别的色块之上，
   * 否则相邻国家/省份的色块会盖住高亮，看起来像「高亮失效」。
   */
  function drawFill() {
    const dpr = size.dpr;
    fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fctx.clearRect(0, 0, size.w, size.h);
    refreshRamp();

    const k = t2.k;
    const tx = t2.tx;
    const ty = t2.ty;
    const a = fillAlpha(k);
    const t = chinaT(k);
    provStat.alpha = a;
    provStat.drawn = 0;
    provStat.markRings = 0;
    ctryStat.drawn = 0;
    /* ⚠️ 这一行以前漏了，于是 `ctryMarkRings` 是**跨帧累加值**而不是本帧值 ——
       读数口注释里写的是「本帧补的亚像素色块数」，实际读到的是历史总和。
       表现是「同一个相机下两次读数不同」（取决于之前画过多少帧），
       曾把一次排查带偏（108 vs 0 的差异其实是这个，不是几何差异）。 */
    ctryStat.markRings = 0;
    jiuStat.drawn = 0;
    jiuStat.lit = false;
    if (a < 0.004) {
      hoverRegion = null;
      return;
    }

    const hover = hoverRegion;
    /* 非悬停的色块一律按**原样**画：alpha 就是 a / alpha 本身，
       不再乘任何全局调制系数。想加回「聚焦」效果的人请先读 HOVER_UP 上面那段注释。 */
    const cnRgb = chinaTotal > 0 ? RAMP_RGB[densityIndex(chinaTotal)] : null;

    for (let pass = 0; pass < 2; pass++) {
      const wantHover = pass === 1;

      /* ---------------------------------------------------------- 他国 */
      for (const c of CTRY) {
        if (!c.count || !c.fill) continue;
        const isHover = !!(hover && hover.kind === 'ctry' && hover.ref === c);
        if (isHover !== wantHover) continue;
        if (shapeOutside(c, k, tx, ty)) continue;
        if (!pathShape(fctx, c, k, tx, ty)) continue;
        const rgb = isHover ? deepArr(RAMP_RGB[densityIndex(c.count)], HOVER_DEEP) : RAMP_RGB[densityIndex(c.count)];
        fctx.globalAlpha = Math.min(1, isHover ? a * HOVER_UP : a);
        fctx.fillStyle = cssRgb(rgb);
        /* evenodd：多环时洞会被自动挖掉、岛屿自动成岛 */
        fctx.fill('evenodd');
        ctryStat.drawn += 1;
        /* 亚像素岛礁补最小可见尺寸（规则与判据见 minRingPath） */
        const cmk = minRingPath(fctx, c, k, tx, ty);
        if (cmk) {
          fctx.fill();
          ctryStat.markRings += cmk;
        }
      }

      /* ---------------------------------------------------------- 中国 */
      if (!cnRgb) continue;
      for (const f of PROV) {
        const hasProv = f.count > 0;
        /* t=0：全省同色同透明度（读起来是一个国家）
           t=1：只有有照片的省在，各省各色
           中间：颜色与透明度一起过渡 —— 缺一个就会出现「色变了但没淡出」的突变 */
        const alpha = a * (hasProv ? 1 : 1 - t);
        if (alpha < 0.004) continue;
        const isHover = !!(hover && hover.kind === 'prov' && hover.ref === f);
        /* 低倍率下中国整体作为一个命中目标，所以每个省都算「被悬停」 */
        const isCnHover = !!(hover && hover.kind === 'china');
        const lit = isHover || isCnHover;
        if (lit !== wantHover) continue;
        if (shapeOutside(f, k, tx, ty)) continue;
        if (!pathShape(fctx, f, k, tx, ty)) continue;

        let rgb = cnRgb;
        if (hasProv) {
          const pRgb = RAMP_RGB[densityIndex(f.count)];
          rgb = t >= 1 ? pRgb : mixArr(cnRgb, pRgb, t);
        }
        if (lit) rgb = deepArr(rgb, HOVER_DEEP);
        fctx.globalAlpha = Math.min(1, lit ? alpha * HOVER_UP : alpha);
        fctx.fillStyle = cssRgb(rgb);
        fctx.fill('evenodd');
        provStat.drawn += 1;
        /* 亚像素岛礁补最小可见尺寸。**南海诸岛能不能被看见完全靠这一步**：
           海南省 258 个环里 257 个在国家维度下都小于 0.6px，没有它，
           「九段线以内所有岛屿都要有色块」这条要求做不到。 */
        const mk = minRingPath(fctx, f, k, tx, ty);
        if (mk) {
          fctx.fill();
          provStat.markRings += mk;
        }
      }
    }

    /* ------------------------------------------------------------ 九段线
     *
     * 压在所有填色**之上**（它是界线，不是区域）。
     *
     * 颜色取**中国整体色阶** `cnRgb`，不取海南省的 —— 理由两条：
     *   ① 国家标准地图上九段线从不跟省色走，它表达的是国界；
     *   ② 跟省色走会让它在「海南有没有照片」之间忽明忽暗，
     *      而用户要的恰恰是「国家维度下它必须亮着」。
     * t < 1 时这本来就是唯一正确的色（整个中国就是一个色），
     * 所以这条规则只在 t ≥ 1 时才与「按省分色」有可见差别。
     *
     * `cnRgb` 为空 = 中国一张照片都没有 → 整条不画。这**不构成领土表述缺失**：
     * 天地图底图自带的九段线始终在，本层的语义只是「你的照片在哪儿」，
     * 中国一张都没有时就没有可点亮的东西。测试缝 `?nojiu` 关掉画线本身。
     *
     * 数据里每一段**本身就是一条 dash**，所以只能整段实描边 + 圆头；
     * 再叠 `setLineDash` 会把每段切碎成一片糊（这是已经踩过的坑）。
     */
    if (jiuOn && cnRgb && JIU.length) {
      const jlit = !!(
        hover &&
        (hover.kind === 'china' || (hover.kind === 'prov' && hover.ref === CN_HN))
      );
      jiuStat.lit = jlit;
      fctx.strokeStyle = cssRgb(jlit ? deepArr(cnRgb, HOVER_DEEP) : cnRgb);
      fctx.globalAlpha = Math.min(1, jlit ? a * HOVER_UP : a);
      fctx.lineWidth = JIU_W;
      fctx.lineCap = 'round';
      fctx.lineJoin = 'round';
      for (const g of JIU) {
        if (g.x1 * k + tx < -8 || g.x0 * k + tx > size.w + 8) continue;
        if (g.y1 * k + ty < -8 || g.y0 * k + ty > size.h + 8) continue;
        fctx.beginPath();
        const p = g.pts;
        fctx.moveTo(p[0] * k + tx, p[1] * k + ty);
        for (let i = 2; i < p.length; i += 2) fctx.lineTo(p[i] * k + tx, p[i + 1] * k + ty);
        fctx.stroke();
        jiuStat.drawn += 1;
      }
      /* 圆头是给九段线专用的，不还给下一位 —— 下面那道悬停描边要的是平头，
         否则相邻两省的接缝会各自鼓出半个圆，看起来像一圈毛边。 */
      fctx.lineCap = 'butt';
      fctx.lineJoin = 'miter';
    }

    /* 悬停描边：单独一遍，压在所有填充之上。
       为什么要有它：提亮在深色主题下只差一点点，而一条亮边能立刻说清
       「高亮的是哪一块、边界在哪」。用主题强调色，不另立颜色。 */
    if (hover) {
      let rim = 0;
      if (hover.kind === 'ctry') rim = pathShape(fctx, hover.ref, k, tx, ty);
      else if (hover.kind === 'prov') rim = pathShape(fctx, hover.ref, k, tx, ty);
      if (rim) {
        fctx.globalAlpha = 0.9;
        fctx.strokeStyle = accentColor();
        fctx.lineWidth = 1.5;
        fctx.stroke();
      }
    }

    fctx.globalAlpha = 1;
  }

  /* ==================================================== 6.9 相册切换（演示 ⇄ 本地） */

  /* 本地照片的 objectURL 由我们负责回收：换一批照片时先释放上一批，
     否则每换一次就漏掉 2×N 个 blob，几十张就上百 MB。 */
  let ownUrls = [];

  /** 当前相册的经纬度包围盒，导入后用它装框 —— 「用我自己的照片看看效果」的那个「看」 */
  function boundsOf() {
    if (!PHOTOS.length) return null;
    let w = 180;
    let s = 90;
    let e = -180;
    let n = -90;
    for (const p of PHOTOS) {
      if (p.lng < w) w = p.lng;
      if (p.lng > e) e = p.lng;
      if (p.lat < s) s = p.lat;
      if (p.lat > n) n = p.lat;
    }
    /* 单点或极小的范围要撑开一点，否则 k 顶到上限、看不出「在哪儿」 */
    const dx = Math.max((e - w) * 1.3, 0.6);
    const dy = Math.max((n - s) * 1.3, 0.5);
    const cx = (w + e) / 2;
    const cy = (s + n) / 2;
    return [cx - dx / 2, cy - dy / 2, cx + dx / 2, cy + dy / 2];
  }

  /**
   * 相册装框用的框：在给定框的基础上**撑到 k 不超过 FILL_FULL_K**。
   *
   * 为什么需要这一步：只导入一两张照片时，包围盒只有零点几度，
   * fitBox 会把 k 推到 3 万量级 —— 而那个尺度下密度填色已经淡出（见 FILL_ZERO_K），
   * 于是用户导入完照片看到的是「什么都没有」，会以为功能坏了。
   * 撑到省一级（k ≤ FILL_FULL_K）既看得见自己的点，也看得见密度色。
   */
  function fitBoxForAlbum(box) {
    const availW = Math.max(40, size.w - PIN_EDGE * 2);
    const availH = Math.max(40, size.h - PIN_EDGE * 2);
    const needX = availW / FILL_FULL_K;
    const needY = availH / FILL_FULL_K;
    const wx0 = M.x(box[0]);
    const wx1 = M.x(box[2]);
    const wyN = M.y(box[3]); // 北的 y 更小
    const wyS = M.y(box[1]);
    const cx = (wx0 + wx1) / 2;
    const cy = (wyN + wyS) / 2;
    const sx = Math.max(wx1 - wx0, needX);
    const sy = Math.max(wyS - wyN, needY);
    /* 返回 [w, s, e, n]：y 小的是北，所以 n 取 cy - sy/2 */
    return [M.lng(cx - sx / 2), M.lat(cy + sy / 2), M.lng(cx + sx / 2), M.lat(cy - sy / 2)];
  }

  /**
   * 换一套相册。演示数据与本地照片走的是同一条路 ——
   * 区别只在 album.photos 里的 wgs / place / src 是谁给的。
   * @param box 装框目标；不传则自动取当前相册的包围盒（导入后「看我的照片」）
   * @param fitMs 装框动画时长；默认 520。启动时恢复存档要走 0 ——
   *        启动不该先演一段从全国拉到自己那几张图的动画（见 loadSavedAlbum）。
   */
  function applyAlbum(album, label, urls, box, fitMs) {
    window.PhotoImport.release(ownUrls);
    ownUrls = urls || [];
    buildPhotos(album, label);
    computeFill();
    closePanel();
    lastFit = fitBoxForAlbum(box || boundsOf() || HOME);
    userMoved = false;
    fitBox(lastFit, fitMs == null ? 520 : fitMs);
    dirty = true;
  }

  /* ============================================== 6.9b 相册存档（刷新不丢）
   *
   * 需求：客户端里导入自己的照片看完效果，**刷新不该重置**；
   * 只有手动点「回到演示数据」才清。
   *
   * 为什么页面自己不落盘：它（作为 iframe）跑在主进程起的**随机端口**静态服务上，
   * 源 = 协议 + 主机 + 端口 —— 端口每次都变，localStorage / IndexedDB 必然从零开始。
   * 所以真身放在 <userData>/album/，由主进程持有；这里只负责「打包/还原 + 上报」。
   * 细节与边界见 photo-store.js 的文件头、desktop/lib/album.js。
   *
   * 三条链：
   *   下行   boot() → PhotoStore.load() → （有存档就）建自己的照片而不是演示数据
   *   上行   导入成功 → PhotoStore.save() → postMessage → 壳 → IPC → 落盘
   *   清除   「回到演示数据」→ PhotoStore.clear()
   */

  /** 存档读数（探针用）。刻意**不**把字节留在这里 —— 那些只在 store 里过一遍。 */
  let savedInfo = { restored: 0, lastSave: '', reason: '', photos: 0, bytes: 0 };

  /**
   * 把一套相册存到本机。**必须传原始相册**（src / preview 还是 blob URL 的那份）——
   * 序列化要的就是那两个 blob 的字节，而 buildPhotos 之后记录里的 src 已经是
   * 给画布用的形态了。
   * 网页版没有宿主，PhotoStore.save() 直接回 false，这里如实报出来。
   */
  async function persistAlbum(album, label) {
    const PS = window.PhotoStore;
    if (!PS) return { ok: false, reason: '存档模块没加载（photo-store.js）' };
    if (!PS.available()) return { ok: false, reason: '网页版不落盘' };
    const r = await PS.save(album, label);
    savedInfo.lastSave = r && r.ok ? 'ok' : 'fail';
    savedInfo.reason = (r && r.reason) || '';
    savedInfo.photos = (r && r.photos) || 0;
    savedInfo.bytes = (r && r.bytes) || 0;
    return r;
  }

  /** 清掉本机存档。只有「回到演示数据」走这条路。 */
  async function dropSavedAlbum() {
    const PS = window.PhotoStore;
    if (!PS) return { ok: false, reason: '存档模块没加载（photo-store.js）' };
    const r = await PS.clear();
    if (r && r.ok) {
      savedInfo.restored = 0;
      savedInfo.lastSave = 'cleared';
    }
    return r;
  }

  /**
   * 取回上一次导入的相册。返回 { album, urls, label } —— 没有存档 / 没有宿主 /
   * 宿主不回应，三种都返回 null，调用方按演示相册走。
   *
   * ⚠️ 必须在**建点之前**调（见 boot）。晚一步就会先按演示数据画一帧、再跳一下。
   */
  async function loadSavedAlbum() {
    const PS = window.PhotoStore;
    if (!PS) return null;
    let r = null;
    try {
      r = await PS.load();
    } catch (e) {
      /* 读存档失败**不能**把启动挡下来：退回演示数据，把原因留在界面上。
         与 lib/store.js 读配置失败时的取舍一致。 */
      savedInfo.reason = '存档读取失败：' + ((e && e.message) || e);
      return null;
    }
    if (!r) return null;
    savedInfo.restored = r.album.photos.length;
    /* 恢复回来的两档小图是**新的** object URL（photo-store.js 从字节重新造的），
       必须挂到 ownUrls 上 —— 否则每恢复一次就漏掉 N×2 个 blob，
       几十张就上百 MB（与导入那条路同一条纪律，见上面 ownUrls 的注释）。 */
    ownUrls = r.urls;
    return r;
  }

  /* ================================================================ 7. 面板 */

  /* ---- 照片格子的 hover 气泡 ----

     与主线 photo-map.js 的同名函数逐行同构，改动请两边一起做。
     一个面板只建一个气泡元素、复用给所有格子（不在格子上挂监听）。
     数据从 li 的 data-* 读 —— 渲染时写、这里读，两边必须成对改。 */
  const TIP_EDGE = 8;

  function bindShotTips(panelEl, listEl) {
    const tip = document.createElement('div');
    tip.className = 'shot-tip';
    tip.setAttribute('aria-hidden', 'true');
    const placeEl = document.createElement('span');
    placeEl.className = 'shot-tip__place';
    const dateEl = document.createElement('span');
    dateEl.className = 'shot-tip__date';
    tip.append(placeEl, dateEl);
    panelEl.append(tip);

    let cur = null;

    function hide() {
      if (!cur) return;
      cur = null;
      tip.classList.remove('is-on');
    }

    function show(li) {
      const place = li.dataset.place || '';
      const date = li.dataset.date || '';
      placeEl.textContent = place;
      placeEl.hidden = !place;
      dateEl.textContent = date;
      dateEl.hidden = !date;

      /* 读-写分离：先把文字写完，一次性读尺寸，再只写 transform。
         气泡常驻 opacity:0，仍然参与布局 —— 所以不先把它显示出来也能量到尺寸。 */
      const pr = panelEl.getBoundingClientRect();
      const lr = li.getBoundingClientRect();
      const tw = tip.offsetWidth;
      const th = tip.offsetHeight;

      let x = lr.left - pr.left + lr.width / 2 - tw / 2;
      x = Math.max(TIP_EDGE, Math.min(x, pr.width - tw - TIP_EDGE));
      /* 默认贴在格子上方；顶到面板顶就翻到下方，免得压住标题行 */
      let y = lr.top - pr.top - th - 6;
      if (y < TIP_EDGE) y = lr.bottom - pr.top + 6;

      tip.style.transform = 'translate3d(' + Math.round(x) + 'px, ' + Math.round(y) + 'px, 0)';
      tip.classList.add('is-on');
    }

    /* 委托：格子可能上百个，不给每个挂监听。
       pointerover 在格子内部的 img 上也会冒泡上来，用 closest 归一到格子。 */
    listEl.addEventListener('pointerover', (e) => {
      const li = e.target instanceof Element ? e.target.closest('.shot') : null;
      if (!li || !listEl.contains(li)) return hide();
      if (li === cur) return;
      cur = li;
      show(li);
    });
    listEl.addEventListener('pointerleave', hide);
    /* 滚动时格子会从光标底下溜走，气泡必须跟着撤 */
    listEl.addEventListener('scroll', hide, { passive: true });
  }

  /* 时间跨度：首尾日期相差几天，含首尾（同一天算 1 天）。
     交给 Date.parse 而不是手算 —— 跨月跨年的进位不值得自己实现。 */
  function spanDays(dates) {
    if (!dates.length) return 0;
    const a = Date.parse(dates[0] + 'T00:00:00');
    const b = Date.parse(dates[dates.length - 1] + 'T00:00:00');
    if (!isFinite(a) || !isFinite(b) || b < a) return 1;
    return Math.round((b - a) / 86400000) + 1;
  }

  function openPanel(c) {
    const dates = c.list.map((s) => s.date).filter(Boolean).sort();
    /* 日期区间的格式照 UI 稿：`2025年12月-2026年10月` —— **年月粒度**、
       中间一个普通连字符、两侧不留空格。原来是 ISO 全日期配长破折号
       （`2024-07-24 — 2024-07-26`），与稿子对不上。
       粒度落到「月」之后，同月的两天会自动折成一项（比较的是**格式化后**的值，
       不是原始字符串）—— 起了几天由数据条里的「天数」交代，脚注不重复。
       稿里那一行的墨宽 135px，就是这个格式在 12px 下的宽度。 */
    const ym = (d) => {
      const m = /^(\d{4})-(\d{1,2})/.exec(String(d));
      return m ? m[1] + '年' + Number(m[2]) + '月' : String(d);
    };
    const span = dates.length
      ? ym(dates[0]) + (ym(dates[dates.length - 1]) !== ym(dates[0]) ? '-' + ym(dates[dates.length - 1]) : '')
      : '—';

    /* 头图的封面：当前点位的**第一张**照片，只当封面用。
       它在下面的缩略图列表里照旧出现一次 —— 哪怕这个地点只有这一张。
       「这个地点有几张照片」只能从列表数出来，封面不承担这个信息。 */
    const cover = c.list[0] || null;

    const multi = c.names.length > 1;
    let html = '';
    /* 面板第一屏就是这张封面：图片铺满，下 1/3 高斯模糊，再叠一层白渐变，
       标题压在渐变的尾巴上。三层的分工与每个数值的出处写在 photo-map.css 的
       .panel__hero 那一段里（这里只搭结构）。
       关闭按钮已经移除：UI 稿的右上角是干净的圆角。关面板仍然有两条路 ——
       点地图（stageEl 的 click）、按 Esc，都在第 8 节接着。 */
    html += '<div class="panel__hero">';
    if (cover) html += '<img class="panel__hero-img" alt="" aria-hidden="true" />';
    html += '<div class="panel__hero-blur" aria-hidden="true"></div>';
    html += '<div class="panel__hero-fade" aria-hidden="true"></div>';
    html += '<div class="panel__hero-text">';
    html += '<h2 class="panel__place"></h2>';
    html += '<p class="panel__adm"></p>';
    html += '</div>';
    html += '</div>';
    /* 数据条只放短值（纯数字），长文本一律下沉到脚注 ——
       短值横排装不下「2024-07-24 — 2024-07-26」这种长度。
       标签用「天数」而不是「天」：UI 稿里是两字，与「照片 / 地点」齐宽。 */
    html += '<div class="panel__stats">';
    html += '<div class="panel__stat" data-stat="photos"><span class="panel__stat-v"></span><span class="panel__stat-k">照片</span></div>';
    if (multi) html += '<div class="panel__stat" data-stat="spots"><span class="panel__stat-v"></span><span class="panel__stat-k">地点</span></div>';
    html += '<div class="panel__stat" data-stat="days"><span class="panel__stat-v"></span><span class="panel__stat-k">天数</span></div>';
    html += '</div>';
    html += '<p class="panel__foot"><span></span><span></span></p>';
    html += '<div class="panel__list"></div>';

    panelEl.innerHTML = html;
    /* 封面单独赋 src，不走 innerHTML —— 照片地址里可能含用户自己的文件夹名，
       拼进 HTML 就是把未转义的字符串当标记用（与下面副标题同一理由）。 */
    const heroImg = cover ? panelEl.querySelector('.panel__hero-img') : null;
    if (heroImg) heroImg.src = cover.preview || cover.src;
    panelEl.querySelector('.panel__place').textContent = c.names[0];
    /* 标题已经点了第一个地点，这里只列其余 —— 不再把「北京·故宫」说两遍。

       分隔符用**浅色斜线**，不用中点：地点名内部已经拿「·」表达从属关系
       （「丽江·古城」= 丽江的古城），同级地点再用「 · 」分隔，两种关系字形一样，
       读者分不出「丽江·玉龙雪山 · 大理·古城」是两处还是四处。
       斜线只承担分隔，故与地名分开成独立元素，才能单独调浅；
       它同时 aria-hidden —— 对读屏软件是纯装饰，念出来只是噪声。
       文字仍留在 textContent 里，复制出去是「A/B/C」，不会黏成一段。

       这里必须用 DOM 拼装而不是 innerHTML：地点名有一部分来自用户自己的
       文件夹名，走 innerHTML 就是把未转义的字符串塞进 HTML。 */
    const admEl = panelEl.querySelector('.panel__adm');
    if (multi) {
      for (let i = 1; i < c.names.length; i++) {
        if (i > 1) {
          const sep = document.createElement('span');
          sep.className = 'panel__adm-sep';
          sep.setAttribute('aria-hidden', 'true');
          sep.textContent = '/';
          admEl.appendChild(sep);
        }
        admEl.appendChild(document.createTextNode(c.names[i]));
      }
    }

    const setStat = (key, value) => {
      const el = panelEl.querySelector('[data-stat="' + key + '"] .panel__stat-v');
      if (el) el.textContent = value;
    };
    setStat('photos', String(c.list.length));
    setStat('spots', String(c.names.length));
    setStat('days', String(spanDays(dates)));

    /* 脚注两段的**顺序**跟 UI 稿：坐标在左、日期区间在右（两端对齐）。
       稿里坐标墨迹 768~899、日期 944~1078 —— 短的那段在左。 */
    const foot = panelEl.querySelectorAll('.panel__foot span');
    foot[0].textContent = M.lng(c.wx).toFixed(4) + '°E, ' + M.lat(c.wy).toFixed(4) + '°N';
    foot[1].textContent = span;

    /* 图片下方不再放任何文字：地点与日期移到 hover 气泡（见 bindShotTips）。
       data-* 是气泡唯一的数据来源，改这里要连着改那边。

       列表**无条件**渲染 c.list 的每一项 —— 包括「这个地点只有 1 张」那种
       （演示数据 86 个地点里有 83 个是这种）。不要因为「封面已经显示过第一张」
       就把列表里那一张省掉：封面是装饰，列表才是「有几张」的证据。
       列表里第一格与头图是同一张照片，这是有意的重复。 */
    const listEl = panelEl.querySelector('.panel__list');
    for (const s of c.list) {
      const li = document.createElement('div');
      li.className = 'shot';
      li.dataset.place = s.place || c.names[0] || '';
      li.dataset.date = s.date || '';
      const im = document.createElement('img');
      im.className = 'shot__img';
      im.loading = 'lazy';
      im.decoding = 'async';
      im.alt = s.place || '';
      /* 本地照片带 preview（512×384 那档）；演示数据没有，就用原图 */
      im.src = s.preview || s.src;
      li.appendChild(im);
      listEl.appendChild(li);
    }
    bindShotTips(panelEl, listEl);

    panelEl.classList.add('is-open');
    panelEl.setAttribute('aria-hidden', 'false');
    appEl.classList.add('is-panel');
  }

  function closePanel() {
    panelEl.classList.remove('is-open');
    panelEl.setAttribute('aria-hidden', 'true');
    appEl.classList.remove('is-panel');
  }

  /* ================================================================ 8. 交互 */

  let drag = null;
  const pointers = new Map();
  let pinch = null;
  let pinchDirty = false;
  let captured = false;
  let suppressClick = false;

  function localPt(e) {
    const r = stageEl.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function onWheel(e) {
    e.preventDefault();
    markMoved();
    const p = localPt(e);
    /* 每格 420 的刻度来自主线实测：再小会「一跳一格」，再大会拖泥带水 */
    zoomBy(Math.pow(2, -e.deltaY / 420), p.x, p.y);
  }

  function onDown(e) {
    if (e.button != null && e.button !== 0 && e.pointerType === 'mouse') return;
    /* 按下就收起 hover 反馈：拖动中地图在走，而气泡的位置不跟着走，
       留在屏幕上会同「停在那儿不动」。松手后移动鼠标自然会重新出现。 */
    clearHover();
    /* 这里刻意不调 setPointerCapture。pointerdown 会从 .pin 冒泡到 .stage，
       一旦此刻捕获，浏览器会把后续 click 改派到捕获目标，挂在 .pin 上的
       点按就永远收不到 —— 表现是「点照片没反应」。等拖出真实位移再捕获。 */
    const p = localPt(e);
    pointers.set(e.pointerId, p);
    suppressClick = false;
    if (pointers.size === 1) {
      drag = { x: p.x, y: p.y, ox: p.x, oy: p.y, id: e.pointerId };
      captured = false;
      tween = null;
    } else if (pointers.size === 2) {
      pinch = null;
      pinchDirty = true;
      drag = null;
    }
  }

  function onMove(e) {
    if (!pointers.has(e.pointerId)) return;
    const p = localPt(e);
    pointers.set(e.pointerId, p);

    if (!captured) {
      const far = drag ? Math.hypot(p.x - drag.ox, p.y - drag.oy) > 4 : true;
      if (pointers.size === 2 || far) {
        captured = true;
        suppressClick = true;
        try {
          stageEl.setPointerCapture(e.pointerId);
        } catch (_) {}
      }
    }

    if (pointers.size === 2) {
      pinchDirty = true;
      suppressClick = true;
      return;
    }

    if (drag) {
      /* 手指开始真正挪动了，就放弃进行中的缩放动画：
         否则两者各写各的 cam，表现成「拖不动」或者边拖边回弹 */
      markMoved();
      zoomView = null;
      tween = null;
      panBy(p.x - drag.x, p.y - drag.y);
      drag.x = p.x;
      drag.y = p.y;
    }
  }

  /* 双指：把「上一帧的手指对」到「这一帧的手指对」的变化一次性应用掉。
     不在 pointermove 里直接算 —— 一次触摸移动浏览器会逐指派两条 pointermove，
     各算一遍的话中间那一下只有一根手指到新位，平移量与锚点都取自半成品，
     误差逐次累积（主线实测横漂 10.1px）。合并到帧上就没有中间态。 */
  function applyPinch() {
    if (!pinchDirty) return;
    pinchDirty = false;
    if (pointers.size !== 2) return;
    const it = pointers.values();
    const a = it.next().value;
    const b = it.next().value;
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    if (!pinch) {
      pinch = { d: d, cx: cx, cy: cy };
      return;
    }
    /* 先平移再缩放：panBy 读的是当前仿射参数 t2，得先用它算完平移 */
    panBy(cx - pinch.cx, cy - pinch.cy);
    if (pinch.d > 0) zoomBy(d / pinch.d, cx, cy);
    pinch = { d: d, cx: cx, cy: cy };
  }

  function onUp(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) {
      drag = null;
      captured = false;
      if (stageEl.hasPointerCapture && stageEl.hasPointerCapture(e.pointerId)) {
        stageEl.releasePointerCapture(e.pointerId);
      }
    }
  }

  function bindEvents() {
    stageEl.addEventListener('wheel', onWheel, { passive: false });
    stageEl.addEventListener('pointerdown', onDown);
    stageEl.addEventListener('pointermove', onMove);
    stageEl.addEventListener('pointerup', onUp);
    stageEl.addEventListener('pointercancel', onUp);
    /* 填色层的 hover。只认鼠标 —— 触摸没有「悬停」，手指按住只会变成拖动，
       若也参与 hover 会出现「一按就弹出气泡又被拖走」的抖动。 */
    stageEl.addEventListener('pointermove', function (e) {
      if (e.pointerType !== 'mouse') return;
      if (pointers.size) return; // 正在拖动/缩放，不参与 hover
      hoverPt = localPt(e);
      hoverMoved = true;
    });
    stageEl.addEventListener('pointerleave', clearHover);
    stageEl.addEventListener('dblclick', function (e) {
      /* 双击也要钉住光标下那个地点。定点缓动插的是相机经纬度，
         点不在屏幕正中心时同样会横向漂 —— 与滚轮同一类毛病，走同一条路。 */
      markMoved();
      const p = localPt(e);
      zoomBy(1.8, p.x, p.y);
    });
    stageEl.addEventListener('click', function () {
      if (suppressClick) return;
      closePanel();
    });
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (keybox.classList.contains('is-open')) closeKeybox();
        else closePanel();
      }
    });
    window.addEventListener('resize', function () {
      resize();
      clearHover();
      fitIfNeeded();
    });
  }

  /* ============================================================= 9. 主循环 */

  function updateHud() {
    scaleTag.textContent = curZ ? 'z' + curZ : '—';
    attrScale.textContent = FAKE
      ? '测试瓦片 z' + curZ
      : TDT.tk
        ? '缩放 ' + Math.round(t2.k) + ' px/rad'
        : '未接入密钥';
  }

  function frame(now) {
    requestAnimationFrame(frame);
    stepTween(now);
    stepZoom(now);
    applyPinch();

    const v = viewFromCam(cam);
    if (v.k !== t2.k || v.tx !== t2.tx || v.ty !== t2.ty) {
      t2.k = v.k;
      t2.tx = v.tx;
      t2.ty = v.ty;
      dirty = true;
    }

    resolveHover();

    if (dirty || fillDirty) {
      if (dirty) {
        dirty = false;
        draw();
      }
      /* 填色层与底图同帧重画。它的 ctx 是独立的，不受底图那个 CSS filter 影响 */
      fillDirty = false;
      drawFill();
    }
    layoutMarkers(now);
    updateHud();
  }

  /* ============================================================== 10. 界面 */

  function buildThemes() {
    THEME_LIST.forEach(function (t) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'theme-chip' + (t.id === appEl.dataset.theme ? ' is-active' : '');
      chip.dataset.theme = t.id;
      chip.innerHTML =
        '<span class="theme-chip__swatch" style="background:linear-gradient(135deg,' +
        t.a +
        ' 0 50%,' +
        t.b +
        ' 50% 100%)"></span><span class="theme-chip__name">' +
        t.name +
        '</span>';
      chip.addEventListener('click', function () {
        appEl.dataset.theme = t.id;
        const all = themesEl.querySelectorAll('.theme-chip');
        for (let i = 0; i < all.length; i++) all[i].classList.toggle('is-active', all[i] === chip);
        dirty = true;
      });
      themesEl.appendChild(chip);
    });
  }

  function openKeybox() {
    keyInput.value = TDT.tk || '';
    /* 「记住密钥」这个开关只在网页版有意义：客户端下密钥的权威是
       <userData>/config.json，页面这边**不会**碰 localStorage（见上面那块说明）。
       所以嵌着跑时把这个勾连同它的行一起收起来 —— 摆在那里会让人以为
       「我勾了却没记住」，而实际上记住这件事由外层负责。 */
    const saveRow = keySave ? keySave.closest('.keybox__row') : null;
    if (saveRow) saveRow.hidden = embeddedInHost();
    /* 被客户端（Electron 外壳）嵌着跑时，得说清记住这件事由谁做。 */
    if (embeddedInHost()) {
      const hint = keybox.querySelector('.keybox__hint');
      if (hint) {
        hint.innerHTML =
          '在 <b>console.tianditu.gov.cn</b> 注册后「应用管理」里创建，选<b>浏览器端</b>，把当前域名填进白名单。' +
          '粘贴到这里即可，<b>客户端会替你记住</b>，下次打开不用再填。';
      }
    }
    keybox.classList.add('is-open');
    keybox.setAttribute('aria-hidden', 'false');
    setTimeout(function () {
      keyInput.focus();
    }, 60);
  }

  function closeKeybox() {
    keybox.classList.remove('is-open');
    keybox.setAttribute('aria-hidden', 'true');
  }

  /**
   * 向宿主上报密钥。
   *
   * 场景：本页被 Electron 客户端整个嵌在 iframe 里跑。客户端需要知道用户填了什么，
   * 才能替他把密钥存进自己的配置目录 —— 那条路径下页面这边**不落盘**
   * （见上面「密钥的本机记忆」：嵌着跑时 localStorage 一律不碰）。
   * 网页版（顶层页面）没有宿主可报，密钥由页面自己记在 localStorage 里。
   *
   * 两条收窄：
   *   ① 只在**同源宿主**下上报。判断办法是试着读 `parent.location.href` ——
   *      跨源会抛，读不到就不报。否则一串浏览器端密钥会被递给任意嵌入方。
   *   ② targetOrigin 钉成 `location.origin`，不用 `'*'`。
   *
   * 顶层页面（网页版）拿不到同源宿主，本函数直接返回。
   */
  function reportKey(tk) {
    if (window.parent === window) return;
    let sameOrigin = false;
    try { sameOrigin = !!window.parent.location.href; } catch (_) { sameOrigin = false; }
    if (!sameOrigin) return;
    try {
      window.parent.postMessage({ type: 'tdt:key', tk: tk }, location.origin);
    } catch (_) { /* 上报失败不影响本页：密钥已经在内存里生效了 */ }
  }

  /** 宿主是不是「同源的那个」—— 用于文案微调（客户端下会替用户记住密钥） */
  function embeddedInHost() {
    if (window.parent === window) return false;
    try { return !!window.parent.location.href; } catch (_) { return false; }
  }

  /* ------------------------------------------------------------ 密钥的本机记忆
   *
   * 这块以前**有意不做**：tdt-demo 会被部署成公开网页，把浏览器端密钥写进
   * localStorage 等于给它一个公开落点。所以那时的取舍是「只留内存，刷新就没了」。
   *
   * 现在前提变了 —— 站点定位已改为「家庭私密相册」（口令门 + noindex，见 robots.txt
   * 与 Nginx 的 X-Robots-Tag）。在一个本来就被门挡住的页面里，把密钥记住才是对的，
   * 「刷新就要重填」反而成了需要解释的怪事。
   *
   * 放宽的只有一条，边界仍在：
   *   ① **被客户端嵌着跑时一律不碰 localStorage**。桌面端的权威是
   *      <userData>/config.json（见 desktop/lib/store.js），而且那边的源是
   *      127.0.0.1 的**随机端口** —— 写进去也留不住，只会攒下一堆互不相认的孤儿值。
   *   ② 密钥只落在**本站源**下，不发往任何地方；页面 meta 已把 referrer 钉成 no-referrer。
   *   ③ 用户可以在密钥框里取消勾选，那会连旧的记录一起清掉（见 applyKey）。
   *
   * 测试缝 `?nostore` 关掉整块记忆（读写都停），好在探针里验「记不住会怎样」。
   */
  const TK_STORE = 'tdt.tk.v1';
  let storeOff = false;
  /* 密钥来源：'url' | 'store' | 'host' | 'manual' | 'none'。
     只用于读数 —— 「刷新后还要重填」这类问题靠它一眼定位。 */
  let tkSrc = 'none';

  function loadSavedKey() {
    if (storeOff || embeddedInHost()) return '';
    try {
      return (localStorage.getItem(TK_STORE) || '').trim();
    } catch (_) {
      /* 隐私模式或被策略禁用时 localStorage 会抛。读不到就当没有 ——
         绝不能让一个取不到的密钥把启动挡下来。 */
      return '';
    }
  }

  function saveKeyLocal(tk) {
    if (storeOff || embeddedInHost()) return false;
    try {
      localStorage.setItem(TK_STORE, tk);
      return true;
    } catch (_) {
      return false;
    }
  }

  function clearSavedKey() {
    try { localStorage.removeItem(TK_STORE); } catch (_) {}
  }

  function applyKey() {
    const tk = keyInput.value.trim().replace(/^.*tk=/, '');
    if (!tk) {
      toast('密钥不能为空');
      return;
    }
    TDT.tk = tk;
    tileImg.clear();
    tileReq.clear();
    loadedOnce = false;
    netErrors = 0;
    removeNoKey();
    /* 被客户端嵌着跑时，顺手上报给宿主落盘（见 reportKey）。网页版无人接收。 */
    reportKey(tk);
    /* 地址栏也带一份是可选项：勾了就能把链接发给别人，不勾则只在本机 */
    if (keyRemember.checked) {
      const u = new URL(location.href);
      u.searchParams.set('tk', tk);
      history.replaceState(null, '', u.toString());
    }
    /* 记住密钥（默认勾选）。取消勾选时连旧的记录一起清掉 ——
       否则「取消了却还在用」会让人以为这个开关是坏的。 */
    const wantStore = !keySave || keySave.checked;
    const stored = wantStore ? saveKeyLocal(tk) : (clearSavedKey(), false);
    tkSrc = 'manual';
    dirty = true;
    closeKeybox();
    toast(wantStore && stored ? '密钥已记住，正在拉取瓦片' : '密钥已应用，正在拉取瓦片');
  }

  let noKeyEl = null;

  function showNoKey(msg) {
    if (!noKeyEl) {
      noKeyEl = document.createElement('div');
      noKeyEl.className = 'nokey';
      stageEl.appendChild(noKeyEl);
    }
    noKeyEl.textContent = msg || '还没有天地图密钥 —— 点右上角「密钥」填入，交互部分现在就能用';
  }

  function removeNoKey() {
    if (noKeyEl && noKeyEl.parentNode) noKeyEl.parentNode.removeChild(noKeyEl);
    noKeyEl = null;
  }

  let toastTimer = 0;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('is-on');
    }, 2000);
  }

  function hideLoading() {
    loadingEl.classList.remove('is-on');
  }

  /* 视口尺寸变了之后再装一次框，但只在用户还没开始操作时做 ——
     否则会在用户正在看的位置上「跳」一下。 */
  let userMoved = false;
  function markMoved() {
    userMoved = true;
  }
  let lastFit = null;
  function fitIfNeeded() {
    if (userMoved) return;
    fitBox(lastFit || HOME, 0);
  }

  /* ================================================================ 11. 启动 */

  function readParams() {
    const q = new URLSearchParams(location.search);
    /* 密钥三条来源，优先级从高到低：
       ① URL 上的 ?tk= —— 客户端注入、以及「地址栏也带一份」都走这条；
       ② localStorage 里记着的那份（只有网页版用得上，见上面那块说明）；
       ③ 空 —— 等宿主推（桌面端 __tdt.setTk）或用户手填。 */
    storeOff = q.get('nostore') != null;
    const fromUrl = q.get('tk');
    const tk = fromUrl || loadSavedKey();
    if (tk) {
      TDT.tk = tk;
      tkSrc = fromUrl ? 'url' : 'store';
    }
    const th = q.get('theme');
    if (th && THEME_LIST.some((t) => t.id === th)) appEl.dataset.theme = th;
    if (q.get('note') != null) noteOn = true;
    if (q.get('fake') != null) FAKE = true;
    /* 测试缝：关掉聚合过渡动画，回到「每帧即时吸附」（见 5.5 节 animOff） */
    if (q.get('noanim') != null) animOff = true;
    /* 测试缝：新簇的父簇退回「几何最近」（见 5.5 节 animProx） */
    if (q.get('proxanim') != null) animProx = true;
    /* 测试缝：市界到货后的重建**不**重跑归属（见 ensureCity）。
       这是给「重建必须重跑 computeFill」那条判据配的反向锁：
       少了它，「重建后 regionKey / provName / solo 都还在」这句话
       与「这批字段压根没人读」无法区分。 */
    if (q.get('noreassign') != null) reassignOff = true;
    /* 测试缝：覆盖「同名照片的空间闸」（PLACE_SPLIT_DEG），把地点分组的判据
       从两头打红 —— `&placesplit=999` 关掉闸（跨省的幽灵点回来）、
       `&placesplit=0` 一律拆开（挨着的照片也被拆散）。两头都不红，那组判据
       就是恒真的。
       注意：boot() 里 buildPhotos(相册) 排在 readParams() **之前**，
       所以这道缝只对 readParams 之后重建的相册生效 —— 即探针注入的那批
       （判据正是基于它们）。**用户导入的照片、以及从存档恢复回来的那份，
       同样在建点之前**（恢复更早，它在 boot 的第一段），因此这条缝对它们不生效；
       要验它们就在加载后走 __tdt.setAlbum() 重新注入一份。 */
    if (q.get('placesplit') != null) {
      const v = Number(q.get('placesplit'));
      if (isFinite(v) && v >= 0) PLACE_SPLIT_DEG = v;
    }
    /* 测试缝：关掉「被拆开的地点优先报市名」，退回旧的「省名 + 序号」。
       存在的唯一理由是反向验证 —— 判据 `splitLabelsAreCity` 必须在这条缝下
       变红（标签退成「广东」「广东 2」），否则它可能只是在测一个恒真的东西。
       与 `placesplit` 同样受 boot 顺序限制：只对 readParams 之后重建的相册
       生效，即探针注入的那批。正常访问取不到。 */
    if (q.get('nocity') != null) cityLabels = false;
    /* 测试缝：撤掉「预占活簇已有元素」（见 5.5 节 poolReserve），退回旧的分配行为，
       让两个活簇有机会共用一个 DOM 节点。用来证明那三条判据不是恒真的。
       注意它只对**之后发生的帧**生效，所以探针要在加载时就带上它，
       再靠反复切「世界 / 全国」把共用触发出来。 */
    if (q.get('nopoolfix') != null) poolReserve = false;
    /* 测试缝：撤掉国家级「国家中心」锚点（见 5.5 节 useAnchor），退回加权质心。
       用来把 `countryAnchorInside` 从反面打红。 */
    if (q.get('noanchor') != null) useAnchor = false;
    /* 测试缝：关掉「地名放不下就藏起来」，退回旧的「原位叠压」。
       用来把 `noOverlappingLabels` 从反面打红 —— 带上它之后，
       那组密集点位必须重新出现「两个可见地名框相交」。
       它对**已经建好的相册**同样生效（readParams 排在 buildPhotos 之后、
       但排在首帧之前），所以演示数据与探针注入的数据都能用。 */
    if (q.get('nonameoff') != null) nonameOn = false;
    /* 测试缝：关掉配额闸门（见第 5 节 quotaGate），动画期间退回
       「每帧按当前层级请求」。用来证明节省是实的 —— 带上它之后，
       一次「切世界视图」必须重新涨回 100 张以上。 */
    if (q.get('noquotagate') != null) quotaGate = false;
    /* 测试缝：退回旧 assetUrl 白名单（见该函数注释），把 importThumbDecoded 打红 */
    if (q.get('oldasset') != null) legacyAssetUrl = true;
    /* 测试缝：关掉区县一级，标签退回市名 —— 即用户报的那个现状
       （同一个市里的点只能报「广州 1」「广州 2」）。存在的唯一理由是
       反向验证：`districtDrilldown` 必须在这条缝下变红。
       与 `?nocity` 同样受 boot 顺序限制，只对 readParams 之后重建的相册生效
       （探针注入的那批；见 `?placesplit` 那条缝的说明）。 */
    if (q.get('nocounty') != null) countyLabels = false;
    /* 测试缝：不描九段线。用来把 `jiuLitWithoutHover` 打红 —— 证明那条判据
       真的在看画布，而不是在空集上恒真。 */
    if (q.get('nojiu') != null) jiuOn = false;
    const at = q.get('at');
    if (at) {
      const a = at.split(',').map(Number);
      if (a.length === 3 && a.every((v) => isFinite(v))) {
        setCamera({ lng: a[0], lat: a[1], k: a[2] }, 0);
        userMoved = true;
        return true;
      }
    }
    return false;
  }

  async function boot() {
    resize();
    /* 几何要在建点之前载入：computeFill() 会同时用到省与国的世界坐标 */
    buildProvinceGeometry();
    buildCountryGeometry();
    buildJiuGeometry();
    refreshRamp();

    /* 存档（上一次导入的照片）要在这里取回来，**建点之前**。
       为什么不能等首帧之后再换相册：那样会先画一帧演示数据、再跳一下，
       而「刷新之后照片还在」这个承诺的第一印象恰恰就是「不闪」。
       网页版没有同源宿主，PhotoStore.load() 立刻 resolve(null)，
       一帧都不拖（见 photo-store.js 的两条边界）。
       ⚠️ 于是恢复回来的这份相册与演示相册一样，排在建点之前 ——
       而 `?placesplit` / `?nocity` / `?nocounty` 那几条测试缝在 readParams 里，
       排在更后面 ⇒ **它们对恢复回来的相册不生效**。要验那几条缝，
       得在加载之后走 __tdt.setAlbum() 重新注入（探针都是这么做的）。 */
    const saved = await loadSavedAlbum();

    buildPhotos(saved ? saved.album : window.PHOTO_ALBUM, saved ? saved.label : '天地图底图');
    computeFill();
    buildThemes();
    bindEvents();

    TDT.tk = '';
    const pinned = readParams();

    if (FAKE) {
      loadingText.textContent = '正在铺测试瓦片…';
    } else if (!TDT.tk) {
      loadingEl.classList.remove('is-on');
      showNoKey();
    } else {
      loadingText.textContent = '正在拉取天地图瓦片…';
    }

    if (!pinned) {
      /* 有存档就装到**自己那些照片**上，而不是全国 ——
         这就是「重新打开客户端，看到的是我上次那份相册」。
         没有存档时与以前逐字相同：装到全国。 */
      lastFit = saved ? fitBoxForAlbum(boundsOf() || HOME) : HOME;
      fitBox(lastFit, 0);
    }
    btnNote.setAttribute('aria-pressed', noteOn ? 'true' : 'false');

    requestAnimationFrame(frame);
  }

  btnHome.addEventListener('click', function () {
    userMoved = false;
    lastFit = HOME;
    fitBox(HOME, 520);
  });

  btnWorld.addEventListener('click', function () {
    userMoved = false;
    lastFit = WORLD;
    fitBox(WORLD, 520);
  });

  btnIn.addEventListener('click', function () {
    markMoved();
    zoomBy(1.55);
  });

  btnOut.addEventListener('click', function () {
    markMoved();
    zoomBy(1 / 1.55);
  });

  btnNote.addEventListener('click', function () {
    noteOn = !noteOn;
    btnNote.setAttribute('aria-pressed', noteOn ? 'true' : 'false');
    tileImg.clear();
    tileReq.clear();
    dirty = true;
    toast(noteOn ? '已叠天地图注记层（含 POI 与地名）' : '已关闭注记层，底图只剩面与道路');
  });

  btnKey.addEventListener('click', openKeybox);
  keyInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') applyKey();
  });

  keybox.addEventListener('click', function (e) {
    if (e.target === keybox) closeKeybox();
  });

  document.getElementById('keyApply').addEventListener('click', applyKey);
  document.getElementById('keyCancel').addEventListener('click', closeKeybox);

  /* ======================================================= 11.5 本地照片导入 */

  let importing = false;

  function openImpbox() {
    if (!impbox) return;
    impbox.classList.add('is-open');
    impbox.setAttribute('aria-hidden', 'false');
  }

  function closeImpbox() {
    if (!impbox) return;
    impbox.classList.remove('is-open');
    impbox.setAttribute('aria-hidden', 'true');
  }

  function setHint(msg) {
    if (impHint) impHint.textContent = msg;
  }

  /** 非 JPEG 格式的中文名 —— 提示语里得能说清「是什么」。 */
  function kindName(k) {
    return (
      { png: 'PNG', heic: 'HEIC', webp: 'WebP', gif: 'GIF', isobmff: 'HEIF', tooSmall: '空文件' }[k] || k
    );
  }

  /**
   * 把「跳过」的成因翻成人话。
   *
   * 之前这里一律写「EXIF 里没有 GPS」。实测一批 1945 张的相机胶卷：
   * 1847 张是**拍摄时就没有记录位置**、55 张根本不是 JPEG、8 张 EXIF 被平台剥离 ——
   * 三种成因完全不同，却共用同一句话。用户看到「1000 张只有 20 张有坐标」，
   * 第一反应必然是解析器坏了；归因一旦错，排查方向从一开始就偏了。
   */
  function explainSkip(res) {
    const w = res.why || {};
    const parts = [];
    if (w.noGps) parts.push(w.noGps + ' 张拍照时没有记录位置');
    if (w.noExif) parts.push(w.noExif + ' 张位置信息在导出时被剥离');
    if (w.notJpeg) {
      const ks = Object.keys(res.kinds || {});
      const detail = ks.length
        ? '（' + ks.map(function (k) { return kindName(k) + ' ' + res.kinds[k] + ' 张'; }).join('、') + '）'
        : '';
      parts.push(w.notJpeg + ' 张不是 JPEG，没有 EXIF 可读' + detail);
    }
    if (w.gpsInvalid) parts.push(w.gpsInvalid + ' 张坐标无效');
    if (w.broken) parts.push(w.broken + ' 张文件结构异常');
    if (w.readError) parts.push(w.readError + ' 张读取失败');
    return parts.length ? parts.join('；') : res.skipped + ' 张未定位';
  }

  /**
   * 导入一批本地照片。整个过程只读文件、只在内存里解码，
   * 除了 objectURL 之外不留下任何东西（换相册时统一回收）。
   */
  async function importFiles(files, byFolder) {
    if (importing) return;
    if (!files || !files.length) return;
    if (!window.PhotoImport) {
      setHint('导入模块没加载（photo-import.js）。');
      return;
    }
    importing = true;
    const total = files.length;
    let lastPaint = 0;
    try {
      const res = await window.PhotoImport.buildAlbum(files, {
        byFolder: byFolder,
        onProgress: function (done, all, placed, skipped) {
          /* 节流：100 张全在解的时候，每张都改一次 DOM 会把主线程搅乱 */
          const now = performance.now();
          if (now - lastPaint < 90 && done < all) return;
          lastPaint = now;
          setHint('正在解码 ' + done + ' / ' + all + '　已定位 ' + placed + ' 张' + (skipped ? '，跳过 ' + skipped + ' 张' : ''));
        },
      });

      if (!res.placed) {
        setHint(
          '这 ' + total + ' 张里没有一张带 GPS 定位：' + explainSkip(res) +
            (res.failed ? '；' + res.failed + ' 张无法解码' : '') +
            '。相册地图靠坐标定位，没有坐标就没法摆到图上。'
        );
        toast('没有可定位的照片');
        return;
      }

      applyAlbum({ photos: res.photos }, '本地照片', res.urls);
      /* 存到本机 —— 「刷新不要重置」的全部实现就在这一行。
         落盘失败**必须说出来**：否则用户下次刷新发现照片没了，却没有任何线索
         （与 desktop/src/app.js 里那条「密钥没能存下来」同一个理由）。 */
      setHint('已导入 ' + res.placed + ' 张，正在存到本机…');
      const sv = await persistAlbum({ photos: res.photos }, '本地照片');
      const stored = !!(sv && sv.ok);
      setHint(
        '已导入 ' + res.placed + ' 张，' + (byFolder ? '按文件夹聚成点位' : '一张一个点') +
          (stored
            ? '；已存到本机，刷新与重新打开都不用重选'
            : '；⚠️ 没能存到本机（' + ((sv && sv.reason) || '未知原因') + '），刷新会丢') +
          (res.skipped ? '；跳过 ' + res.skipped + ' 张 —— ' + explainSkip(res) : '') +
          (res.failed ? '；' + res.failed + ' 张解码失败' : '')
      );
      toast(stored ? '已载入 ' + res.placed + ' 张本地照片，已存到本机' : '已载入 ' + res.placed + ' 张本地照片');
      closeImpbox();
    } catch (e) {
      setHint('导入失败：' + (e && e.message ? e.message : e));
    } finally {
      importing = false;
    }
  }

  /**
   * 「回到演示数据」—— 这也是**唯一**一处用户主动要求清掉存档的地方
   * （需求原文：「手动点回到演示数据才清」）。
   *
   * 顺序是「先清存档、再换相册」，不是反过来：反过来的话，万一清失败，
   * 留下的是「界面上已经是演示数据、下次启动又变回我的照片」——
   * 这是最难查的一种形态（同一个按钮，行为取决于你什么时候重启）。
   */
  async function rebuildDemo() {
    const c = await dropSavedAlbum();
    applyAlbum(window.PHOTO_ALBUM, '天地图底图', [], HOME);
    const gone = !!(c && c.ok);
    setHint(gone ? '已回到演示数据，本机存的照片也清掉了。' : '已回到演示数据（本机存档没清掉：' + ((c && c.reason) || '未知原因') + '）');
    toast(gone ? '已回到演示数据，本机存档已清' : '已回到演示数据');
  }

  /* 拖拽导入：整窗接管。顺带挡掉「把图片拖到页面上」的默认行为 ——
     否则浏览器会直接导航到那张图片，页面连同相机状态一起没了。 */
  function bindDrop() {
    window.addEventListener('dragover', function (e) {
      e.preventDefault();
    });
    window.addEventListener('drop', function (e) {
      e.preventDefault();
      const dt = e.dataTransfer;
      if (!dt || !dt.files || !dt.files.length) return;
      const list = Array.prototype.filter.call(dt.files, function (f) {
        return /^image\//.test(f.type) || /\.jpe?g$/i.test(f.name);
      });
      if (!list.length) {
        toast('拖进来的不是图片');
        return;
      }
      openImpbox();
      /* 拖进来的文件没有目录层级（webkitRelativePath 为空）→ 一张一个点 */
      importFiles(list, false);
    });
  }

  if (btnPhoto) btnPhoto.addEventListener('click', openImpbox);
  if (impbox) {
    impbox.addEventListener('click', function (e) {
      if (e.target === impbox) closeImpbox();
    });
  }
  bindDrop();
  if (filePhotos) {
    filePhotos.addEventListener('change', function () {
      importFiles(filePhotos.files, false);
      filePhotos.value = ''; /* 清空，否则选同一批文件不会再触发 change */
    });
  }
  if (fileFolder) {
    fileFolder.addEventListener('change', function () {
      importFiles(fileFolder.files, true);
      fileFolder.value = '';
    });
  }
  if (document.getElementById('pickPhotos')) {
    document.getElementById('pickPhotos').addEventListener('click', function () {
      filePhotos.click();
    });
  }
  if (document.getElementById('pickFolder')) {
    document.getElementById('pickFolder').addEventListener('click', function () {
      fileFolder.click();
    });
  }
  if (document.getElementById('impReset')) {
    document.getElementById('impReset').addEventListener('click', rebuildDemo);
  }
  if (document.getElementById('impClose')) {
    document.getElementById('impClose').addEventListener('click', closeImpbox);
  }

  btnTheme.addEventListener('click', function (e) {
    e.stopPropagation();
    const open = themesEl.classList.toggle('is-open');
    btnTheme.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  document.addEventListener('click', function (e) {
    if (!themesEl.contains(e.target) && e.target !== btnTheme) {
      themesEl.classList.remove('is-open');
      btnTheme.setAttribute('aria-expanded', 'false');
    }
  });

  /* 探针接口：只读为主，供 CDP 验证「缩放锚点零漂移」这类硬指标。
     正常使用不需要它。 */
  window.__tdt = {
    cam: cam,
    t2: t2,
    size: size,
    state: function () {
      return {
        k: t2.k,
        tx: t2.tx,
        ty: t2.ty,
        lng: cam.lng,
        lat: cam.lat,
        z: curZ,
        tk: !!TDT.tk,
        /* 密钥是从哪儿来的 —— 「记不住」这类问题的唯一直接读数。
           url / store / host / none 四种来源，见 readParams 与 setTk。 */
        tkSrc: tkSrc,
        storeOff: storeOff,
        tiles: tileImg.size,
        inFlight: tileReq.size,
        placed: lastShown,
        dirty: dirty,
        note: noteOn,
        album: PHOTOS.reduce(function (a, p) {
          return a + p.list.length;
        }, 0),
        places: PHOTOS.length,
      };
    },
    /* 配额读数 —— 唯一能把「省了多少请求」直接读出来的口。
       asked    实际发起的瓦片请求数（≈ 实付配额）
       held     被闸门拦下的唯一瓦片数（这两者相加就是旧行为的开销）
       fallback 累计「本层没有、用祖先顶住」的格次（代价的度量：这些帧是糊的）
       z / zWant 本帧绘制层 / 请求层，两者不同即「动画中只请求终点层」
       gate     闸门是否打开（`?noquotagate` 下为 false） */
    quota: function () {
      return {
        asked: tileAsked,
        held: heldKeys.size,
        fallback: tileFallback,
        z: curZ,
        zWant: curZWant,
        miss: curMiss,
        gate: quotaGate,
        tiles: tileImg.size,
        inFlight: tileReq.size,
      };
    },
    /* 市界加载状态。have = 已建成几何的省，ok = 名单里还认得的省，want = 在途。
       三者对不上就是「名单与目录不一致」或「有请求没回来」——
       两种都会让标签悄悄退回省名，而页面上看不出来。 */
    city: function () {
      return {
        have: Array.from(CITY.keys()).sort(function (a, b) { return a - b; }),
        ok: Array.from(CITY_OK).sort(function (a, b) { return a - b; }),
        want: Array.from(CITY_WANT).sort(function (a, b) { return a - b; }),
      };
    },
    /* 区县界的加载状态。形状与 city() 逐字相同，**必须分开读** ——
       标签停在市名有两种完全不同的原因（区县数据没到 / 根本没触发加载），
       合成一个口就分不清是哪一种，而那两种的修法相反。 */
    county: function () {
      return {
        have: Array.from(COUNTY.keys()).sort(function (a, b) { return a - b; }),
        ok: Array.from(COUNTY_OK).sort(function (a, b) { return a - b; }),
        want: Array.from(COUNTY_WANT).sort(function (a, b) { return a - b; }),
        labels: countyLabels,
      };
    },
    project: function (lng, lat) {
      return { x: M.x(lng) * t2.k + t2.tx, y: M.y(lat) * t2.k + t2.ty };
    },
    unproject: function (x, y) {
      return { lng: M.lng((x - t2.tx) / t2.k), lat: M.lat((y - t2.ty) / t2.k) };
    },
    setTk: function (tk) {
      TDT.tk = tk;
      tkSrc = 'host';
      tileImg.clear();
      tileReq.clear();
      loadedOnce = true;
      removeNoKey();
      dirty = true;
    },
    setCamera: function (lng, lat, k) {
      setCamera({ lng: lng, lat: lat, k: k }, 0);
    },
    zoomAt: function (factor, x, y) {
      zoomBy(factor, x, y);
    },
    /* ---- 密度填色层的读数口 ---- */
    fill: function () {
      return {
        features: provStat.features,
        rings: provStat.rings,
        verts: provStat.verts,
        geoMs: provStat.ms,
        filled: provStat.filled,
        ringsTotal: provStat.ringsTotal,
        unassigned: provStat.unassigned,
        nearAssigned: provStat.nearAssigned,
        drawn: provStat.drawn,
        alpha: provStat.alpha,
        /* 本帧补的亚像素色块数。**它与 rings 的关系就是南海那条 bug 的读数形态**：
           没有它时，海南 258 个环里有 257 个被 LOD 丢掉且无人补位，
           画布上就是空的。 */
        markRings: provStat.markRings,
        ctryMarkRings: ctryStat.markRings,
        /* 九段线：segs 是数据里真实的段数（10），drawn 是本帧描了几段，
           lit 是这一帧它有没有被算作「高亮」。三个分开记 —— 只看 segs
           会把「一段都没落到屏幕上」这种情形盖过去。 */
        jiu: { segs: jiuStat.segs, drawn: jiuStat.drawn, lit: jiuStat.lit, on: jiuOn },
        /* 亚像素补块的两道阈值。**探针必须能读到它们** —— 否则
           「pathShape 与 minRingPath 的判据严格互补」这条判据无从复核：
           复刻者只能自己猜一个 0.6，而猜错的那一天，判据会同时失去意义
           与报警能力（南海那块三角形就是这么漏过去的）。 */
        lod: { ringMinPx: RING_MIN_PX, markPx: RING_MARK_PX },
        ramp: RAMP.slice(),
        chinaTotal: chinaTotal,
        chinaT: +chinaT(t2.k).toFixed(3),
        countries: ctryStat.features,
        ctryRings: ctryStat.rings,
        ctryVerts: ctryStat.verts,
        ctryGeoMs: ctryStat.ms,
        ctryFilled: ctryStat.filled,
        ctryDrawn: ctryStat.drawn,
        ctrySkippedWide: ctryStat.skippedWide,
        ctryUnassigned: ctryStat.unassigned,
        provinces: PROV.filter(function (f) {
          return f.count > 0;
        }).map(function (f) {
          return {
            name: f.name,
            adcode: f.adcode,
            count: f.count,
            idx: densityIndex(f.count),
            fill: f.fill,
            rings: f.rings.length,
          };
        }),
        ctryList: CTRY.filter(function (c) {
          return c.count > 0;
        }).map(function (c) {
          return {
            name: c.zh,
            en: c.name,
            iso: c.iso,
            count: c.count,
            idx: densityIndex(c.count),
            fill: c.fill,
            rings: c.rings.length,
          };
        }),
      };
    },
    /* 不经过文件选择器直接换相册 —— 供探针注入合成数据，
       把「分档 / 上色」这条链路与「解 EXIF」那条链路分开验。 */
    setAlbum: function (album, label) {
      applyAlbum(album, label || '测试相册', [], HOME);
    },
    hasImporter: function () {
      return !!window.PhotoImport;
    },
    /**
     * 注入一套相册**并走真实的落盘路径**。
     *
     * 与 setAlbum 的区别只有一个：它顺带存档。
     * 为什么探针需要它：要验的命题是「导入自己的照片 → 刷新之后还在」，
     * 而真实入口（选文件）在无头环境里走不通 —— 没有文件选择器，也没法
     * 造出带 EXIF GPS 的 File。所以探针从这条路进来，
     * 「打包 → postMessage → IPC → 落盘」后面那几段与真实导入**逐行同一条**。
     * @param album { photos: [{ place, wgs, src, preview, date }] }
     * @returns Promise<{ ok, reason, photos, bytes }>
     */
    persistAlbum: function (album, label) {
      const name = label || '本地照片';
      applyAlbum(album, name, [], null);
      return persistAlbum(album, name).then(function (r) {
        return {
          ok: !!(r && r.ok),
          reason: (r && r.reason) || '',
          photos: (r && r.photos) || 0,
          bytes: (r && r.bytes) || 0,
        };
      });
    },
    /**
     * 相册存档的读数口。要能把下面四件事分开 —— 否则「存档没生效」
     * 与「本来就没有存档」分不清，而那两种的修法相反：
     *   mode      host = 有宿主、走存档；none = 网页版（这块整块不参与）；
     *             missing = photo-store.js 根本没加载
     *   restored  本次会话从存档读回来几张（0 = 没读回来，不管磁盘上有没有）
     *   saved     落盘成功过几次 / photos / bytes
     *   cleared   清了几次（点「回到演示数据」）
     * 再带上当前相册本身的张数与地点数 —— 与 state() 同口径，
     * 这样「读回来的照片真的建成了点」不必靠截图看。
     */
    albumStore: function () {
      const PS = window.PhotoStore;
      const r = PS ? PS.reading() : { mode: 'missing' };
      return {
        mode: r.mode,
        restored: savedInfo.restored,
        saved: r.saved || 0,
        photos: r.photos || 0,
        bytes: r.bytes || 0,
        cleared: r.cleared || 0,
        missing: r.missing || 0,
        lastSave: savedInfo.lastSave,
        lastError: r.lastError || savedInfo.reason || '',
        requests: r.requests || 0,
        label: lastLabel || '',
        album: PHOTOS.reduce(function (a, p) {
          return a + p.list.length;
        }, 0),
        places: PHOTOS.length,
      };
    },
    /* 每个地点的归属：[名字, 省 adcode 或 ISO 国家码（0 = 未归属）, 'in' | 'near'] */
    assign: function () {
      return assignLog.slice();
    },
    /* 地点表 —— 「照片到底被摆在哪儿」的直接读数。
       探针用它验核心能力：**没有任何一个地点的位置离它名下的照片太远**。
       spread = 堆内最深的一张离堆心多远（度）；splitFrom = 它从哪个名字里拆出来。
       光看地图截图验不了这条：一个跨省平均出来的「幽灵点」在图上与真点无异。 */
    /* 数量守恒读数 —— 「数量精准」这条产品红线的第一类硬读数。
       恒等式：clustered + culled == total。clustered 是本帧进了簇的张数，
       culled 是因视口外被剔除的张数（屏幕外看不见，不算丢）。
       探针在每个相机下验这条恒等式：任何「放大一级少了几十张」的事故，
       无论根因在建点、聚合还是显示层，都会让恒等式当场破掉。 */
    conservation: function () {
      let total = 0;
      for (let i = 0; i < PHOTOS.length; i++) total += PHOTOS[i].list.length;
      return {
        total: total,
        clustered: clusterStat.clustered,
        culled: clusterStat.culled,
        ok: clusterStat.clustered + clusterStat.culled === total,
      };
    },
    places: function () {
      return PHOTOS.map(function (p) {        return {
          name: p.name,
          city: p.city,
          /* 区县名（没下钻到时为空串）。`name` 与 `city` 的关系是判「下钻了没有」
             的唯一直接证据：`name !== city && district !== ''` 才算真的下钻了。 */
          district: p.district || '',
          n: p.list.length,
          lng: +p.lng.toFixed(6),
          lat: +p.lat.toFixed(6),
          spread: +(p.spread || 0).toFixed(4),
          splitFrom: p.splitFrom || '',
          place: p.place || '',
          region: p.regionName || '',
          provName: p.provName || '',
        };
      });
    },
    /* 聚合结果：每一簇的区域键、区域名、**分级标签**与张数，
       以及簇内出现过的全部区域 / 城市 / 省份。
       regions 由 clusterize() 直接维护（regionSet），不是从簇成员反推 ——
       簇成员是照片记录，身上没有区域键，反推只会得到一堆空串，
       那条判据就变成恒真的了（踩过）。
       cities / provs 同理，既给标签分级用，也让探针能独立复核分级结果。 */
    clusters: function () {
      const k = t2.k;
      /* 填色粒度传给标签：t < 0.5 时省级标签会被压回国名，
         所以「裸省名只在 t ≥ 0.5 出现」这条要在读数口上就能验。 */
      const gt = chinaT(k);
      return clusterize(k, t2.tx, t2.ty).map(function (c) {
        const st = anim.get(c.key);
        return {
          region: c.region,
          regionName: c.regionName,
          /* 稳定身份（= 创建它的那张照片的地名）。过渡动画按它认簇；
             探针用它验「同一个簇跨帧没换元素」。 */
          key: c.key,
          /* 过渡动画的不透明度：1 = 完全就位，< 1 = 正在淡入/淡出。
             静止时恒为 1 —— 这是「动画不侵入静止态」的可读数证据。 */
          alpha: st ? +st.a.toFixed(3) : 1,
          regions: (c.regionSet || []).slice(),
          /* 聚合单位键。探针用它验「省级粒度下不得跨省」——
             跨没跨省看截图看不出来（两个省并成一簇也是一个小气泡）。 */
          unit: c.unit || '',
          cities: (c.citySet || []).slice(),
          provs: (c.provSet || []).slice(),
          /* 省级短名（shortName 的结果）。探针要独立复核「省名有没有被缩写」，
             所以把引擎算好的那一份也导出来，不让探针自己再实现一遍。 */
          provShort:
            c.provSet && c.provSet.length === 1 && c.provSet[0] ? shortName(c.provSet[0]) : '',
          names: (c.nameSet || []).slice(),
          /* 合规读数：台湾是否单列（solo）、簇内出现过哪些必须单列的地区（msts） */
          solo: !!c.solo,
          msts: (c.mstSet || []).slice(),
          /* 位置是否被国家级锚点接管（写国名 → 摆到国家中心）。
             探针用它把「标签=国名的簇都该被锚定」这条独立验一遍：
             anchored=false 且 label===regionName，就是锚点漏了。 */
          anchored: !!c.anchored,
          label: clusterLabel(c, gt),
          n: c.list.length,
          places: c.names.slice(),
          /* 簇的**锚点**屏幕位置（= 最大成员堆的真实堆心；过渡动画收敛后
             pin 的 DOM 位置与它重合）。探针拿它对 DOM 实测位置做逐像素
             比对 —— 「固定点」判据的真值来源。
             wx/wy 是同一锚点的世界坐标：**跨缩放级别恒定**（锚点钉在地理上，
             不随相机变）—— 「缩放一级 pin 就挪地方」在这两个字段上可证伪。 */
          sx: +c.sx.toFixed(1),
          sy: +c.sy.toFixed(1),
          wx: +c.wx.toFixed(2),
          wy: +c.wy.toFixed(2),
        };
      });
    },
    /* 池元素的实际占用情况 —— 「中国的照片全不见了」那类 bug 的**直接**读数。
       它回答的是「每一个活簇是不是都有自己的元素」，而这个从 `clusters()`
       里看不出来：簇表算的是模型，元素才是屏幕上那个东西。两者不一致时，
       画面就会骗人（布局里占着位、元素被别人顶着）。
       实测抓到的形态：两个活簇共用同一个 rec，后写的赢 ——
       DOM 上出现两个一模一样的标签，另一个活簇连元素都没有。 */
    pins: function () {
      return pool.map(function (r) {
        return {
          id: r.id,
          state: r.state,
          label: r.lab || '',
          key: r.key || '',
          n: r.cnt || 0,
          park: r.px === -9999,
          /* 「地名放不下、只剩缩略图」的退化形态。`park` 是「这个元素没被用」，
             `noname` 是「在用，但地名藏起来了」—— 两者不同，探针要分开看。 */
          noname: !!r.noname,
        };
      });
    },
    /* 国家级锚点读数口 —— 「写着国名的气泡是不是落在该国境内」的直接读法。
       给一串区域键（'CN' / 'FR' / 'US' …），回每个的锚点经纬度、是否精确质心
       （exact=false 表示质心落在域外、被吸附到了最近的境内格点），
       以及**独立的境内复核**（inside：拿锚点坐标回查 regionContains）。
       inside 由引擎自己算，探针不再实现一遍判定 —— 否则判据会验到自己身上。 */
    anchors: function (keys) {
      const list = keys && keys.length ? keys : ['CN'];
      return list.map(function (key) {
        const a = regionAnchor(key);
        if (!a) return { key: key, found: false };
        return {
          key: key,
          found: true,
          lng: +M.lng(a.wx).toFixed(6),
          lat: +M.lat(a.wy).toFixed(6),
          exact: !!a.exact,
          inside: regionContains(key, a.wx, a.wy),
        };
      });
    },
    /* 任意经纬度是否落在某区域内。探针用来把「黄海海面」这个反例坐实：
       旧的加权质心落在这里 —— inside=false，正是用户报的「指着两地之间」。 */
    contains: function (key, lng, lat) {
      return regionContains(key, M.x(lng), M.y(lat));
    },
    /* 全量锚点审计 —— 把 238 个国 + 中国的锚点一次算完，报「有几个落在域外」。
       这是 `countryAnchorInside` 判据的最强形态：不是抽查几个样本，
       而是把整张世界地图的每一个区域都过一遍。漏掉的形态（环退化、
       岛屿国被bbox拉伸、南极那种跨 180° 的）全都会在这里现形。
       `why` 分开两种失败：
         no-rings  —— 引擎的国别几何里根本没有这个国家（跨 ±180° 被整国丢了）；
         no-anchor —— 有环，但质心落域外且 25×25 格点也没搜到一个境内点；
         outside   —— 算出了锚点，但它不在境内（真 bug）。
       返回 bad 列表 —— 空数组才算过。 */
    anchorAudit: function () {
      const bad = [];
      let n = 0;
      let haveRings = 0;
      const keys = ['CN'];
      for (let i = 0; i < CTRY.length; i++) {
        const c = CTRY[i];
        keys.push(c.iso || c.name);
      }
      for (let i = 0; i < keys.length; i++) {
        const rings = regionRings(keys[i]);
        if (!rings || !rings.length) {
          bad.push({ key: keys[i], why: 'no-rings' });
          continue;
        }
        haveRings += 1;
        const a = regionAnchor(keys[i]);
        if (!a) {
          bad.push({ key: keys[i], why: 'no-anchor' });
          continue;
        }
        n += 1;
        if (!regionContains(keys[i], a.wx, a.wy)) bad.push({ key: keys[i], why: 'outside' });
      }
      return { total: keys.length, haveRings: haveRings, ok: n, ctry: CTRY.length, bad: bad };
    },
    /* 锚点的中间量 —— 每个环的等面积权重 / 质心 / 周期偏移。
       用来诊断「锚点为什么摆在这儿」：只看最终经纬度，「权重算错了」
       与「偏移算错了」长得一模一样，把中间量摊开才分得清。 */
    anchorParts: function (key) {
      const parts = regionParts(key || 'CN');
      if (!parts) return [];
      return parts.map(function (q) {
        return {
          cx: +q.cx.toFixed(6), cy: +q.cy.toFixed(6), lat: +q.lat.toFixed(4),
          w: +q.w.toExponential(3), off: Math.round(q.off / (Math.PI * 2)),
          x0: +q.r.x0.toFixed(4), x1: +q.r.x1.toFixed(4),
          y0: +q.r.y0.toFixed(4), y1: +q.r.y1.toFixed(4),
        };
      });
    },
    /* 命中测试的读数口：给经纬度，回「这里被算作哪个填色区域」 */
    hitAt: function (lng, lat) {
      const h = hitFill(M.x(lng), M.y(lat), chinaT(t2.k));
      return h ? { kind: h.kind, name: h.name, count: h.count } : null;
    },
    /* 清空出生 / 收拢记录。探针要在「某一次缩放」这个区间内单独统计，
       而日志是自页面加载起累积的。 */
    clearBirths: function () {
      animBirthLog.length = 0;
      animMergeLog.length = 0;
      return 0;
    },
    /* 过渡动画的收敛读数口。三条读数合起来就是「动画没有侵入静止态」的证据：
         maxResidualPx = 每个存活簇「平滑位置 ↔ 目标位置」的最大屏幕距离；
         minAlpha      = 存活簇里最小的不透明度（< 1 说明还在淡入）；
         dying         = 正在淡出的簇数。
       静止后三者必须分别是 0 / 1 / 0 —— 这正是「与无动画版本逐像素相同」的前提，
       也是静止截图能复现的前提。 */
    anim: function () {
      let maxPx = 0;
      let minAlpha = 1;
      let dying = 0;
      let live = 0;
      anim.forEach(function (st) {
        if (!st.live) {
          dying += 1;
          return;
        }
        live += 1;
        if (st.a < minAlpha) minAlpha = st.a;
        const c = st.c;
        if (!c) return;
        const dx = (c.wx - st.wx) * t2.k;
        const dy = (c.wy - st.wy) * t2.k;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > maxPx) maxPx = d;
      });
      return {
        tracked: anim.size,
        live: live,
        dying: dying,
        maxResidualPx: +maxPx.toFixed(4),
        minAlpha: +minAlpha.toFixed(4),
        /* 出生记录：每条「新簇是从哪个上一帧簇长出来的」。
           判据「父簇必须含着我」、「出生不许跨国」全靠它。
           `prox` 回读测试缝是否真的生效 —— 「关掉 X 也没变化」这种结论
           必须先确认 X 真的关掉了，否则量的是自己没动过的那份代码。 */
        births: animBirthLog.slice(-32),
        merges: animMergeLog.slice(-32),
        prox: animProx,
        off: animOff,
      };
    },
    /* 让宿主能在页面上留一句话 —— 目前唯一的用途是「密钥没保存成功」。
       客户端把密钥落到 config.json 是 IPC 跨进程的，失败时如果只 console.error，
       用户看到的现象就退回「填了又要重填」，没有任何线索。 */
    notify: function (msg) {
      toast(String(msg == null ? '' : msg));
    },
    /* 让探针能用真实鼠标移动之外的路径验 hover 的渲染效果 */
    hover: function () {
      return hoverRegion
        ? { kind: hoverRegion.kind, name: hoverRegion.name, count: hoverRegion.count }
        : null;
    },
    /* 把悬停状态清干净。
       为什么取样前还要清：**被悬停的那一块自己会被画深**（颜色往黑里混 + alpha 提高），
       所以只要光标正好落在被采样的那个区域上，读数就不是无悬停基线。
       探针用它保证「两级切换 / 色阶」这类判据读到的是干净值。
       （这段注释以前写的是「悬停把其余区域压暗到 0.42 倍」—— 那个机制已经删掉，
        现在的 hover 只动被悬停的那一块。清理的必要性因此变小了，但没有消失。） */
    resetHover: function () {
      clearHover();
    },
    tip: function () {
      return {
        on: fillTipEl.classList.contains('is-on'),
        text: fillTipEl.textContent,
        sig: tipSig,
      };
    },
    /* 直接取密度填色层的像素（设备像素坐标）。比截图对比更硬：
       它只反映被验的那一层，不含底图与标注的任何影响。 */
    sampleFill: function (lng, lat) {
      const p = { x: M.x(lng) * t2.k + t2.tx, y: M.y(lat) * t2.k + t2.ty };
      const dpr = size.dpr;
      const x = Math.round(p.x * dpr);
      const y = Math.round(p.y * dpr);
      if (x < 0 || y < 0 || x >= fillEl.width || y >= fillEl.height) return null;
      const d = fctx.getImageData(x, y, 1, 1).data;
      return [d[0], d[1], d[2], d[3]];
    },
    /* 在一个小窗口里取 alpha 最大的像素。
       为什么需要它：钓鱼岛这种几百米级的岛，在 k=6000 时只有 4×2 像素，
       单点采样很容易落在抗锯齿边缘上拿到 alpha 8~18 —— 那是「画了但采样点不好」，
       不是「没画」。用窗口取最大值才把这两件事分开。 */
    sampleFillMax: function (lng, lat, rad) {
      const p = { x: M.x(lng) * t2.k + t2.tx, y: M.y(lat) * t2.k + t2.ty };
      const dpr = size.dpr;
      const r = Math.max(1, Math.round((rad || 6) * dpr));
      const x0 = Math.round(p.x * dpr) - r;
      const y0 = Math.round(p.y * dpr) - r;
      const w = r * 2 + 1;
      if (x0 < 0 || y0 < 0 || x0 + w > fillEl.width || y0 + w > fillEl.height) return null;
      const d = fctx.getImageData(x0, y0, w, w).data;
      let best = null;
      for (let i = 0; i < d.length; i += 4) {
        if (!best || d[i + 3] > best[3]) best = [d[i], d[i + 1], d[i + 2], d[i + 3]];
      }
      return best;
    },
    /**
     * 整层像素指纹（设备像素）。`ex` 传 [x,y,w,h]（CSS 像素）就跳过那一块。
     *
     * 存在的理由：判据「悬停只改被悬停的那一块，其余逐像素不变」——
     * 点采样证不了这个命题。一个区块可能画成上千个像素，点采样只碰到其中一个，
     * 而「其余也不变」这句话的全部证据就在**没被点到的那 99.9%** 上。
     * 所以算一个整层哈希，并把悬停区的包围盒排除掉：
     * 剩下那片区域前后哈希相同，才真的等于「别处一个像素都没动」。
     *
     * 用 FNV-1a，逐像素 4 通道。一次调用扫一遍画布，只在探针里用，不进渲染路径。
     */
    fillDigest: function (ex) {
      const d = fctx.getImageData(0, 0, fillEl.width, fillEl.height).data;
      const dpr = size.dpr;
      let x0 = -1, y0 = -1, x1 = -1, y1 = -1;
      if (ex) {
        x0 = Math.floor(ex[0] * dpr); y0 = Math.floor(ex[1] * dpr);
        x1 = Math.ceil((ex[0] + ex[2]) * dpr); y1 = Math.ceil((ex[1] + ex[3]) * dpr);
      }
      let h = 2166136261;
      let n = 0;
      for (let y = 0; y < fillEl.height; y++) {
        const inRow = ex && y >= y0 && y < y1;
        for (let x = 0; x < fillEl.width; x++) {
          if (inRow && x >= x0 && x < x1) continue;
          const i = (y * fillEl.width + x) * 4;
          h ^= d[i]; h = Math.imul(h, 16777619);
          h ^= d[i + 1]; h = Math.imul(h, 16777619);
          h ^= d[i + 2]; h = Math.imul(h, 16777619);
          h ^= d[i + 3]; h = Math.imul(h, 16777619);
          n += 1;
        }
      }
      return { h: h >>> 0, n: n };
    },
  };

  boot();
})();
