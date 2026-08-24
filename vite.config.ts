import vinext from "vinext";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json";
import { sites } from "./build/sites-vite-plugin";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

// R2 is intentionally not bound: complaint photos are stored in D1, so the
// deployment does not require an R2-enabled account.
const { d1 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [
        {
          binding: d1,
          // Real values come from the environment at build time so a deploy can
          // target an actual database without editing tracked configuration.
          database_name: process.env.CF_D1_DATABASE_NAME || "site-creator-d1",
          database_id:
            process.env.CF_D1_DATABASE_ID || SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  vars: {
    // Local preview seeds by default. A deployment opts out with
    // SEED_DEMO_DATA=false at build time, or in for a populated demo.
    SEED_DEMO_DATA: process.env.SEED_DEMO_DATA ?? "true",
    // Forwarded from the parent process. `.dev.vars` overrides worker vars, but
    // only for keys it defines, so this stays effective alongside real secrets.
    ...(process.env.EMAIL_DELIVERY_DISABLED === "1"
      ? { EMAIL_DELIVERY_DISABLED: "1" }
      : {}),
  },
  r2_buckets: [],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
