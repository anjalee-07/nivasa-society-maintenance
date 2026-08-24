import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Nivasa application shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Nivasa \| Society Maintenance, Made Clear<\/title>/i);
  assert.match(html, /Preparing your society workspace/i);
  assert.match(html, /Nivasa/i);
  assert.doesNotMatch(html, /The Anjalee Files|codex-preview|Building your site/i);
});

test("ships the required product surfaces and protected APIs", async () => {
  const [client, complaintRoute, bootstrapRoute, schema, readme] = await Promise.all([
    readFile(new URL("../app/nivasa-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/complaints/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/bootstrap/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
  ]);

  assert.match(client, /Raise a maintenance complaint/);
  assert.match(client, /Status history/);
  assert.match(client, /Email delivery center/);
  assert.match(complaintRoute, /requireAdmin/);
  assert.match(complaintRoute, /expectedVersion/);
  assert.match(bootstrapRoute, /is_overdue/);
  assert.match(schema, /complaintHistory/);
  assert.match(schema, /notificationOutbox/);
  assert.match(readme, /API reference/);
  assert.match(readme, /Database schema/);
});
