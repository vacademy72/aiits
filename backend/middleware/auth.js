const admin  = require('../utils/firebaseAdmin');
const User   = require('../dynamo/userModel'); // was: const UserProfile = require('../models/UserProfile');
const jwt    = require('jsonwebtoken');

exports.authenticateStudent = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : req.cookies.studentToken;

    if (!token) return res.status(401).json({ error: 'Authentication required. Please login.' });

    const decoded = await admin.auth().verifyIdToken(token);

    const profile = await User.getByUid(decoded.uid);
    if (!profile) return res.status(401).json({ error: 'Profile not found. Please register again.' });

    req.user = {
      // _id kept as an alias for uid, same string value — every route that
      // reads req.user._id (results.js, leaderboard.js, admin.js, etc.) was
      // only ever using it as an opaque key to pass into a query, never for
      // any Mongo-ObjectId-specific behavior, so nothing downstream needed
      // to change when the underlying id type changed from ObjectId to a
      // plain string.
      _id:              decoded.uid,
      uid:              decoded.uid,
      name:             profile.name,
      email:            decoded.email,
      phone:            profile.phone,
      batch:            profile.batch,
      coachingName:     profile.coachingName,
      fatherName:       profile.fatherName,
      fatherOccupation:  profile.fatherOccupation,
      whatsappNumber:   profile.whatsappNumber,
    };
    next();
  } catch (err) {
    const expired = err.code === 'auth/id-token-expired';
    res.status(401).json({ error: expired ? 'Session expired. Please login again.' : 'Authentication failed. Please login again.' });
  }
};

exports.authenticateAdmin = (req, res, next) => {
  try {
    const token = req.cookies.adminToken || (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'Admin authentication required.' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
    req.admin = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Admin session expired. Please login again.' });
  }
};

// Accepts EITHER an admin session or a student session — for routes both
// the student app and the admin panel need to read (e.g. the global
// leaderboard). Tries the admin cookie first (cheap, synchronous JWT
// verify) since the admin panel never sends a Firebase ID token at all, so
// running authenticateStudent first would always fail loudly for admin
// requests before this ever got a chance to fall back.
exports.authenticateStudentOrAdmin = (req, res, next) => {
  try {
    const adminToken = req.cookies.adminToken || (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (adminToken) {
      const decoded = jwt.verify(adminToken, process.env.JWT_SECRET);
      if (decoded.role === 'admin') { req.admin = decoded; return next(); }
    }
  } catch { /* not a valid admin token — fall through to student auth below */ }
  return exports.authenticateStudent(req, res, next);
};
