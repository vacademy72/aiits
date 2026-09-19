const express     = require('express');
const router      = express.Router();
const Result      = require('../dynamo/resultModel'); // was: const Result = require('../models/Result');
const User        = require('../dynamo/userModel');   // was: const UserProfile = require('../models/UserProfile');
const { authenticateStudent, authenticateStudentOrAdmin } = require('../middleware/auth');
const { getCached, safeBatch } = require('../utils/leaderboardCache');

router.get('/test/:testId', authenticateStudent, async (req, res) => {
  try {
    const batch = safeBatch(req.query.batch);
    const limit = Math.min(parseInt(req.query.limit)||200, 500);

    // Shared rankings list is cacheable (same test+batch+limit → same list for
    // every viewer); myRank/myResult stay live below since they're per-viewer.
    const cacheKey = `rankings:${req.params.testId}:${batch}:${limit}`;
    const { sanitized, total } = await getCached(cacheKey, 'per-test', { testId:req.params.testId, batch }, async () => {
      let results = (await Result.queryByTest(req.params.testId, batch ? { batch } : {})).filter(r => !r.inProgress);
      const count = results.length;
      results = results.sort((a,b) => b.obtainedMarks - a.obtainedMarks || a.timeTaken - b.timeTaken).slice(0, limit);
      const sanitized = results.map((obj,i) => {
        const out = { ...obj };
        if (out.userEmail) {
          const parts = out.userEmail.split('@');
          out.userEmail = parts[0].substring(0,2) + '***@' + (parts[1]||'');
        }
        return { ...out, rank: i+1 };
      });
      return { sanitized, total: count };
    });

    let myRank=null, myResult=null;
    if (req.user) {
      myResult = await Result.getByUserAndTest(req.user.uid, req.params.testId);
      if (myResult && myResult.inProgress) myResult = null;
      if (myResult) {
        const { overallRank, batchRank } = await Result.computeRanks(req.params.testId, myResult.batch, myResult.obtainedMarks, myResult.timeTaken);
        myRank = batch ? batchRank : overallRank;
      }
    }
    res.json({ rankings:sanitized, total, myRank, myResult: myResult ? { obtainedMarks:myResult.obtainedMarks, totalMarks:myResult.totalMarks, rank:myResult.rank, batchRank:myResult.batchRank } : null });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// Admin panel's Analytics tab reads this same endpoint (no per-viewer data
// like req.user is used below), but was sending its adminToken cookie
// against a route gated by authenticateStudent — which only ever accepts a
// Firebase student ID token — so every admin request 401'd and the
// leaderboard silently never rendered (the frontend's .catch swallowed it).
router.get('/leaderboard', authenticateStudentOrAdmin, async (req, res) => {
  try {
    const batch = safeBatch(req.query.batch);
    // No dedicated batch-scoped GSI for this legacy route (dead in the
    // current frontend UI per the earlier audit — kept working, not
    // optimized further). Fetches via the RankIndex GSI (already sorted by
    // totalMarks) and filters by batch client-side if requested.
    let users = await User.listTopPerformers(500);
    if (batch) users = users.filter(u => u.batch === batch);
    users = users.slice(0, 200);
    res.json(users.map((u,i) => ({ ...u, rank:i+1 })));
  } catch(err) { res.status(500).json({ error:err.message }); }
});

router.get('/top-performers', async (req, res) => {
  try {
    const top = await User.listTopPerformers(10);
    res.json(top.map((u,i) => ({ ...u, rank:i+1 })));
  } catch(err) { res.status(500).json({ error:err.message }); }
});

module.exports = router;
