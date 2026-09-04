const express     = require('express');
const router      = express.Router();
const multer      = require('multer');
const mongoose    = require('mongoose');
const Test        = require('../dynamo/testModel');   // was: const Test = require('../models/Test');
const User        = require('../dynamo/userModel');   // was: const UserProfile = require('../models/UserProfile');
const Result      = require('../dynamo/resultModel'); // was: const Result = require('../models/Result');
const AdImage     = require('../models/AdImage'); // stays on MongoDB — not part of this migration
const admin       = require('../utils/firebaseAdmin');
const { authenticateAdmin } = require('../middleware/auth');
const { invalidate } = require('../utils/leaderboardCache');
const { uploadTestImages, uploadBuffer } = require('../utils/cloudinary');

// One-time repair: recompute totalTests/totalMarks/highestMarks on every
// User from actual Results (the source of truth), instead of trusting
// whatever cumulative counters currently sit on the User item. This exists
// because the public "Top Performers" widget (GET /api/rankings/top-performers)
// reads those counters directly rather than recomputing live — so if they
// ever drifted from real Results (e.g. carried over from the old MongoDB
// data during the DynamoDB migration, before Test/Result had any fresh data
// under them), the widget would keep showing those stale numbers/names
// indefinitely with no way to self-correct. Uses the exact same per-user
// recompute already used after a per-test result deletion elsewhere in this
// file — just run once, for everyone.
router.post('/recompute-user-stats', authenticateAdmin, async (req, res) => {
  try {
    const { items } = await User.scanAll(5000);
    let updated = 0;
    for (const u of items) {
      const rem = (await Result.queryByUser(u.uid)).filter(r => !r.inProgress);
      await User.update(u.uid, {
        totalTests:   rem.length,
        totalMarks:   rem.reduce((s,r) => s+(r.obtainedMarks||0), 0),
        highestMarks: rem.length ? Math.max(...rem.map(r=>r.obtainedMarks||0)) : 0,
      });
      updated++;
    }
    res.json({ message: 'Recomputed stats for ' + updated + ' students from their actual results.', updated });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Stats — public, no auth needed (used on home page for counters)
router.get('/stats', async (req, res) => {
  try {
    // DynamoDB has no cheap countDocuments() equivalent — these are Scan+COUNT
    // operations now (see count()/countSubmitted() in the dynamo models),
    // which do cost a full table read server-side, unlike Mongo's index-backed
    // count. Acceptable here: this is a low-frequency public informational
    // endpoint, not one of the concurrent-load paths this migration targeted.
    const [totalTests, totalStudents, totalAttempts] = await Promise.all([
      Test.count(), User.count(), Result.countSubmitted(),
    ]);
    // Storage info now only reflects what's LEFT on MongoDB (chat, ad images,
    // PDF imports, the leaderboard cache) — Test/UserProfile/Result no
    // longer live there, so this number means something different than it
    // used to. DynamoDB has its own separate storage view in the AWS console
    // (Tables → [table] → Additional info) — not surfaced here.
    let storageInfo = null;
    try {
      const s = await mongoose.connection.db.stats();
      const used = Math.round(s.dataSize/1024/1024*10)/10;
      storageInfo = { usedMB: used, totalMB: 512, usedPct: Math.round(used/512*100), freesMB: Math.round((512-used)*10)/10, note: 'MongoDB-side only (chat/ad-images/PDF-imports/cache) — Tests/Students/Results now live on DynamoDB' };
    } catch(e) {}
    let sheetStats = null;
    try { sheetStats = await require('../utils/sheets').getSheetStats(); } catch(e) {}
    res.json({ totalTests, totalStudents, totalAttempts, storageInfo, sheetStats });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.use(authenticateAdmin);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

// Tests CRUD
// _id: t.testId (and per-question _id: q.questionId) aliased in here — the
// frontend (adminvibacdonlineaiits.html) still reads t._id/q._id everywhere,
// a leftover from Mongo. Test/Question no longer HAVE an _id field at all
// post-DynamoDB-migration, so without this alias every t._id/q._id read on
// the admin side silently evaluates to undefined (this is exactly what was
// causing "Test not found" on Edit, and the DynamoDB "key element does not
// match schema" error on the student side once _id also went undefined into
// a Put's key). Same alias convention already used in routes/tests.js's
// dashboard list and routes/results.js's /my-results.
function aliasTest(t) {
  // isPublished is stored in DynamoDB as the STRING 'true'/'false' (GSI key
  // attributes can't be boolean — see testModel.js's table doc comment).
  // The admin frontend does plain JS truthy checks on isPublished
  // (`t.isPublished ? 'Unpublish' : 'Publish'`), and the string 'false' is
  // truthy — so passing the raw stored value straight through made the
  // Published/Draft badge and Publish/Unpublish button permanently stuck
  // showing "Published" regardless of the real state, even though each
  // click was correctly flipping the actual stored value server-side.
  // Coerced to a real boolean here so every API response through this
  // function (list/create/update) reflects the true state.
  return { ...t, _id: t.testId, isPublished: t.isPublished === 'true', questions: (t.questions || []).map(q => ({ ...q, _id: q.questionId })) };
}

router.get('/tests', async (req, res) => {
  try { res.json((await Test.scanAll()).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)).map(aliasTest)); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

router.post('/tests', async (req, res) => {
  try {
    const questions = await uploadTestImages(req.body.questions);
    res.status(201).json({ message: 'Test created', test: aliasTest(await Test.create({ ...req.body, questions })) });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.put('/tests/:id', async (req, res) => {
  try {
    const questions = await uploadTestImages(req.body.questions);
    const test = await Test.update(req.params.id, { ...req.body, questions });
    if (!test) return res.status(404).json({ error: 'Not found' });
    res.json({ message: 'Updated', test: aliasTest(test) });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.patch('/tests/:id/publish', async (req, res) => {
  try {
    const test = await Test.getById(req.params.id);
    if (!test) return res.status(404).json({ error: 'Not found' });
    const next = test.isPublished !== 'true';
    await Test.setPublished(req.params.id, next);
    res.json({ isPublished: next });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.delete('/tests/:id', async (req, res) => {
  try {
    await Promise.all([Test.deleteById(req.params.id), Result.deleteByTest(req.params.id)]);
    res.json({ message: 'Test and all results deleted' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Bonus marks: whole-test (applies to every student who attempted it) ───
// Stores the currently-applied amount on the Test item and shifts every
// Result's obtainedMarks by the delta, so re-applying with a new value only
// shifts marks by the difference (safe to call repeatedly / edit later).
router.post('/tests/:id/bonus', async (req, res) => {
  try {
    const bonusMarks = Number(req.body.bonusMarks);
    if (!Number.isFinite(bonusMarks)) return res.status(400).json({ error: 'bonusMarks must be a number' });
    const test = await Test.getById(req.params.id);
    if (!test) return res.status(404).json({ error: 'Test not found' });
    const delta = bonusMarks - (test.bonusMarks || 0);
    if (delta !== 0) await Result.applyBonusToTest(req.params.id, delta);
    await Test.setBonusMarks(req.params.id, bonusMarks);
    invalidate({ testId: req.params.id }); // bonus changes affect that test's leaderboard immediately, not after TTL
    res.json({ message: 'Bonus marks applied to all students who took this test', bonusMarks });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Bonus marks: single student on a single test ───────────────────────────
// Result's key is composite (userId+testId) now, not a single Mongo _id —
// this route takes both as path params (see the matching frontend change in
// adminvibacdonlineaiits.html's applyStudentBonus()).
router.post('/results/:userId/:testId/bonus', async (req, res) => {
  try {
    const bonusMarks = Number(req.body.bonusMarks);
    if (!Number.isFinite(bonusMarks)) return res.status(400).json({ error: 'bonusMarks must be a number' });
    const updated = await Result.applyBonusToOne(req.params.userId, req.params.testId, bonusMarks);
    if (!updated) return res.status(404).json({ error: 'Result not found' });
    invalidate({ testId: req.params.testId, batch: updated.batch });
    res.json({ message: 'Bonus marks applied to this student for this test', bonusMarks, obtainedMarks: updated.obtainedMarks });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Delete results for a test by batch
// DELETE from DynamoDB + archive Sheet rows to AIITS_Archive
// Frees DynamoDB storage AND Sheet row limit. Data preserved in Archive sheet.
router.delete('/tests/:id/results-only', async (req, res) => {
  try {
    const testId = req.params.id;
    const batch  = req.query.batch || 'all';

    // 1. Archive Sheet rows for this test → AIITS_Archive, then remove from main sheet.
    // Deliberately FAIL-CLOSED: if archiving throws, we stop here and do NOT
    // touch DynamoDB. This used to be a non-fatal try/catch that logged the
    // error and deleted from DynamoDB anyway — meaning a Sheets API hiccup
    // (auth expiry, quota, network blip) would silently and permanently wipe
    // real student results with zero backup and zero warning to the admin.
    let archived = 0;
    try {
      const { archiveTestResults } = require('../utils/sheets');
      const r = await archiveTestResults(testId, batch);
      archived = r.archived;
    } catch(e) {
      console.error('[ADMIN] Sheet archive error — aborting delete, nothing was removed:', e.message);
      return res.status(502).json({ error: 'Could not archive to the Sheet, so nothing was deleted (this action never deletes without a successful archive first). Sheet error: ' + e.message });
    }

    // 2. Delete from DynamoDB, recalculate each affected student's stats
    const affected = await Result.deleteByTest(testId, batch);
    const userIds  = [...new Set(affected.map(r => r.userId))];
    invalidate({ testId, batch: batch !== 'all' ? batch : undefined });
    for (const uid of userIds) {
      const rem = (await Result.queryByUser(uid)).filter(r => !r.inProgress);
      await User.update(uid, {
        totalTests:   rem.length,
        totalMarks:   rem.reduce((s,r) => s+(r.obtainedMarks||0), 0),
        highestMarks: rem.length ? Math.max(...rem.map(r=>r.obtainedMarks||0)) : 0,
      });
    }

    res.json({
      deleted: affected.length,
      archived,
      message: affected.length + ' results removed from DynamoDB. ' + archived + ' rows moved to Archive sheet.'
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// GET leaderboard from AIITS_Archive sheet (used after results cleared)
router.get('/tests/:id/sheet-leaderboard', async (req, res) => {
  try {
    const batch = req.query.batch || 'all';
    const { readArchivedResults } = require('../utils/sheets');
    const rows = await readArchivedResults(req.params.id, batch);
    if (!rows.length) return res.json([]);

    const sorted = rows.sort((a,b) => b.obtainedMarks - a.obtainedMarks || a.timeTaken - b.timeTaken);
    const bMap = {'11':'Class 11','12':'Class 12','dropper':'Dropper'};
    res.json(sorted.map((r,i) => ({
      ...r,
      rank: i+1,
      batchLabel: bMap[r.batch] || r.batch,
      percentage: r.totalMarks ? (r.obtainedMarks/r.totalMarks*100).toFixed(1) : r.percentage.toFixed(1)
    })));
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.delete('/tests/:id/results', async (req, res) => {
  try {
    const testId = req.params.id;
    const batch  = req.query.batch || 'all';

    // Same fail-closed reasoning as /results-only above.
    let archived = 0;
    try {
      const { archiveTestResults } = require('../utils/sheets');
      const r = await archiveTestResults(testId, batch);
      archived = r.archived;
    } catch(e) {
      console.error('[ADMIN] Sheet archive error — aborting delete, nothing was removed:', e.message);
      return res.status(502).json({ error: 'Could not archive to the Sheet, so nothing was deleted (this action never deletes without a successful archive first). Sheet error: ' + e.message });
    }

    // 2. Delete from DynamoDB, recalculate each affected student's stats
    const affected = await Result.deleteByTest(testId, batch);
    const userIds  = [...new Set(affected.map(r => r.userId))];
    invalidate({ testId, batch: batch !== 'all' ? batch : undefined });
    for (const uid of userIds) {
      const rem = (await Result.queryByUser(uid)).filter(r => !r.inProgress);
      await User.update(uid, {
        totalTests:   rem.length,
        totalMarks:   rem.reduce((s,r) => s+(r.obtainedMarks||0), 0),
        highestMarks: rem.length ? Math.max(...rem.map(r=>r.obtainedMarks||0)) : 0,
      });
    }
    const remainingForTest = (await Result.queryByTest(testId)).filter(r => !r.inProgress).length;
    await Test.setAttemptCount(testId, remainingForTest);

    res.json({ deleted: affected.length, archived, message: affected.length + ' results deleted from DynamoDB. ' + archived + ' rows archived to AIITS_Archive sheet.' });
  } catch(err) {
    console.error('[ADMIN] delete results:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/tests/:id/results', async (req, res) => {
  try {
    // Was .populate('userId','name phone coachingName batch') — not needed:
    // Result already stores userName/coachingName/batch directly on each
    // item from submit time (denormalized), which is what the admin
    // frontend actually reads (see adminvibacdonlineaiits.html's fallback
    // chain, already handles a plain userId string with no populated object).
    const results = (await Result.queryByTest(req.params.id)).filter(r => !r.inProgress);
    results.sort((a,b) => b.obtainedMarks - a.obtainedMarks || a.timeTaken - b.timeTaken);
    res.json(results);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Students
router.get('/students', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit)||2000;
    // DynamoDB Scan — no cheap "sort by createdAt across the whole table"
    // without a dedicated GSI (not added; this is a low-traffic admin-only
    // screen). Sorted client-side after fetching.
    const { items, count } = await User.scanAll(limit);
    const students = items.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
    // Fetch emails from Firebase in batch (up to 100 at a time)
    // _id: s.uid aliased for the same reason as aliasTest() above — the
    // admin frontend's student table still reads s._id (delete/mute buttons).
    const studentsWithEmail = await Promise.all(students.map(async (s) => {
      try {
        const fbUser = await admin.auth().getUser(s.uid);
        return { ...s, _id: s.uid, email: fbUser.email };
      } catch {
        return { ...s, _id: s.uid, email: '' };
      }
    }));
    res.json({ students: studentsWithEmail, total: count });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Delete specific student — :id here is the uid (same value as before,
// since req.user._id/uid have always been the same string post-migration)
router.delete('/students/:id', async (req, res) => {
  try {
    const profile = await User.getByUid(req.params.id);
    // Grab the email BEFORE deleting the Firebase Auth account (it's gone
    // once deleteUser() runs) so it can be recorded as blocked below —
    // without this, deleting a student would free their email up for a
    // brand-new registration a moment later.
    let email = null;
    if (profile) { try { email = (await admin.auth().getUser(profile.uid)).email; } catch {} }
    await Promise.all([
      User.deleteByUid(req.params.id),
      Result.deleteAllByUser(req.params.id),
      profile ? admin.auth().deleteUser(profile.uid).catch(() => {}) : Promise.resolve()
    ]);
    if (email) {
      const DeletedAccount = require('../models/DeletedAccount');
      await DeletedAccount.findByIdAndUpdate(email.toLowerCase(), { _id: email.toLowerCase(), deletedBy: 'admin' }, { upsert: true }).catch(() => {});
    }
    res.json({ message: 'Student and their results deleted' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Delete entire batch
router.delete('/students/batch/:batch', async (req, res) => {
  try {
    const batch = req.params.batch;
    if (!['11','12','dropper'].includes(batch)) return res.status(400).json({ error: 'Invalid batch' });
    // No batch-scoped GSI on Users (low-traffic admin action) — Scan+filter.
    const { items } = await User.scanAll(5000);
    const profiles = items.filter(u => u.batch === batch);

    let deletedResults = 0;
    const emails = [];
    for (const p of profiles) {
      try { const fbUser = await admin.auth().getUser(p.uid); if (fbUser.email) emails.push(fbUser.email.toLowerCase()); } catch {}
      deletedResults += await Result.deleteAllByUser(p.uid);
      await User.deleteByUid(p.uid);
    }
    await Promise.all(profiles.map(p => admin.auth().deleteUser(p.uid).catch(() => {})));
    if (emails.length) {
      const DeletedAccount = require('../models/DeletedAccount');
      await Promise.all(emails.map(e => DeletedAccount.findByIdAndUpdate(e, { _id: e, deletedBy: 'admin' }, { upsert: true }).catch(() => {})));
    }

    res.json({ deletedStudents: profiles.length, deletedResults });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Ad Images — unchanged, still MongoDB
router.get('/ad-images', async (req, res) => {
  try { res.json(await AdImage.find().sort({ createdAt: -1 })); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

router.post('/ad-images', upload.single('image'), async (req, res) => {
  try {
    // Uploaded to Cloudinary instead of stored inline as base64 — imageData
    // now holds a Cloudinary secure_url string. AdImage.imageData is a plain
    // String field either way, so no schema change was needed, only this
    // write path. If Cloudinary isn't configured yet (see CLOUDINARY_SETUP.md)
    // this throws, same as any other failed save — it does not silently fall
    // back to base64 here, since ad images are exactly the "storage weight"
    // Cloudinary was requested to take off Mongo.
    const imageData = req.file ? await uploadBuffer(req.file.buffer, 'aiits/ad-images') : '';
    const img = await AdImage.create({
      title: req.body.title||'', description: req.body.description||'',
      imageData, redirectUrl: req.body.redirectUrl||'',
      showOnHome: req.body.showOnHome !== 'false'
    });
    res.status(201).json({ message: 'Uploaded', image: { _id: img._id, title: img.title, redirectUrl: img.redirectUrl, showOnHome: img.showOnHome } });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.put('/ad-images/:id', async (req, res) => {
  try {
    const img = await AdImage.findByIdAndUpdate(req.params.id, {
      title: req.body.title||'', description: req.body.description||'',
      redirectUrl: req.body.redirectUrl||'',
      showOnHome: req.body.showOnHome !== false && req.body.showOnHome !== 'false'
    }, { new: true });
    if (!img) return res.status(404).json({ error: 'Not found' });
    res.json({ message: 'Updated', image: img });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.delete('/ad-images/:id', async (req, res) => {
  try { await AdImage.findByIdAndDelete(req.params.id); res.json({ message: 'Deleted' }); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
