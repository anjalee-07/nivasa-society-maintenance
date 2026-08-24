import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import {
  api,
  createComplaint,
  getComplaint,
  pngBytes,
  startServer,
  stopServer,
  uniqueKey,
} from "./helpers/server.mjs";

let server;

before(async () => {
  server = await startServer();
  // The demo resident is created on first contact without a flat number, so the
  // profile gate would reject complaint creation until it is completed.
  await api("/api/profile", {
    role: "resident",
    method: "PATCH",
    body: { name: "Priya Shah", flatNumber: "A-804", phone: "+91 90000 00002" },
  });
}, { timeout: 180000 });

after(async () => {
  await stopServer(server);
});

describe("identity and role enforcement", () => {
  test("resolves a resident and an administrator from platform identity", async () => {
    const resident = await api("/api/bootstrap", { role: "resident" });
    const admin = await api("/api/bootstrap", { role: "admin" });
    assert.equal(resident.status, 200);
    assert.equal(resident.body.user.role, "resident");
    assert.equal(admin.status, 200);
    assert.equal(admin.body.user.role, "admin");
  });

  test("residents cannot perform administrator mutations", async () => {
    const { body: created } = await createComplaint();
    const update = await api("/api/complaints", {
      role: "resident",
      method: "PATCH",
      body: { id: created.complaintId, status: "In Progress", expectedVersion: 1 },
    });
    assert.equal(update.status, 403);

    const notice = await api("/api/notices", {
      role: "resident",
      method: "POST",
      body: { title: "Unauthorised notice", body: "This should never be published." },
    });
    assert.equal(notice.status, 403);

    const settings = await api("/api/settings", {
      role: "resident",
      method: "PATCH",
      body: { overdueDays: 10 },
    });
    assert.equal(settings.status, 403);
  });

  test("administrators cannot raise complaints as residents", async () => {
    const form = new FormData();
    form.set("title", "Administrator raised complaint");
    form.set("category", "Plumbing");
    form.set("description", "This should be rejected by the role check.");
    form.set("location", "Office");
    form.set("idempotencyKey", uniqueKey("admin"));
    const response = await api("/api/complaints", { role: "admin", method: "POST", body: form });
    assert.equal(response.status, 403);
  });

  test("delivery configuration state is not exposed to residents", async () => {
    const { body } = await api("/api/bootstrap", { role: "resident" });
    assert.equal(body.emailConfigured, null);
  });
});

describe("complaint creation and validation", () => {
  test("creates a complaint and records an opening history event", async () => {
    const { status, body } = await createComplaint({ title: "Lift door closes too quickly" });
    assert.equal(status, 201);
    assert.match(body.publicId, /^SM-/);

    const complaint = await getComplaint(body.complaintId);
    assert.equal(complaint.status, "Open");
    assert.equal(complaint.priority, "Medium");
    assert.equal(complaint.version, 1);
    assert.equal(complaint.history.length, 1);
    assert.equal(complaint.history[0].eventType, "created");
    assert.equal(complaint.history[0].toValue, "Open");
  });

  test("the same idempotency key never creates a second complaint", async () => {
    const key = uniqueKey("idem");
    const first = await createComplaint({ idempotencyKey: key });
    const second = await createComplaint({ idempotencyKey: key });
    assert.equal(first.status, 201);
    assert.equal(second.body.duplicate, true);
    assert.equal(second.body.complaintId, first.body.complaintId);
  });

  test("rejects an unknown category", async () => {
    const { status } = await createComplaint({ category: "Teleportation" });
    assert.equal(status, 400);
  });

  test("rejects text outside the documented bounds", async () => {
    assert.equal((await createComplaint({ title: "Hi" })).status, 400);
    assert.equal((await createComplaint({ description: "Too short" })).status, 400);
    assert.equal((await createComplaint({ title: "x".repeat(91) })).status, 400);
  });

  test("rejects a non-image disguised with an image MIME type", async () => {
    const { status } = await createComplaint({
      photo: {
        bytes: Buffer.from("MZ this is an executable, not a picture"),
        type: "image/png",
        name: "payload.png",
      },
    });
    assert.equal(status, 415);
  });

  test("accepts a genuine PNG and streams it back privately", async () => {
    const { status, body } = await createComplaint({
      title: "Cracked tile in the lobby",
      photo: { bytes: pngBytes(), type: "image/png", name: "tile.png" },
    });
    assert.equal(status, 201);

    const complaint = await getComplaint(body.complaintId);
    assert.equal(complaint.photos.length, 1);

    const owner = await api(complaint.photos[0].url, { role: "resident", raw: true });
    assert.equal(owner.status, 200);
    assert.equal(owner.headers.get("content-type"), "image/png");
    // A private cache policy keeps complaint media out of shared caches.
    assert.match(owner.headers.get("cache-control") ?? "", /private/);
    assert.equal(owner.headers.get("x-content-type-options"), "nosniff");

    const admin = await api(complaint.photos[0].url, { role: "admin", raw: true });
    assert.equal(admin.status, 200);
  });

  test("an unknown photo id is not found", async () => {
    const { status } = await api("/api/photos/does-not-exist", { role: "admin" });
    assert.equal(status, 404);
  });
});

describe("status lifecycle", () => {
  test("moves Open to In Progress and records actor, note and timestamp", async () => {
    const { body: created } = await createComplaint();
    const update = await api("/api/complaints", {
      method: "PATCH",
      body: {
        id: created.complaintId,
        status: "In Progress",
        note: "Technician assigned for this afternoon.",
        expectedVersion: 1,
      },
    });
    assert.equal(update.status, 200);
    assert.equal(update.body.version, 2);

    const complaint = await getComplaint(created.complaintId);
    assert.equal(complaint.status, "In Progress");
    const event = complaint.history.find((item) => item.eventType === "status_changed");
    assert.equal(event.fromValue, "Open");
    assert.equal(event.toValue, "In Progress");
    assert.equal(event.actorName, "Rohan Mehta");
    assert.equal(event.note, "Technician assigned for this afternoon.");
    assert.ok(!Number.isNaN(Date.parse(event.createdAt)));
  });

  test("allows the direct Open to Resolved path", async () => {
    const { body: created } = await createComplaint();
    const update = await api("/api/complaints", {
      method: "PATCH",
      body: { id: created.complaintId, status: "Resolved", expectedVersion: 1 },
    });
    assert.equal(update.status, 200);
    const complaint = await getComplaint(created.complaintId);
    assert.equal(complaint.status, "Resolved");
    assert.ok(complaint.resolvedAt, "resolvedAt should be stamped on closure");
  });

  test("refuses to move a complaint backwards", async () => {
    const { body: created } = await createComplaint();
    await api("/api/complaints", {
      method: "PATCH",
      body: { id: created.complaintId, status: "In Progress", expectedVersion: 1 },
    });
    const backwards = await api("/api/complaints", {
      method: "PATCH",
      body: { id: created.complaintId, status: "Open", expectedVersion: 2 },
    });
    assert.equal(backwards.status, 409);
    assert.equal((await getComplaint(created.complaintId)).status, "In Progress");
  });

  test("Resolved is terminal for both status and priority", async () => {
    const { body: created } = await createComplaint();
    await api("/api/complaints", {
      method: "PATCH",
      body: { id: created.complaintId, status: "Resolved", expectedVersion: 1 },
    });

    const reopen = await api("/api/complaints", {
      method: "PATCH",
      body: { id: created.complaintId, status: "In Progress", expectedVersion: 2 },
    });
    assert.equal(reopen.status, 409);

    const reprioritise = await api("/api/complaints", {
      method: "PATCH",
      body: { id: created.complaintId, priority: "High", expectedVersion: 2 },
    });
    assert.equal(reprioritise.status, 409);
    assert.equal((await getComplaint(created.complaintId)).status, "Resolved");
  });

  test("rejects an update that changes nothing", async () => {
    const { body: created } = await createComplaint();
    const noop = await api("/api/complaints", {
      method: "PATCH",
      body: { id: created.complaintId, status: "Open", priority: "Medium", expectedVersion: 1 },
    });
    assert.equal(noop.status, 400);
  });

  test("records a priority change as its own history event", async () => {
    const { body: created } = await createComplaint();
    await api("/api/complaints", {
      method: "PATCH",
      body: { id: created.complaintId, priority: "High", expectedVersion: 1 },
    });
    const complaint = await getComplaint(created.complaintId);
    assert.equal(complaint.priority, "High");
    const event = complaint.history.find((item) => item.eventType === "priority_changed");
    assert.equal(event.fromValue, "Medium");
    assert.equal(event.toValue, "High");
  });

  test("an unknown complaint is not found", async () => {
    const { status } = await api("/api/complaints", {
      method: "PATCH",
      body: { id: "no-such-complaint", status: "Resolved", expectedVersion: 1 },
    });
    assert.equal(status, 404);
  });
});

describe("optimistic concurrency", () => {
  test("a stale version is rejected and leaves the record untouched", async () => {
    const { body: created } = await createComplaint();
    const first = await api("/api/complaints", {
      method: "PATCH",
      body: { id: created.complaintId, priority: "High", expectedVersion: 1 },
    });
    assert.equal(first.status, 200);

    // A second administrator still holding version 1 must not overwrite this.
    const stale = await api("/api/complaints", {
      method: "PATCH",
      body: { id: created.complaintId, priority: "Low", expectedVersion: 1 },
    });
    assert.equal(stale.status, 409);

    const complaint = await getComplaint(created.complaintId);
    assert.equal(complaint.priority, "High");
    assert.equal(complaint.version, 2);
  });

  test("requires a valid version on every update", async () => {
    const { body: created } = await createComplaint();
    for (const expectedVersion of [0, -1, "two", null]) {
      const { status } = await api("/api/complaints", {
        method: "PATCH",
        body: { id: created.complaintId, status: "Resolved", expectedVersion },
      });
      assert.equal(
        status,
        400,
        `expectedVersion ${JSON.stringify(expectedVersion)} should be rejected`,
      );
    }
  });
});

describe("ownership scoping", () => {
  test("a resident only ever receives their own complaints", async () => {
    const { body } = await api("/api/bootstrap", { role: "resident" });
    const residentId = body.user.id;
    assert.ok(body.complaints.length > 0);
    for (const complaint of body.complaints) {
      assert.equal(complaint.residentId, residentId);
    }
  });

  test("an administrator sees at least as many complaints as a resident", async () => {
    const resident = await api("/api/bootstrap", { role: "resident" });
    const admin = await api("/api/bootstrap", { role: "admin" });
    assert.ok(admin.body.complaints.length >= resident.body.complaints.length);
  });
});

describe("overdue detection", () => {
  test("the threshold is validated and persisted", async () => {
    assert.equal(
      (await api("/api/settings", { method: "PATCH", body: { overdueDays: 0 } })).status,
      400,
    );
    assert.equal(
      (await api("/api/settings", { method: "PATCH", body: { overdueDays: 61 } })).status,
      400,
    );
    assert.equal(
      (await api("/api/settings", { method: "PATCH", body: { overdueDays: 2.5 } })).status,
      400,
    );

    const ok = await api("/api/settings", { method: "PATCH", body: { overdueDays: 30 } });
    assert.equal(ok.status, 200);
    const { body } = await api("/api/bootstrap");
    assert.equal(body.settings.overdueDays, 30);
  });

  test("overdue is derived from the threshold and never applies to Resolved", async () => {
    await api("/api/settings", { method: "PATCH", body: { overdueDays: 1 } });
    const lenient = await api("/api/bootstrap");
    for (const complaint of lenient.body.complaints) {
      if (complaint.status === "Resolved") {
        assert.equal(complaint.isOverdue, false, "resolved complaints are never overdue");
      }
    }
    const flagged = lenient.body.complaints.filter((complaint) => complaint.isOverdue).length;

    // Raising the threshold can only ever shrink the overdue set.
    await api("/api/settings", { method: "PATCH", body: { overdueDays: 60 } });
    const strict = await api("/api/bootstrap");
    const stillFlagged = strict.body.complaints.filter((complaint) => complaint.isOverdue).length;
    assert.ok(stillFlagged <= flagged, "a longer threshold cannot flag more complaints");

    // A complaint raised moments ago is never overdue at any sane threshold.
    const { body: fresh } = await createComplaint();
    assert.equal((await getComplaint(fresh.complaintId)).isOverdue, false);
  });

  test("the dashboard reconciles with the authorised complaint list", async () => {
    const { body } = await api("/api/bootstrap");
    const counted = body.complaints.reduce((totals, complaint) => {
      totals[complaint.status] = (totals[complaint.status] ?? 0) + 1;
      return totals;
    }, {});
    assert.equal(body.dashboard.statusCounts.Open, counted.Open ?? 0);
    assert.equal(body.dashboard.statusCounts["In Progress"], counted["In Progress"] ?? 0);
    assert.equal(body.dashboard.statusCounts.Resolved, counted.Resolved ?? 0);
    assert.equal(
      body.dashboard.overdueCount,
      body.complaints.filter((complaint) => complaint.isOverdue).length,
    );
  });
});

describe("notice board", () => {
  test("publishes a notice and pins important ones above the rest", async () => {
    const ordinary = await api("/api/notices", {
      method: "POST",
      body: {
        title: "Garden waste collection",
        body: "Garden waste is collected every Tuesday morning.",
      },
    });
    assert.equal(ordinary.status, 201);

    const important = await api("/api/notices", {
      method: "POST",
      body: {
        title: "Emergency water shutdown",
        body: "Water will be shut off between 9am and noon for an urgent repair.",
        important: true,
      },
    });
    assert.equal(important.status, 201);

    const { body } = await api("/api/bootstrap");
    const importantIndex = body.notices.findIndex((notice) => notice.id === important.body.id);
    const ordinaryIndex = body.notices.findIndex((notice) => notice.id === ordinary.body.id);
    assert.ok(importantIndex < ordinaryIndex, "important notices sort above ordinary ones");
    assert.equal(body.notices[importantIndex].important, true);
  });

  test("an important notice queues a message for the resident", async () => {
    const created = await api("/api/notices", {
      method: "POST",
      body: {
        title: "Annual general meeting",
        body: "The annual general meeting takes place on the last Sunday of this month.",
        important: true,
      },
    });
    assert.ok(created.body.notifiedResidents >= 1);

    const { body } = await api("/api/bootstrap");
    const queued = body.notifications.find(
      (item) =>
        item.type === "important_notice" && item.subject.includes("Annual general meeting"),
    );
    assert.ok(queued, "an outbox record should exist for the important notice");
  });

  test("an ordinary notice queues nothing", async () => {
    const created = await api("/api/notices", {
      method: "POST",
      body: {
        title: "Lost umbrella in lobby",
        body: "A black umbrella is waiting at the security desk.",
      },
    });
    assert.equal(created.body.notifiedResidents, 0);
  });

  test("validates notice text and supports removal", async () => {
    assert.equal(
      (await api("/api/notices", { method: "POST", body: { title: "Hi", body: "Long enough body here." } })).status,
      400,
    );
    assert.equal(
      (await api("/api/notices", { method: "POST", body: { title: "Valid title", body: "Short" } })).status,
      400,
    );

    const created = await api("/api/notices", {
      method: "POST",
      body: { title: "Temporary notice", body: "This notice exists only for the removal test." },
    });
    const removal = await api("/api/notices", { method: "DELETE", body: { id: created.body.id } });
    assert.equal(removal.status, 200);

    const { body } = await api("/api/bootstrap");
    assert.equal(
      body.notices.some((notice) => notice.id === created.body.id),
      false,
    );
  });
});

describe("notification outbox", () => {
  test("a status change queues exactly one message for the resident", async () => {
    const { body: created } = await createComplaint({ title: "Corridor light flickers badly" });
    const before = await api("/api/bootstrap");
    const beforeCount = before.body.notifications.filter(
      (item) => item.type === "status_change",
    ).length;

    await api("/api/complaints", {
      method: "PATCH",
      body: { id: created.complaintId, status: "In Progress", expectedVersion: 1 },
    });

    const after = await api("/api/bootstrap");
    const messages = after.body.notifications.filter((item) => item.type === "status_change");
    assert.equal(messages.length, beforeCount + 1);
    assert.equal(messages[0].subject, `${created.publicId} is now In Progress`);
  });

  test("a priority-only change does not email the resident", async () => {
    const { body: created } = await createComplaint();
    const before = await api("/api/bootstrap");
    await api("/api/complaints", {
      method: "PATCH",
      body: { id: created.complaintId, priority: "High", expectedVersion: 1 },
    });
    const after = await api("/api/bootstrap");
    assert.equal(
      after.body.notifications.length,
      before.body.notifications.length,
      "priority changes are not resident-facing email events",
    );
  });

  test("an unconfigured provider leaves messages pending with their retry budget intact", async () => {
    const { body } = await api("/api/bootstrap");
    assert.equal(body.emailConfigured, false, "tests run with delivery disabled");
    const pending = body.notifications.filter((item) => item.status === "pending");
    assert.ok(pending.length > 0);
    for (const message of pending) {
      assert.equal(message.attempts, 0, "a configuration gap must not consume attempts");
    }
  });

  test("draining reports a tally and an unknown retry id is not found", async () => {
    const drain = await api("/api/notifications", { method: "POST", body: {} });
    assert.equal(drain.status, 200);
    for (const key of ["processed", "sent", "pending", "failed", "remaining"]) {
      assert.equal(typeof drain.body[key], "number");
    }
    const unknown = await api("/api/notifications", { method: "POST", body: { id: "not-a-real-id" } });
    assert.equal(unknown.status, 404);
  });

  test("delivery totals count the whole outbox, not just the recent page", async () => {
    const { body } = await api("/api/bootstrap");
    const summed =
      body.deliverySummary.sent + body.deliverySummary.pending + body.deliverySummary.failed;
    assert.ok(summed >= body.notifications.length);
  });
});

describe("reviewer admin access", () => {
  test("the invite route does not exist when no code is configured", async () => {
    // The test server runs without ADMIN_INVITE_CODE, so the feature is off and
    // must not even acknowledge itself.
    const { status } = await api("/api/admin-claim", {
      role: "resident",
      method: "POST",
      body: { code: "anything" },
    });
    assert.equal(status, 404);
  });

  test("a resident is not silently promoted by calling the route", async () => {
    await api("/api/admin-claim", { role: "resident", method: "POST", body: { code: "guess" } });
    const { body } = await api("/api/bootstrap", { role: "resident" });
    assert.equal(body.user.role, "resident");
  });
});

describe("profile and health", () => {
  test("validates the resident profile", async () => {
    assert.equal(
      (await api("/api/profile", { role: "resident", method: "PATCH", body: { name: "P", flatNumber: "A-804" } })).status,
      400,
    );
    assert.equal(
      (await api("/api/profile", { role: "resident", method: "PATCH", body: { name: "Priya Shah", flatNumber: "" } })).status,
      400,
    );
    assert.equal(
      (await api("/api/profile", {
        role: "resident",
        method: "PATCH",
        body: { name: "Priya Shah", flatNumber: "A-804", phone: "not a phone" },
      })).status,
      400,
    );

    const ok = await api("/api/profile", {
      role: "resident",
      method: "PATCH",
      body: { name: "Priya Shah", flatNumber: "A-804", phone: "+91 90000 00002" },
    });
    assert.equal(ok.status, 200);
  });

  test("reports database readiness", async () => {
    const { status, body } = await api("/api/health");
    assert.equal(status, 200);
    assert.equal(body.status, "ok");
  });
});
