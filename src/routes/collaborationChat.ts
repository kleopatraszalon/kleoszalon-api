import { Router } from "express";
import db from "../db";
import { requireAuth, AuthRequest } from "../middleware/auth";

const router = Router();
router.use(requireAuth);

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

router.get("/coworkers", async (req: AuthRequest, res, next) => {
  try {
    const me = await actor(req);
    const { rows } = await db.query(
      `SELECT id::text AS id, COALESCE(full_name, email, 'Munkatárs') AS full_name,
              email, location_id, photo_url
       FROM employees
       WHERE COALESCE(active, true) = true
         AND ('employee:' || id::text) <> $1
       ORDER BY COALESCE(full_name, email)`,
      [me.key]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get("/conversations", async (req: AuthRequest, res, next) => {
  try {
    const me = await actor(req);
    const { rows } = await db.query(
      `SELECT c.id, c.participant_a, c.participant_b, c.updated_at,
              CASE WHEN c.participant_a = $1 THEN c.participant_b ELSE c.participant_a END AS other_key,
              COALESCE(e.full_name, e.email, CASE WHEN c.participant_a = $1 THEN c.participant_b ELSE c.participant_a END) AS other_name,
              lm.content AS last_message, lm.created_at AS last_message_at
       FROM staff_chat_conversations c
       LEFT JOIN employees e ON ('employee:' || e.id::text) = CASE WHEN c.participant_a = $1 THEN c.participant_b ELSE c.participant_a END
       LEFT JOIN LATERAL (
         SELECT content, created_at FROM staff_chat_messages m
         WHERE m.conversation_id = c.id
         ORDER BY created_at DESC LIMIT 1
       ) lm ON true
       WHERE c.participant_a = $1 OR c.participant_b = $1
       ORDER BY COALESCE(lm.created_at, c.updated_at) DESC`,
      [me.key]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post("/conversations", async (req: AuthRequest, res, next) => {
  try {
    const me = await actor(req);
    const coworkerId = String(req.body?.coworker_id || "").trim();
    if (!coworkerId) return res.status(400).json({ message: "A munkatárs kiválasztása kötelező." });
    const other = `employee:${coworkerId}`;
    if (other === me.key) return res.status(400).json({ message: "Saját magaddal nem indíthatsz beszélgetést." });
    const pair = [me.key, other].sort();
    const { rows } = await db.query(
      `INSERT INTO staff_chat_conversations (participant_a, participant_b)
       VALUES ($1,$2)
       ON CONFLICT (participant_a, participant_b) DO UPDATE SET updated_at = now()
       RETURNING *`,
      pair
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

router.get("/conversations/:id/messages", async (req: AuthRequest, res, next) => {
  try {
    const me = await actor(req);
    const allowed = await db.query(
      `SELECT 1 FROM staff_chat_conversations WHERE id = $1 AND (participant_a = $2 OR participant_b = $2)`,
      [req.params.id, me.key]
    );
    if (!allowed.rows[0]) return res.status(404).json({ message: "A beszélgetés nem található." });
    const { rows } = await db.query(
      `SELECT id, conversation_id, sender_key, sender_name, content, created_at, read_at,
              (sender_key = $2) AS is_mine
       FROM staff_chat_messages WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT 300`,
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
    const allowed = await db.query(
      `SELECT 1 FROM staff_chat_conversations WHERE id = $1 AND (participant_a = $2 OR participant_b = $2)`,
      [req.params.id, me.key]
    );
    if (!allowed.rows[0]) return res.status(404).json({ message: "A beszélgetés nem található." });
    const { rows } = await db.query(
      `INSERT INTO staff_chat_messages (conversation_id, sender_key, sender_name, content)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, me.key, me.name, content]
    );
    await db.query(`UPDATE staff_chat_conversations SET updated_at = now() WHERE id = $1`, [req.params.id]);
    res.status(201).json({ ...rows[0], is_mine: true });
  } catch (err) { next(err); }
});

export default router;
