const express     = require('express');
const router      = express.Router();
const jwt         = require('jsonwebtoken');
const admin       = require('../utils/firebaseAdmin');
const User        = require('../dynamo/userModel');   // was: const UserProfile = require('../models/UserProfile');
const Result      = require('../dynamo/resultModel'); // was: const Result = require('../models/Result');
const { authenticateStudent, authenticateAdmin } = require('../middleware/auth');

function makeToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '30d' });
}
function setAdminCookie(res, token) {
  res.cookie('adminToken', token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge:   30 * 24 * 60 * 60 * 1000,
  });
}

// POST /register
// Called after Firebase creates the user on the frontend.
// Body: { idToken, name, phone, coachingName, fatherName, fatherOccupation, whatsappNumber, batch, cityState? (optional) }
router.post('/register', async (req, res) => {
  try {
    const { idToken, name, phone, coachingName, fatherName, fatherOccupation, whatsappNumber, batch } = req.body;
    const cityState = String(req.body.cityState || '').trim().slice(0, 80); // optional

    if (!idToken || !name || !phone || !coachingName || !fatherName || !fatherOccupation || !whatsappNumber || !batch)
      return res.status(400).json({ error: 'All fields are required' });

    if (!['11', '12', 'dropper'].includes(batch))
      return res.status(400).json({ error: 'Batch must be 11, 12, or dropper' });

    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch {
      return res.status(401).json({ error: 'Invalid Firebase token. Please try again.' });
    }

    // Block re-registration on an email an admin previously deleted. Firebase
    // has already created the Auth account by this point (registration is
    // Firebase-first, this route runs after) — so on a match, undo that
    // Firebase account too, not just reject the DynamoDB profile write.
    if (decoded.email) {
      const DeletedAccount = require('../models/DeletedAccount');
      const blocked = await DeletedAccount.findById(decoded.email.toLowerCase()).catch(() => null);
      if (blocked) {
        await admin.auth().deleteUser(decoded.uid).catch(() => {});
        return res.status(403).json({ error: 'This email was previously removed by an admin and cannot be used to register again. Contact your coaching institute if you believe this is a mistake.' });
      }
    }

    const phoneExists = await User.getByPhone(phone);
    if (phoneExists) {
      await admin.auth().deleteUser(decoded.uid).catch(() => {});
      return res.status(400).json({ error: 'Phone number already registered' });
    }

    const existing = await User.getByUid(decoded.uid);
    if (existing) {
      return res.json({
        message: 'Account already exists',
        user: { id: existing.uid, name: existing.name, email: decoded.email, batch: existing.batch, coachingName: existing.coachingName },
      });
    }

    await admin.auth().updateUser(decoded.uid, { displayName: name }).catch(() => {});

    const profile = await User.create({ uid: decoded.uid, name, phone, coachingName, fatherName, fatherOccupation, whatsappNumber, cityState, batch });

    res.status(201).json({
      message: 'Account created',
      user: { id: profile.uid, name: profile.name, email: decoded.email, batch: profile.batch, coachingName: profile.coachingName },
    });
  } catch (err) {
    console.error('[AUTH] register:', err);
    res.status(500).json({ error: err.message || 'Registration failed' });
  }
});

// POST /lookup-email — used for phone-based login
// Returns the email for a given phone number so Firebase signIn can proceed
router.post('/lookup-email', async (req, res) => {
  try {
    const phone = (req.body.phone || '').trim();
    if (!phone) return res.status(400).json({ error: 'Phone required' });
    const profile = await User.getByPhone(phone);
    if (!profile) return res.status(404).json({ error: 'No account found with this phone number' });
    const fbUser = await admin.auth().getUser(profile.uid);
    res.json({ email: fbUser.email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin-login — unchanged (env-var based)
router.post('/admin-login', async (req, res) => {
  try {
    const email    = (req.body.email || '').trim().toLowerCase();
    const password =  req.body.password || '';
    if (email !== (process.env.ADMIN_EMAIL || '').toLowerCase() || password !== process.env.ADMIN_PASSWORD)
      return res.status(401).json({ error: 'Invalid admin credentials' });
    setAdminCookie(res, makeToken({ role: 'admin', email }));
    res.json({ message: 'Admin login successful' });
  } catch {
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /me — session restore via Firebase token
router.get('/me', authenticateStudent, (req, res) => {
  res.json({
    user: {
      id:               req.user._id,
      name:             req.user.name,
      email:            req.user.email,
      batch:            req.user.batch,
      coachingName:     req.user.coachingName,
      phone:            req.user.phone,
      fatherName:       req.user.fatherName,
      fatherOccupation: req.user.fatherOccupation,
      whatsappNumber:   req.user.whatsappNumber,
      cityState:        req.user.cityState || '',
    },
  });
});

router.get('/admin-me', authenticateAdmin, (req, res) => {
  res.json({ admin: { email: req.admin.email, role: 'admin' } });
});

// POST /logout
router.post('/logout', (req, res) => {
  res.clearCookie('adminToken',   { sameSite: 'lax' });
  res.clearCookie('studentToken', { sameSite: 'lax' });
  res.json({ message: 'Logged out' });
});

// DELETE /account — removes from both Firebase and MongoDB
router.delete('/account', authenticateStudent, async (req, res) => {
  try {
    await Promise.all([
      User.deleteByUid(req.user.uid),
      Result.deleteAllByUser(req.user.uid),
      admin.auth().deleteUser(req.user.uid).catch(() => {}),
    ]);
    res.clearCookie('studentToken', { sameSite: 'lax' });
    res.json({ message: 'Account deleted permanently' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

// POST /forgot-attempts — check/increment attempt count (rate limit: 3/day per email)
// Called before sending reset email from frontend
router.post('/forgot-attempts', async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email required' });

    // Check if email exists in Firebase first
    try {
      await admin.auth().getUserByEmail(email);
    } catch (e) {
      // Email not registered — return success silently (security: don't reveal)
      return res.json({ allowed: false, notFound: true });
    }

    // Rate limit: persisted in MongoDB (see backend/models/ForgotAttempt.js) —
    // was in-process memory, which resets on restart and would give each PM2
    // worker its own independent counter if the app ever runs multi-process.
    const ForgotAttempt = require('../models/ForgotAttempt');
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const key = email + ':' + today;
    const attempt = await ForgotAttempt.findOneAndUpdate(
      { _id: key },
      { $inc: { count: 1 } },
      { upsert: true, new: true }
    );

    if (attempt.count > 3) {
      return res.status(429).json({ allowed: false, error: 'Maximum 3 reset emails per day. Try again tomorrow.' });
    }

    res.json({ allowed: true, remaining: 3 - attempt.count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /profile — update editable profile fields
router.put('/profile', authenticateStudent, async (req, res) => {
  try {
    const allowed = ['name', 'phone', 'coachingName', 'fatherName', 'fatherOccupation', 'whatsappNumber', 'cityState'];
    const updates = {};
    allowed.forEach(f => { if (req.body[f] !== undefined) updates[f] = String(req.body[f]).trim(); });
    if (updates.cityState) updates.cityState = updates.cityState.slice(0, 80);

    if (updates.phone) {
      const existing = await User.getByPhone(updates.phone);
      if (existing && existing.uid !== req.user.uid) return res.status(400).json({ error: 'Phone number already used by another account' });
    }

    // Update Firebase display name if name changed
    if (updates.name) {
      await admin.auth().updateUser(req.user.uid, { displayName: updates.name }).catch(() => {});
    }

    await User.update(req.user.uid, updates);
    res.json({ message: 'Profile updated', user: { ...req.user, ...updates } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /update-email — update email in Firebase Auth
router.put('/update-email', authenticateStudent, async (req, res) => {
  try {
    const newEmail = (req.body.email || '').trim().toLowerCase();
    if (!newEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail))
      return res.status(400).json({ error: 'Valid email required' });

    await admin.auth().updateUser(req.user.uid, { email: newEmail });
    res.json({ message: 'Email updated successfully' });
  } catch (err) {
    const msg = err.code === 'auth/email-already-exists'
      ? 'This email is already used by another account'
      : err.message;
    res.status(400).json({ error: msg });
  }
});

// PUT /change-password — change password directly (no OTP, student already logged in)
router.put('/change-password', authenticateStudent, async (req, res) => {
  try {
    const newPassword = req.body.newPassword || '';
    if (newPassword.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });

    await admin.auth().updateUser(req.user.uid, { password: newPassword });
    res.json({ message: 'Password changed successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
