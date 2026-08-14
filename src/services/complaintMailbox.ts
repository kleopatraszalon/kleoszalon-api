import tls, { TLSSocket } from "tls";
import crypto from "crypto";
import pool from "../db";

export type ComplaintAttachmentInput = {
  filename: string;
  contentType?: string | null;
  content: Buffer;
};

type MailboxConfig = {
  host: string;
  port: number;
  user: string;
  pass: string;
  inbox: string;
  sent: string;
  complaintAddress: string;
};

type ParsedMail = {
  messageId: string | null;
  from: string;
  fromName: string;
  to: string;
  subject: string;
  receivedAt: Date;
  text: string;
  html: string;
  attachments: ComplaintAttachmentInput[];
};

type MailboxState = {
  enabled: boolean;
  running: boolean;
  host: string | null;
  user: string | null;
  inbox: string | null;
  sent: string | null;
  complaintAddress: string;
  lastStartedAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  lastImported: number;
  totalImported: number;
};

const mailboxState: MailboxState = {
  enabled: false,
  running: false,
  host: null,
  user: null,
  inbox: null,
  sent: null,
  complaintAddress: process.env.COMPLAINT_EMAIL?.trim() || "vendegpanasz@kleoszalon.hu",
  lastStartedAt: null,
  lastSuccessAt: null,
  lastErrorAt: null,
  lastError: null,
  lastImported: 0,
  totalImported: 0,
};

let schemaPromise: Promise<void> | null = null;
let workerTimer: NodeJS.Timeout | null = null;

function env(name: string): string {
  return String(process.env[name] || "").trim();
}

function getConfig(): MailboxConfig | null {
  const host = env("COMPLAINT_IMAP_HOST") || env("IMAP_HOST");
  const user = env("COMPLAINT_IMAP_USER") || env("IMAP_USER") || env("SMTP_USER");
  const pass = env("COMPLAINT_IMAP_PASS") || env("IMAP_PASS") || env("SMTP_PASS");
  if (!host || !user || !pass) return null;
  return {
    host,
    port: Number(env("COMPLAINT_IMAP_PORT") || env("IMAP_PORT") || 993),
    user,
    pass,
    inbox: env("COMPLAINT_IMAP_MAILBOX") || "INBOX",
    sent: env("COMPLAINT_IMAP_SENT_MAILBOX") || env("IMAP_SENT_MAILBOX") || "Sent",
    complaintAddress: env("COMPLAINT_EMAIL") || "vendegpanasz@kleoszalon.hu",
  };
}

function getSentConfig(): MailboxConfig | null {
  const complaint = getConfig();
  const host = env("IMAP_HOST") || complaint?.host || "";
  const user = env("IMAP_USER") || env("SMTP_USER") || complaint?.user || "";
  const pass = env("IMAP_PASS") || env("SMTP_PASS") || complaint?.pass || "";
  if (!host || !user || !pass) return null;
  return {
    host,
    port: Number(env("IMAP_PORT") || complaint?.port || 993),
    user,
    pass,
    inbox: "INBOX",
    sent: env("IMAP_SENT_MAILBOX") || env("COMPLAINT_IMAP_SENT_MAILBOX") || complaint?.sent || "Sent",
    complaintAddress: env("COMPLAINT_EMAIL") || complaint?.complaintAddress || "vendegpanasz@kleoszalon.hu",
  };
}

function q(value: string): string {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

class MinimalImapClient {
  private socket: TLSSocket | null = null;
  private buffer = Buffer.alloc(0);
  private tagNo = 0;
  private waiters: Array<() => void> = [];
  private socketError: Error | null = null;

  constructor(private cfg: MailboxConfig) {}

  async connect(): Promise<void> {
    this.socket = tls.connect({
      host: this.cfg.host,
      port: this.cfg.port,
      servername: this.cfg.host,
      rejectUnauthorized: env("IMAP_TLS_REJECT_UNAUTHORIZED") !== "0",
    });
    this.socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
      const waiters = this.waiters.splice(0);
      waiters.forEach((fn) => fn());
    });
    this.socket.on("error", (error) => {
      this.socketError = error;
      const waiters = this.waiters.splice(0);
      waiters.forEach((fn) => fn());
    });
    await new Promise<void>((resolve, reject) => {
      const socket = this.socket!;
      const onError = (e: Error) => { cleanup(); reject(e); };
      const onSecure = () => { cleanup(); resolve(); };
      const cleanup = () => {
        socket.off("error", onError);
        socket.off("secureConnect", onSecure);
      };
      socket.once("error", onError);
      socket.once("secureConnect", onSecure);
    });
    const greeting = await this.readUntil((buf) => buf.includes(Buffer.from("\r\n")), 15000);
    const first = greeting.toString("utf8").split("\r\n", 1)[0];
    if (!/^\*\s+(OK|PREAUTH)/i.test(first)) throw new Error(`IMAP greeting rejected: ${first}`);
    const firstLineEnd = greeting.indexOf(Buffer.from("\r\n"));
    this.buffer = greeting.subarray(firstLineEnd + 2);
    await this.command(`LOGIN ${q(this.cfg.user)} ${q(this.cfg.pass)}`);
  }

  private async waitForData(timeoutMs: number): Promise<void> {
    if (this.socketError) throw this.socketError;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(done);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error("IMAP response timeout"));
      }, timeoutMs);
      const done = () => { clearTimeout(timer); resolve(); };
      this.waiters.push(done);
    });
    if (this.socketError) throw this.socketError;
  }

  private async readUntil(test: (buf: Buffer) => boolean, timeoutMs = 20000): Promise<Buffer> {
    const started = Date.now();
    while (!test(this.buffer)) {
      const left = timeoutMs - (Date.now() - started);
      if (left <= 0) throw new Error("IMAP response timeout");
      await this.waitForData(left);
    }
    return this.buffer;
  }

  private taggedLinePosition(buf: Buffer, tag: string): number {
    const text = buf.toString("latin1");
    const match = new RegExp(`(?:^|\\r\\n)${tag}\\s`).exec(text);
    if (!match || match.index == null) return -1;
    return match.index + (match[0].startsWith("\r\n") ? 2 : 0);
  }

  async command(command: string): Promise<Buffer> {
    if (!this.socket) throw new Error("IMAP socket is not connected");
    const tag = `K${String(++this.tagNo).padStart(4, "0")}`;
    this.socket.write(`${tag} ${command}\r\n`);
    const all = await this.readUntil((buf) => {
      const pos = this.taggedLinePosition(buf, tag);
      if (pos < 0) return false;
      return buf.indexOf(Buffer.from("\r\n"), pos) >= 0;
    });
    const pos = this.taggedLinePosition(all, tag);
    const lineEnd = all.indexOf(Buffer.from("\r\n"), pos);
    const response = all.subarray(0, lineEnd + 2);
    this.buffer = all.subarray(lineEnd + 2);
    const tagged = all.subarray(pos, lineEnd).toString("utf8");
    if (!new RegExp(`^${tag}\\s+OK\\b`, "i").test(tagged)) {
      throw new Error(`IMAP command failed (${command.split(" ", 1)[0]}): ${tagged}`);
    }
    return response;
  }

  async append(mailbox: string, raw: Buffer): Promise<void> {
    if (!this.socket) throw new Error("IMAP socket is not connected");
    const tag = `K${String(++this.tagNo).padStart(4, "0")}`;
    this.socket.write(`${tag} APPEND ${q(mailbox)} (\\Seen) {${raw.length}}\r\n`);
    await this.readUntil((buf) => /(^|\r\n)\+\s/.test(buf.toString("utf8")), 15000);
    const continuationEnd = this.buffer.indexOf(Buffer.from("\r\n"));
    if (continuationEnd >= 0) this.buffer = this.buffer.subarray(continuationEnd + 2);
    this.socket.write(raw);
    this.socket.write("\r\n");
    const all = await this.readUntil((buf) => {
      const pos = this.taggedLinePosition(buf, tag);
      return pos >= 0 && buf.indexOf(Buffer.from("\r\n"), pos) >= 0;
    }, 30000);
    const pos = this.taggedLinePosition(all, tag);
    const lineEnd = all.indexOf(Buffer.from("\r\n"), pos);
    const tagged = all.subarray(pos, lineEnd).toString("utf8");
    this.buffer = all.subarray(lineEnd + 2);
    if (!new RegExp(`^${tag}\\s+OK\\b`, "i").test(tagged)) throw new Error(`IMAP APPEND failed: ${tagged}`);
  }

  async close(): Promise<void> {
    if (!this.socket) return;
    try { await this.command("LOGOUT"); } catch {}
    this.socket.end();
    this.socket = null;
  }
}

function splitHeaderBody(raw: Buffer): { headers: string; body: Buffer } {
  let idx = raw.indexOf(Buffer.from("\r\n\r\n"));
  let sep = 4;
  if (idx < 0) { idx = raw.indexOf(Buffer.from("\n\n")); sep = 2; }
  if (idx < 0) return { headers: raw.toString("utf8"), body: Buffer.alloc(0) };
  return { headers: raw.subarray(0, idx).toString("utf8"), body: raw.subarray(idx + sep) };
}

function headerMap(text: string): Record<string, string> {
  const unfolded = text.replace(/\r?\n[\t ]+/g, " ");
  const out: Record<string, string> = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    out[key] = out[key] ? `${out[key]}, ${value}` : value;
  }
  return out;
}

function decodeQuotedPrintable(input: string): Buffer {
  const normalized = input.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < normalized.length; i += 1) {
    if (normalized[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(normalized.slice(i + 1, i + 3))) {
      bytes.push(parseInt(normalized.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(normalized.charCodeAt(i) & 0xff);
  }
  return Buffer.from(bytes);
}

function decodeTransfer(body: Buffer, encoding: string): Buffer {
  const enc = encoding.toLowerCase();
  if (enc.includes("base64")) return Buffer.from(body.toString("ascii").replace(/\s+/g, ""), "base64");
  if (enc.includes("quoted-printable")) return decodeQuotedPrintable(body.toString("latin1"));
  return body;
}

function decodeWords(value: string): string {
  return String(value || "").replace(/=\?([^?]+)\?([bBqQ])\?([^?]+)\?=/g, (_m, charset, mode, data) => {
    try {
      const buf = String(mode).toUpperCase() === "B"
        ? Buffer.from(data, "base64")
        : decodeQuotedPrintable(String(data).replace(/_/g, " "));
      if (/utf-?8/i.test(charset)) return buf.toString("utf8");
      return buf.toString("latin1");
    } catch { return data; }
  });
}

function parameter(value: string, name: string): string | null {
  const extended = new RegExp(`${name}\\*=([^;]+)`, "i").exec(value);
  if (extended) {
    const raw = extended[1].trim().replace(/^"|"$/g, "");
    const encoded = raw.includes("''") ? raw.split("''").slice(1).join("''") : raw;
    try { return decodeURIComponent(encoded); } catch { return encoded; }
  }
  const normal = new RegExp(`${name}=(?:"([^"]+)"|([^;]+))`, "i").exec(value);
  return normal ? decodeWords((normal[1] || normal[2] || "").trim()) : null;
}

function splitMultipart(body: Buffer, boundary: string): Buffer[] {
  const marker = `--${boundary}`;
  const text = body.toString("latin1");
  return text.split(marker).slice(1).map((part) => part.replace(/^\r?\n/, "").replace(/\r?\n--\s*$/, "").replace(/\r?\n$/, "")).filter(Boolean).map((part) => Buffer.from(part, "latin1"));
}

function parseEntity(raw: Buffer, acc: { text: string[]; html: string[]; attachments: ComplaintAttachmentInput[] }): void {
  const { headers: headerText, body } = splitHeaderBody(raw);
  const h = headerMap(headerText);
  const type = h["content-type"] || "text/plain; charset=utf-8";
  const disposition = h["content-disposition"] || "";
  const transfer = h["content-transfer-encoding"] || "";
  const boundary = parameter(type, "boundary");
  if (/^multipart\//i.test(type) && boundary) {
    splitMultipart(body, boundary).forEach((part) => parseEntity(part, acc));
    return;
  }
  const decoded = decodeTransfer(body, transfer);
  const filename = parameter(disposition, "filename") || parameter(type, "name");
  const contentType = type.split(";", 1)[0].trim().toLowerCase();
  if (filename || /^attachment/i.test(disposition)) {
    acc.attachments.push({ filename: filename || "csatolmany.bin", contentType, content: decoded });
  } else if (contentType === "text/html") acc.html.push(decoded.toString("utf8"));
  else if (contentType.startsWith("text/")) acc.text.push(decoded.toString("utf8"));
}

function extractAddress(value: string): { email: string; name: string } {
  const decoded = decodeWords(value || "");
  const angle = /^(.*)<([^>]+)>/.exec(decoded);
  if (angle) return { email: angle[2].trim().toLowerCase(), name: angle[1].replace(/^"|"$/g, "").trim() };
  const email = decoded.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || decoded.trim();
  return { email: email.toLowerCase(), name: decoded.replace(email, "").trim().replace(/^"|"$/g, "") };
}

function htmlToText(html: string): string {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function parseMail(raw: Buffer): ParsedMail {
  const { headers: headerText } = splitHeaderBody(raw);
  const h = headerMap(headerText);
  const parts = { text: [] as string[], html: [] as string[], attachments: [] as ComplaintAttachmentInput[] };
  parseEntity(raw, parts);
  const from = extractAddress(h.from || "");
  const text = parts.text.join("\n\n").trim() || htmlToText(parts.html.join("\n"));
  const dt = new Date(h.date || Date.now());
  return {
    messageId: h["message-id"]?.trim() || null,
    from: from.email,
    fromName: from.name,
    to: decodeWords(h.to || ""),
    subject: decodeWords(h.subject || "(Tárgy nélkül)").trim() || "(Tárgy nélkül)",
    receivedAt: Number.isNaN(dt.getTime()) ? new Date() : dt,
    text,
    html: parts.html.join("\n"),
    attachments: parts.attachments,
  };
}

function fetchLiteral(response: Buffer): Buffer {
  const text = response.toString("latin1");
  const match = /\{(\d+)\}\r\n/.exec(text);
  if (!match || match.index == null) throw new Error("IMAP FETCH response has no literal body");
  const start = match.index + match[0].length;
  const length = Number(match[1]);
  return response.subarray(start, start + length);
}

async function ensureSchema(): Promise<void> {
  if (!schemaPromise) schemaPromise = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS operations_quality_records(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), module_key text NOT NULL, title text NOT NULL,
        description text, location_name text, department text, assignee text, priority text DEFAULT 'normal',
        status text DEFAULT 'open', due_at timestamptz, recurrence text, requires_approval boolean DEFAULT false,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS complaint_mail_messages(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), complaint_id uuid NOT NULL REFERENCES operations_quality_records(id) ON DELETE CASCADE,
        mailbox_key text NOT NULL, imap_uid bigint NOT NULL, message_id text, sender_email text, sender_name text,
        recipient text, subject text, received_at timestamptz, raw_sha256 text NOT NULL, created_at timestamptz DEFAULT now(),
        UNIQUE(mailbox_key, imap_uid)
      );
      CREATE INDEX IF NOT EXISTS idx_complaint_mail_message_id ON complaint_mail_messages(message_id);
      CREATE TABLE IF NOT EXISTS complaint_attachments(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), complaint_id uuid NOT NULL REFERENCES operations_quality_records(id) ON DELETE CASCADE,
        mail_message_id uuid REFERENCES complaint_mail_messages(id) ON DELETE CASCADE, filename text NOT NULL,
        content_type text, byte_size bigint NOT NULL DEFAULT 0, sha256 text NOT NULL, content bytea NOT NULL,
        source text NOT NULL DEFAULT 'email', created_at timestamptz DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_complaint_attachments_complaint ON complaint_attachments(complaint_id, created_at);
    `);
  })().catch((error) => { schemaPromise = null; throw error; });
  await schemaPromise;
}

export async function storeComplaintAttachment(complaintId: string, attachment: ComplaintAttachmentInput, source = "manual"): Promise<any> {
  await ensureSchema();
  const content = Buffer.from(attachment.content);
  const sha256 = crypto.createHash("sha256").update(content).digest("hex");
  const r = await pool.query(`INSERT INTO complaint_attachments(complaint_id,filename,content_type,byte_size,sha256,content,source)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,complaint_id,filename,content_type,byte_size,sha256,source,created_at`,
    [complaintId, attachment.filename, attachment.contentType || "application/octet-stream", content.length, sha256, content, source]);
  return r.rows[0];
}

async function persistMail(mailboxKey: string, uid: number, mail: ParsedMail, raw: Buffer): Promise<boolean> {
  await ensureSchema();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const exists = await client.query("SELECT id FROM complaint_mail_messages WHERE mailbox_key=$1 AND imap_uid=$2", [mailboxKey, uid]);
    if (exists.rowCount) { await client.query("ROLLBACK"); return false; }
    const slaDays = Math.max(1, Math.min(90, Number(env("COMPLAINT_SLA_DAYS") || 5)));
    const description = (mail.text || "E-mailben érkezett vendégpanasz.").slice(0, 12000);
    const op = await client.query(`INSERT INTO operations_quality_records(module_key,title,description,priority,status,due_at,requires_approval,metadata)
      VALUES('complaints',$1,$2,'high','open',now()+($3::text||' days')::interval,true,$4::jsonb) RETURNING id`, [
      `E-mail panasz: ${mail.subject}`.slice(0, 500), description, String(slaDays), JSON.stringify({
        subject: mail.subject, source: "email", sla_days: slaDays, sender_email: mail.from, sender_name: mail.fromName,
        recipient: mail.to, message_id: mail.messageId, received_at: mail.receivedAt.toISOString(), attachment_count: mail.attachments.length,
      }),
    ]);
    const complaintId = op.rows[0].id;
    const rawSha = crypto.createHash("sha256").update(raw).digest("hex");
    const mm = await client.query(`INSERT INTO complaint_mail_messages(complaint_id,mailbox_key,imap_uid,message_id,sender_email,sender_name,recipient,subject,received_at,raw_sha256)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [complaintId, mailboxKey, uid, mail.messageId, mail.from, mail.fromName, mail.to, mail.subject, mail.receivedAt, rawSha]);
    for (const attachment of mail.attachments) {
      const content = Buffer.from(attachment.content);
      const sha = crypto.createHash("sha256").update(content).digest("hex");
      await client.query(`INSERT INTO complaint_attachments(complaint_id,mail_message_id,filename,content_type,byte_size,sha256,content,source)
        VALUES($1,$2,$3,$4,$5,$6,$7,'email')`, [complaintId, mm.rows[0].id, attachment.filename.slice(0, 500), attachment.contentType || "application/octet-stream", content.length, sha, content]);
    }
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

export function getComplaintMailboxStatus(): MailboxState {
  const cfg = getConfig();
  mailboxState.enabled = Boolean(cfg);
  mailboxState.host = cfg?.host || null;
  mailboxState.user = cfg?.user || null;
  mailboxState.inbox = cfg?.inbox || null;
  mailboxState.sent = cfg?.sent || null;
  mailboxState.complaintAddress = cfg?.complaintAddress || mailboxState.complaintAddress;
  return { ...mailboxState };
}

export async function syncComplaintMailbox(): Promise<{ imported: number; scanned: number; status: MailboxState }> {
  const cfg = getConfig();
  if (!cfg) throw Object.assign(new Error("IMAP nincs konfigurálva. Add meg a COMPLAINT_IMAP_HOST / USER / PASS környezeti változókat."), { code: "IMAP_NOT_CONFIGURED" });
  if (mailboxState.running) return { imported: 0, scanned: 0, status: getComplaintMailboxStatus() };
  mailboxState.running = true;
  mailboxState.lastStartedAt = new Date().toISOString();
  mailboxState.lastImported = 0;
  const client = new MinimalImapClient(cfg);
  try {
    await client.connect();
    const selected = await client.command(`SELECT ${q(cfg.inbox)}`);
    const selectedText = selected.toString("utf8");
    const uidValidity = /\[UIDVALIDITY\s+(\d+)\]/i.exec(selectedText)?.[1] || "unknown";
    const mailboxKey = `${cfg.user.toLowerCase()}/${cfg.inbox}/${uidValidity}`;
    const search = await client.command("UID SEARCH UNSEEN");
    const searchLine = search.toString("utf8").split(/\r?\n/).find((line) => /^\* SEARCH/i.test(line)) || "";
    const uids = searchLine.replace(/^\* SEARCH\s*/i, "").trim().split(/\s+/).filter(Boolean).map(Number).filter(Number.isFinite);
    let imported = 0;
    const maxPerRun = Math.max(1, Math.min(100, Number(env("COMPLAINT_IMAP_MAX_PER_RUN") || 25)));
    for (const uid of uids.slice(0, maxPerRun)) {
      const fetched = await client.command(`UID FETCH ${uid} (BODY.PEEK[])`);
      const raw = fetchLiteral(fetched);
      const mail = parseMail(raw);
      const created = await persistMail(mailboxKey, uid, mail, raw);
      await client.command(`UID STORE ${uid} +FLAGS (\\Seen)`);
      if (created) imported += 1;
    }
    mailboxState.lastImported = imported;
    mailboxState.totalImported += imported;
    mailboxState.lastSuccessAt = new Date().toISOString();
    mailboxState.lastError = null;
    return { imported, scanned: Math.min(uids.length, maxPerRun), status: getComplaintMailboxStatus() };
  } catch (error: any) {
    mailboxState.lastErrorAt = new Date().toISOString();
    mailboxState.lastError = error?.message || String(error);
    throw error;
  } finally {
    mailboxState.running = false;
    await client.close();
  }
}

export async function appendRawMessageToSent(raw: Buffer): Promise<boolean> {
  if (env("IMAP_SENT_SYNC") === "0") return false;
  const cfg = getSentConfig();
  if (!cfg) return false;
  const client = new MinimalImapClient(cfg);
  try {
    await client.connect();
    try { await client.append(cfg.sent, raw); }
    catch (error: any) {
      if (/TRYCREATE|does not exist|not found/i.test(error?.message || "")) {
        await client.command(`CREATE ${q(cfg.sent)}`);
        await client.append(cfg.sent, raw);
      } else throw error;
    }
    return true;
  } finally { await client.close(); }
}

export function startComplaintMailboxWorker(): void {
  if (workerTimer) return;
  const cfg = getConfig();
  mailboxState.enabled = Boolean(cfg);
  if (!cfg) {
    console.log("Complaint IMAP worker: disabled (IMAP env not configured)");
    return;
  }
  const pollMs = Math.max(60, Number(env("COMPLAINT_IMAP_POLL_SECONDS") || 120)) * 1000;
  const run = () => syncComplaintMailbox().catch((error) => console.error("Complaint IMAP sync error:", error?.message || error));
  const initial = setTimeout(run, 5000); initial.unref?.();
  workerTimer = setInterval(run, pollMs); workerTimer.unref?.();
  console.log(`Complaint IMAP worker enabled: ${cfg.complaintAddress}, every ${Math.round(pollMs / 1000)}s`);
}
