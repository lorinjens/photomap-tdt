/**
 * 相册存档 —— 「用我自己的照片看效果」在刷新之后还在
 * ============================================================================
 * 需求（2026-09-13）：客户端里导入自己的照片看完效果，**刷新不该把它重置**；
 * 只有手动点「回到演示数据」才清。
 *
 * 为什么这件事必须由宿主（主进程）持有 —— 本文件存在的唯一理由
 * ---------------------------------------------------------------------------
 * 客户端的内容区是一个 iframe，它跑在主进程起的本地静态服务上，而那个服务用
 * **随机端口**（`desktop/main.js`：`startStatic({ port: 0 })`）。
 * 源 = 协议 + 主机 + 端口；端口每次都变 ⇒ 每次启动都是新源
 * ⇒ 页面自己的 localStorage / IndexedDB **一律从零开始**
 * （连 HTTP 磁盘缓存的分区键都跟着变）。
 * 所以「刷新之后还在」只能记在**主进程**那边 —— 主进程没有「源」这个概念。
 * 与天地图密钥同一套道理，见 `desktop/lib/store.js` 的文件头与 README `## 八`。
 *
 * 于是这里只做三件事：
 *   ① 序列化：把相册里的 blob URL 读成字节（jpeg 两档小图），交给宿主；
 *   ② 反序列化：把宿主还回来的字节重新变成 object URL 的相册；
 *   ③ 一个读数口，好让探针能分辨「本来就没有存档」与「有存档但没读回来」。
 * 落盘位置、原子性、孤儿清理全在 `desktop/lib/album.js`。
 *
 * 边界（刻意收窄，两条都有反向锁）
 * ---------------------------------------------------------------------------
 *   ① **没有同源宿主时一律不动**（tdt-demo 当普通网页打开 / 网页版部署）。
 *      此时 load() 立刻返回 null，页面保持既有行为：只在内存里，刷新就没了。
 *      这与密钥那条链路的取舍不同（网页版把密钥记在了 localStorage）——
 *      密钥是一个 32 字符串，照片是几十 MB，两者不该共用一套判断。
 *   ② 只认同源宿主。跨源时 `parent.location.href` 会抛，就当作没有宿主 ——
 *      否则一串私人照片会被递给任意嵌入方（同 reportKey 的两条收窄）。
 * ============================================================================
 */
(function () {
  'use strict';

  var V = 1;

  /* 三种请求的超时。取值的依据：
     get    —— 宿主手上就是内存里的 payload，一次 IPC 往返即可；给 1.5s 只为兜住
               「宿主根本没装这套协议」（老版本客户端）时的降级：超时即按没有存档走。
     set    —— 要走 postMessage + IPC + 落盘（几百张照片时是几十 MB）；
               给 20s，宁可让用户多等一会儿，也不能把「写成功了」误报成失败。
     clear  —— 删一个目录。 */
  var TIMEOUT = { get: 1500, set: 20000, clear: 5000 };

  /** 单次 payload 的上限（防线 2；防线 1 在主进程的 lib/album.js）。
      为什么两道都要有：页面这道拦住的是「解出 5 万张照片还闷头往 IPC 里塞」，
      主进程那道拦的是「别的什么人都能 invoke」。 */
  var MAX_PHOTOS = 5000;
  var MAX_BYTES = 512 * 1024 * 1024;

  var seq = 0;
  var pending = new Map(); // id -> { resolve, timer }
  var listening = false;

  var stats = {
    restored: 0, // 从存档里读回来几张（本次会话）
    saved: 0, // 落盘成功几次
    photos: 0, // 最后一次落盘的照片数
    bytes: 0, // 最后一次落盘的字节数
    cleared: 0, // 清了几次
    missing: 0, // 存档里有、但图片文件已经不在的照片数
    lastError: '',
    requests: 0, // 发出过几个请求（两侧都没回应的那种情况靠它看出来）
  };

  /* ------------------------------------------------------------------ 宿主判定 */

  function hostPresent() {
    if (window.parent === window) return false;
    try {
      return !!window.parent.location.href;
    } catch (_) {
      return false; // 跨源：读不到就当没有宿主
    }
  }

  function post(msg) {
    try {
      window.parent.postMessage(msg, location.origin);
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * 与宿主会话。返回 { id, done: Promise }。
   * 超时也 resolve（而不是 reject）—— 「宿主没回应」与「宿主说没有」在调用方
   * 那里是同一种处理（按没有存档走），分成两条路只会多一处要记得 catch 的地方。
   */
  function ask(type, extra, timeoutMs) {
    var id = 'a' + ++seq;
    stats.requests += 1;
    ensureListen();
    return new Promise(function (resolve) {
      var timer = setTimeout(function () {
        pending.delete(id);
        resolve({ ok: false, timeout: true, reason: '宿主没有回应（' + type + '）' });
      }, timeoutMs);
      pending.set(id, {
        resolve: function (r) {
          clearTimeout(timer);
          pending.delete(id);
          resolve(r);
        },
      });
      var msg = { type: type, id: id };
      if (extra) for (var k in extra) msg[k] = extra[k];
      if (!post(msg)) {
        var p = pending.get(id);
        if (p) p.resolve({ ok: false, reason: '发不出去（没有宿主）' });
      }
    });
  }

  function ensureListen() {
    if (listening) return;
    listening = true;
    window.addEventListener('message', function (ev) {
      /* 两条收窄，缺一不可：
         ① 同源 —— 否则任何一个页面都能塞一份「相册」进来；
         ② 来源必须就是宿主窗口 —— ev.origin 只说明「谁发的源」，不说明是哪个窗口。 */
      if (ev.origin !== location.origin) return;
      if (ev.source !== window.parent) return;
      var d = ev.data;
      if (!d || typeof d !== 'object' || !d.id) return;
      var p = pending.get(d.id);
      if (!p) return;
      if (d.type === 'tdt:album:data') p.resolve({ ok: true, payload: d.payload || null, missing: d.missing || 0 });
      else if (d.type === 'tdt:album:done') p.resolve(d);
    });
  }

  /* --------------------------------------------------------------- 序列化 */

  /** blob: URL → 字节。fetch 对 blob: 是同步可解析的，不需要 XHR。 */
  function bytesOf(url) {
    if (!url) return Promise.resolve(null);
    return fetch(url)
      .then(function (r) {
        return r.blob();
      })
      .then(function (b) {
        return b.arrayBuffer();
      })
      .then(function (a) {
        return new Uint8Array(a);
      })
      .catch(function () {
        return null; // 图没了（比如已经被 revoke）—— 那这张就只能丢，见 buildPayload
      });
  }

  /** 把相册序列化成可跨进程传的形态。**丢弃**读不到字节的那些照片，并报出来。 */
  async function buildPayload(album, label) {
    var list = (album && album.photos) || [];
    var out = [];
    var dropped = 0;
    var bytes = 0;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (!p || !p.wgs) continue;
      var thumb = await bytesOf(p.src);
      var prev = await bytesOf(p.preview);
      if (!thumb || !prev) {
        dropped += 1;
        continue;
      }
      bytes += thumb.byteLength + prev.byteLength;
      out.push({
        id: p.id || 'loc-' + i,
        date: p.date || '',
        dateFromExif: !!p.dateFromExif,
        place: p.place || '',
        wgs: [p.wgs[0], p.wgs[1]],
        thumb: thumb,
        prev: prev,
      });
      if (out.length > MAX_PHOTOS) break;
    }
    if (bytes > MAX_BYTES) return { ok: false, reason: '照片体积超过上限，没有落盘' };
    return {
      ok: true,
      payload: {
        v: V,
        label: label || '本地照片',
        savedAt: new Date().toISOString(),
        dropped: dropped,
        photos: out,
      },
      dropped: dropped,
      bytes: bytes,
    };
  }

  /**
   * 反序列化：字节 → object URL 的相册。
   * 返回 { album, urls }，urls 交给 applyAlbum 去管回收 —— 与真实导入那条路
   * 完全同形（那边也是「两档小图 + 一个 urls 数组」），所以下游一行都不用改。
   */
  function hydrate(payload) {
    var urls = [];
    var photos = [];
    var list = (payload && payload.photos) || [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (!p || !p.thumb || !p.prev || !p.wgs) continue;
      var src = URL.createObjectURL(new Blob([p.thumb], { type: 'image/jpeg' }));
      var prev = URL.createObjectURL(new Blob([p.prev], { type: 'image/jpeg' }));
      urls.push(src, prev);
      photos.push({
        id: p.id || 'saved-' + i,
        src: src,
        preview: prev,
        date: p.date || '',
        dateFromExif: !!p.dateFromExif,
        place: p.place || '',
        wgs: [p.wgs[0], p.wgs[1]],
      });
    }
    return { album: { photos: photos }, urls: urls };
  }

  /* ------------------------------------------------------------------ 对外 */

  /**
   * 取回存档。没有宿主、没有存档、宿主不回应 —— 三种都返回 null，
   * 调用方一律按「演示相册」走。
   */
  function load() {
    if (!hostPresent()) return Promise.resolve(null); // 网页版：立刻返回，一帧都不拖
    return ask('tdt:album:get', null, TIMEOUT.get).then(function (r) {
      if (!r || !r.ok || !r.payload || !r.payload.photos || !r.payload.photos.length) return null;
      var h = hydrate(r.payload);
      if (!h.album.photos.length) return null;
      h.label = r.payload.label || '本地照片';
      stats.restored = h.album.photos.length;
      stats.missing = r.missing || 0;
      return h;
    });
  }

  /** 落盘。album 必须是**原始**相册（src/preview 还是 blob URL 的那份）。 */
  async function save(album, label) {
    if (!hostPresent()) return { ok: false, reason: '没有宿主，照片只留在内存里' };
    var b;
    try {
      b = await buildPayload(album, label);
    } catch (e) {
      stats.lastError = String((e && e.message) || e);
      return { ok: false, reason: '打包失败：' + stats.lastError };
    }
    if (!b.ok) {
      stats.lastError = b.reason;
      return b;
    }
    if (!b.payload.photos.length) {
      stats.lastError = '没有可存的照片';
      return { ok: false, reason: stats.lastError };
    }
    var r = await ask('tdt:album:set', { payload: b.payload }, TIMEOUT.set);
    if (r && r.ok) {
      stats.saved += 1;
      stats.photos = r.photos != null ? r.photos : b.payload.photos.length;
      stats.bytes = r.bytes != null ? r.bytes : b.bytes;
      stats.lastError = '';
    } else {
      stats.lastError = (r && r.reason) || '未知原因';
    }
    return r;
  }

  /** 清存档。点「回到演示数据」时调 —— 那是唯一一处**用户主动**要它消失的地方。 */
  function clear() {
    if (!hostPresent()) return Promise.resolve({ ok: true, reason: '没有宿主' });
    return ask('tdt:album:clear', null, TIMEOUT.clear).then(function (r) {
      if (r && r.ok) stats.cleared += 1;
      return r;
    });
  }

  window.PhotoStore = {
    V: V,
    available: hostPresent,
    load: load,
    save: save,
    clear: clear,
    serialize: buildPayload,
    hydrate: hydrate,
    /* 读数口。探针要能分辨这四件事，否则「存档没生效」与「本来就没有」分不开：
         mode       none = 网页版（这块整块不参与）；host = 有宿主，走存档
         restored   本次会话从存档读回来几张
         saved      落盘成功过几次 / photos / bytes
         missing    存档里有、但图片文件不在的照片数（磁盘被别的东西动过时才非 0）
         lastError  最近一次失败的原因 */
    reading: function () {
      return {
        mode: hostPresent() ? 'host' : 'none',
        restored: stats.restored,
        saved: stats.saved,
        photos: stats.photos,
        bytes: stats.bytes,
        cleared: stats.cleared,
        missing: stats.missing,
        lastError: stats.lastError,
        requests: stats.requests,
        timeout: TIMEOUT,
      };
    },
  };
})();
