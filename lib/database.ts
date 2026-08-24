import { env } from "cloudflare:workers";

export type NivasaEnv = {
  DB: D1Database;
  ADMIN_EMAILS?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  SEED_DEMO_DATA?: string;
  DEMO_RESIDENT_EMAIL?: string;
  EMAIL_DELIVERY_DISABLED?: string;
  ADMIN_INVITE_CODE?: string;
  TRUST_PLATFORM_IDENTITY?: string;
};

const appEnv = env as unknown as NivasaEnv;
let schemaReady: Promise<void> | null = null;

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    flat_number TEXT,
    phone TEXT,
    role TEXT NOT NULL DEFAULT 'resident' CHECK (role IN ('resident', 'admin')),
    admin_granted INTEGER NOT NULL DEFAULT 0,
    password_hash TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS complaints (
    id TEXT PRIMARY KEY,
    public_id TEXT NOT NULL UNIQUE,
    resident_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    description TEXT NOT NULL,
    location TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'In Progress', 'Resolved')),
    priority TEXT NOT NULL DEFAULT 'Medium' CHECK (priority IN ('Low', 'Medium', 'High')),
    idempotency_key TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at TEXT,
    UNIQUE (resident_id, idempotency_key)
  )`,
  `CREATE TABLE IF NOT EXISTS complaint_history (
    id TEXT PRIMARY KEY,
    complaint_id TEXT NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    from_value TEXT,
    to_value TEXT NOT NULL,
    actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    actor_name TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS complaint_photos (
    id TEXT PRIMARY KEY,
    complaint_id TEXT NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
    data BLOB NOT NULL,
    original_name TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS notices (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    important INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    author_name TEXT NOT NULL,
    published_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS notification_outbox (
    id TEXT PRIMARY KEY,
    dedupe_key TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    email TEXT NOT NULL,
    type TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sent_at TEXT
  )`,
];

const indexStatements = [
  "CREATE INDEX IF NOT EXISTS idx_complaints_resident_created ON complaints(resident_id, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_complaints_status_category_created ON complaints(status, category, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_history_complaint_created ON complaint_history(complaint_id, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_photos_complaint ON complaint_photos(complaint_id)",
  "CREATE INDEX IF NOT EXISTS idx_notices_important_published ON notices(important DESC, published_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_outbox_status_created ON notification_outbox(status, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)",
  "CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)",
];

export function getAppEnv(): NivasaEnv {
  return appEnv;
}

export async function getDatabase(): Promise<D1Database> {
  if (!appEnv.DB) throw new Error("The DB binding is unavailable.");
  await ensureDatabase();
  return appEnv.DB;
}

export async function ensureDatabase(): Promise<void> {
  if (!schemaReady) {
    schemaReady = initializeDatabase().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
}

async function initializeDatabase(): Promise<void> {
  const db = appEnv.DB;
  if (!db) throw new Error("The DB binding is unavailable.");

  await db.batch(schemaStatements.map((statement) => db.prepare(statement)));
  await db.batch(indexStatements.map((statement) => db.prepare(statement)));
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").bind("overdue_days", "3"),
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").bind("society_name", "Greenwood Residency"),
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").bind("society_location", "Phase II · Bengaluru"),
  ]);

  // Demo residents, complaints, and notices are local-preview fixtures. The
  // local Wrangler config sets SEED_DEMO_DATA; hosted environments do not, so a
  // real society never starts out holding fabricated records or bouncing
  // addresses like priya@nivasa.local.
  if (appEnv.SEED_DEMO_DATA !== "true") return;
  await addMissingColumns(db);

  const row = await db.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>();
  if (Number(row?.count ?? 0) === 0) await seedDemoData(db);
}

/**
 * `CREATE TABLE IF NOT EXISTS` cannot widen a table that already exists, so a
 * database created before a column was introduced needs it added explicitly.
 */
async function addMissingColumns(db: D1Database): Promise<void> {
  const columns = await db.prepare("PRAGMA table_info(users)").all<{ name: string }>();
  const present = new Set(columns.results.map((column) => column.name));
  if (!present.has("admin_granted")) {
    await db
      .prepare("ALTER TABLE users ADD COLUMN admin_granted INTEGER NOT NULL DEFAULT 0")
      .run();
  }
  if (!present.has("password_hash")) {
    // Nullable: platform and demo identities authenticate without a password.
    await db.prepare("ALTER TABLE users ADD COLUMN password_hash TEXT").run();
  }

  // Photos previously lived in R2 and the table stored only an object key.
  // SQLite cannot relax that column in place, and the referenced objects no
  // longer exist, so the table is rebuilt. Only photo rows are affected;
  // complaints and their history are untouched.
  const photoColumns = await db
    .prepare("PRAGMA table_info(complaint_photos)")
    .all<{ name: string }>();
  const photoNames = new Set(photoColumns.results.map((column) => column.name));
  if (photoNames.size > 0 && !photoNames.has("data")) {
    const createTable = schemaStatements.find((statement) =>
      statement.includes("CREATE TABLE IF NOT EXISTS complaint_photos"),
    );
    const createIndex = indexStatements.find((statement) =>
      statement.includes("ON complaint_photos"),
    );
    await db.prepare("DROP TABLE complaint_photos").run();
    if (createTable) await db.prepare(createTable).run();
    if (createIndex) await db.prepare(createIndex).run();
  }
}

/**
 * The demo resident's address. Resend's shared test sender only delivers to the
 * address that owns the account, so DEMO_RESIDENT_EMAIL lets a local preview
 * receive real mail without putting a personal address in the source.
 */
function demoResidentEmail(): string {
  return appEnv.DEMO_RESIDENT_EMAIL?.trim() || "priya@nivasa.local";
}

async function seedDemoData(db: D1Database): Promise<void> {
  const now = new Date();
  const daysAgo = (days: number, hours = 0) =>
    new Date(now.getTime() - (days * 24 + hours) * 60 * 60 * 1000).toISOString();

  const statements = [
    db.prepare("INSERT INTO users (id, email, name, flat_number, phone, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind("demo-admin", "admin@nivasa.local", "Rohan Mehta", "Society Office", "+91 90000 00001", "admin", daysAgo(90), daysAgo(2)),
    db.prepare("INSERT INTO users (id, email, name, flat_number, phone, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind("demo-resident", demoResidentEmail(), "Priya Shah", "A-804", "+91 90000 00002", "resident", daysAgo(62), daysAgo(3)),
  ];

  const complaintRows = [
    ["cmp-lift", "SM-1048", "Lift stops between floors", "Lift", "Tower B lift pauses between the sixth and seventh floors and the doors take several seconds to reopen.", "Tower B · Lift 2", "In Progress", "High", "seed-lift", daysAgo(5, 2), daysAgo(1, 3), null],
    ["cmp-seepage", "SM-1043", "Water seepage near balcony", "Plumbing", "A damp patch is spreading along the balcony wall after the last rainfall.", "A-804", "Open", "Medium", "seed-seepage", daysAgo(2, 4), daysAgo(2, 4), null],
    ["cmp-light", "SM-1038", "Basement light not working", "Electrical", "Two lights beside parking bay P2-18 were not switching on.", "Parking P2", "Resolved", "Low", "seed-light", daysAgo(8), daysAgo(6), daysAgo(6)],
    ["cmp-intercom", "SM-1032", "Intercom has heavy static", "Security", "Visitors are difficult to hear through the lobby intercom.", "Tower A lobby", "Resolved", "Medium", "seed-intercom", daysAgo(12), daysAgo(10), daysAgo(10)],
    ["cmp-parking", "SM-1027", "Parking bay line has faded", "Parking", "The boundary line between P2-18 and P2-19 needs repainting.", "Parking P2", "Resolved", "Low", "seed-parking", daysAgo(20), daysAgo(16), daysAgo(16)],
    ["cmp-waste", "SM-1019", "Waste collection delayed", "Housekeeping", "The dry waste collection was missed twice this week.", "Tower A", "Resolved", "Medium", "seed-waste", daysAgo(25), daysAgo(23), daysAgo(23)],
  ] as const;

  for (const row of complaintRows) {
    const progressAt = new Date(
      new Date(row[9]).getTime() + 24 * 60 * 60 * 1000,
    ).toISOString();
    statements.push(
      db.prepare(`INSERT INTO complaints (
        id, public_id, resident_id, title, category, description, location,
        status, priority, idempotency_key, version, created_at, updated_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        row[0], row[1], "demo-resident", row[2], row[3], row[4], row[5],
        row[6], row[7], row[8], row[6] === "Resolved" ? 3 : row[6] === "In Progress" ? 2 : 1,
        row[9], row[10], row[11],
      ),
    );
    statements.push(
      db.prepare("INSERT INTO complaint_history (id, complaint_id, event_type, from_value, to_value, actor_id, actor_name, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(`${row[0]}-created`, row[0], "created", null, "Open", "demo-resident", "Priya Shah", "Complaint raised by resident", row[9]),
    );
    if (row[6] === "In Progress" || row[6] === "Resolved") {
      statements.push(
        db.prepare("INSERT INTO complaint_history (id, complaint_id, event_type, from_value, to_value, actor_id, actor_name, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .bind(`${row[0]}-progress`, row[0], "status_changed", "Open", "In Progress", "demo-admin", "Rohan Mehta", "Assigned to the maintenance team", progressAt),
      );
    }
    if (row[6] === "Resolved") {
      statements.push(
        db.prepare("INSERT INTO complaint_history (id, complaint_id, event_type, from_value, to_value, actor_id, actor_name, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .bind(`${row[0]}-resolved`, row[0], "status_changed", "In Progress", "Resolved", "demo-admin", "Rohan Mehta", "Work completed and verified", row[11]),
      );
    }
  }

  statements.push(
    db.prepare("INSERT INTO notices (id, title, body, important, created_by, author_name, published_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind("notice-water", "Scheduled water supply interruption", "Water supply will pause from 11:00 AM to 1:30 PM today while the overhead tank is cleaned. Please store only what you need.", 1, "demo-admin", "Community Office", daysAgo(0, 2)),
    db.prepare("INSERT INTO notices (id, title, body, important, created_by, author_name, published_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind("notice-photos", "Independence Day celebration photos are ready", "Thank you to everyone who joined us in the central garden. The community photo album is now available at the society office.", 0, "demo-admin", "Community Office", daysAgo(2)),
    db.prepare("INSERT INTO notices (id, title, body, important, created_by, author_name, published_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind("notice-pest", "Quarterly pest control schedule", "Common-area pest control begins Saturday at 9:00 AM, starting with Tower C and moving clockwise through the complex.", 0, "demo-admin", "Maintenance Desk", daysAgo(6)),
  );

  await db.batch(statements);
  await db.prepare("PRAGMA optimize").run();
}
