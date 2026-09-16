#!/usr/bin/env node
/**
 * inject-gps.js — 往 JPEG 里写入正确的 GPS EXIF（零依赖）
 *
 * 用法：
 *   node inject-gps.js <照片.jpg> <纬度> <经度> [拍摄日期YYYY-MM-DD] [--out=输出.jpg]
 *   例：node inject-gps.js IMG_001.jpg 34.0456 -118.2428 2025-10-01
 *   省略 --out 时原地覆盖（建议先备份）。
 *
 * 写出的结构与相册导入解析器（photo-import.js）逐字段对齐，要点：
 *   1. GPS IFD 标签号：0x0001 GPSLatitudeRef / 0x0002 GPSLatitude /
 *      0x0003 GPSLongitudeRef / 0x0004 GPSLongitude —— **0x0003 是经度半球引用、
 *      0x0004 才是经度值**（手写最容易错位的一处）。
 *   2. 半球引用是 ASCII 字符：'N'/'S'/'E'/'W'。西经必须把 'W' 写进 0x0003，
 *      坐标本体保持正值 —— 解析器读到 'W' 才会取负。漏写/小写 = 坐标落到东半球。
 *   3. 经纬度值是 3 个 RATIONAL（度/分/秒），count 必须是 3。
 *      直接把十进制度写成 1 个 RATIONAL 解析器会读越界出垃圾值。
 *   4. 有效范围：|纬度| ≤ 85.06、|经度| ≤ 180、不许 0,0（那是"没有定位"）。
 *
 * 已知限制：整个 APP1(Exif) 段被替换 —— 原照片若有 orientation 等别的 EXIF
 * 标签会一并丢掉（相机直出照片的 orientation 通常也已烘焙进像素，影响有限）。
 */
'use strict';
const fs = require('fs');

function w16(v) { return Buffer.from([v & 255, (v >> 8) & 255]); }
function w32(v) { return Buffer.from([v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]); }
/** JPEG 段长度是大端（TIFF 内部才是小端）—— 两个字节序混用是这类工具的第一大坑 */
function w16be(v) { return Buffer.from([(v >> 8) & 255, v & 255]); }

/** 十进制度 → 度/分/秒 三个 RATIONAL（100 分之一秒精度） */
function dmsRationals(v) {
  const a = Math.abs(v);
  const deg = Math.floor(a);
  const min = Math.floor((a - deg) * 60);
  const sec = Math.round(((a - deg) * 60 - min) * 60 * 100);
  return Buffer.concat([w32(deg), w32(1), w32(min), w32(1), w32(sec), w32(100)]);
}

/** 构造 APP1(Exif) 段：IFD0{ExifIFD, GPSInfo} + ExifIFD{日期} + GPSIFD{半球,度分秒} */
function buildExifApp1(lat, lng, date) {
  // 偏移布局（TIFF 内相对偏移，II 小端）
  const IFD0 = 8;
  const EXIF_IFD = IFD0 + 2 + 12 * 2 + 4;      // IFD0: 2 项 + next=0 → 38
  const DATE_OFF = EXIF_IFD + 2 + 12 + 4;      // ExifIFD: 1 项 + next → 56
  const GPS_IFD = DATE_OFF + 20;               // 日期 19 字符 + NUL = 20 → 76
  const LAT_RAT = GPS_IFD + 2 + 12 * 4 + 4;    // GPS IFD: 4 项 + next → 130
  const LNG_RAT = LAT_RAT + 24;                // 154

  const latRef = lat >= 0 ? 'N' : 'S';
  const lngRef = lng >= 0 ? 'E' : 'W';
  const dateStr = (date || '') ? date.replace(/-/g, ':') + ' 00:00:00\0' : '';
  const hasDate = dateStr.length > 0;

  const ifd0 = Buffer.concat([
    w16(2),
    w16(0x8769), w16(4), w32(1), w32(EXIF_IFD), // ExifIFDPointer
    w16(0x8825), w16(4), w32(1), w32(GPS_IFD),  // GPSInfoIFDPointer
    w32(0),
  ]);
  const exifIfd = hasDate
    ? Buffer.concat([w16(1), w16(0x9003), w16(2), w32(20), w32(DATE_OFF), w32(0)])
    : Buffer.concat([w16(0), w32(0)]);

  const gps = Buffer.concat([
    w16(4),
    w16(0x0001), w16(2), w32(2), Buffer.from([latRef.charCodeAt(0), 0, 0, 0]),
    w16(0x0002), w16(5), w32(3), w32(LAT_RAT),
    w16(0x0003), w16(2), w32(2), Buffer.from([lngRef.charCodeAt(0), 0, 0, 0]),
    w16(0x0004), w16(5), w32(3), w32(LNG_RAT),
    w32(0),
  ]);
  const rationals = Buffer.concat([dmsRationals(lat), dmsRationals(lng)]);
  const dateBuf = hasDate ? Buffer.from(dateStr, 'latin1') : Buffer.alloc(0);

  let tiffLen = GPS_IFD + 2 + 48 + 4;
  if (LAT_RAT + 48 > tiffLen) tiffLen = LAT_RAT + 48;
  const tiff = Buffer.alloc(tiffLen);
  Buffer.from('II', 'latin1').copy(tiff, 0);
  w16(42).copy(tiff, 2);
  w32(IFD0).copy(tiff, 4);
  ifd0.copy(tiff, IFD0);
  exifIfd.copy(tiff, EXIF_IFD);
  if (hasDate) dateBuf.copy(tiff, DATE_OFF);
  gps.copy(tiff, GPS_IFD);
  rationals.copy(tiff, LAT_RAT);

  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  return Buffer.concat([Buffer.from([0xff, 0xe1]), w16be(payload.length + 2), payload]);
}

/** 扫描 JPEG 段，替换已有 APP1-Exif，其余原样保留，新 APP1 插在 SOI 之后 */
function inject(jpeg, app1) {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('不是 JPEG（缺 SOI）');
  const parts = [jpeg.subarray(0, 2), app1];
  let off = 2;
  while (off + 4 <= jpeg.length) {
    if (jpeg[off] !== 0xff) throw new Error('JPEG 段结构损坏 @' + off);
    const marker = jpeg[off + 1];
    if (marker === 0xda) { parts.push(jpeg.subarray(off)); break; } // SOS 起原样接上
    if (marker === 0xd9) { parts.push(jpeg.subarray(off)); break; } // EOI
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { parts.push(jpeg.subarray(off, off + 2)); off += 2; continue; }
    const len = jpeg.readUInt16BE(off + 2);
    const seg = jpeg.subarray(off, off + 2 + len);
    const isExifApp1 = marker === 0xe1
      && jpeg[off + 4] === 0x45 && jpeg[off + 5] === 0x78 && jpeg[off + 6] === 0x69
      && jpeg[off + 7] === 0x66 && jpeg[off + 8] === 0x00; // "Exif\0"
    if (!isExifApp1) parts.push(seg); // 旧 EXIF 丢弃，其余段（JFIF/XMP…）保留
    off += 2 + len;
  }
  return Buffer.concat(parts);
}

function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--out='));
  const outArg = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6);
  const [file, latS, lngS, date] = args;
  if (!file || latS === undefined || lngS === undefined) {
    console.log('用法: node inject-gps.js <照片.jpg> <纬度> <经度> [YYYY-MM-DD] [--out=输出.jpg]');
    process.exit(1);
  }
  const lat = Number(latS);
  const lng = Number(lngS);
  if (!isFinite(lat) || !isFinite(lng)) { console.error('坐标不是数字'); process.exit(1); }
  if (Math.abs(lat) > 85.06 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) {
    console.error('坐标越界（|纬度|≤85.06、|经度|≤180、不许 0,0）');
    process.exit(1);
  }
  const src = fs.readFileSync(file);
  const out = inject(src, buildExifApp1(lat, lng, date));
  const dest = outArg || file;
  fs.writeFileSync(dest, out);
  console.log(`OK: ${dest}  lat=${lat} lng=${lng} (${lat >= 0 ? 'N' : 'S'}${Math.abs(lat).toFixed(4)} ${lng >= 0 ? 'E' : 'W'}${Math.abs(lng).toFixed(4)})`);
}
main();
