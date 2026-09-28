const { GetCommand, PutCommand, UpdateCommand, QueryCommand, ScanCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const { db, TABLES } = require('../config/dynamoClient');

/**
 * Replaces backend/models/UserProfile.js. Table: AIITS_Users
 *   PK: uid (the Firebase uid directly — no separate Mongo ObjectId layer;
 *       every other table that used to reference `UserProfile._id` now just
 *       uses this same uid string, which removes an entire id-translation
 *       layer that only existed because Mongoose needed its own _id).
 *   GSI PhoneIndex: PK = phone            — best-effort duplicate-phone check on register
 *   GSI RankIndex:  PK = gsiType (='USER'), SK = totalMarks (Number)
 *                   — supports the public top-performers query, which needs
 *                   "every user, sorted by totalMarks" without a full scan.
 *
 * IMPORTANT caveat, stated plainly: MongoDB enforced `phone` uniqueness at
 * the database level (a unique index — a genuine hard guarantee). DynamoDB
 * has no equivalent for a non-key attribute. What's implemented below
 * (check PhoneIndex, then Put) is best-effort, not atomic — two requests
 * with the same phone number arriving in the same few milliseconds could
 * theoretically both pass the check. Low real risk on a single-process
 * deployment, but it is a real, honest gap versus what Mongo gave you for
 * free — the fix if it ever matters is a separate `AIITS_Users_ByPhone`
 * table used as a lock via a conditional Put, not implemented here to keep
 * this migration to the scope you asked for.
 */

async function getByUid(uid) {
  const r = await db.send(new GetCommand({ TableName: TABLES.USERS, Key: { uid } }));
  return r.Item || null;
}

async function getByPhone(phone) {
  const r = await db.send(new QueryCommand({
    TableName: TABLES.USERS, IndexName: 'PhoneIndex',
    KeyConditionExpression: 'phone = :p', ExpressionAttributeValues: { ':p': phone }, Limit: 1,
  }));
  return (r.Items && r.Items[0]) || null;
}

async function create(data) {
  const now = new Date().toISOString();
  const item = {
    uid: data.uid, name: data.name, phone: data.phone, coachingName: data.coachingName,
    fatherName: data.fatherName, fatherOccupation: data.fatherOccupation, whatsappNumber: data.whatsappNumber,
    cityState: data.cityState || '', // optional — older accounts simply don't have it
    batch: data.batch,
    totalTests: 0, totalMarks: 0, highestMarks: 0,
    gsiType: 'USER', // constant partition value for RankIndex — see table doc above
    createdAt: now, updatedAt: now,
  };
  // ConditionExpression: refuse to overwrite an existing profile for this uid
  // (mirrors Mongoose's `unique:true` on uid — this one IS safe/atomic,
  // since uid is the actual table primary key, unlike phone above).
  await db.send(new PutCommand({
    TableName: TABLES.USERS, Item: item,
    ConditionExpression: 'attribute_not_exists(uid)',
  }));
  return item;
}

async function update(uid, fields) {
  const names = {}, values = {}, sets = [];
  for (const [k, v] of Object.entries(fields)) {
    names['#' + k] = k; values[':' + k] = v; sets.push(`#${k} = :${k}`);
  }
  sets.push('#updatedAt = :updatedAt');
  names['#updatedAt'] = 'updatedAt'; values[':updatedAt'] = new Date().toISOString();
  const r = await db.send(new UpdateCommand({
    TableName: TABLES.USERS, Key: { uid },
    UpdateExpression: 'SET ' + sets.join(', '),
    ExpressionAttributeNames: names, ExpressionAttributeValues: values,
    ReturnValues: 'ALL_NEW',
  }));
  return r.Attributes;
}

/** Atomic stat update on submit — mirrors the old $inc/$max pattern exactly:
 *  totalTests/totalMarks accumulate, highestMarks only rises. */
async function applySubmitStats(uid, { marksGained }) {
  const r = await db.send(new UpdateCommand({
    TableName: TABLES.USERS, Key: { uid },
    UpdateExpression: 'ADD totalTests :one, totalMarks :marks SET highestMarks = if_not_exists(highestMarks, :zero), updatedAt = :now',
    ExpressionAttributeValues: { ':one': 1, ':marks': marksGained, ':zero': 0, ':now': new Date().toISOString() },
    ReturnValues: 'ALL_NEW',
  }));
  // highestMarks needs a real max(), which DynamoDB's ADD can't express in
  // one step for "only if greater" — do it as a guarded second write.
  if ((r.Attributes.highestMarks || 0) < marksGained) {
    await db.send(new UpdateCommand({
      TableName: TABLES.USERS, Key: { uid },
      UpdateExpression: 'SET highestMarks = :marks',
      ConditionExpression: 'attribute_not_exists(highestMarks) OR highestMarks < :marks',
      ExpressionAttributeValues: { ':marks': marksGained },
    })).catch(() => {}); // benign race with a concurrent higher score — condition just fails silently, correct either way
  }
  return r.Attributes;
}

async function listTopPerformers(limit = 10) {
  const r = await db.send(new QueryCommand({
    TableName: TABLES.USERS, IndexName: 'RankIndex',
    KeyConditionExpression: 'gsiType = :t', ExpressionAttributeValues: { ':t': 'USER' },
    ScanIndexForward: false, Limit: limit,
  }));
  return (r.Items || []).filter(u => (u.totalTests || 0) > 0);
}

/** Admin student list — paginated Scan. Honest limitation: DynamoDB has no
 *  cheap "sort by createdAt across the whole table" without a dedicated GSI
 *  we didn't add (this is a low-traffic admin-only screen, not one of the
 *  concurrent-load paths this migration targeted — see the earlier
 *  discussion on why Test/User/Result were the ones worth moving). Results
 *  come back in whatever order Scan returns them, not sorted; the frontend
 *  admin table will need to sort client-side if that matters. */
/** Admin student list. `limit` is a soft budget for how many items to
 *  return in total (default matches admin.js's own default) — internally
 *  loops across DynamoDB's LastEvaluatedKey pages (a single Scan call can
 *  return far fewer than `limit` items if it hits the 1MB-per-call
 *  response cap first) so callers that pass a large limit (e.g.
 *  recompute-user-stats's User.scanAll(5000), which needs literally every
 *  user, not just one page of them) actually get up to that many items
 *  instead of silently truncating at whatever the first page happened to
 *  hold. Honest limitation unchanged from before: DynamoDB has no cheap
 *  "sort by createdAt across the whole table" without a dedicated GSI we
 *  didn't add — results come back in Scan order, sorted client-side by
 *  the caller if needed. */
async function scanAll(limit = 100) {
  let items = [];
  let count = 0;
  let key;
  do {
    const r = await db.send(new ScanCommand({ TableName: TABLES.USERS, Limit: Math.max(1, limit - items.length), ExclusiveStartKey: key }));
    if (r.Items) items = items.concat(r.Items);
    if (typeof r.Count === 'number') count += r.Count;
    key = r.LastEvaluatedKey;
  } while (key && items.length < limit);
  return { items, count };
}

async function deleteByUid(uid) {
  await db.send(new DeleteCommand({ TableName: TABLES.USERS, Key: { uid } }));
}

// True total count — Select:COUNT still only covers one ≤1MB page per
// call, so this must follow LastEvaluatedKey too or a large table
// silently reports a lower count than actually exists.
async function count() {
  let total = 0;
  let key;
  do {
    const r = await db.send(new ScanCommand({ TableName: TABLES.USERS, Select: 'COUNT', ExclusiveStartKey: key }));
    total += r.Count || 0;
    key = r.LastEvaluatedKey;
  } while (key);
  return total;
}

module.exports = { getByUid, getByPhone, create, update, applySubmitStats, listTopPerformers, scanAll, deleteByUid, count };
