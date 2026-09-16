/* ---------------------------------------------------------------------------
   顶栏按钮的宽度自适应编排（零依赖，主线与实验线共用）

   规则来自一个明确的取舍：**按钮不许缩放**。

   宽度不够时，宁可少显示几个按钮（收进「更多」），也不把每个按钮压窄。
   压窄的后果不是「变小」，是**把两字标签折成两行** —— 34px 高的药丸装不下
   一行半的字，看起来像界面坏了；而少一个入口只是少一个入口。

   谁是「少显示的那个」由 `data-pri` 决定，数字越小越先保留（缺省 5）。
   收纳顺序与优先级相反：先收 6，最后才动 1。

   为什么是**搬移** DOM 而不是克隆一个「菜单版按钮」：
   被收起的按钮带状态（注记的 aria-pressed、配色按钮的色点、aria-expanded）。
   搬移保住节点、状态、事件监听和脚本里持有的引用；克隆要重新接线，
   接线漏一处就是一个「收起来能用、放回去失灵」的 bug。

   用法：
     <script src="topbar-fit.js"></script>
     按钮上加 data-pri="1"（1 最优先保留）。
     尺寸变化会自动重排；若脚本改了品牌文字，调 window.topbarFit() 立刻重排。

   测试缝：`?topbarmin=<px>` 把可用宽度强制成给定值，用来在不改窗口尺寸的
   情况下验证收纳（无头环境里改窗口尺寸会连带改变地图视野，读数不可比）。
--------------------------------------------------------------------------- */
(function () {
  'use strict';

  var topbar = document.querySelector('.topbar');
  if (!topbar) return;

  var brand = topbar.querySelector('.brand');

  /* 只认 topbar 的**直接子**按钮。菜单里的按钮也是 .pill-btn，
     用后代选择器会把收进去的按钮再数一遍，编排变成自我参照。 */
  var pills = [];
  for (var i = 0; i < topbar.children.length; i++) {
    var ch = topbar.children[i];
    if (ch.classList && ch.classList.contains('pill-btn')) pills.push(ch);
  }
  if (!pills.length) return;

  var order = pills.slice(); // 原始顺序。还原、以及「同优先级优先收右边的」都靠它

  var GAP = 10; // 与 .topbar 的 gap 一致

  /* 左右内边距**从计算值读**，不抄常量。
     这不是洁癖：顶栏的 padding 会被宿主改 —— 桌面版（tdt-demo-desktop）在 macOS 上
     注入 `padding-left: 88px` 给系统红绿灯让位。编排若还按 16 算，就等于凭空多出
     72px 可用宽度，症状是「按钮其实放不下却不收进更多」，标签被裁掉，
     而这种裁切从截图上几乎看不出来。读不到（元素被隐藏等）时回退 16，
     与改动前逐字一致 —— 网页版的行为因此一点没变。 */
  function padOf(side) {
    var v = parseFloat(getComputedStyle(topbar)['padding' + side]);
    return isFinite(v) ? v : 16;
  }

  /* 强制可用宽度（测试缝）。NaN 表示不干预。 */
  var forceAvail = NaN;
  var m = /[?&]topbarmin=(\d+)/.exec(location.search);
  if (m) forceAvail = +m[1];

  /* ---- 结构：更多按钮 + 收纳菜单 ---- */

  var MORE_SVG =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
    '<circle cx="3.3" cy="8" r="1.35" fill="currentColor"/>' +
    '<circle cx="8" cy="8" r="1.35" fill="currentColor"/>' +
    '<circle cx="12.7" cy="8" r="1.35" fill="currentColor"/></svg>';

  var more = document.createElement('div');
  more.className = 'topbar__more';

  var moreBtn = document.createElement('button');
  moreBtn.type = 'button';
  moreBtn.className = 'pill-btn topbar__more-btn';
  moreBtn.setAttribute('aria-label', '更多');
  moreBtn.setAttribute('aria-expanded', 'false');
  moreBtn.setAttribute('title', '更多');
  moreBtn.innerHTML = MORE_SVG;

  var menu = document.createElement('div');
  menu.className = 'topbar__menu';

  more.appendChild(moreBtn);
  more.appendChild(menu);
  topbar.appendChild(more);

  function closeMenu() {
    if (!more.classList.contains('is-open')) return;
    more.classList.remove('is-open');
    moreBtn.setAttribute('aria-expanded', 'false');
  }

  moreBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    var open = more.classList.toggle('is-open');
    moreBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  document.addEventListener('click', function (e) {
    if (more.contains(e.target)) return;
    closeMenu();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeMenu();
  });

  /* ---- 编排 ---- */

  /* 优先级表：`data-pri` 属性优先，其次查这张表，最后缺省 5。

     表放在这里而不是散进两条线的 HTML，理由只有一个 —— 两条线的按钮集
     不同（主线三个、实验线六个），放一起才看得出「谁比谁先被收」，
     也才不容易只改一边。属性仍然可用，页面想单独调某个按钮不必动这个文件。

     排序依据是「离了它还能不能用」，不是「哪个好看」：
       全国 / 世界  —— 没了就回不到已知视野，最高；
       配色        —— 高频动作，且是纯视觉入口；
       注记 / 照片  —— 实验线专有的一次性动作；
       密钥        —— 设置类，配一次就不再碰。 */
  var PRI = {
    btnHome: 1,
    btnWorld: 2,
    btnTheme: 3,
    btnNote: 4,
    btnPhoto: 5,
    btnKey: 6,
  };

  function pri(el) {
    var v = parseFloat(el.getAttribute('data-pri'));
    if (isFinite(v)) return v;
    var byId = PRI[el.id];
    return isFinite(byId) ? byId : 5;
  }

  /* 谁先被收：优先级数字大的先收；同级时**靠右的先收** ——
     右侧本来就被窗口边缘先吃掉，先收它在视觉上最自然。 */
  var dropOrder = order.slice().sort(function (a, b) {
    return pri(b) - pri(a) || order.indexOf(b) - order.indexOf(a);
  });

  function layout() {
    /* 第一步必须是**还原**：所有按钮先回 topbar 再测量。
       不这么做就会拿「菜单里的宽度」去算 topbar —— 菜单里的按钮是
       width:100%，量出来恒等于菜单宽，编排结果全错。 */
    for (var i = 0; i < order.length; i++) {
      if (order[i].parentNode !== topbar) topbar.insertBefore(order[i], more);
    }

    var avail = isFinite(forceAvail) ? forceAvail : topbar.clientWidth - padOf('Left') - padOf('Right');
    if (avail <= 0) return; // 还没布局出宽度（首帧 / 被隐藏）

    /* 先假定要显示「更多」再量它：display:none 的元素 offsetWidth 恒为 0，
       不先亮出来就永远算不出该给它留多少空间。 */
    more.classList.add('is-shown');
    var moreW = moreBtn.offsetWidth;
    var brandW = brand ? brand.offsetWidth : 0;

    var widths = order.map(function (el) {
      return el.offsetWidth;
    });
    var sum = widths.reduce(function (a, b) {
      return a + b;
    }, 0);

    /* 全部显示所需。`.topbar__spacer` 是 flex-basis:0 的弹性块，宽度 0，
       但它**仍是一个 flex item**，所以它的那个 gap 是要算进去的。 */
    var needAll = brandW + sum + GAP * (1 + order.length);
    if (needAll <= avail) {
      more.classList.remove('is-shown');
      closeMenu();
      return;
    }

    var dropped = 0;
    var keptSum = sum;
    for (var k = 0; k < dropOrder.length; k++) {
      var el = dropOrder[k];
      var nextSum = keptSum - widths[order.indexOf(el)];
      var nextCount = order.length - dropped - 1;
      /* 显示 nextCount 个按钮 + 更多按钮时的 flex item 数：
         brand + spacer + 这些按钮 + 更多 = nextCount + 3 → gap 数 = nextCount + 2 */
      var need = brandW + moreW + GAP * (nextCount + 2) + nextSum;
      dropped++;
      keptSum = nextSum;
      if (need <= avail) break;
    }

    for (var j = 0; j < dropped; j++) menu.appendChild(dropOrder[j]);
    more.classList.add('is-shown');
    if (!dropped) closeMenu();
  }

  /* 节流而不是纯 rAF。顶栏的右边界挂在 --panel-w 上，而面板是 300ms 的
     缓动滑入 —— ResizeObserver 会在这 300ms 里连发几十次。每次都重排
     意味着每秒上百次 DOM 搬移（按钮在 topbar 与菜单之间来回），
     既不必要也会让过渡掉帧。80ms 一次，过渡全程约 4 次，够用。 */
  var timer = 0;
  var last = 0;
  function schedule() {
    if (timer) return;
    var wait = Math.max(0, 80 - (performance.now() - last));
    timer = setTimeout(function () {
      timer = 0;
      last = performance.now();
      layout();
    }, wait);
  }

  if (window.ResizeObserver) {
    var ro = new ResizeObserver(schedule);
    ro.observe(topbar);
    if (brand) ro.observe(brand); // 品牌文字变了也要重排（它宽度变了）
  }
  window.addEventListener('resize', schedule);

  window.topbarFit = schedule;

  /* 首帧之后先跑一次：等样式表生效、字体度量稳定，量出来的宽度才可信。 */
  if (document.readyState === 'complete') schedule();
  else window.addEventListener('load', schedule);
})();
