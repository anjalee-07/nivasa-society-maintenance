"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";

type Role = "resident" | "admin";
type DemoRole = Role;
type View = "overview" | "complaints" | "notices" | "delivery";
type Status = "Open" | "In Progress" | "Resolved";
type Priority = "Low" | "Medium" | "High";

type HistoryEvent = {
  id: string;
  eventType: string;
  fromValue: string | null;
  toValue: string;
  actorName: string;
  note: string | null;
  createdAt: string;
};

type Complaint = {
  id: string;
  publicId: string;
  residentId: string;
  residentName: string;
  residentEmail: string;
  residentFlat: string | null;
  title: string;
  category: string;
  description: string;
  location: string;
  status: Status;
  priority: Priority;
  version: number;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  isOverdue: boolean;
  history: HistoryEvent[];
  photos: Array<{
    id: string;
    name: string;
    contentType: string;
    sizeBytes: number;
    url: string;
  }>;
};

type Notice = {
  id: string;
  title: string;
  body: string;
  important: boolean;
  authorName: string;
  publishedAt: string;
};

type Delivery = {
  id: string;
  type: string;
  subject: string;
  status: "pending" | "sent" | "failed";
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
  email: string;
};

type BootstrapData = {
  user: {
    id: string;
    email: string;
    name: string;
    flatNumber: string | null;
    phone: string | null;
    role: Role;
    profileComplete: boolean;
    isDemo: boolean;
  };
  settings: {
    overdueDays: number;
    societyName: string;
    societyLocation: string;
  };
  complaints: Complaint[];
  notices: Notice[];
  notifications: Delivery[];
  deliverySummary: { sent: number; pending: number; failed: number };
  emailConfigured: boolean | null;
  dashboard: {
    statusCounts: Record<Status, number>;
    categoryCounts: Record<string, number>;
    overdueCount: number;
  };
  serverNow: string;
};

const categories = [
  "Plumbing",
  "Electrical",
  "Lift",
  "Security",
  "Housekeeping",
  "Parking",
  "Other",
];

export function NivasaApp() {
  const [demoRole, setDemoRole] = useState<DemoRole>(() => {
    if (typeof window === "undefined") return "admin";
    const stored = window.localStorage.getItem("nivasa-demo-role");
    return stored === "resident" ? "resident" : "admin";
  });
  const [view, setView] = useState<View>("overview");
  const [data, setData] = useState<BootstrapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [complaintOpen, setComplaintOpen] = useState(false);
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  // A reviewer arrives on `?admin=<code>`. Redeem it once, strip it from the
  // address bar so the code is not left in history or copied links, then let the
  // normal bootstrap run with the upgraded role.
  const [claiming, setClaiming] = useState(() =>
    typeof window !== "undefined" && new URLSearchParams(window.location.search).has("admin"),
  );

  useEffect(() => {
    if (!claiming) return;
    const params = new URLSearchParams(window.location.search);
    const code = params.get("admin") ?? "";
    params.delete("admin");
    const cleaned = `${window.location.pathname}${params.toString() ? `?${params}` : ""}`;
    window.history.replaceState(null, "", cleaned);
    void fetch("/api/admin-claim", {
      method: "POST",
      // The demo role header is ignored by a hosted deployment, where identity
      // comes from the platform; it keeps the local preview consistent.
      headers: { "Content-Type": "application/json", "x-nivasa-demo-role": demoRole },
      body: JSON.stringify({ code }),
      cache: "no-store",
    })
      .catch(() => null)
      .finally(() => setClaiming(false));
  }, [claiming, demoRole]);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError(null);
    try {
      const result = await requestJson<BootstrapData>("/api/bootstrap", {}, demoRole);
      setData(result);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "The dashboard could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [demoRole]);

  useEffect(() => {
    if (claiming) return;
    let active = true;
    requestJson<BootstrapData>("/api/bootstrap", {}, demoRole)
      .then((result) => {
        if (active) setData(result);
      })
      .catch((loadError) => {
        if (active) setError(messageOf(loadError));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [claiming, demoRole]);

  const changeDemoRole = (role: DemoRole) => {
    window.localStorage.setItem("nivasa-demo-role", role);
    setSelectedId(null);
    setView("overview");
    setData(null);
    setError(null);
    setLoading(true);
    setDemoRole(role);
  };

  const notify = (tone: "success" | "error", text: string) => {
    setToast({ tone, text });
    window.setTimeout(() => setToast(null), 4200);
  };

  if (claiming || (loading && !data)) return <LoadingScreen />;
  if (!data) return <ErrorScreen message={error ?? "Nivasa is unavailable."} onRetry={() => void load()} />;

  const selectedComplaint = data.complaints.find((item) => item.id === selectedId) ?? null;
  const userFirstName = data.user.name.split(/\s+/)[0] || data.user.name;
  const activeCount = data.complaints.filter((item) => item.status !== "Resolved").length;
  const pendingDeliveries = data.deliverySummary.pending + data.deliverySummary.failed;

  const navItems: Array<{ id: View; label: string; count?: number; mark: string }> = data.user.role === "admin"
    ? [
        { id: "overview", label: "Dashboard", mark: "01" },
        { id: "complaints", label: "All complaints", count: activeCount, mark: "02" },
        { id: "notices", label: "Notice board", count: data.notices.length, mark: "03" },
        { id: "delivery", label: "Email delivery", count: pendingDeliveries || undefined, mark: "04" },
      ]
    : [
        { id: "overview", label: "Home", mark: "01" },
        { id: "complaints", label: "My complaints", count: activeCount, mark: "02" },
        { id: "notices", label: "Notice board", count: data.notices.length, mark: "03" },
      ];

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <aside className="app-sidebar">
        <button className="brand" type="button" onClick={() => setView("overview")} aria-label="Nivasa dashboard">
          <span className="brand-mark">N</span>
          <span>Nivasa<small>Society care</small></span>
        </button>

        <div className="society-block">
          <span className="mini-label">Community</span>
          <strong>{data.settings.societyName}</strong>
          <small>{data.settings.societyLocation}</small>
        </div>

        <nav className="side-nav" aria-label="Primary navigation">
          <span className="mini-label nav-label">Workspace</span>
          {navItems.map((item) => (
            <button
              key={item.id}
              className={view === item.id ? "active" : ""}
              type="button"
              onClick={() => setView(item.id)}
            >
              <span className="nav-mark">{item.mark}</span>
              <span>{item.label}</span>
              {item.count != null && <em>{item.count}</em>}
            </button>
          ))}
        </nav>

        <div className="support-card">
          <span className="support-orbit" aria-hidden="true">?</span>
          <strong>Need urgent help?</strong>
          <p>Call the 24-hour society desk for safety-critical issues.</p>
          <a href="tel:+918000012345">+91 80000 12345</a>
        </div>

        {data.user.isDemo && (
          <div className="demo-switch" aria-label="Local demo role">
            <span className="mini-label">Preview role</span>
            <div>
              <button type="button" className={demoRole === "resident" ? "active" : ""} onClick={() => changeDemoRole("resident")}>Resident</button>
              <button type="button" className={demoRole === "admin" ? "active" : ""} onClick={() => changeDemoRole("admin")}>Admin</button>
            </div>
          </div>
        )}

        <div className="account-card">
          <span className="avatar">{initials(data.user.name)}</span>
          <span><strong>{data.user.name}</strong><small>{data.user.role === "admin" ? "Society administrator" : `Resident · ${data.user.flatNumber ?? "Profile pending"}`}</small></span>
          {!data.user.isDemo && <a href="/signout-with-chatgpt?return_to=%2F" aria-label="Sign out">↗</a>}
        </div>
      </aside>

      <main className="app-main" id="main-content">
        <header className="topbar">
          <div>
            <span className="mobile-brand"><i>N</i>Nivasa</span>
            <p className="eyebrow">{formatLongDate(data.serverNow)}</p>
            <h1>{viewTitle(view, data.user.role, userFirstName)}</h1>
            <p>{viewSubtitle(view, data.user.role)}</p>
          </div>
          <div className="top-actions">
            {data.user.role === "admin" && view === "overview" && (
              <button className="quiet-button" type="button" onClick={() => setSettingsOpen(true)}>
                Overdue after {data.settings.overdueDays} days
              </button>
            )}
            {data.user.role === "resident" ? (
              <button className="primary-button" type="button" onClick={() => setComplaintOpen(true)}><span>＋</span> Raise a complaint</button>
            ) : (
              <button className="primary-button" type="button" onClick={() => setNoticeOpen(true)}><span>＋</span> Post notice</button>
            )}
          </div>
        </header>

        {error && <div className="inline-alert error"><span>!</span>{error}<button type="button" onClick={() => setError(null)}>Dismiss</button></div>}

        {view === "overview" && data.user.role === "resident" && (
          <ResidentOverview
            data={data}
            onRaise={() => setComplaintOpen(true)}
            onOpenComplaint={setSelectedId}
            onViewComplaints={() => setView("complaints")}
            onViewNotices={() => setView("notices")}
          />
        )}
        {view === "overview" && data.user.role === "admin" && (
          <AdminOverview
            data={data}
            onOpenComplaint={setSelectedId}
            onViewComplaints={() => setView("complaints")}
            onSettings={() => setSettingsOpen(true)}
          />
        )}
        {view === "complaints" && (
          <ComplaintsView data={data} onOpenComplaint={setSelectedId} onRaise={() => setComplaintOpen(true)} />
        )}
        {view === "notices" && (
          <NoticesView
            data={data}
            onCompose={() => setNoticeOpen(true)}
            onDelete={async (id) => {
              try {
                await requestJson("/api/notices", {
                  method: "DELETE",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ id }),
                }, demoRole);
                await load(true);
                notify("success", "Notice removed from the board.");
              } catch (deleteError) {
                notify("error", messageOf(deleteError));
              }
            }}
          />
        )}
        {view === "delivery" && data.user.role === "admin" && (
          <DeliveryView
            deliveries={data.notifications}
            summary={data.deliverySummary}
            emailConfigured={data.emailConfigured}
            onRetryAll={async () => {
              try {
                const result = await requestJson<{ sent: number; pending: number; failed: number; remaining: number }>("/api/notifications", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({}),
                }, demoRole);
                await load(true);
                if (result.sent > 0) {
                  notify("success", `${result.sent} email${result.sent === 1 ? "" : "s"} delivered.${result.remaining ? ` ${result.remaining} still queued — run this again to continue.` : ""}`);
                } else {
                  notify("error", result.pending > 0 ? "Email is still waiting for provider configuration." : "No messages could be delivered.");
                }
              } catch (drainError) {
                notify("error", messageOf(drainError));
              }
            }}
            onRetry={async (id) => {
              try {
                const result = await requestJson<{ status: string }>("/api/notifications", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ id }),
                }, demoRole);
                await load(true);
                notify(result.status === "sent" ? "success" : "error", result.status === "sent" ? "Email delivered." : "Email is still waiting for provider configuration.");
              } catch (retryError) {
                notify("error", messageOf(retryError));
              }
            }}
          />
        )}
      </main>

      {selectedComplaint && (
        <ComplaintDrawer
          complaint={selectedComplaint}
          role={data.user.role}
          demoRole={demoRole}
          onClose={() => setSelectedId(null)}
          onUpdated={async (message) => {
            await load(true);
            setSelectedId(null);
            notify("success", message);
          }}
          onError={(message) => notify("error", message)}
        />
      )}
      {complaintOpen && (
        <NewComplaintModal
          userFlat={data.user.flatNumber ?? ""}
          demoRole={demoRole}
          onClose={() => setComplaintOpen(false)}
          onCreated={async (publicId) => {
            setComplaintOpen(false);
            await load(true);
            notify("success", `${publicId} was raised and is now visible to the society team.`);
          }}
          onError={(message) => notify("error", message)}
        />
      )}
      {noticeOpen && data.user.role === "admin" && (
        <NoticeComposer
          demoRole={demoRole}
          onClose={() => setNoticeOpen(false)}
          onCreated={async (message) => {
            setNoticeOpen(false);
            await load(true);
            notify("success", message);
          }}
          onError={(message) => notify("error", message)}
        />
      )}
      {settingsOpen && data.user.role === "admin" && (
        <SettingsModal
          currentDays={data.settings.overdueDays}
          demoRole={demoRole}
          onClose={() => setSettingsOpen(false)}
          onSaved={async () => {
            setSettingsOpen(false);
            await load(true);
            notify("success", "Overdue rules updated across the dashboard.");
          }}
          onError={(message) => notify("error", message)}
        />
      )}
      {!data.user.profileComplete && (
        <ProfileModal
          user={data.user}
          demoRole={demoRole}
          onSaved={async () => {
            await load(true);
            notify("success", "Your resident profile is ready.");
          }}
          onError={(message) => notify("error", message)}
        />
      )}
      {toast && <div className={`toast ${toast.tone}`} role="status"><span>{toast.tone === "success" ? "✓" : "!"}</span>{toast.text}</div>}
    </div>
  );
}

function ResidentOverview({
  data,
  onRaise,
  onOpenComplaint,
  onViewComplaints,
  onViewNotices,
}: {
  data: BootstrapData;
  onRaise: () => void;
  onOpenComplaint: (id: string) => void;
  onViewComplaints: () => void;
  onViewNotices: () => void;
}) {
  const active = data.complaints.filter((item) => item.status !== "Resolved");
  const important = data.notices.find((notice) => notice.important);

  return (
    <div className="page-stack">
      {important && (
        <button className="important-strip" type="button" onClick={onViewNotices}>
          <span className="notice-bang">!</span>
          <span><small>Important community notice</small><strong>{important.title}</strong></span>
          <em>{timeAgo(important.publishedAt, data.serverNow)} · View notice →</em>
        </button>
      )}

      <section className="resident-hero">
        <div>
          <span className="eyebrow light">Your maintenance requests</span>
          <h2>{active.length === 0 ? "You have no active requests." : `You have ${active.length} active ${active.length === 1 ? "request" : "requests"}.`}</h2>
          <p>Track updates from the society team and review the complete history of each request.</p>
          <button type="button" onClick={onRaise}>Raise a new complaint <span>→</span></button>
        </div>
        <div className="request-summary" aria-label="Your requests by status">
          <div className="request-summary-head">
            <span>Request summary</span>
            <strong>{data.complaints.length}<small>Total</small></strong>
          </div>
          <div className="request-status-list">
            <div className="request-status-row open"><span><i className="blue-dot" />Open</span><strong>{data.dashboard.statusCounts.Open}</strong></div>
            <div className="request-status-row progress"><span><i className="amber-dot" />In progress</span><strong>{data.dashboard.statusCounts["In Progress"]}</strong></div>
            <div className="request-status-row resolved"><span><i className="green-dot" />Resolved</span><strong>{data.dashboard.statusCounts.Resolved}</strong></div>
          </div>
          <p>Updated as the society team moves each request forward.</p>
        </div>
      </section>

      <section className="resident-grid">
        <div className="surface-card recent-card">
          <SectionHeading eyebrow="Live requests" title="Your recent complaints" action="View all" onAction={onViewComplaints} />
          <div className="compact-list">
            {data.complaints.slice(0, 4).map((complaint) => (
              <ComplaintRow key={complaint.id} complaint={complaint} onOpen={() => onOpenComplaint(complaint.id)} />
            ))}
            {!data.complaints.length && <EmptyState title="No complaints yet" body="When something needs attention, raise it here and track every update." action="Raise complaint" onAction={onRaise} />}
          </div>
        </div>
        <div className="surface-card notice-preview">
          <SectionHeading eyebrow="Around the society" title="Notice board" action="See all" onAction={onViewNotices} />
          {data.notices[0] ? (
            <article>
              <time>{formatShortDate(data.notices[0].publishedAt)}</time>
              <h3>{data.notices[0].title}</h3>
              <p>{data.notices[0].body}</p>
              <footer><span>{data.notices[0].authorName}</span><span>{readingTime(data.notices[0].body)} min read</span></footer>
            </article>
          ) : <EmptyState title="The board is quiet" body="New society notices will appear here." />}
        </div>
      </section>
    </div>
  );
}

function AdminOverview({
  data,
  onOpenComplaint,
  onViewComplaints,
  onSettings,
}: {
  data: BootstrapData;
  onOpenComplaint: (id: string) => void;
  onViewComplaints: () => void;
  onSettings: () => void;
}) {
  const total = data.complaints.length;
  const openTotal = data.dashboard.statusCounts.Open + data.dashboard.statusCounts["In Progress"];
  const maxCategory = Math.max(1, ...Object.values(data.dashboard.categoryCounts));
  const overdue = data.complaints.filter((item) => item.isOverdue);

  return (
    <div className="page-stack admin-dashboard">
      {overdue.length > 0 && (
        <button className="overdue-banner" type="button" onClick={onViewComplaints}>
          <span className="overdue-icon">!</span>
          <span><strong>{overdue.length} overdue {overdue.length === 1 ? "complaint needs" : "complaints need"} attention</strong><small>Oldest open request: {daysOpen(overdue[overdue.length - 1].createdAt, data.serverNow)} days</small></span>
          <em>Review queue →</em>
        </button>
      )}

      <section className="metric-grid" aria-label="Complaint summary">
        <MetricCard label="Total complaints" value={total} detail="All recorded requests" tone="ink" />
        <MetricCard label="Active queue" value={openTotal} detail={`${data.dashboard.statusCounts.Open} waiting to start`} tone="blue" />
        <MetricCard label="Resolved" value={data.dashboard.statusCounts.Resolved} detail={`${total ? Math.round((data.dashboard.statusCounts.Resolved / total) * 100) : 0}% completion rate`} tone="green" />
        <MetricCard label="Overdue" value={data.dashboard.overdueCount} detail={`Threshold · ${data.settings.overdueDays} days`} tone="amber" onClick={onSettings} />
      </section>

      <section className="analytics-grid">
        <article className="surface-card status-analytics">
          <SectionHeading eyebrow="Workload" title="Status overview" />
          <div className="status-chart">
            <div className="stacked-bar" aria-label="Complaints by status">
              <i className="open" style={{ flex: data.dashboard.statusCounts.Open || 0.2 }} />
              <i className="progress" style={{ flex: data.dashboard.statusCounts["In Progress"] || 0.2 }} />
              <i className="resolved" style={{ flex: data.dashboard.statusCounts.Resolved || 0.2 }} />
            </div>
            <div className="status-totals">
              <span><i className="blue-dot" /><strong>{data.dashboard.statusCounts.Open}</strong><small>Open</small></span>
              <span><i className="amber-dot" /><strong>{data.dashboard.statusCounts["In Progress"]}</strong><small>In progress</small></span>
              <span><i className="green-dot" /><strong>{data.dashboard.statusCounts.Resolved}</strong><small>Resolved</small></span>
            </div>
          </div>
        </article>

        <article className="surface-card category-analytics">
          <SectionHeading eyebrow="Patterns" title="Complaints by category" />
          <div className="category-bars">
            {Object.entries(data.dashboard.categoryCounts)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 5)
              .map(([category, count]) => (
                <div key={category}>
                  <span>{category}</span>
                  <i><b style={{ width: `${Math.max(9, (count / maxCategory) * 100)}%` }} /></i>
                  <strong>{count}</strong>
                </div>
              ))}
          </div>
        </article>
      </section>

      <section className="surface-card queue-card">
        <SectionHeading eyebrow="Priority queue" title="Complaints needing action" action="View complete queue" onAction={onViewComplaints} />
        <div className="admin-table" role="table" aria-label="Priority complaints">
          <div className="table-head" role="row"><span>Complaint</span><span>Resident</span><span>Priority</span><span>Status</span><span>Age</span><span /></div>
          {data.complaints.filter((item) => item.status !== "Resolved").slice(0, 6).map((complaint) => (
            <button className="table-row" role="row" type="button" key={complaint.id} onClick={() => onOpenComplaint(complaint.id)}>
              <span><small>{complaint.publicId} · {complaint.category}</small><strong>{complaint.title}</strong></span>
              <span><strong>{complaint.residentName}</strong><small>{complaint.residentFlat ?? complaint.location}</small></span>
              <span><PriorityBadge value={complaint.priority} /></span>
              <span><StatusBadge value={complaint.status} overdue={complaint.isOverdue} /></span>
              <span><strong>{daysOpen(complaint.createdAt, data.serverNow)}d</strong><small>{complaint.isOverdue ? "Overdue" : "Open"}</small></span>
              <span className="row-arrow">→</span>
            </button>
          ))}
          {!data.complaints.some((item) => item.status !== "Resolved") && <EmptyState title="Queue cleared" body="There are no active maintenance complaints." />}
        </div>
      </section>
    </div>
  );
}

function ComplaintsView({
  data,
  onOpenComplaint,
  onRaise,
}: {
  data: BootstrapData;
  onOpenComplaint: (id: string) => void;
  onRaise: () => void;
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("All");
  const [category, setCategory] = useState("All");
  const [age, setAge] = useState("All");

  const filtered = useMemo(() => data.complaints.filter((complaint) => {
    const matchesQuery = !query || `${complaint.publicId} ${complaint.title} ${complaint.residentName} ${complaint.location}`.toLowerCase().includes(query.toLowerCase());
    const matchesStatus = status === "All" || complaint.status === status || (status === "Overdue" && complaint.isOverdue);
    const matchesCategory = category === "All" || complaint.category === category;
    const maxAge = age === "7 days" ? 7 : age === "30 days" ? 30 : Infinity;
    const matchesAge = daysOpen(complaint.createdAt, data.serverNow) <= maxAge;
    return matchesQuery && matchesStatus && matchesCategory && matchesAge;
  }), [age, category, data.complaints, data.serverNow, query, status]);

  return (
    <section className="surface-card complaints-page">
      <div className="filter-row">
        <label className="search-field"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={data.user.role === "admin" ? "Search complaint, resident or flat" : "Search your complaints"} /></label>
        <FilterSelect label="Status" value={status} onChange={setStatus} options={["All", "Open", "In Progress", "Resolved", ...(data.user.role === "admin" ? ["Overdue"] : [])]} />
        <FilterSelect label="Category" value={category} onChange={setCategory} options={["All", ...categories]} />
        <FilterSelect label="Raised" value={age} onChange={setAge} options={["All", "7 days", "30 days"]} />
      </div>
      <div className="result-count"><strong>{filtered.length}</strong> {filtered.length === 1 ? "complaint" : "complaints"}<span>{data.user.role === "admin" ? "Overdue requests are kept at the top." : "Select a request to view its full timeline."}</span></div>
      <div className="complaint-cards">
        {filtered.map((complaint) => (
          <button className="complaint-card" type="button" key={complaint.id} onClick={() => onOpenComplaint(complaint.id)}>
            <span className={`category-tile ${slug(complaint.category)}`}>{complaint.category.slice(0, 2).toUpperCase()}</span>
            <span className="complaint-copy"><small>{complaint.publicId} · {formatShortDate(complaint.createdAt)}</small><strong>{complaint.title}</strong><em>{complaint.location}{data.user.role === "admin" ? ` · ${complaint.residentName}` : ""}</em></span>
            <span className="complaint-state"><PriorityBadge value={complaint.priority} /><StatusBadge value={complaint.status} overdue={data.user.role === "admin" && complaint.isOverdue} /></span>
            <span className="complaint-age"><strong>{daysOpen(complaint.createdAt, data.serverNow)}d</strong><small>{complaint.status === "Resolved" ? "to close" : "open"}</small></span>
            <span className="row-arrow">→</span>
          </button>
        ))}
        {!filtered.length && <EmptyState title="No matching complaints" body="Try changing the filters or search terms." action={data.user.role === "resident" ? "Raise a complaint" : undefined} onAction={data.user.role === "resident" ? onRaise : undefined} />}
      </div>
    </section>
  );
}

function NoticesView({
  data,
  onCompose,
  onDelete,
}: {
  data: BootstrapData;
  onCompose: () => void;
  onDelete: (id: string) => void;
}) {
  const important = data.notices.filter((notice) => notice.important);
  const regular = data.notices.filter((notice) => !notice.important);
  return (
    <div className="page-stack notices-page">
      {important.map((notice) => (
        <article className="pinned-notice" key={notice.id}>
          <div><span className="pin-label">Pinned · Important</span><h2>{notice.title}</h2><p>{notice.body}</p></div>
          <footer><span>{notice.authorName}</span><time>{formatDateTime(notice.publishedAt)}</time>{data.user.role === "admin" && <button type="button" onClick={() => onDelete(notice.id)}>Remove</button>}</footer>
        </article>
      ))}
      <section className="notice-grid">
        {regular.map((notice) => (
          <article className="notice-item" key={notice.id}>
            <time>{formatShortDate(notice.publishedAt)}</time>
            <h3>{notice.title}</h3>
            <p>{notice.body}</p>
            <footer><span>{notice.authorName}</span><span>{readingTime(notice.body)} min read</span>{data.user.role === "admin" && <button type="button" onClick={() => onDelete(notice.id)}>Remove</button>}</footer>
          </article>
        ))}
        {!data.notices.length && <EmptyState title="No notices yet" body="Community updates will be published here." action={data.user.role === "admin" ? "Post first notice" : undefined} onAction={data.user.role === "admin" ? onCompose : undefined} />}
      </section>
    </div>
  );
}

function DeliveryView({
  deliveries,
  summary,
  emailConfigured,
  onRetry,
  onRetryAll,
}: {
  deliveries: Delivery[];
  summary: { sent: number; pending: number; failed: number };
  emailConfigured: boolean | null;
  onRetry: (id: string) => void;
  onRetryAll: () => Promise<void>;
}) {
  const [draining, setDraining] = useState(false);
  const outstanding = summary.pending + summary.failed;
  const runDrain = async () => {
    setDraining(true);
    try {
      await onRetryAll();
    } finally {
      setDraining(false);
    }
  };
  return (
    <div className="page-stack delivery-page">
      <div className="delivery-summary">
        <MetricCard label="Sent" value={summary.sent} detail="Delivered by the email provider" tone="green" />
        <MetricCard label="Queued" value={summary.pending} detail="Waiting for provider configuration" tone="blue" />
        <MetricCard label="Failed" value={summary.failed} detail="Available for a safe retry" tone="amber" />
      </div>
      {emailConfigured === false && (
        <div className="inline-alert error email-setup-alert">
          <span>!</span>
          <div>
            <strong>Email delivery is not configured.</strong>
            <p>
              Set <code>RESEND_API_KEY</code> and a verified <code>EMAIL_FROM</code> address in this
              environment. Messages stay queued with their retry budget intact until then, so nothing
              is lost — send them with <em>Send all queued</em> once setup is complete.
            </p>
          </div>
        </div>
      )}
      <section className="surface-card delivery-card">
        <SectionHeading eyebrow="Notification outbox" title="Email delivery activity" />
        {outstanding > 0 && (
          <div className="drain-row">
            <p>
              <strong>{outstanding}</strong> {outstanding === 1 ? "message is" : "messages are"} waiting to be delivered.
              {deliveries.length < outstanding && " Only the most recent activity is listed below."}
            </p>
            <button className="primary-button" type="button" disabled={draining} onClick={() => void runDrain()}>
              {draining ? "Sending…" : "Send all queued"}
            </button>
          </div>
        )}
        <div className="delivery-list">
          {deliveries.map((item) => (
            <article key={item.id}>
              <span className={`delivery-mark ${item.status}`}>{item.status === "sent" ? "✓" : item.status === "failed" ? "!" : "…"}</span>
              <div><small>{item.type.replaceAll("_", " ")} · {formatDateTime(item.createdAt)}</small><strong>{item.subject}</strong><p>To {item.email}</p>{item.lastError && <em>{item.lastError}</em>}</div>
              <StatusPill value={item.status} />
              {item.status !== "sent" && <button type="button" onClick={() => onRetry(item.id)}>Retry</button>}
            </article>
          ))}
          {!deliveries.length && <EmptyState title="No email activity yet" body="Status updates and important notices will appear here." />}
        </div>
      </section>
    </div>
  );
}

function ComplaintDrawer({
  complaint,
  role,
  demoRole,
  onClose,
  onUpdated,
  onError,
}: {
  complaint: Complaint;
  role: Role;
  demoRole: DemoRole;
  onClose: () => void;
  onUpdated: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [status, setStatus] = useState<Status>(complaint.status);
  const [priority, setPriority] = useState<Priority>(complaint.priority);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const closed = complaint.status === "Resolved";

  useEscape(onClose);
  const save = async () => {
    setSaving(true);
    try {
      await requestJson("/api/complaints", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: complaint.id,
          status,
          priority,
          note,
          expectedVersion: complaint.version,
        }),
      }, demoRole);
      await onUpdated(`${complaint.publicId} was updated successfully.`);
    } catch (saveError) {
      onError(messageOf(saveError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className="complaint-drawer" role="dialog" aria-modal="true" aria-labelledby="complaint-title">
        <header className="drawer-head">
          <div><small>{complaint.publicId} · Raised {formatDateTime(complaint.createdAt)}</small><h2 id="complaint-title">{complaint.title}</h2></div>
          <button type="button" onClick={onClose} aria-label="Close complaint details">×</button>
        </header>
        <div className="drawer-body">
          <div className="drawer-badges"><StatusBadge value={complaint.status} overdue={role === "admin" && complaint.isOverdue} /><PriorityBadge value={complaint.priority} /><span className="plain-pill">{complaint.category}</span></div>
          {role === "admin" && complaint.isOverdue && <div className="drawer-overdue"><strong>Overdue by {Math.max(1, daysOpen(complaint.createdAt, new Date().toISOString()))} days</strong><span>This unresolved request has crossed the society threshold.</span></div>}
          <section className="detail-section">
            <span className="mini-label">Complaint details</span>
            <p>{complaint.description}</p>
            <dl><div><dt>Location</dt><dd>{complaint.location}</dd></div><div><dt>Resident</dt><dd>{complaint.residentName} · {complaint.residentFlat ?? "—"}</dd></div><div><dt>Last updated</dt><dd>{formatDateTime(complaint.updatedAt)}</dd></div></dl>
          </section>
          {complaint.photos.length > 0 && (
            <section className="detail-section">
              <span className="mini-label">Supporting photo</span>
              {/* Authenticated complaint media intentionally bypasses the public image optimizer. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="complaint-photo" src={complaint.photos[0].url} alt={`Supporting evidence for ${complaint.title}`} />
            </section>
          )}
          {role === "admin" && (
            <section className="admin-update-panel">
              <div><span className="mini-label">Admin workflow</span><h3>{closed ? "Complaint closed" : "Update this complaint"}</h3></div>
              {closed ? <p>Resolved complaints are preserved as closed records and cannot be changed.</p> : (
                <>
                  <div className="field-pair">
                    <label><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value as Status)}><option>Open</option><option>In Progress</option><option>Resolved</option></select></label>
                    <label><span>Priority</span><select value={priority} onChange={(event) => setPriority(event.target.value as Priority)}><option>Low</option><option>Medium</option><option>High</option></select></label>
                  </div>
                  <label className="full-field"><span>Update note <em>optional</em></span><textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} placeholder="Tell the resident what changed or what happens next." /></label>
                  <button className="primary-button full" type="button" disabled={saving || (status === complaint.status && priority === complaint.priority)} onClick={() => void save()}>{saving ? "Saving update…" : "Save and notify resident"}</button>
                </>
              )}
            </section>
          )}
          <section className="timeline-section">
            <span className="mini-label">Complete activity</span>
            <h3>Status history</h3>
            <div className="timeline">
              {complaint.history.map((event, index) => (
                <article key={event.id}>
                  <span className={`timeline-dot ${index === 0 ? "latest" : ""}`} />
                  <div><strong>{historyTitle(event)}</strong><small>{formatDateTime(event.createdAt)} · {event.actorName}</small>{event.note && <p>{event.note}</p>}</div>
                </article>
              ))}
            </div>
          </section>
        </div>
      </aside>
    </div>
  );
}

function NewComplaintModal({
  userFlat,
  demoRole,
  onClose,
  onCreated,
  onError,
}: {
  userFlat: string;
  demoRole: DemoRole;
  onClose: () => void;
  onCreated: (publicId: string) => void;
  onError: (message: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("Plumbing");
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState(userFlat);
  const [photo, setPhoto] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const preview = useMemo(() => photo ? URL.createObjectURL(photo) : null, [photo]);

  useEscape(onClose);
  useEffect(() => {
    return () => { if (preview) URL.revokeObjectURL(preview); };
  }, [preview]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    try {
      const form = new FormData();
      form.set("title", title);
      form.set("category", category);
      form.set("description", description);
      form.set("location", location);
      form.set("idempotencyKey", idempotencyKey);
      if (photo) form.set("photo", photo);
      const result = await requestJson<{ publicId: string }>("/api/complaints", { method: "POST", body: form }, demoRole);
      await onCreated(result.publicId);
    } catch (submitError) {
      onError(messageOf(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalShell title="Raise a maintenance complaint" eyebrow="New resident request" onClose={onClose}>
      <form className="modal-form" onSubmit={submit}>
        <div className="field-pair">
          <label><span>Short title</span><input required minLength={4} maxLength={90} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Water leak under kitchen sink" /></label>
          <label><span>Category</span><select value={category} onChange={(event) => setCategory(event.target.value)}>{categories.map((item) => <option key={item}>{item}</option>)}</select></label>
        </div>
        <label className="full-field"><span>Description</span><textarea required minLength={12} maxLength={1200} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Describe what is happening, when it started, and anything the maintenance team should know." /><small>{description.length}/1200</small></label>
        <label className="full-field"><span>Location</span><input required minLength={2} maxLength={80} value={location} onChange={(event) => setLocation(event.target.value)} placeholder="Flat, tower, floor, or common area" /></label>
        <label className={`photo-drop ${preview ? "has-photo" : ""}`}>
          {preview ? (
            <>
              {/* Local object URL preview; it cannot use the framework image optimizer. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={preview} alt="Selected complaint preview" />
            </>
          ) : <span className="upload-mark">＋</span>}
          <span><strong>{photo ? photo.name : "Add a supporting photo"}</strong><small>JPG, PNG, or WebP · up to 2 MB</small></span>
          <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setPhoto(event.target.files?.[0] ?? null)} />
          {photo && <button type="button" onClick={(event) => { event.preventDefault(); setPhoto(null); }}>Remove</button>}
        </label>
        <div className="modal-actions"><button className="quiet-button" type="button" onClick={onClose}>Cancel</button><button className="primary-button" type="submit" disabled={submitting}>{submitting ? "Raising complaint…" : "Raise complaint"}</button></div>
      </form>
    </ModalShell>
  );
}

function NoticeComposer({ demoRole, onClose, onCreated, onError }: { demoRole: DemoRole; onClose: () => void; onCreated: (message: string) => void; onError: (message: string) => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [important, setImportant] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  useEscape(onClose);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    try {
      const result = await requestJson<{ notifiedResidents: number }>("/api/notices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, body, important }),
      }, demoRole);
      const message = important
        ? `Important notice pinned. ${result.notifiedResidents} resident email${result.notifiedResidents === 1 ? "" : "s"} queued — track delivery in the email center.`
        : "Notice published to the community board.";
      await onCreated(message);
    } catch (submitError) {
      onError(messageOf(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalShell title="Post a community notice" eyebrow="Admin announcement" onClose={onClose}>
      <form className="modal-form" onSubmit={submit}>
        <label className="full-field"><span>Notice title</span><input required minLength={4} maxLength={110} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="What should residents know?" /></label>
        <label className="full-field"><span>Details</span><textarea required minLength={12} maxLength={1800} value={body} onChange={(event) => setBody(event.target.value)} placeholder="Include dates, timings, affected areas, and any action residents should take." /><small>{body.length}/1800</small></label>
        <label className="important-toggle" htmlFor="notice-important" aria-label="Mark this notice as important"><input id="notice-important" type="checkbox" checked={important} onChange={(event) => setImportant(event.target.checked)} /><span><strong>Mark as important</strong><small>Pin this notice to the top and create an email for every registered resident.</small></span></label>
        <div className="modal-actions"><button className="quiet-button" type="button" onClick={onClose}>Cancel</button><button className="primary-button" type="submit" disabled={submitting}>{submitting ? "Publishing…" : "Publish notice"}</button></div>
      </form>
    </ModalShell>
  );
}

function SettingsModal({ currentDays, demoRole, onClose, onSaved, onError }: { currentDays: number; demoRole: DemoRole; onClose: () => void; onSaved: () => void; onError: (message: string) => void }) {
  const [days, setDays] = useState(currentDays);
  const [saving, setSaving] = useState(false);
  useEscape(onClose);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await requestJson("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ overdueDays: days }) }, demoRole);
      await onSaved();
    } catch (saveError) {
      onError(messageOf(saveError));
    } finally { setSaving(false); }
  };
  return (
    <ModalShell title="Overdue detection" eyebrow="Society workflow settings" onClose={onClose}>
      <form className="modal-form" onSubmit={submit}>
        <div className="setting-explainer"><span>Clock</span><p>Any unresolved complaint is flagged once it has remained open for this many complete days. Resolved complaints are never overdue.</p></div>
        <label className="full-field"><span>Overdue threshold</span><div className="number-field"><input type="number" min={1} max={60} step={1} value={days} onChange={(event) => setDays(Number(event.target.value))} /><em>days</em></div></label>
        <div className="modal-actions"><button className="quiet-button" type="button" onClick={onClose}>Cancel</button><button className="primary-button" type="submit" disabled={saving}>{saving ? "Saving…" : "Save rule"}</button></div>
      </form>
    </ModalShell>
  );
}

function ProfileModal({ user, demoRole, onSaved, onError }: { user: BootstrapData["user"]; demoRole: DemoRole; onSaved: () => void; onError: (message: string) => void }) {
  const [name, setName] = useState(user.name);
  const [flatNumber, setFlatNumber] = useState(user.flatNumber ?? "");
  const [phone, setPhone] = useState(user.phone ?? "");
  const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await requestJson("/api/profile", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, flatNumber, phone }) }, demoRole);
      await onSaved();
    } catch (saveError) {
      onError(messageOf(saveError));
    } finally { setSaving(false); }
  };
  return (
    <div className="modal-backdrop onboarding-backdrop">
      <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="profile-title">
        <div className="onboarding-mark">N</div>
        <div className="modal-head"><div><span className="eyebrow">One last step</span><h2 id="profile-title">Set up your resident profile</h2><p>This links future maintenance requests to the right home and contact details.</p></div></div>
        <form className="modal-form" onSubmit={submit}>
          <label className="full-field"><span>Full name</span><input required minLength={2} maxLength={70} value={name} onChange={(event) => setName(event.target.value)} /></label>
          <div className="field-pair"><label><span>Flat number</span><input required minLength={2} maxLength={30} value={flatNumber} onChange={(event) => setFlatNumber(event.target.value)} placeholder="A-804" /></label><label><span>Phone <em>optional</em></span><input maxLength={24} value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="+91 98765 43210" /></label></div>
          <button className="primary-button full" type="submit" disabled={saving}>{saving ? "Creating profile…" : "Enter Nivasa"}</button>
        </form>
      </section>
    </div>
  );
}

function ModalShell({ title, eyebrow, onClose, children }: { title: string; eyebrow: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div className="modal-head"><div><span className="eyebrow">{eyebrow}</span><h2 id="modal-title">{title}</h2></div><button type="button" onClick={onClose} aria-label="Close dialog">×</button></div>
        {children}
      </section>
    </div>
  );
}

function MetricCard({ label, value, detail, tone, onClick }: { label: string; value: number; detail: string; tone: string; onClick?: () => void }) {
  const content = <><span className={`metric-mark ${tone}`} /><small>{label}</small><strong>{value}</strong><p>{detail}</p>{onClick && <em>Configure →</em>}</>;
  return onClick ? <button className="metric-card" type="button" onClick={onClick}>{content}</button> : <article className="metric-card">{content}</article>;
}

function ComplaintRow({ complaint, onOpen }: { complaint: Complaint; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen}>
      <span className={`row-accent ${statusTone(complaint.status)}`} />
      <span><small>{complaint.publicId}</small><strong>{complaint.title}</strong><em>{complaint.location}</em></span>
      <StatusBadge value={complaint.status} />
      <span className="row-arrow">→</span>
    </button>
  );
}

function SectionHeading({ eyebrow, title, action, onAction }: { eyebrow: string; title: string; action?: string; onAction?: () => void }) {
  return <div className="section-heading"><div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2></div>{action && <button type="button" onClick={onAction}>{action} →</button>}</div>;
}

function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: string[] }) {
  return <label className="filter-select"><span>{label}</span><select value={value} onChange={(event) => onChange(event.target.value)}>{options.map((item) => <option key={item}>{item}</option>)}</select></label>;
}

function StatusBadge({ value, overdue = false }: { value: Status; overdue?: boolean }) {
  return <span className={`status-badge ${statusTone(value)} ${overdue ? "overdue" : ""}`}><i />{overdue ? "Overdue" : value}</span>;
}

function PriorityBadge({ value }: { value: Priority }) {
  return <span className={`priority-badge ${value.toLowerCase()}`}><i />{value}</span>;
}

function StatusPill({ value }: { value: string }) {
  return <span className={`delivery-pill ${value}`}>{value}</span>;
}

function EmptyState({ title, body, action, onAction }: { title: string; body: string; action?: string; onAction?: () => void }) {
  return <div className="empty-state"><span>○</span><strong>{title}</strong><p>{body}</p>{action && <button type="button" onClick={onAction}>{action}</button>}</div>;
}

function LoadingScreen() {
  return <main className="loading-screen"><span className="loading-mark">N</span><div><strong>Preparing your society workspace</strong><i /></div></main>;
}

function ErrorScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  const needsSignIn = message.toLowerCase().includes("sign in");
  return <main className="error-screen"><span>!</span><h1>We could not open Nivasa.</h1><p>{message}</p>{needsSignIn ? <a className="primary-button" href="/signin-with-chatgpt?return_to=%2F">Sign in to continue</a> : <button className="primary-button" type="button" onClick={onRetry}>Try again</button>}</main>;
}

async function requestJson<T = { ok: boolean }>(path: string, init: RequestInit, demoRole: DemoRole): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("x-nivasa-demo-role", demoRole);
  const response = await fetch(path, { ...init, headers, cache: "no-store" });
  const body = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) throw new Error(body.error || "The request could not be completed.");
  return body;
}

function useEscape(onClose: () => void) {
  useEffect(() => {
    const listener = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [onClose]);
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function viewTitle(view: View, role: Role, firstName: string): string {
  if (view === "overview") return role === "admin" ? "Maintenance command center" : `Good morning, ${firstName}.`;
  if (view === "complaints") return role === "admin" ? "Complaint queue" : "My complaints";
  if (view === "notices") return "Community notice board";
  return "Email delivery center";
}

function viewSubtitle(view: View, role: Role): string {
  if (view === "overview") return role === "admin" ? "See what is waiting, what is late, and where the team should focus next." : "Here is what is happening around your home today.";
  if (view === "complaints") return role === "admin" ? "Filter, prioritize, and move every request through a transparent workflow." : "Every request, update, and resolution in one continuous timeline.";
  if (view === "notices") return role === "admin" ? "Keep residents informed with pinned updates and important email alerts." : "Updates and essential information from your society team.";
  return "Inspect queued, sent, and failed resident emails without losing an update.";
}

function statusTone(status: Status): string {
  return status === "Open" ? "blue" : status === "In Progress" ? "amber" : "green";
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "The request could not be completed.";
}

function formatLongDate(value: string): string {
  return new Intl.DateTimeFormat("en-IN", { weekday: "long", day: "numeric", month: "long" }).format(new Date(value));
}

function formatShortDate(value: string): string {
  return new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(value)).toUpperCase();
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function timeAgo(value: string, now: string): string {
  const hours = Math.max(0, Math.floor((new Date(now).getTime() - new Date(value).getTime()) / 3600000));
  if (hours < 1) return "Just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function daysOpen(value: string, now: string): number {
  return Math.max(0, Math.floor((new Date(now).getTime() - new Date(value).getTime()) / 86400000));
}

function readingTime(value: string): number {
  return Math.max(1, Math.ceil(value.trim().split(/\s+/).length / 180));
}

function historyTitle(event: HistoryEvent): string {
  if (event.eventType === "created") return "Complaint opened";
  if (event.eventType === "priority_changed") return `Priority changed from ${event.fromValue} to ${event.toValue}`;
  return `Status changed to ${event.toValue}`;
}
