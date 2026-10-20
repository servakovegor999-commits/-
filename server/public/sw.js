// Минимальный сервис-воркер: нужен, чтобы «Круг» можно было установить как приложение.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
