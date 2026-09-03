import type { Session, SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-side trigger for the one-time welcome email.
 *
 * Fire-and-forget by design: it MUST never break authentication. The Edge
 * Function and the database own the "send exactly once" guarantee
 * (public.profiles.welcome_email_sent), so this helper only:
 *   1. gates on a Google OAuth session (never email/password signups),
 *   2. invokes the deployed `welcome-email` function with the user's own JWT,
 *   3. swallows every failure (undeployed function, missing secret, outage).
 *
 * Runs on the server only — before the /auth/callback redirect, but bounded
 * to welcome-email-timeout-ms so the redirect is never delayed past ~7s.
 */

const WELCOME_EMAIL_FUNCTION = "welcome-email";
const WELCOME_EMAIL_TIMEOUT_MS = 7_000;

export async function enqueueWelcomeEmailForGoogleSignup(
  supabase: SupabaseClient,
  session: Session | null
): Promise<void> {
  const user = session?.user;
  if (!user || user.app_metadata?.provider !== "google") {
    return;
  }

  const invoke = async () => {
    const { error } = await supabase.functions.invoke(WELCOME_EMAIL_FUNCTION, {
      body: {},
    });
    if (error) {
      // Function undeployed / not configured / transient — never fatal.
      console.warn(
        `[welcome-email] invocation failed (safe to ignore): ${error.message}`
      );
    }
  };

  try {
    await Promise.race([
      invoke(),
      new Promise((resolve) =>
        setTimeout(resolve, WELCOME_EMAIL_TIMEOUT_MS)
      ),
    ]);
  } catch (error) {
    console.warn(
      "[welcome-email] unexpected error (safe to ignore):",
      error instanceof Error ? error.message : error
    );
  }
}