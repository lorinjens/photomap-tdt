/**
 * 本地照片导入 —— 相册地图 · 天地图实验线
 * ============================================================================
 * 零依赖：EXIF 解析与缩略图管线全部自己写。
 *
 * 为什么必须自己读 EXIF 二进制：浏览器**没有任何 API** 能从 File 里取 GPS。
 * `createImageBitmap` 能拿到像素、也能按 EXIF 方向转正，但拿不到标签值。
 * 所以只能把 JPEG 的 APP1 段按 TIFF 结构走一遍。
 *
 * 只认 JPEG（FFD8）里的 GPS。PNG / WebP / HEIC 没有这条标签 ——
 * 会被计入 skipped 并在界面上如实报出，不做静默丢弃。
 *
 * 输出结构与 photo-data.js 的相册一致（id / date / place / wgs），
 * 外加 src（点位缩略图）与 preview（面板里看的那张）。
 *
 * 内存纪律：每张照片只解一次位图，缩成两档小图后立刻 close()。
 * 否则 100 张 1200 万像素的照片解码后会占掉上 GB —— 这是本模块唯一
 * 真正需要小心的资源。
 * ============================================================================
 */
(function () {
  'use strict';

  var THUMB = 128; // 点位缩略图边长（屏幕上显示 44px，留 DPR=2 余量）
  var PREV_W = 512; // 面板里的图（双列，实际约 150px × DPR2）
  var PREV_H = 384; // 与 photo-map.css 的 .shot__img aspect-ratio: 4/3 对齐

  /* ======================================================== 1. EXIF（只读 GPS + 拍摄时间） */

  function u16(dv, off, le) {
    return dv.getUint16(off, le);
  }
  function u32(dv, off, le) {
    return dv.getUint32(off, le);
  }

  /** 3 个 RATIONAL 的度分秒 → 十进制度 */
  function dms(dv, off, le) {
    var d = u32(dv, off, le) / u32(dv, off + 4, le);
    var m = u32(dv, off + 8, le) / u32(dv, off + 12, le);
    var s = u32(dv, off + 16, le) / u32(dv, off + 20, le);
    return d + m / 60 + s / 3600;
  }

  function asciiAt(dv, off, len) {
    var s = '';
    for (var i = 0; i < len; i++) {
      var c = dv.getUint8(off + i);
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  }

  /**
   * 读一个 IFD，返回 { tag: {type, count, valOff} }。
   * 只收集我们关心的三个 tag，不做通用实现 —— 通用实现要处理 12 种类型，
   * 而这里只用到 ASCII / RATIONAL。
   */
  function readIFD(dv, tiff, off, le, wanted) {
    var out = {};
    if (off + 2 > dv.byteLength) return out;
    var n = u16(dv, off, le);
    if (n > 512) return out; // 明显是坏数据，别继续
    for (var i = 0; i < n; i++) {
      var e = off + 2 + i * 12;
      if (e + 12 > dv.byteLength) break;
      var tag = u16(dv, e, le);
      if (wanted.indexOf(tag) < 0) continue;
      var type = u16(dv, e + 2, le);
      var count = u32(dv, e + 4, le);
      var size = type === 3 ? 2 : type === 4 ? 4 : type === 5 ? 8 : 1;
      var bytes = size * count;
      /* 超过 4 字节的值存的是「相对 TIFF 起点的偏移」，不超过则就地存放 */
      var at = bytes > 4 ? tiff + u32(dv, e + 8, le) : e + 8;
      out[tag] = { type: type, count: count, at: at };
    }
    return out;
  }

  /** 非 JPEG 时从文件头认出真实格式 —— 提示语里得说清楚「是什么」，
      否则「不是 JPEG」和「照片没位置」在用户眼里是同一句话。 */
  function sniff(buf) {
    var b = new Uint8Array(buf);
    if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
    if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
      var br = String.fromCharCode(b[8], b[9], b[10], b[11]);
      return /^(heic|heix|hevc|hevx|mif1|msf1|heim|heis)/.test(br) ? 'heic' : 'isobmff';
    }
    if (b.length >= 4 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return 'webp';
    if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif';
    if (b.length < 4) return 'tooSmall';
    return 'unknown';
  }

  /**
   * 诊断版解析：不只回答「有没有坐标」，还回答「卡在哪一步」。
   *
   * 为什么需要它：调用方原来只拿得到 null，于是「不是 JPEG」「EXIF 被平台剥离」
   * 「拍照时压根没记位置」三种完全不同的成因被压成同一个数字，界面一律提示
   * 「EXIF 里没有 GPS」。用户看到 1000 张里只有 20 张有坐标，第一反应必然是
   * 解析器坏了 —— 而归因一旦错，排查方向就全错。
   *
   * why 穷尽所有出口，取值：
   *   ok          解析成功
   *   notJpeg     不是 JPEG；kind 给出真实格式（png / heic / webp / gif …）
   *   noExif      JPEG 里没有 EXIF 段 —— 导出时被平台剥离（微信/微博的典型）
   *   broken      TIFF 结构异常（字节序或魔数不对，通常是文件损坏）
   *   noGps       有 EXIF 但没有 GPS 子 IFD —— **拍摄时没有记录位置**
   *   gpsInvalid  有 GPS 子 IFD 但值不可用（标签不全 / 0,0 / 超范围）
   */
  function probeExif(buf) {
    var dv = new DataView(buf);
    if (dv.byteLength < 4) return { why: 'notJpeg', kind: 'tooSmall' };
    if (dv.getUint16(0, false) !== 0xffd8) return { why: 'notJpeg', kind: sniff(buf) };

    /* 扫段：每个段是 FF + 标记 + 2 字节长度（长度含这两个字节本身） */
    var off = 2;
    var app1 = -1;
    while (off + 4 <= dv.byteLength) {
      if (dv.getUint8(off) !== 0xff) break; // 结构断了，停
      var marker = dv.getUint8(off + 1);
      if (marker === 0xda || marker === 0xd9) break; // 到了图像数据，后面不可能再有 EXIF
      /* 0x01 / 0xD0~0xD7 是「无长度」段，不跳过会把下一段当成长度字段读错位 */
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        off += 2;
        continue;
      }
      var len = dv.getUint16(off + 2, false);
      if (len < 2) break;
      if (marker === 0xe1) {
        /* APP1 里可能有多段（XMP 也是 APP1），只有以 Exif\0\0 开头的才是。
           这里不 break 而是继续扫 —— EXIF 段可能排在 XMP 之后。 */
        var p = off + 4;
        if (
          dv.getUint32(p, false) === 0x45786966 &&
          dv.getUint16(p + 4, false) === 0x0000
        ) {
          app1 = p + 6;
          break;
        }
      }
      off += 2 + len;
    }
    if (app1 < 0) return { why: 'noExif' };

    /* TIFF 头：字节序 + 0x002A + IFD0 偏移 */
    var tiff = app1;
    var bo = dv.getUint16(tiff, false);
    var le;
    if (bo === 0x4949) le = true;
    else if (bo === 0x4d4d) le = false;
    else return { why: 'broken' };
    if (u16(dv, tiff + 2, le) !== 0x002a) return { why: 'broken' };

    var ifd0 = readIFD(dv, tiff, tiff + u32(dv, tiff + 4, le), le, [0x8825, 0x8769]);

    /* 拍摄时间：原始标签在 Exif 子 IFD（DateTimeOriginal 0x9003）。
       用它的目的是让面板上的「时间」是拍摄时间，而不是文件时间 ——
       从手机导出的照片，文件时间经常是导出那一刻。 */
    var date = '';
    if (ifd0[0x8769]) {
      var exifIfd = readIFD(dv, tiff, tiff + u32(dv, ifd0[0x8769].at, le), le, [0x9003]);
      if (exifIfd[0x9003]) {
        /* 'YYYY:MM:DD HH:MM:SS' → 'YYYY-MM-DD' */
        var s = asciiAt(dv, exifIfd[0x9003].at, 19);
        var m = /^(\d{4}):(\d{2}):(\d{2})/.exec(s);
        if (m) date = m[1] + '-' + m[2] + '-' + m[3];
      }
    }

    /* 有 EXIF 却连 GPS 子 IFD 都没有 —— 这是 iOS/Android 在「拍摄时没有
       位置可用」时的写法（不是写 0,0）。和「解析不出来」是两回事。 */
    if (!ifd0[0x8825]) return { why: 'noGps', date: date };
    var g = readIFD(dv, tiff, tiff + u32(dv, ifd0[0x8825].at, le), le, [0x0001, 0x0002, 0x0003, 0x0004]);
    if (!g[0x0002] || !g[0x0004] || !g[0x0001] || !g[0x0003]) return { why: 'gpsInvalid', date: date };

    var lat = dms(dv, g[0x0002].at, le);
    var lng = dms(dv, g[0x0004].at, le);
    var latRef = asciiAt(dv, g[0x0001].at, 1);
    var lngRef = asciiAt(dv, g[0x0003].at, 1);
    if (latRef === 'S') lat = -lat;
    if (lngRef === 'W') lng = -lng;

    /* 0,0 是「没有定位」的常见写法，不是真坐标（在几内亚湾） */
    if (!isFinite(lat) || !isFinite(lng)) return { why: 'gpsInvalid', date: date };
    if (Math.abs(lat) < 0.0001 && Math.abs(lng) < 0.0001) return { why: 'gpsInvalid', date: date };
    if (Math.abs(lat) > 85.06 || Math.abs(lng) > 180) return { why: 'gpsInvalid', date: date };

    return { why: 'ok', lng: lng, lat: lat, date: date };
  }

  /**
   * 从 JPEG ArrayBuffer 里取 GPS 与拍摄时间。
   * 返回 { lng, lat, date }，date 为 'YYYY-MM-DD' 或 ''。
   * 没有 GPS 时返回 null（调用方据此跳过这张）。
   * 返回契约不变 —— 探针在验它，诊断信息走 probeExif。
   */
  function readExif(buf) {
    var r = probeExif(buf);
    if (r.why !== 'ok') return null;
    return { lng: r.lng, lat: r.lat, date: r.date };
  }

  /* ============================================================= 2. 缩略图管线 */

  /** 等比缩放后居中裁切（cover），与 .pin__thumb / .shot__img 的 object-fit 同口径 */
  function coverCanvas(bmp, w, h) {
    var cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    var c = cv.getContext('2d');
    var s = Math.max(w / bmp.width, h / bmp.height);
    var dw = bmp.width * s;
    var dh = bmp.height * s;
    c.drawImage(bmp, (w - dw) / 2, (h - dh) / 2, dw, dh);
    return cv;
  }

  function canvasUrl(cv, q) {
    return new Promise(function (res) {
      cv.toBlob(
        function (b) {
          res(b ? URL.createObjectURL(b) : '');
        },
        'image/jpeg',
        q
      );
    });
  }

  /**
   * 解一张照片 → 两档小图 → 立刻释放位图。
   * imageOrientation:'from-image' 让浏览器按 EXIF 方向转正，
   * 省掉自己处理 1/3/6/8 那套旋转矩阵。老浏览器不支持该选项时退回默认。
   */
  async function render(file) {
    var bmp;
    try {
      bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (e) {
      try {
        bmp = await createImageBitmap(file);
      } catch (e2) {
        return null; // 解不开（HEIC、损坏文件），计数上报
      }
    }
    var thumb = await canvasUrl(coverCanvas(bmp, THUMB, THUMB), 0.82);
    var prev = await canvasUrl(coverCanvas(bmp, PREV_W, PREV_H), 0.78);
    if (bmp.close) bmp.close(); // 关键：位图不驻留
    return { src: thumb, preview: prev };
  }

  /* ================================================================ 3. 命名 */

  function stem(name) {
    return String(name || '').replace(/\.[^.]+$/, '');
  }

  /**
   * 地点名。
   * 选文件夹导入时用**直属父文件夹名** —— 这是最有意义的一种：
   * 「2024东京/IMG_1.jpg」→「2024东京」，一次旅行聚成一个点。
   * 选多张照片时没有文件夹信息，退回文件名（去掉扩展名），一张一个点。
   */
  function placeOf(file, byFolder) {
    if (byFolder && file.webkitRelativePath) {
      var parts = file.webkitRelativePath.split('/');
      if (parts.length >= 2) return parts[parts.length - 2];
    }
    return stem(file.name);
  }

  /* ================================================================ 4. 入口 */

  /**
   * 把 File[] 变成相册。
   * @param files     File[]（或 FileList）
   * @param opts      { byFolder, onProgress(done, total, placed, skipped) }
   * @returns { photos, urls, placed, skipped, failed }
   */
  async function buildAlbum(files, opts) {
    opts = opts || {};
    var list = Array.prototype.slice.call(files || []);
    var photos = [];
    var urls = [];
    var skipped = 0; // 没能上点位的总数（向后兼容，界面/探针都在读它）
    var failed = 0; // 解不开 / 读不出
    /* 按成因拆开。合并成一个数字的代价见 probeExif 的注释 ——
       用户会把它读成「解析器坏了」，方向就全错。 */
    var why = { notJpeg: 0, noExif: 0, noGps: 0, gpsInvalid: 0, broken: 0, readError: 0 };
    var kinds = {}; // 非 JPEG 的具体格式：{ png: 50, heic: 3 }

    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      try {
        var buf = await f.arrayBuffer();
        var ex = probeExif(buf);
        if (ex.why !== 'ok') {
          skipped++;
          why[ex.why] = (why[ex.why] || 0) + 1;
          if (ex.why === 'notJpeg') {
            var kd = ex.kind || 'unknown';
            kinds[kd] = (kinds[kd] || 0) + 1;
          }
        } else {
          var img = await render(f);
          if (!img || !img.src) {
            failed++;
          } else {
            urls.push(img.src);
            if (img.preview) urls.push(img.preview);
            photos.push({
              id: 'loc-' + i + '-' + f.name,
              src: img.src,
              preview: img.preview,
              /* 优先 EXIF 拍摄时间；没有就退回文件时间 —— 并如实标注在界面上 */
              date: ex.date || isoDay(f.lastModified),
              dateFromExif: !!ex.date,
              place: placeOf(f, opts.byFolder),
              wgs: [ex.lng, ex.lat],
            });
          }
        }
      } catch (e) {
        failed++;
        why.readError++;
      }
      if (opts.onProgress) opts.onProgress(i + 1, list.length, photos.length, skipped);
      /* 让出一帧，进度才有机会画出来。100 张一起解会把主线程堵死。 */
      if (i % 4 === 3) await new Promise(function (r) { requestAnimationFrame(r); });
    }

    return {
      photos: photos,
      urls: urls,
      placed: photos.length,
      skipped: skipped,
      failed: failed,
      why: why,
      kinds: kinds,
    };
  }

  function isoDay(ms) {
    if (!ms) return '';
    var d = new Date(ms);
    var p = function (n) {
      return (n < 10 ? '0' : '') + n;
    };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function release(urls) {
    if (!urls) return;
    for (var i = 0; i < urls.length; i++) {
      try {
        URL.revokeObjectURL(urls[i]);
      } catch (e) {}
    }
  }

  window.PhotoImport = {
    buildAlbum: buildAlbum,
    release: release,
    readExif: readExif,
    probeExif: probeExif,
    sniff: sniff,
    THUMB: THUMB,
    PREV: [PREV_W, PREV_H],
  };
})();
