/**
 * routes/chat.js
 * Public chat, mute controlled by admin — moderation state lives in MongoDB
 * (ChatState), not process memory, so it's correct across restarts and safe
 * if the app ever runs multiple Node.js workers (see backend/utils/chatState.js).
 * Messages are persisted to a SECOND MongoDB (MONGODB_URI2) via ChatMessage,
 * and are never auto-deleted — only an admin can remove them.
 */
const express      = require('express');
const router       = express.Router();
const ChatMessage  = require('../models/ChatMessage');
const { authenticateAdmin } = require('../middleware/auth');
const { isMuted, isBlocked, toggleMute, getState } = require('../utils/chatState');

// GET chat status (public) - clients call on page load to restore mute state.
// Pass ?uid=<student uid> to also get that student's individual-block status —
// this is what lets a page refresh (or a fresh tab that missed the live
// 'student-blocked' socket event) learn the TRUE current state from the
// server, instead of only trusting whatever was last cached in localStorage.
router.get('/status', async (req, res) => {
  try {
    const muted = await isMuted();
    const uid = (req.query.uid || '').slice(0, 64);
    const blocked = uid ? await isBlocked(uid) : false;
    res.json({ muted, blocked });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// GET full list of individually-blocked student uids — admin only. The admin
// panel's "mute in chat" buttons (students table + inline in the chat
// window) previously started from an empty in-memory object every time the
// page loaded, with no idea which students were actually already blocked.
// That meant a refresh made every button show "not muted" regardless of the
// real state, and clicking one could silently flip an already-blocked
// student back to unblocked. This lets the admin frontend seed its buttons
// with the real state on every load.
router.get('/blocked-students', authenticateAdmin, async (req, res) => {
  try { const { blockedUids } = await getState(); res.json({ blockedUids }); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

// GET chat history (public) — most recent messages, oldest first
router.get('/messages', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 300, 500);
    const msgs = await ChatMessage.find().sort({ createdAt: -1 }).limit(limit).lean();
    res.json(msgs.reverse());
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// POST toggle mute — admin only
router.post('/mute', authenticateAdmin, async (req, res) => {
  try {
    const next = await toggleMute();
    const io = req.app.get('io');
    if (io) io.emit('chat-mute-changed', { muted: next });
    res.json({ muted: next });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// DELETE a single message — admin only
router.delete('/messages/:id', authenticateAdmin, async (req, res) => {
  try {
    await ChatMessage.findByIdAndDelete(req.params.id);
    const io = req.app.get('io');
    if (io) io.emit('chat-message-deleted', { id: req.params.id });
    res.json({ message: 'Deleted' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// DELETE all messages — admin only
router.delete('/messages', authenticateAdmin, async (req, res) => {
  try {
    const r = await ChatMessage.deleteMany({});
    const io = req.app.get('io');
    if (io) io.emit('chat-cleared');
    res.json({ message: 'Chat cleared', deleted: r.deletedCount });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
