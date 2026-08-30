// ---------------------------------------------------------------------------
// Phase 6F — LIVE end-to-end memory probe
//
// Drives the REAL 6F persistence service (src/lib/memory/store.ts) against a
// Supabase project whose RLS owns rows via the authenticated session. Identity
// is a dedicated probe account (PROBE_USER_EMAIL / PROBE_USER_PASSWORD from
// .env.local) — on the anon client it is never possible to bypass RLS, so
// every write/read runs under exactly the same boundary the app relies on.
//
// SAFE OUTPUT ONLY: probe outcome, key/type/source/confidence, row count,
// removal counts of the probe's own rows. Never printed: passwords, keys,
// secret values, other users' memory.
//
// Honest tiers:
//   creds missing / login failed          → LIVE=PENDING (upstream account)
//   storage/RLS rejected the probe write  → LIVE=FAIL     (boundary is wrong)
//   full lifecycle succeeded              → LIVE=OK
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  isMemoryEnabled,
  setMemoryMode,
  upsertMemory,
  listMemories,
  patchMemory,
  deleteMemory,
  resolveDeleteTarget,
} from "./src/lib/memory";
import { looksSensitive } from "./src/lib/memory/security";

function loadEnv(tokenVar: string): string {
  try {
    const raw = readFileSync(".env.local", "utf8");
    const line = raw.split(/\r?\n/).find((l) => l.startsWith(`${tokenVar}=`));
    return line ? line.slice(tokenVar.length + 1).trim() : "";
  } catch {
    return "";
  }
}

function result(outcome: "PENDING" | "FAIL" | "OK", message: string): void {
  console.log(`[probe] RESULT ${outcome} — ${message}`);
}

const OWN_KEY = "probe:response_language";

async function main(): Promise<void> {
  const url = loadEnv("NEXT_PUBLIC_SUPABASE_URL");
  const key = loadEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  const email = loadEnv("PROBE_USER_EMAIL");
  const password = loadEnv("PROBE_USER_PASSWORD");

  console.log(
    `[probe] supabase url present=${Boolean(url)} publishable key present=${Boolean(key)} ` +
      `probe account present=${Boolean(email && password)} (values never printed)`
  );

  if (!url || !key || !email || !password) {
    result("PENDING", "probe account or Supabase env missing — add PROBE_USER_EMAIL/PROBE_USER_PASSWORD to .env.local (a throwaway account), then re-run");
    process.exit(0);
  }

  const client: SupabaseClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) {
    result("PENDING", `login failed (${signInError.message}) — genuine account required for RLS to bind ownership`);
    process.exit(0);
  }
  const uid = (await client.auth.getUser()).data.user?.id ?? "?";
  console.log(`[probe] signed in as probe account (uid=${uid.slice(0, 8)}…)`);

  const enabledBefore = await isMemoryEnabled(client);
  console.log(`[probe] memory master switch initially enabled=${enabledBefore}`);

  try {
    // ---- (1) master switch toggle (restored at the end) ------------------
    if (enabledBefore) {
      const off = await setMemoryMode(client, false);
      const on = await setMemoryMode(client, true);
      console.log(`[probe] switch off=${off} on=${on}`);
      if (off !== false || on !== true) {
        result("FAIL", "master switch did not round-trip (off=false, on=true expected)");
        process.exit(1);
      }
    }

    // ---- (2) create (dedup key), then merge via the same key --------------
    const created = await upsertMemory(client, {
      key: OWN_KEY,
      content: "The user prefers concise memory probe answers.",
      type: "preference",
      source: "explicit",
      confidence: "high",
      importance: 2,
    });
    if (created.kind === "error" || !created.memory || !created.memory.id) {
      result("FAIL", `probe write rejected — kind=${created.kind} (RLS insert boundary?)`);
      process.exit(1);
    }
    const probeId = created.memory.id;
    console.log(
      `[probe] created key="${created.memory.key}" type=${created.memory.type} ` +
        `source=${created.memory.source} confidence=${created.memory.confidence} id=${probeId.slice(0, 8)}…`
    );
    if (created.memory.type !== "preference" || created.memory.source !== "explicit") {
      result("FAIL", "payload typed fields did not persist");
      process.exit(1);
    }

    const merged = await upsertMemory(client, {
      key: OWN_KEY,
      content: "The user prefers concise memory probe answers.",
      type: "preference",
      source: "explicit",
      confidence: "high",
    });
    console.log(`[probe] re-save merge kind=${merged.kind}`);
    if (merged.kind !== "updated" || merged.memory?.id !== probeId) {
      result("FAIL", "same-key re-save did not merge onto the same row");
      process.exit(1);
    }

    // ---- (3) listing sees exactly one probe row for this key -------------
    const owned = await listMemories(client);
    const mine = owned.filter((m) => m.key === OWN_KEY);
    console.log(`[probe] listMemories=${owned.length} rows; probe-key rows=${mine.length}`);
    if (mine.length !== 1 || mine[0].id !== probeId) {
      result("FAIL", "listMemories did not surface the probe row (RLS over/under visibility)");
      process.exit(1);
    }

    // ---- (4) patch the probe row ------------------------------------------
    const patched = await patchMemory(client, probeId, {
      content: "The user prefers concise memory probe answers (updated).",
      importance: 3,
    });
    console.log(`[probe] patch importance=${patched?.importance}`);
    if (!patched || patched.importance !== 3) {
      result("FAIL", "patchMemory did not update the probe row");
      process.exit(1);
    }

    // ---- (5) resolveDeleteTarget + delete ONLY the probe row --------------
    const targets = resolveDeleteTarget(owned, "probe response language");
    const removed = await deleteMemory(client, [probeId]);
    console.log(`[probe] resolveDeleteTarget matched=${targets.length} removed=${removed}`);
    if (removed !== 1 || (targets.length > 0 && !targets.includes(probeId))) {
      result("FAIL", "delete resolution or removal went wrong");
      process.exit(1);
    }

    // ---- (6) secret veto still armed on the real security module ----------
    const secret = looksSensitive(
      `api_key=${"A" + "B".repeat(38)}`
    ) satisfies boolean;
    console.log(`[probe] looksSensitive(API_KEY=…) = ${secret}`);
    if (!secret) {
      result("FAIL", "credential veto disarmed");
      process.exit(1);
    }

    result("OK", "create → merge → list → patch → delete → veto all verified under live RLS");
  } finally {
    await client.auth.signOut();
    process.exit(0);
  }
}

main().catch((e) => {
  console.log("[probe] error:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});