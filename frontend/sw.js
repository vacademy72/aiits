// Bump this string on every deploy that changes any cached asset (JS/CSS/
// HTML) — it's the ONLY thing that makes activate() below evict the old
// cache. Forgetting to bump it is exactly what caused a real production bug:
// admins' browsers kept serving a stale cached frontend/ai-import.js (with
// an old upload field name) against an already-updated backend, producing
// "MulterError: Unexpected field" server-side and a confusing "Unexpected
// token '<'" JSON-parse error client-side (Express's default HTML error
// page being fed to res.json()). Bump this on every deploy touching
// frontend/*.js or *.html, not just when something "feels" cache-related.
var CACHE = 'aiits-v8';
var STATIC = ['/', '/manifest.json'];
self.addEventListener('install', function(e) {
  e.waitUntil(caches.open(CACHE).then(function(c){ return c.addAll(STATIC); }).then(function(){ return self.skipWaiting(); }).catch(function(){ return self.skipWaiting(); }));
});
self.addEventListener('activate', function(e) {
  e.waitUntil(caches.keys().then(function(keys){ return Promise.all(keys.filter(function(k){ return k!==CACHE; }).map(function(k){ return caches.delete(k); })); }).then(function(){ return self.clients.claim(); }));
});
self.addEventListener('fetch', function(e) {
  var url = e.request.url;
  if (e.request.method !== 'GET') return;
  if (url.includes('/socket.io') || url.includes('google') || url.includes('cdnjs') || url.includes('doubleclick') || url.includes('adtrafficquality') || url.includes('sodar') || url.includes('pagead') || url.includes('adsbygoogle') || url.includes('fonts.g')) return;
  if (new URL(url).origin !== self.location.origin) return; // Gemini / PubChem / RCSB / CDN requests go straight to the network
  var p = new URL(url).pathname;
  if (p.startsWith('/api/')) {
    e.respondWith(fetch(e.request).catch(function(){ return new Response(JSON.stringify({ error:'Offline' }),{ status:503, headers:{ 'Content-Type':'application/json' } }); }));
    return;
  }
  var accept = e.request.headers.get('accept')||'';
  if (accept.includes('text/html')) {
    e.respondWith(fetch(e.request).then(function(res){ if(res&&res.status===200&&res.type==='basic'){var c=res.clone();caches.open(CACHE).then(function(ca){ca.put(e.request,c);});}return res;}).catch(function(){ return caches.match(e.request).then(function(c){ return c||caches.match('/'); }); }));
    return;
  }
  e.respondWith(caches.match(e.request).then(function(c){ if(c)return c; return fetch(e.request).then(function(res){ if(res&&res.status===200&&res.type==='basic'){var cl=res.clone();caches.open(CACHE).then(function(ca){ca.put(e.request,cl);});}return res;}).catch(function(){ return new Response('',{status:404}); }); }));
});
self.addEventListener('push', function(e) {
  var d={};
  try{ d=e.data?e.data.json():{};} catch(err){}
  e.waitUntil(self.registration.showNotification(d.title||'AITTS',{ body:d.body||'New update', icon:'/images/icon-192.png', badge:'/images/icon-192.png', tag:'aiits', data:{ url:d.url||'/' }, vibrate:[200,100,200] }));
});
self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  var url=(e.notification.data&&e.notification.data.url)||'/';
  e.waitUntil(clients.matchAll({ type:'window', includeUncontrolled:true }).then(function(list){ for(var i=0;i<list.length;i++){if(list[i].url.includes(self.location.origin)&&'focus' in list[i]){list[i].navigate(url);return list[i].focus();}}return clients.openWindow(url); }));
});
