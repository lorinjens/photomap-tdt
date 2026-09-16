#!/usr/bin/env node
/* 在项目根目录起一个本地静态服务器，并打开相册地图。

   用法：
     node tools/serve.js          # 自动挑端口、自动开浏览器
     node tools/serve.js 8000     # 指定端口
     MAP_NO_OPEN=1 node tools/serve.js   # 不开浏览器（自动化用）

   为什么是 Node 而不是 Python：
     部分环境下 `python` 可能解析到应用商店占位程序或根本不存在，
     Node 是本项目唯一假设存在的东西（Node 18+，零第三方依赖）。
     脚本本身只用标准库。

   为什么不直接双击页面文件（file://）：
     能跑，但页面要请求 ./assets/geo/*.js 这类子资源，file:// 下各浏览器、
     各安全设置的策略不一致；一旦出问题，报错是「加载失败 assets/geo/xxx.js」，
     看不出断在哪一环。走 http://127.0.0.1 就和线上一致。

   为什么不直接用 `python -m http.server`（假设有 Python）：
     它能跑，但不发禁缓存头 —— 改完 JS 刷新看到的还是旧的，很容易误判成
     「我的改动没生效」。线上 nginx 给 .js 挂 30 天 immutable 是同一个坑的另一面。
     这里统一 no-store。
*/

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
/* 启动浏览器时自动打开的页面。 */
const PAGE = 'index.html';
const PREFERRED = 8000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

function makeServer() {
  return http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    const file = path.join(ROOT, url === '/' ? '/' + PAGE : url);
    /* 防目录穿越：解析后必须仍落在项目根之内 */
    if (path.relative(ROOT, file).startsWith('..') || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 ' + url);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store, must-revalidate',   // 改完刷新即生效
    });
    fs.createReadStream(file).pipe(res);
  });
}

function listenOn(server, port) {
  return new Promise((resolve, reject) => {
    const onErr = (e) => { server.removeListener('listening', onOk); reject(e); };
    const onOk = () => { server.removeListener('error', onErr); resolve(server.address().port); };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(port, '127.0.0.1');
  });
}

function openBrowser(url) {
  if (process.env.MAP_NO_OPEN === '1') return;
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
    : process.platform === 'darwin' ? ['open', [url]]
      : ['xdg-open', [url]];
  try {
    /* error 事件是异步的，try/catch 接不住（如 xdg-open 不存在），必须挂监听 */
    spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' })
      .on('error', () => { /* 开不了就自己点，别因此崩掉 */ })
      .unref();
  } catch (e) { /* 同上 */ }
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, PAGE))) {
    console.error('找不到 ' + PAGE + '：这个脚本要放在项目里跑（推断的项目根目录是 ' + ROOT + '）');
    process.exit(2);
  }
  const want = Number(process.argv[2]) || PREFERRED;
  const server = makeServer();
  let port;
  try {
    port = await listenOn(server, want);
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
    console.log('端口 ' + want + ' 被占用，改用系统分配的空闲端口。');
    port = await listenOn(server, 0);
  }
  const url = 'http://127.0.0.1:' + port + '/' + PAGE;
  console.log('相册地图  ->  ' + url);
  console.log('项目根目录 ->  ' + ROOT);
  console.log('按 Ctrl+C 停止。');
  setTimeout(() => openBrowser(url), 700);
}

main().catch((e) => {
  console.error('启动失败：' + ((e && e.stack) || e));
  process.exit(1);
});
