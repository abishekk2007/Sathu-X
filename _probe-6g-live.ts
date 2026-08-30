// ---------------------------------------------------------------------------
// Phase 6G — LIVE end-to-end tasks + planning probe
//
// Drives the REAL 6G persistence service (src/lib/tasks/store.ts) against a
// Supabase project whose RLS owns rows via the authenticated session. Identity
// is a dedicated probe account (PROBE_USER_EMAIL / PROBE_USER_PASSWORD from
// .env.local) — on the anon client it is never possible to bypass RLS, so
// every write/read runs under exactly the same boundary the app relies on.
//
// SAFE OUTPUT ONLY: probe outcome, task/plan titles, statuses, row counts,
// removal counts of the probe's own rows. Never printed: passwords, keys,
// secret values, other users' rows.
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
  listTasks,
  createTask,
  completeTask,
  rescheduleTask,
  countTasksByStatus,
  deleteTask,
  getPlanWithSteps,
  createPlan,
  updatePlan,
  deletePlan,
  setStepStatus,
} from "./src/lib/tasks";

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

const STAMP = Date.now();
const PROBE_TITLE = `probe:6g:task:${STAMP}`;
const PROBE_PLAN = `probe:6g:plan:${STAMP}`;

function fail(message: string): never {
  result("FAIL", message);
  process.exit(1);
}

async function selfCleanTasks(client: SupabaseClient): Promise<void> {
  const stale = (await listTasks(client)).filter((t) => t.title.startsWith("probe:6g:"));
  for (const t of stale) await deleteTask(client, t.id);
}

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

  try {
    // ---- (0) sweep leftover rows from previous failed probe runs ---------
    await selfCleanTasks(client);

    // ---- (1) create a task, list it, complete it --------------------------
    const created = await createTask(client, {
      title: PROBE_TITLE,
      description: "Live probe lifecycle row — safe to delete.",
      priority: "medium",
      tags: ["probe"],
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    if (!created?.id) fail("probe task write rejected — RLS insert boundary?");
    console.log(
      `[probe] task created title="${created.title}" status=${created.status} dueAt=${created.dueAt} id=${created.id.slice(0, 8)}…`
    );
    if (created.status !== "pending") fail("new task did not start as pending");

    const listed = await listTasks(client);
    if (!listed.some((t) => t.id === created.id)) fail("listTasks did not surface the probe task (RLS visibility)");
    console.log(`[probe] listTasks=${listed.length} rows; probe task found`);

    const counts = await countTasksByStatus(client);
    console.log(`[probe] status counts pending=${counts.pending} completed=${counts.completed} cancelled=${counts.cancelled} failed=${counts.failed}`);

    const done = await completeTask(client, created.id);
    if (!done || done.status !== "completed") fail("completeTask did not flip status to completed");
    console.log(`[probe] completeTask → ${done.status}`);

    const rescheduled = await rescheduleTask(client, created.id, null);
    if (!rescheduled || rescheduled.dueAt !== null) fail("rescheduleTask did not clear dueAt");
    console.log(`[probe] rescheduleTask → dueAt=${rescheduled.dueAt}`);

    if (!(await deleteTask(client, created.id))) fail("deleteTask did not remove the probe task");
    console.log(`[probe] probe task deleted (removed=1)`);

    // ---- (2) create a plan with dependency-aware steps ---------------------
    const resultPlan = await createPlan(
      client,
      { title: PROBE_PLAN, objective: "Verify plan_steps RLS + dependency resolution live." },
      [
        { title: "step one", position: 1, estimatedMinutes: 15, dueAt: new Date(Date.now() + 43_200_000).toISOString() },
        { title: "step two", position: 2, dependsOnPositions: [1], estimatedMinutes: 30 },
      ]
    );
    if (!resultPlan) fail("probe plan write rejected — RLS insert boundary?");
    const planId = resultPlan.plan.id;
    console.log(
      `[probe] plan created title="${resultPlan.plan.title}" status=${resultPlan.plan.status} ` +
        `steps=${resultPlan.steps.length} id=${planId.slice(0, 8)}…`
    );
    if (resultPlan.plan.status !== "active") fail("new plan did not start as active");

    const full = await getPlanWithSteps(client, planId);
    if (!full || full.steps.length !== 2) fail("getPlanWithSteps did not return the probe plan with 2 steps");
    const [s1, s2] = full.steps.sort((a, b) => a.position - b.position);
    console.log(
      `[probe] plan steps: "${s1.title}" position=${s1.position} status=${s1.status}; ` +
        `"${s2.title}" position=${s2.position} status=${s2.status} dependsOn=${s2.dependsOn.length}`
    );
    if (s1.status !== "pending" || s2.status !== "pending") fail("plan steps did not start as pending");
    if (s2.dependsOn.length !== 1 || s2.dependsOn[0] !== s1.id) fail("dependsOnPositions did not resolve to the sibling row id");

    const stepDone = await setStepStatus(client, s1.id, "completed");
    if (!stepDone || stepDone.status !== "completed") fail("setStepStatus did not complete step one");
    console.log(`[probe] setStepStatus("${s1.title}") → ${stepDone.status}`);

    const updatedPlan = await updatePlan(client, planId, { description: "live-probe verified" });
    if (!updatedPlan || updatedPlan.description !== "live-probe verified") fail("updatePlan did not persist");
    console.log("[probe] updatePlan description persisted");

    if (!(await deletePlan(client, planId))) fail("deletePlan did not remove the probe plan");
    console.log(`[probe] probe plan deleted (removed=1)`);
    await selfCleanTasks(client);

    // ---- (3) RLS boundary: anon client must see and write NOTHING ----------
    const anon: SupabaseClient = createClient(url, key, {
      auth: { persistSession: false },
    });
    const anonWrite = await createTask(anon, { title: `probe:6g:anon:${STAMP}` });
    const anonList = await listTasks(anon);
    console.log(
      `[probe] anon client (no session): createTask=${anonWrite ? "ACCEPTED" : "rejected"} listTasks=${anonList.length}`
    );
    if (anonWrite !== null || anonList.length !== 0) {
      result("FAIL", "anon client bypassed RLS — ownership boundary is not enforced");
      process.exit(1);
    }

    result("OK", "task create→list→complete→reschedule→delete, plan+steps create→deps→status→delete, anon RLS rejection all verified under live RLS");
  } finally {
    await client.auth.signOut();
    process.exit(0);
  }
}

main().catch((e) => {
  console.log("[probe] error:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});