// ---------------------------------------------------------------------------
// Sathux Spidey Bot — welcome-email Edge Function (Deno / Supabase runtime)
// ---------------------------------------------------------------------------
// Sends the one-time branded welcome email for a FIRST-TIME Google signup.
//
// Design notes (do not weaken these without rereading the spec):
//  * The caller's identity ALWAYS comes from the Authorization bearer JWT —
//    never from the request body, so one user can never trigger emails for
//    another address.
//  * Only Google OAuth sessions are eligible (app_metadata.provider == google).
//  * The database is the source of truth. public.profiles.welcome_email_sent
//    is claimed with an atomic `UPDATE ... WHERE welcome_email_sent = false`
//    so concurrent callbacks cannot send duplicates; if delivery fails the
//    claim is reverted and a later login retries.
//  * RESEND_API_KEY lives only in Supabase secrets (Deno.env) — it is never
//    returned, logged, or exposed to any client.
//
// Secrets (set via `supabase secrets set` / dashboard):
//   RESEND_API_KEY             — required to send (else 503, nothing claimed)
//   SUPABASE_URL               — auto-injected by the CLI
//   SUPABASE_ANON_KEY          — auto-injected by the CLI (RLS-bound anon role)
// ---------------------------------------------------------------------------

import { createClient } from "jsr:@supabase/supabase-js@2";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const SENDER = "Sathux Spidey Bot <onboarding@resend.dev>";
const SUBJECT = "Welcome to Sathux Spidey Bot! 🎉";

/** Server-only log line — strips tokens/keys; never logs payload secrets. */
function log(label: string, detail = ""): void {
  console.log(`[welcome-email] ${label}${detail ? ` — ${detail}` : ""}`);
}

function jsonResponse(
  body: Record<string, string | number | boolean>,
  status: number
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function bearerToken(request: Request): string {
  const header = request.headers.get("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

/** Escape user-controlled values before embedding them in HTML. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Revert the claim so a later login can retry after a failed delivery. */
async function revertClaim(
  supabase: SupabaseClient,
  userId: string
): Promise<void> {
  const { error } = await supabase
    .from("profiles")
    .update({ welcome_email_sent: false, welcome_email_sent_at: null })
    .eq("id", userId);
  if (error) {
    log("revert claim failed", `id=${userId.slice(0, 8)} (${error.message})`);
  }
}

function buildWelcomeHtml(name: string): string {
  return `<!DOCTYPE html>
<html lang="en">
  <body style="margin:0;padding:0;background:#0f172a;">
    <div style="max-width:600px;margin:0 auto;padding:24px 16px;font-family:Arial,Helvetica,sans-serif;color:#e2e8f0;">
      <h1 style="margin:0 0 16px;font-size:24px;text-align:center;color:#ffffff;">
        Welcome to Sathux Spidey Bot! 🎉
      </h1>
      <div style="background:#1e293b;border:1px solid #334155;border-radius:12px;padding:24px;">
        <p style="margin:0 0 12px;font-size:16px;line-height:1.6;">Hi ${name},</p>
        <p style="margin:0 0 12px;font-size:16px;line-height:1.6;">
          Enjoy our AI-powered intelligent chatbot.
        </p>
        <p style="margin:0 0 4px;font-size:16px;line-height:1.6;">
          We're excited to have you with us!
        </p>
      </div>
      <p style="margin:24px 0 0;font-size:14px;color:#94a3b8;text-align:center;">
        Regards,<br />Sathux Spidey Bot Team
      </p>
    </div>
  </body>
</html>`;
}

function buildWelcomeText(name: string): string {
  return [
    "Welcome to Sathux Spidey Bot! 🎉",
    "",
    `Hi ${name},`,
    "",
    "Welcome to Sathux Spidey Bot! 🎉",
    "Enjoy our AI-powered intelligent chatbot.",
    "We're excited to have you with us!",
    "",
    "Regards,",
    "Sathux Spidey Bot Team",
  ].join("\n");
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (request.method !== "POST") {
    return jsonResponse({ status: "skipped", reason: "method_not_allowed" }, 405);
  }

  const token = bearerToken(request);
  if (!token) {
    return jsonResponse({ status: "skipped", reason: "no_auth" }, 401);
  }

  const resendKey = Deno.env.get("RESEND_API_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!resendKey) {
    // Nothing claimed/sent — a later invocation (next login) will retry.
    log("not configured", "RESEND_API_KEY missing (set via supabase secrets)");
    return jsonResponse({ status: "skipped", reason: "not_configured" }, 503);
  }
  if (!supabaseUrl || !supabaseAnonKey) {
    log("not configured", "SUPABASE_URL / SUPABASE_ANON_KEY missing");
    return jsonResponse({ status: "skipped", reason: "not_configured" }, 503);
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  // Validate the JWT server-side; identity only ever comes from the token.
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser(token);
  if (userError || !user) {
    log("invalid token", userError?.message ?? "no user");
    return jsonResponse({ status: "skipped", reason: "invalid_token" }, 401);
  }
  if (user.app_metadata?.provider !== "google") {
    // Email/password or other providers are out of scope for the Google email.
    return jsonResponse({ status: "skipped", reason: "provider_not_google" }, 200);
  }

  const email = (user.email ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return jsonResponse({ status: "skipped", reason: "no_email" }, 200);
  }

  const {
    data: profile,
    error: profileError,
  } = await supabase
    .from("profiles")
    .select("full_name,welcome_email_sent,welcome_email_sent_at")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError) {
    if (profileError.code === "42703") {
      // Migration not applied: we cannot verify once-only, so send nothing.
      log("profile tracking column missing", "run the welcome_email migration");
      return jsonResponse({ status: "skipped", reason: "not_provisioned" }, 200);
    }
    log("profile read failed", profileError.message);
    return jsonResponse({ status: "skipped", reason: "profile_read_failed" }, 503);
  }
  if (!profile) {
    log("no profile row", `id=${user.id.slice(0, 8)}`);
    return jsonResponse({ status: "skipped", reason: "no_profile" }, 200);
  }
  if (profile.welcome_email_sent === true) {
    return jsonResponse({ status: "skipped", reason: "already_sent" }, 200);
  }

  // ---- Atomic claim: the row can only be claimed once, so concurrent
  // ---- callbacks / repeated events can never double-send.
  const {
    data: claimed,
    error: claimError,
  } = await supabase
    .from("profiles")
    .update({ welcome_email_sent: true })
    .eq("id", user.id)
    .eq("welcome_email_sent", false)
    .select("id")
    .maybeSingle();

  if (claimError) {
    log("claim failed", claimError.message);
    return jsonResponse({ status: "skipped", reason: "claim_failed" }, 503);
  }
  if (!claimed) {
    // Another invocation claimed the row first.
    return jsonResponse({ status: "skipped", reason: "already_sent" }, 200);
  }

  const rawName =
    (profile.full_name || (user.user_metadata?.full_name as string | undefined) ||
      email.split("@")[0] ||
      "there").trim();
  const safeName = escapeHtml(rawName);

  let resendResponse: Response;
  try {
    resendResponse = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: SENDER,
        to: [email],
        subject: SUBJECT,
        html: buildWelcomeHtml(safeName),
        text: buildWelcomeText(rawName),
      }),
    });
  } catch (networkError) {
    log("resend unreachable", `id=${user.id.slice(0, 8)}`);
    await revertClaim(supabase, user.id);
    return jsonResponse(
      { status: "skipped", reason: "resend_unreachable" },
      502
    );
  }

  if (!resendResponse.ok) {
    const detail = (await resendResponse.text().catch(() => "")).slice(0, 200);
    log(
      "resend rejected",
      `status=${resendResponse.status} id=${user.id.slice(0, 8)} ${detail}`
    );
    await revertClaim(supabase, user.id);
    return jsonResponse({ status: "skipped", reason: "resend_error" }, 502);
  }

  // Delivery confirmed — record the audit timestamp. (The flag is already
  // true from the claim; this finalizes the "sent" record.)
  const { error: markError } = await supabase
    .from("profiles")
    .update({ welcome_email_sent_at: new Date().toISOString() })
    .eq("id", user.id);
  if (markError) {
    log("mark sent_at failed", `id=${user.id.slice(0, 8)} (${markError.message})`);
  }

  log("sent", `to=${email.replace(/\*/g, "")} id=${user.id.slice(0, 8)}`);
  return jsonResponse({ status: "sent" }, 200);
});