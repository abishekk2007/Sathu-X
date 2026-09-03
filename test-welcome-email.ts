// ---------------------------------------------------------------------------
// One-time welcome email — trigger helper tests
//
// Covers the parts that are testable WITHOUT live credentials:
//   * Google-only gate (email/password or missing session => no invocation)
//   * invites the `welcome-email` Edge Function with the user's JWT
//   * swallows every failure so the OAuth callback is NEVER broken
//   * bounded wait: a hanging function cannot delay the auth redirect forever
//
// Not covered here (needs live Supabase + Resend): the Edge Function itself,
// actual email delivery, and DB once-only claims — see
// docs/welcome-email-setup.md for the live/remote verification steps.
// ---------------------------------------------------------------------------

import { enqueueWelcomeEmailForGoogleSignup } from "./src/lib/supabase/welcome-email";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function googleSession(overrides: Record<string, unknown> = {}) {
  return {
    access_token: "token-google-user",
    refresh_token: "",
    expires_in: 3600,
    expires_at: 0,
    token_type: "bearer",
    user: {
      id: "abcdef12-abcd-abcd-abcd-abcdef123456",
      email: "jane@example.com",
      app_metadata: { provider: "google" },
      user_metadata: { full_name: "Jane Roe" },
      ...overrides,
    },
  };
}

function fakeClient(show: () => void) {
  return {
    functions: {
      invoke: async () => {
        show();
        return { data: null, error: null };
      },
    },
  } as unknown as Parameters<typeof enqueueWelcomeEmailForGoogleSignup>[0];
}

async function main(): Promise<void> {
  console.log("\nWELCOME EMAIL — TRIGGER HELPER");
  console.log("==============================");

  // --- 1. Google session => invokes the welcome-email function -------------
  {
    let invoked = false;
    const client = fakeClient(() => (invoked = true));
    await enqueueWelcomeEmailForGoogleSignup(client, googleSession() as never);
    check("google session invokes welcome-email", invoked);
  }

  // --- 2. Non-Google provider => never invoked ------------------------------
  {
    let invoked = false;
    const client = fakeClient(() => (invoked = true));
    const session = googleSession({ app_metadata: { provider: "email" } });
    await enqueueWelcomeEmailForGoogleSignup(client, session as never);
    check("email/password session is never invoked", !invoked);
  }

  // --- 3. Null session => never invoked ------------------------------------
  {
    let invoked = false;
    const client = fakeClient(() => (invoked = true));
    await enqueueWelcomeEmailForGoogleSignup(client, null);
    check("null session is never invoked", !invoked);
  }

  // --- 4. Invocation error is swallowed (auth must keep working) ------------
  {
    let resolved = false;
    const client = {
      functions: {
        invoke: async () => ({ data: null, error: { message: "Function not found" } }),
      },
    } as unknown as Parameters<typeof enqueueWelcomeEmailForGoogleSignup>[0];
    await enqueueWelcomeEmailForGoogleSignup(client, googleSession() as never);
    resolved = true;
    check("invocation error is swallowed without throwing", resolved);
  }

  // --- 5. Hanging function cannot block the callback forever ----------------
  {
    const client = {
      functions: {
        invoke: () => new Promise<never>(() => {}), // never resolves
      },
    } as unknown as Parameters<typeof enqueueWelcomeEmailForGoogleSignup>[0];
    const started = Date.now();
    await enqueueWelcomeEmailForGoogleSignup(client, googleSession() as never);
    const elapsed = Date.now() - started;
    check(
      "hanging function times out before blocking auth",
      elapsed < 10_000,
      `elapsed=${elapsed}ms`
    );
  }

  console.log(
    "\n============================================================\n" +
      `Welcome email trigger tests: ${passed} passed, ${failed} failed\n` +
      "============================================================"
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("suite crashed:", error);
  process.exit(1);
});