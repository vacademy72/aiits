// backend/utils/indexNow.js
// Pings IndexNow (notifies Bing, Yandex, and other participating search
// engines instantly) whenever a page's content changes, instead of waiting
// for their normal crawl schedule.
//
// Requires INDEXNOW_KEY in .env, and the matching key file to be hosted at
// https://aitts.in/<INDEXNOW_KEY>.txt (already present in frontend/).

const HOST = 'aitts.in';

async function pingIndexNow(urls) {
  const key = process.env.INDEXNOW_KEY;
  if (!key) {
    console.warn('[IndexNow] INDEXNOW_KEY not set in env -- skipping ping');
    return;
  }

  const urlList = (Array.isArray(urls) ? urls : [urls]).map(u =>
    u.startsWith('http') ? u : `https://${HOST}${u.startsWith('/') ? '' : '/'}${u}`
  );

  try {
    const res = await fetch('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        host: HOST,
        key,
        keyLocation: `https://${HOST}/${key}.txt`,
        urlList
      })
    });
    if (!res.ok) {
      console.warn(`[IndexNow] ping failed: ${res.status} ${res.statusText}`);
    }
  } catch (err) {
    // Never let an IndexNow failure break the actual request that triggered it.
    console.warn('[IndexNow] ping error:', err.message);
  }
}

module.exports = { pingIndexNow };
