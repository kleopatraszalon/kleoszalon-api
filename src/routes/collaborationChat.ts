import { Router } from "express";
import db from "../db";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { requireFeature } from "../middleware/featureAccess";

const router = Router();
router.use(requireAuth);
router.use(requireFeature("staff_chat"));

async function actor(req: AuthRequest) {
  const email = String(req.user?.email || "").trim().toLowerCase();
  if (email) {
    const { rows } = await db.query(
      `SELECT id::text AS employee_id, COALESCE(full_name, email) AS full_name, email
       FROM employees
       WHERE lower(email) = $1 AND COALESCE(active, true) = true
       LIMIT 1`,
      [email]
    );
    if (rows[0]) return { key: `employee:${rows[0].employee_id}`, name: rows[0].full_name, email };
  }
  return { key: `user:${req.user?.id ?? "unknown"}`, name: req.user?.email || `Felhasználó ${req.user?.id ?? ""}`, email };
}

async function touchPresence(key: string) {
  await db.query(
    `INSERT INTO staff_chat_presence (user_key, last_seen_at)
     VALUES ($1, now())
     ON CONFLICT (user_key) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at`,
    [key]
  );
}

async function requireMembership(conversationId: string, memberKey: string) {
  const { rows } = await db.query(
    `SELECT 1 FROM staff_chat_members WHERE conversation_id = $1 AND member_key = $2`,
    [conversationId, memberKey]
  );
  return Boolean(rows[0]);
}

router.post("/presence", async (req: AuthRequest, res, next) => {
  try {
    const me = await actor(req);
    await touchPresence(me.key);
    res.json({ ok: true, at: new Date().toISOString() });
  } catch (err) { next(err); }
});

router.get("/unread-count", async (req: AuthRequest, res, next) => {
  try {
    const me = await actor(req);
    await touchPresence(me.key);
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS unread_count
       FROM staff_chat_messages m
       JOIN staff_chat_members sm ON sm.conversation_id = m.conversation_id AND sm.member_key = $1
       WHERE m.sender_key <> $1
         AND m.created_at > COALESCE(sm.last_read_at, '-infinity'::timestamptz)`,
      [me.key]
    );
    res.json({ unread_count: rows[0]?.unread_count || 0 });
  } catch (err) { next(err); }
});

router.get("/coworkers", async (req: AuthRequest, res, next) => {
  try {
    const me = await actor(req);
    await touchPresence(me.key);
    const q = String(req.query.q || "").trim();
    const { rows } = await db.query(
      `SELECT e.id::text AS id,
              COALESCE(e.full_name, e.email, 'Munkatárs') AS full_name,
              e.email, e.location_id, e.photo_url,
              p.last_seen_at,
              (p.last_seen_at >= now() - interval '90 seconds') AS online
       FROM employees e
       LEFT JOIN staff_chat_presence p ON p.user_key = ('employee:' || e.id::text)
       WHERE COALESCE(e.active, true) = true
         AND ('employee:' || e.id::text) <> $1
         AND ($2 = '' OR COALESCE(e.full_name,'') ILIKE '%' || $2 || '%' OR COALESCE(e.email,'') ILIKE '%' || $2 || '%')
       ORDER BY (p.last_seen_at >= now() - interval '90 seconds') DESC, COALESCE(e.full_name, e.email)`,
      [me.key, q]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get("/conversations", async (req: AuthRequest, res, next) => {
  try {
    const me = await actor(req);
    await touchPresence(me.key);
    const q = String(req.query.q || "").trim();
    const { rows } = await db.query(
      `SELECT c.id, c.is_group, c.title, c.updated_at,
              CASE
                WHEN c.is_group THEN COALESCE(c.title, 'Csoportos beszélgetés')
                ELSE COALESCE(other_e.full_name, other_e.email, other.member_key)
              END AS other_name,
              lm.content AS last_message,
              lm.created_at AS last_message_at,
              COUNT(unread.id)::int AS unread_count,
              CASE WHEN c.is_group THEN NULL ELSE op.last_seen_at END AS other_last_seen_at,
              CASE WHEN c.is_group THEN NULL ELSE (op.last_seen_at >= now() - interval '90 seconds') END AS other_online
       FROM staff_chat_conversations c
       JOIN staff_chat_members mine ON mine.conversation_id = c.id AND mine.member_key = $1
       LEFT JOIN LATERAL (
         SELECT sm.member_key FROM staff_chat_members sm
         WHERE sm.conversation_id = c.id AND sm.member_key <> $1
         ORDER BY sm.joined_at LIMIT 1
       ) other ON true
       LEFT JOIN employees other_e ON ('employee:' || other_e.id::text) = other.member_key
       LEFT JOIN staff_chat_presence op ON op.user_key = other.member_key
       LEFT JOIN LATERAL (
         SELECT content, created_at FROM staff_chat_messages m
         WHERE m.conversation_id = c.id ORDER BY created_at DESC LIMIT 1
       ) lm ON true
       LEFT JOIN staff_chat_messages unread
         ON unread.conversation_id = c.id
        AND unread.sender_key <> $1
        AND unread.created_at > COALESCE(mine.last_read_at, '-infinity'::timestamptz)
       WHERE ($2 = '' OR COALESCE(c.title,'') ILIKE '%' || $2 || '%'
              OR COALESCE(other_e.full_name,'') ILIKE '%' || $2 || '%'
              OR COALESCE(other_e.email,'') ILIKE '%' || $2 || '%'
              OR COALESCE(lm.content,'') ILIKE '%' || $2 || '%')
       GROUP BY c.id, c.is_group, c.title, c.updated_at, other.member_key, other_e.full_name, other_e.email,
                lm.content, lm.created_at, op.last_seen_at
       ORDER BY COALESCE(lm.created_at, c.updated_at) DESC`,
      [me.key, q]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post("/conversations", async (req: AuthRequest, res, next) => {
  const client = await db.connect();
  try {
    const me = await actor(req);
    const coworkerId = String(req.body?.coworker_id || "").trim();
    if (!coworkerId) return res.status(400).json({ message: "A munkatárs kiválasztása kötelező." });
    const other = `employee:${coworkerId}`;
    if (other === me.key) return res.status(400).json({ message: "Saját magaddal nem indíthatsz beszélgetést." });
    const pair = [me.key, other].sort();
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO staff_chat_conversations (participant_a, participant_b, is_group, created_by)
       VALUES ($1,$2,false,$3)
       ON CONFLICT (participant_a, participant_b) DO UPDATE SET updated_at = now()
       RETURNING *`,
      [pair[0], pair[1], me.key]
    );
    await client.query(
      `INSERT INTO staff_chat_members (conversation_id, member_key)
       VALUES ($1,$2),($1,$3) ON CONFLICT DO NOTHING`,
      [rows[0].id, pair[0], pair[1]]
    );
    await client.query("COMMIT");
    res.status(201).json(rows[0]);
  } catch (err) { await client.query("ROLLBACK"); next(err); }
  finally { client.release(); }
});

router.post("/groups", async (req: AuthRequest, res, next) => {
  const client = await db.connect();
  try {
    const me = await actor(req);
    const title = String(req.body?.title || "").trim().slice(0, 120);
    const coworkerIds = Array.from(new Set((Array.isArray(req.body?.coworker_ids) ? req.body.coworker_ids : []).map((x: unknown) => String(x).trim()).filter(Boolean)));
    if (!title) return res.status(400).json({ message: "A csoport neve kötelező." });
    if (coworkerIds.length < 2) return res.status(400).json({ message: "Csoportos beszélgetéshez legalább két munkatársat válassz." });
    await client.query("BEGIN");
    const created = await client.query(
      `INSERT INTO staff_chat_conversations (participant_a, participant_b, is_group, title, created_by)
       VALUES ($1,$2,true,$3,$1) RETURNING *`,
      [me.key, `group:${Date.now()}:${Math.random().toString(36).slice(2,8)}`, title]
    );
    const id = created.rows[0].id;
    const members = [me.key, ...coworkerIds.map(id => `employee:${id}`)];
    for (const member of members) {
      await client.query(`INSERT INTO staff_chat_members (conversation_id, member_key) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, member]);
    }
    await client.query("COMMIT");
    res.status(201).json(created.rows[0]);
  } catch (err) { await client.query("ROLLBACK"); next(err); }
  finally { client.release(); }
});

router.get("/conversations/:id/messages", async (req: AuthRequest, res, next) => {
  try {
    const me = await actor(req);
    if (!(await requireMembership(req.params.id, me.key))) return res.status(404).json({ message: "A beszélgetés nem található." });
    const { rows } = await db.query(
      `SELECT id, conversation_id, sender_key, sender_name, content, created_at, read_at,
              (sender_key = $2) AS is_mine
       FROM staff_chat_messages WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT 300`,
      [req.params.id, me.key]
    );
    await db.query(
      `UPDATE staff_chat_members SET last_read_at = now()
       WHERE conversation_id = $1 AND member_key = $2`,
      [req.params.id, me.key]
    );
    await db.query(
      `UPDATE staff_chat_messages SET read_at = COALESCE(read_at, now())
       WHERE conversation_id = $1 AND sender_key <> $2`,
      [req.params.id, me.key]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post("/conversations/:id/messages", async (req: AuthRequest, res, next) => {
  try {
    const me = await actor(req);
    const content = String(req.body?.content || "").trim().slice(0, 4000);
    if (!content) return res.status(400).json({ message: "Az üzenet nem lehet üres." });
    if (!(await requireMembership(req.params.id, me.key))) return res.status(404).json({ message: "A beszélgetés nem található." });
    const { rows } = await db.query(
      `INSERT INTO staff_chat_messages (conversation_id, sender_key, sender_name, content)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, me.key, me.name, content]
    );
    await db.query(`UPDATE staff_chat_conversations SET updated_at = now() WHERE id = $1`, [req.params.id]);
    await db.query(`UPDATE staff_chat_members SET last_read_at = now() WHERE conversation_id = $1 AND member_key = $2`, [req.params.id, me.key]);
    res.status(201).json({ ...rows[0], is_mine: true });
  } catch (err) { next(err); }
});

// Teljes chat-felügyelet: kizárólag külön staff_chat_all feature-rel.
router.get("/supervision/conversations", requireFeature("staff_chat_all"), async (req: AuthRequest, res, next) => {
  try {
    const q = String(req.query.q || "").trim();
    const { rows } = await db.query(
      `SELECT c.id,c.is_group,c.title,c.created_by,c.created_at,c.updated_at,
              COUNT(DISTINCT sm.member_key)::int AS member_count,
              COUNT(m.id)::int AS message_count,
              MAX(m.created_at) AS last_message_at,
              STRING_AGG(DISTINCT COALESCE(e.full_name,e.email,sm.member_key), ', ' ORDER BY COALESCE(e.full_name,e.email,sm.member_key)) AS members
       FROM staff_chat_conversations c
       LEFT JOIN staff_chat_members sm ON sm.conversation_id=c.id
       LEFT JOIN employees e ON ('employee:' || e.id::text)=sm.member_key
       LEFT JOIN staff_chat_messages m ON m.conversation_id=c.id
       WHERE ($1='' OR COALESCE(c.title,'') ILIKE '%'||$1||'%' OR COALESCE(e.full_name,'') ILIKE '%'||$1||'%' OR COALESCE(e.email,'') ILIKE '%'||$1||'%')
       GROUP BY c.id,c.is_group,c.title,c.created_by,c.created_at,c.updated_at
       ORDER BY COALESCE(MAX(m.created_at),c.updated_at) DESC
       LIMIT 300`, [q]);
    res.json(rows);
  } catch (err) { next(err); }
});

router.get("/supervision/conversations/:id/messages", requireFeature("staff_chat_all"), async (req: AuthRequest, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id,conversation_id,sender_key,sender_name,content,created_at,read_at
       FROM staff_chat_messages WHERE conversation_id=$1 ORDER BY created_at ASC LIMIT 1000`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

export default router;
