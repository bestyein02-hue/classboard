// 수업 보드 설치용 파일 — 아무것도 저장해 두지 않고 늘 최신 화면을 불러옵니다.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", e => {
  if (e.request.mode !== "navigate") return;
  e.respondWith(fetch(e.request).catch(() => new Response(
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div style="font:20px/1.6 sans-serif;padding:40px;color:#1B1B1B;background:#FBF8F1;min-height:100vh">인터넷에 연결되어 있지 않아요.<br>연결을 확인한 뒤 다시 열어 주세요.</div>',
    { headers: { "content-type": "text/html; charset=utf-8" } })));
});
