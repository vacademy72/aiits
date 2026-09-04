require('dotenv').config();
// AWS_* required as of the DynamoDB migration — Test, UserProfile, and
// Result all now live there (see backend/dynamo/*.js); MongoDB is still
// required too, for everything that stayed there (chat, ad images, PDF
// imports, the leaderboard cache, forgot-password attempts).
const REQUIRED = ['MONGODB_URI','ADMIN_EMAIL','ADMIN_PASSWORD','AWS_REGION','AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY'];
const missing  = REQUIRED.filter(k=>!process.env[k]);
if (missing.length) { console.error('[STARTUP] Missing env vars:', missing.join(', '), '— see DYNAMODB_SETUP.md for the AWS_* ones'); process.exit(1); }
if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON && !process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
  console.error('[STARTUP] Missing FIREBASE_SERVICE_ACCOUNT_JSON env var');
  process.exit(1);
}
if (!process.env.JWT_SECRET) { process.env.JWT_SECRET = require('crypto').randomBytes(64).toString('hex'); console.warn('[STARTUP] JWT_SECRET not set -- add to Render env!'); }
if (!process.env.CLIENT_URL) { console.warn('[STARTUP] CLIENT_URL not set — CORS will reflect any request origin with credentials enabled. Set CLIENT_URL to your actual frontend URL.'); }

const express      = require('express');
const http         = require('http');
const { Server }   = require('socket.io');
const mongoose     = require('mongoose');
const cookieParser = require('cookie-parser');
const cors         = require('cors');
const compression  = require('compression');
const path         = require('path');
const rateLimit    = require('express-rate-limit');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors:{ origin:process.env.CLIENT_URL||'*', credentials:true } });
app.set('io', io);

// The app sits behind exactly one reverse proxy in production (Render's edge
// and/or a fronting Cloudflare hop) — trusting a SPECIFIC hop count (not
// `true`, which would trust an arbitrary chain of forwarded-for headers) is
// what makes req.ip and the rate limiters below reflect the real client
// instead of the proxy. Without this, express-rate-limit keys on the proxy's
// address and effectively rate-limits ALL students as a single client.
// If the deployment topology changes (e.g. an additional proxy hop is added
// in front), this number needs to change to match — verify by logging req.ip
// against a known real client IP after deploying.
app.set('trust proxy', 1);

app.use((req,res,next) => { res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('X-XSS-Protection','1; mode=block'); next(); });
app.use(cors({ origin:process.env.CLIENT_URL||true, credentials:true }));
app.use(compression()); // gzip/br for JSON+HTML responses; images/already-compressed types are excluded by its default filter
// Admin test create/edit payloads legitimately carry base64 question/option
// images and can run several MB — give ONLY that router the larger limit.
// This must be mounted before the global parser below so it's the one that
// actually consumes the body for /api/admin/* requests.
app.use('/api/admin', express.json({ limit:'20mb' }), express.urlencoded({ extended:true, limit:'20mb' }));
// Every other route is student/public-facing JSON (registration, save-progress,
// submit, chat REST, etc.) — none of it needs more than a fraction of a MB.
// Keeping this small closes off an easy memory-exhaustion vector on public
// endpoints while leaving plenty of headroom for legitimate payloads.
app.use(express.json({ limit:'1mb' }));
app.use(express.urlencoded({ extended:true, limit:'1mb' }));
app.use(cookieParser());

// General API rate limit. save-progress and submit are excluded here and
// given their own, more generous, dedicated limiters below — both are
// legitimately high-frequency (save-progress fires every ~10s per active
// test-taker) and can see MANY real students sharing one IP behind a single
// school/coaching-center network, so folding them into this tighter general
// bucket would rate-limit real students, not abuse.
app.use('/api/', rateLimit({
  windowMs: 15*60*1000, max: 600,
  skip: (req) => req.path.endsWith('/save-progress') || req.path === '/results/submit'
}));
app.use('/api/auth/register',    rateLimit({ windowMs:60*60*1000, max:10 }));
// Admin login has no dedicated brute-force protection today beyond the
// (now-excluded-from-nothing, still-applying) general bucket — add one
// specifically, since it's the highest-value credential in the app.
app.use('/api/auth/admin-login', rateLimit({ windowMs:15*60*1000, max:10 }));
// save-progress: generous ceiling sized for many concurrent test-takers
// sharing one IP (e.g. a whole coaching-center batch on one network), not
// for a single client — legitimate traffic here is bounded by
// (active test-takers behind that IP) × (test duration / 10s).
app.use('/api/tests', rateLimit({
  windowMs: 15*60*1000, max: 3000,
  skip: (req) => !req.path.endsWith('/save-progress')
}));
// submit: same shared-NAT consideration — a real classroom submitting near a
// deadline can look like a burst from one IP. Still meaningfully protective
// against a single scripted abuser (a real student submits a given test once).
app.use('/api/results/submit', rateLimit({ windowMs:15*60*1000, max:200 }));

app.use(express.static(path.join(__dirname,'frontend'), {
  index: false,   // Do NOT serve index.html automatically — catch-all handles it with Firebase injection
  setHeaders:(res,fp) => {
    if (fp.endsWith('sw.js'))  { res.setHeader('Cache-Control','no-cache'); res.setHeader('Service-Worker-Allowed','/'); }
    if (fp.endsWith('.html'))    res.setHeader('Cache-Control','no-cache,no-store,must-revalidate');
  }
}));

app.get('/ping',   (_,res) => res.status(200).json({ status:'ok', ts:Date.now() }));
app.get('/health', (_,res) => res.json({ status:'ok', uptime:process.uptime() }));
app.get('/favicon.ico', (_,res) => res.status(204).end());
// Debug route — visit /api/debug-firebase to confirm env vars are set
app.get('/api/debug-firebase', (_,res) => {
  res.json({
    FIREBASE_API_KEY:            process.env.FIREBASE_API_KEY             ? 'SET ('+process.env.FIREBASE_API_KEY.slice(0,8)+'...)' : 'MISSING',
    FIREBASE_AUTH_DOMAIN:        process.env.FIREBASE_AUTH_DOMAIN         ? 'SET' : 'MISSING',
    FIREBASE_PROJECT_ID:         process.env.FIREBASE_PROJECT_ID          ? 'SET' : 'MISSING',
    FIREBASE_STORAGE_BUCKET:     process.env.FIREBASE_STORAGE_BUCKET      ? 'SET' : 'MISSING',
    FIREBASE_MESSAGING_SENDER_ID:process.env.FIREBASE_MESSAGING_SENDER_ID ? 'SET' : 'MISSING',
    FIREBASE_APP_ID:             process.env.FIREBASE_APP_ID              ? 'SET' : 'MISSING',
    FIREBASE_SERVICE_ACCOUNT_JSON:process.env.FIREBASE_SERVICE_ACCOUNT_JSON? 'SET' : 'MISSING',
  });
});
app.get('/robots.txt', (_,res) => { res.type('text/plain'); res.send('User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: https://msc.aiits.workers.dev/sitemap.xml'); });
app.get('/sitemap.xml', (_,res) => {
  const base='https://msc.aiits.workers.dev', d=new Date().toISOString().split('T')[0];
  res.type('application/xml');
  res.send('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>'+base+'/</loc><lastmod>'+d+'</lastmod><priority>1.0</priority></url><url><loc>'+base+'/register</loc><priority>0.8</priority></url><url><loc>'+base+'/login</loc><priority>0.7</priority></url></urlset>');
});

app.get('/adminvibacdonlineaiits', (_,res) => res.sendFile(path.join(__dirname,'frontend','adminvibacdonlineaiits.html')));
app.get('/ad856eyqafggg',           (_,res) => res.sendFile(path.join(__dirname,'frontend','ad856eyqafggg.html')));

app.use('/api/auth',     require('./backend/routes/auth'));
app.use('/api/admin',    require('./backend/routes/admin'));
app.use('/api/admin/ai', require('./backend/routes/aiImport')); // AI PDF-to-Test import — admin-only, see backend/routes/aiImport.js
app.use('/api/tests',    require('./backend/routes/tests'));
app.use('/api/results',  require('./backend/routes/results'));
app.use('/api/rankings', require('./backend/routes/rankings'));
app.use('/api/leaderboard', require('./backend/routes/leaderboard'));
app.use('/api/chat',        require('./backend/routes/chat'));
app.use('/api/push',     require('./backend/routes/push'));

app.get('/api/public/ad-images', async (req,res) => {
  try {
    const AdImage = require('./backend/models/AdImage');
    res.json(await AdImage.find({ showOnHome:true }).select('imageData title redirectUrl description').sort({ createdAt:-1 }));
  } catch(err) { res.status(500).json({ error:err.message }); }
});

app.get('*', async (req,res) => {
  if (path.extname(req.path)&&path.extname(req.path)!=='.html') return res.status(404).json({ error:'Not found' });
  const firebaseConfig = {
    apiKey:            process.env.FIREBASE_API_KEY             || '',
    authDomain:        process.env.FIREBASE_AUTH_DOMAIN         || '',
    projectId:         process.env.FIREBASE_PROJECT_ID          || '',
    storageBucket:     process.env.FIREBASE_STORAGE_BUCKET      || '',
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
    appId:             process.env.FIREBASE_APP_ID              || '',
  };
  const fs = require('fs');
  let html = fs.readFileSync(path.join(__dirname,'frontend','index.html'),'utf8');
  // Inject Firebase as regular (non-module) scripts so they run before onload
  const fbCfg = JSON.stringify(firebaseConfig);
  // Replace placeholder with compat SDK scripts + inline config
  // Using compat build so firebase.auth() works without ES module import
  // Use locally served Firebase files — no CDN, no network wait, always available
  const firebaseScripts =
    '<script src="/js/firebase-app-compat.js"></script>' +
    '<script src="/js/firebase-auth-compat.js"></script>' +
    '<script>try{var __fbApp=firebase.initializeApp(' + fbCfg + ');window._firebaseAuth=firebase.auth(__fbApp);}catch(e){console.error("Firebase init failed:",e);}</script>';
  html = html.replace('<script type="module">/* FIREBASE_CONFIG_PLACEHOLDER */</script>', firebaseScripts);
  res.setHeader('Content-Type','text/html');
  res.send(html);
});

const { isMuted, isBlocked, toggleMute, setBlocked } = require('./backend/utils/chatState');

app.set('io', io);

io.on('connection', socket => {
  // Send current mute state on connect
  isMuted().then(muted => socket.emit('chat-mute-changed', { muted })).catch(() => {});
  socket.on('join-test',  id => socket.join('test-'+id));
  socket.on('leave-test', id => socket.leave('test-'+id));
  socket.on('join-admin', ()  => socket.join('admin-room'));

  // Verify admin from socket cookie
  function isAdminSocket() {
    try {
      const cookies = socket.handshake.headers.cookie || '';
      const match = cookies.match(/adminToken=([^;]+)/);
      if (!match) return false;
      const jwt = require('jsonwebtoken');
      const decoded = jwt.verify(match[1], process.env.JWT_SECRET);
      return decoded.role === 'admin';
    } catch(e) { return false; }
  }

  // Socket.IO events aren't covered by express-rate-limit (HTTP-only) — chat
  // send had no abuse protection at all. This is deliberately per-connection,
  // in-process state (not moved to Mongo like mute/block below): a given
  // socket connection is only ever handled by the single worker process that
  // accepted it, so there's no cross-worker consistency concern here the way
  // there is for mute/block state, which every worker needs to agree on.
  let lastMsgAt = 0;
  const MIN_MSG_INTERVAL_MS = 1200;

  // Public chat
  socket.on('chat-message', async (data) => {
    const adminSender = data.isAdmin && isAdminSocket();
    if (!adminSender) {
      const now = Date.now();
      if (now - lastMsgAt < MIN_MSG_INTERVAL_MS) return;
      lastMsgAt = now;
    }
    const uid = (data.uid || '').slice(0, 64);
    try {
      // Block if: global mute (non-admin) OR sender is individually blocked
      if (!adminSender && (await isMuted())) return;
      if (!adminSender && (await isBlocked(uid))) return;
    } catch (e) { console.error('[CHAT] moderation check failed:', e.message); return; }
    const msg = {
      name:    adminSender ? 'Admin' : (data.name || 'Student').slice(0, 40),
      uid:     adminSender ? '' : uid,
      batch:   adminSender ? '' : (data.batch || '').slice(0, 20),
      text:    (data.text || '').slice(0, 300),
      isAdmin: adminSender,
      time:    new Date().toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' }),
    };
    try {
      const ChatMessage = require('./backend/models/ChatMessage');
      const saved = await ChatMessage.create(msg);
      io.emit('chat-message', { ...msg, _id: saved._id, id: saved._id });
    } catch(e) {
      console.error('[CHAT] save failed:', e.message);
      io.emit('chat-message', { ...msg, id: Date.now() + Math.random().toString(36).slice(2) });
    }
  });

  // Admin mute/unmute all (also broadcast so clients persist it)
  socket.on('admin-toggle-mute', async () => {
    if (!isAdminSocket()) return;
    try {
      const muted = await toggleMute();
      io.emit('chat-mute-changed', { muted });
    } catch(e) { console.error('[CHAT] toggle-mute failed:', e.message); }
  });

  // Admin block/unblock individual student
  socket.on('admin-block-student', async (data) => {
    if (!isAdminSocket()) return;
    const uid = (data.uid || '').slice(0, 64);
    const name = (data.name || '').slice(0, 40);
    try {
      await setBlocked(uid, !!data.blocked);
      // Notify all clients to hide/show this student messages
      io.emit('student-blocked', { uid, name, blocked: !!data.blocked });
    } catch(e) { console.error('[CHAT] block/unblock failed:', e.message); }
  });
});

const PORT = process.env.PORT||3000;
server.listen(PORT,'0.0.0.0',() => console.log('[SERVER] AIITS on port',PORT));
// maxPoolSize: explicit rather than relying on the driver default (100) —
// this app is a single Node process today, and 50 concurrent in-flight
// queries is comfortably more than a single process's request handling needs
// (queries are fast; connections return to the pool between awaits rather
// than staying checked out for the life of a request). Revisit this only if
// load testing shows connection-wait time, or if/when the app moves to
// multiple worker processes (each worker gets its OWN pool of this size).
mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS:15000, maxPoolSize:50 })
  .then(()=>console.log('[DB] MongoDB connected'))
  .catch(err=>console.error('[DB] MongoDB error:',err.message));
mongoose.connection.on('error', err => console.error('[DB] Connection error:', err.message));
mongoose.connection.on('disconnected', () => console.warn('[DB] Disconnected — driver will attempt to reconnect automatically'));
mongoose.connection.on('reconnected', () => console.log('[DB] Reconnected'));
require('./backend/config/chatDb'); // second connection, dedicated to chat storage (MONGODB_URI2)
module.exports = { app, io };
