/**
 * 跨源隔离（Cross-Origin Isolation）用的 Service Worker。
 *
 * 多线程模拟要 SharedArrayBuffer，浏览器只在页面"跨源隔离"时才给：响应要带两个头
 *   Cross-Origin-Opener-Policy: same-origin
 *   Cross-Origin-Embedder-Policy: credentialless
 * 开发服务器（vite.config.ts）会发；GitHub Pages 这种静态托管改不了响应头，就由这个 Service Worker
 * 拦下本站的每个请求，原样转发，再给响应加上这两个头。
 *
 * 只在安全来源（https:// 或 localhost）上能注册 Service Worker；第一次打开时它还没接管页面，
 * index.html 里的注册脚本会在它装好以后刷新一次。之后每次打开都直接隔离。
 * 不想要多线程：网址里加 ?threads=1（照样会隔离，只是模拟用一个线程）。
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const req = e.request;
  // 只处理本站的请求：跨站的（Google 字体等）原样放行，credentialless 下它们照样能加载
  if (new URL(req.url).origin !== self.location.origin) return;
  // 浏览器内部的预取请求：不能用 only-if-cached 去拿非同源的东西，跳过
  if (req.cache === "only-if-cached" && req.mode !== "same-origin") return;
  e.respondWith(
    fetch(req).then((res) => {
      // opaque / 出错的响应不能改头，原样返回
      if (res.status === 0) return res;
      const headers = new Headers(res.headers);
      headers.set("Cross-Origin-Opener-Policy", "same-origin");
      headers.set("Cross-Origin-Embedder-Policy", "credentialless");
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    }),
  );
});
