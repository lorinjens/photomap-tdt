/**
 * 相册地图 - 照片数据
 *
 * wgs 字段是照片 EXIF 里的原始 GPS 坐标（WGS84 国际标准）。
 * 腾讯地图 / 高德等国内地图用的是 GCJ-02（火星坐标），
 * 所以渲染前必须做一次 WGS84 → GCJ-02 转换，否则会有几百米偏移。
 * 转换在 photo-map.js 里完成，这里只存原始值。
 */
/* ============================================================================
   演示用境外假数据
   ----------------------------------------------------------------------------
   下面这些坐标是造的，不是真照片 —— 只为让「境外照片」这条链路看得见：
   经纬度、国家归属都是真的（真实数据用同样字段就能直接跑），src 复用
   assets/photo-01~18.webp。覆盖到大洋洲与南半球（悉尼 -33.9°、皇后镇
   -45.0°）以及高纬（雷克雅未克 64.1°）—— 墨卡托在南半球要反向、
   高纬要夹到 ±85.05°，这两个边界最容易出问题，先摆进来。
   只想看真实照片，就把下面的 DEMO_WORLD 改成 false。
   ========================================================================== */
var DEMO_WORLD = true;

var DEMO_WORLD_PHOTOS = [
  /* 日本 · 东京（8 张，正好铺满一屏双列网格，用来看列表排布） */
  { id: 'dw-jp-01', src: 'assets/photo-01.webp', date: '2024-03-26', place: '东京·浅草寺', wgs: [139.7967, 35.7148] },
  { id: 'dw-jp-09', src: 'assets/photo-11.webp', date: '2024-03-26', place: '东京·浅草寺', wgs: [139.7960, 35.7152] },
  { id: 'dw-jp-10', src: 'assets/photo-12.webp', date: '2024-03-26', place: '东京·浅草寺', wgs: [139.7972, 35.7145] },
  { id: 'dw-jp-02', src: 'assets/photo-02.webp', date: '2024-03-26', place: '东京·涩谷', wgs: [139.7016, 35.6595] },
  { id: 'dw-jp-03', src: 'assets/photo-03.webp', date: '2024-03-27', place: '东京·东京塔', wgs: [139.7454, 35.6586] },
  { id: 'dw-jp-04', src: 'assets/photo-04.webp', date: '2024-03-27', place: '东京·明治神宫', wgs: [139.6993, 35.6764] },
  { id: 'dw-jp-05', src: 'assets/photo-05.webp', date: '2024-03-28', place: '东京·上野公园', wgs: [139.7745, 35.7141] },
  { id: 'dw-jp-06', src: 'assets/photo-06.webp', date: '2024-03-28', place: '东京·台场', wgs: [139.7745, 35.6297] },

  /* 日本 · 京都 */
  { id: 'dw-jp-07', src: 'assets/photo-07.webp', date: '2024-03-30', place: '京都·清水寺', wgs: [135.7850, 34.9949] },
  { id: 'dw-jp-08', src: 'assets/photo-08.webp', date: '2024-03-31', place: '京都·伏见稻荷', wgs: [135.7727, 34.9671] },

  /* 韩国 · 首尔 */
  { id: 'dw-kr-01', src: 'assets/photo-09.webp', date: '2024-04-05', place: '首尔·景福宫', wgs: [126.9770, 37.5796] },
  { id: 'dw-kr-02', src: 'assets/photo-10.webp', date: '2024-04-06', place: '首尔·南山塔', wgs: [126.9882, 37.5512] },

  /* 泰国 · 曼谷 */
  { id: 'dw-th-01', src: 'assets/photo-11.webp', date: '2024-01-08', place: '曼谷·大皇宫', wgs: [100.4920, 13.7500] },
  { id: 'dw-th-02', src: 'assets/photo-12.webp', date: '2024-01-09', place: '曼谷·郑王庙', wgs: [100.4889, 13.7437] },

  /* 阿联酋 · 迪拜 */
  { id: 'dw-ae-01', src: 'assets/photo-13.webp', date: '2024-01-14', place: '迪拜·哈利法塔', wgs: [55.2744, 25.1972] },

  /* 法国 · 巴黎 */
  { id: 'dw-fr-01', src: 'assets/photo-14.webp', date: '2024-05-18', place: '巴黎·埃菲尔铁塔', wgs: [2.2945, 48.8584] },
  { id: 'dw-fr-02', src: 'assets/photo-15.webp', date: '2024-05-19', place: '巴黎·卢浮宫', wgs: [2.3376, 48.8606] },
  { id: 'dw-fr-03', src: 'assets/photo-16.webp', date: '2024-05-20', place: '巴黎·蒙马特', wgs: [2.3430, 48.8867] },

  /* 意大利 · 罗马 */
  { id: 'dw-it-01', src: 'assets/photo-17.webp', date: '2024-05-24', place: '罗马·斗兽场', wgs: [12.4924, 41.8902] },
  { id: 'dw-it-02', src: 'assets/photo-18.webp', date: '2024-05-25', place: '罗马·许愿池', wgs: [12.4833, 41.9009] },

  /* 冰岛（64°N，高纬：墨卡托放大最狠的地方，顺便看南北半球跨度） */
  { id: 'dw-is-01', src: 'assets/photo-01.webp', date: '2024-02-20', place: '雷克雅未克·极光', wgs: [-21.8277, 64.1466] },
  { id: 'dw-is-02', src: 'assets/photo-02.webp', date: '2024-02-22', place: '维克·黑沙滩', wgs: [-19.0057, 63.4194] },

  /* 埃及 */
  { id: 'dw-eg-01', src: 'assets/photo-03.webp', date: '2024-02-06', place: '吉萨·金字塔', wgs: [31.1342, 29.9792] },
  { id: 'dw-eg-02', src: 'assets/photo-04.webp', date: '2024-02-08', place: '卢克索·卡尔纳克', wgs: [32.6396, 25.7196] },

  /* 美国 */
  { id: 'dw-us-01', src: 'assets/photo-05.webp', date: '2024-09-22', place: '纽约·时代广场', wgs: [-73.9855, 40.7580] },
  { id: 'dw-us-02', src: 'assets/photo-06.webp', date: '2024-09-23', place: '纽约·中央公园', wgs: [-73.9654, 40.7829] },
  { id: 'dw-us-03', src: 'assets/photo-07.webp', date: '2024-09-26', place: '旧金山·金门大桥', wgs: [-122.4783, 37.8199] },

  /* 澳大利亚 / 新西兰（南半球：纬度取负，墨卡托 y 也要取负） */
  { id: 'dw-au-01', src: 'assets/photo-08.webp', date: '2024-11-20', place: '悉尼·歌剧院', wgs: [151.2153, -33.8568] },
  { id: 'dw-au-02', src: 'assets/photo-09.webp', date: '2024-11-21', place: '悉尼·邦迪海滩', wgs: [151.2750, -33.8915] },
  { id: 'dw-nz-01', src: 'assets/photo-10.webp', date: '2024-11-26', place: '皇后镇·瓦卡蒂普湖', wgs: [168.6626, -45.0312] },
];

window.PHOTO_ALBUM = {
  title: '2024 旅行精选',
  subtitle: '一个家庭的欢乐时光',
  photos: [
    /* 北京 */
    { id: 'ph001', src: 'assets/photo-01.webp', date: '2024-07-24', place: '北京·故宫', wgs: [116.3972, 39.9163] },
    { id: 'ph002', src: 'assets/photo-02.webp', date: '2024-07-24', place: '北京·故宫', wgs: [116.4010, 39.9220] },
    { id: 'ph003', src: 'assets/photo-03.webp', date: '2024-07-25', place: '北京·天坛', wgs: [116.4107, 39.8822] },
    { id: 'ph004', src: 'assets/photo-04.webp', date: '2024-07-25', place: '北京·南锣鼓巷', wgs: [116.4030, 39.9370] },
    { id: 'ph005', src: 'assets/photo-05.webp', date: '2024-07-26', place: '北京·八达岭', wgs: [116.0201, 40.3597] },
    { id: 'ph006', src: 'assets/photo-06.webp', date: '2024-07-26', place: '北京·颐和园', wgs: [116.2730, 39.9996] },

    /* 上海 */
    { id: 'ph007', src: 'assets/photo-07.webp', date: '2024-08-02', place: '上海·外滩', wgs: [121.4873, 31.2340] },
    { id: 'ph008', src: 'assets/photo-08.webp', date: '2024-08-02', place: '上海·外滩', wgs: [121.4900, 31.2360] },
    { id: 'ph009', src: 'assets/photo-09.webp', date: '2024-08-03', place: '上海·陆家嘴', wgs: [121.4998, 31.2397] },
    { id: 'ph010', src: 'assets/photo-10.webp', date: '2024-08-03', place: '上海·武康路', wgs: [121.4365, 31.2070] },
    { id: 'ph011', src: 'assets/photo-11.webp', date: '2024-08-04', place: '上海·朱家角', wgs: [121.0560, 31.1110] },

    /* 浙江 */
    { id: 'ph012', src: 'assets/photo-12.webp', date: '2024-08-10', place: '杭州·西湖', wgs: [120.1420, 30.2489] },
    { id: 'ph013', src: 'assets/photo-13.webp', date: '2024-08-10', place: '杭州·西湖', wgs: [120.1350, 30.2420] },
    { id: 'ph014', src: 'assets/photo-14.webp', date: '2024-08-11', place: '杭州·灵隐寺', wgs: [120.1020, 30.2410] },
    { id: 'ph015', src: 'assets/photo-15.webp', date: '2024-08-12', place: '杭州·千岛湖', wgs: [119.0420, 29.6050] },
    { id: 'ph016', src: 'assets/photo-16.webp', date: '2024-08-13', place: '宁波·象山', wgs: [121.8700, 29.4700] },
    { id: 'ph017', src: 'assets/photo-17.webp', date: '2024-08-14', place: '舟山·普陀山', wgs: [122.3900, 30.0100] },

    /* 四川 */
    { id: 'ph018', src: 'assets/photo-18.webp', date: '2024-04-12', place: '成都·宽窄巷子', wgs: [104.0530, 30.6690] },
    { id: 'ph019', src: 'assets/photo-01.webp', date: '2024-04-12', place: '成都·宽窄巷子', wgs: [104.0560, 30.6710] },
    { id: 'ph020', src: 'assets/photo-02.webp', date: '2024-04-13', place: '成都·大熊猫基地', wgs: [104.1467, 30.7333] },
    { id: 'ph021', src: 'assets/photo-03.webp', date: '2024-04-14', place: '都江堰', wgs: [103.6173, 31.0028] },
    { id: 'ph022', src: 'assets/photo-04.webp', date: '2024-04-15', place: '阿坝·九寨沟', wgs: [103.9200, 33.2600] },
    { id: 'ph023', src: 'assets/photo-05.webp', date: '2024-04-16', place: '甘孜·稻城亚丁', wgs: [100.3300, 28.4300] },

    /* 云南 */
    { id: 'ph024', src: 'assets/photo-06.webp', date: '2024-05-03', place: '丽江·古城', wgs: [100.2299, 26.8721] },
    { id: 'ph025', src: 'assets/photo-07.webp', date: '2024-05-04', place: '丽江·玉龙雪山', wgs: [100.1833, 27.1000] },
    { id: 'ph026', src: 'assets/photo-08.webp', date: '2024-05-05', place: '大理·古城', wgs: [100.1600, 25.6900] },
    { id: 'ph027', src: 'assets/photo-09.webp', date: '2024-05-06', place: '大理·洱海', wgs: [100.1800, 25.8000] },
    { id: 'ph028', src: 'assets/photo-10.webp', date: '2024-05-07', place: '香格里拉', wgs: [99.7000, 27.8300] },

    /* 福建 */
    { id: 'ph029', src: 'assets/photo-11.webp', date: '2024-06-08', place: '厦门·鼓浪屿', wgs: [118.0680, 24.4470] },
    { id: 'ph030', src: 'assets/photo-12.webp', date: '2024-06-08', place: '厦门·鼓浪屿', wgs: [118.0720, 24.4450] },
    { id: 'ph031', src: 'assets/photo-13.webp', date: '2024-06-09', place: '厦门·环岛路', wgs: [118.1400, 24.4300] },
    { id: 'ph032', src: 'assets/photo-14.webp', date: '2024-06-10', place: '南平·武夷山', wgs: [117.9800, 27.7000] },

    /* 海南 */
    { id: 'ph033', src: 'assets/photo-15.webp', date: '2024-01-20', place: '三亚·亚龙湾', wgs: [109.6400, 18.2200] },
    { id: 'ph034', src: 'assets/photo-16.webp', date: '2024-01-21', place: '三亚·天涯海角', wgs: [109.3700, 18.3000] },
    { id: 'ph035', src: 'assets/photo-17.webp', date: '2024-01-22', place: '三亚·海棠湾', wgs: [109.7000, 18.3400] },
    { id: 'ph036', src: 'assets/photo-18.webp', date: '2024-01-23', place: '海口·骑楼老街', wgs: [110.3400, 20.0400] },

    /* 山东 */
    { id: 'ph037', src: 'assets/photo-01.webp', date: '2024-10-02', place: '青岛·栈桥', wgs: [120.3130, 36.0600] },
    { id: 'ph038', src: 'assets/photo-02.webp', date: '2024-10-02', place: '青岛·八大关', wgs: [120.3500, 36.0530] },
    { id: 'ph039', src: 'assets/photo-03.webp', date: '2024-10-03', place: '青岛·崂山', wgs: [120.6300, 36.1600] },
    { id: 'ph040', src: 'assets/photo-04.webp', date: '2024-10-05', place: '泰安·泰山', wgs: [117.1000, 36.2500] },

    /* 陕西 */
    { id: 'ph041', src: 'assets/photo-05.webp', date: '2024-09-14', place: '西安·大雁塔', wgs: [108.9640, 34.2186] },
    { id: 'ph042', src: 'assets/photo-06.webp', date: '2024-09-15', place: '西安·兵马俑', wgs: [109.2785, 34.3841] },
    { id: 'ph043', src: 'assets/photo-07.webp', date: '2024-09-15', place: '西安·城墙', wgs: [108.9400, 34.2600] },

    /* 重庆 */
    { id: 'ph044', src: 'assets/photo-08.webp', date: '2024-03-18', place: '重庆·洪崖洞', wgs: [106.5830, 29.5628] },
    { id: 'ph045', src: 'assets/photo-09.webp', date: '2024-03-19', place: '重庆·武隆', wgs: [107.7500, 29.3250] },

    /* 新疆 */
    { id: 'ph046', src: 'assets/photo-10.webp', date: '2024-07-05', place: '伊犁·那拉提', wgs: [84.1000, 43.3000] },
    { id: 'ph047', src: 'assets/photo-11.webp', date: '2024-07-06', place: '博州·赛里木湖', wgs: [81.2000, 44.6000] },
    { id: 'ph048', src: 'assets/photo-12.webp', date: '2024-07-08', place: '喀什·古城', wgs: [75.9900, 39.4700] },

    /* 青海 / 西藏 */
    { id: 'ph049', src: 'assets/photo-13.webp', date: '2024-07-12', place: '海北·青海湖', wgs: [100.2000, 36.9000] },
    { id: 'ph050', src: 'assets/photo-14.webp', date: '2024-07-13', place: '海西·茶卡盐湖', wgs: [99.0800, 36.7000] },
    { id: 'ph051', src: 'assets/photo-15.webp', date: '2024-07-16', place: '拉萨·布达拉宫', wgs: [91.1170, 29.6570] },
    { id: 'ph052', src: 'assets/photo-16.webp', date: '2024-07-18', place: '拉萨·纳木错', wgs: [90.6000, 30.7500] },

    /* 广西 / 湖南 */
    { id: 'ph053', src: 'assets/photo-17.webp', date: '2024-02-11', place: '桂林·阳朔', wgs: [110.4960, 24.7780] },
    { id: 'ph054', src: 'assets/photo-18.webp', date: '2024-02-12', place: '桂林·漓江', wgs: [110.4100, 25.0300] },
    { id: 'ph055', src: 'assets/photo-01.webp', date: '2024-02-14', place: '张家界·武陵源', wgs: [110.4300, 29.3100] },

    /* 内蒙古 / 黑龙江 */
    { id: 'ph056', src: 'assets/photo-02.webp', date: '2024-08-20', place: '呼伦贝尔·海拉尔', wgs: [119.7650, 49.2120] },
    { id: 'ph057', src: 'assets/photo-03.webp', date: '2024-08-21', place: '呼伦贝尔·额尔古纳', wgs: [120.1800, 50.2400] },
    { id: 'ph058', src: 'assets/photo-04.webp', date: '2024-12-28', place: '哈尔滨·冰雪大世界', wgs: [126.5800, 45.7800] },

    /* 中国香港 / 中国澳门 / 中国台湾 */
    { id: 'ph059', src: 'assets/photo-05.webp', date: '2024-11-09', place: '中国香港·维港', wgs: [114.1700, 22.2930] },
    { id: 'ph060', src: 'assets/photo-06.webp', date: '2024-11-09', place: '中国香港·太平山', wgs: [114.1500, 22.2710] },
    { id: 'ph061', src: 'assets/photo-07.webp', date: '2024-11-10', place: '中国澳门·大三巴', wgs: [113.5400, 22.1975] },
    { id: 'ph062', src: 'assets/photo-08.webp', date: '2024-11-12', place: '中国台湾·日月潭', wgs: [120.9100, 23.8600] },
    { id: 'ph063', src: 'assets/photo-09.webp', date: '2024-11-13', place: '中国台湾·台北', wgs: [121.5654, 25.0330] },

    /* 境外演示数据：开关在文件开头的 DEMO_WORLD，关掉后这里就是空数组 */
    ...(DEMO_WORLD ? DEMO_WORLD_PHOTOS : []),
  ],
};
