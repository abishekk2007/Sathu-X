"use client";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";

/**
 * Starts Supabase's hosted Google OAuth flow (PKCE). The provider must be
 * enabled in the Supabase Dashboard (Authentication -> Providers -> Google);
 * see the Phase 3 report for the exact settings.
 */
export async function startGoogleSignIn(nextPath = "/chat") {
  const redirectTo = new URL("/auth/callback", window.location.origin);
  redirectTo.searchParams.set("next", nextPath);

  const { error } = await getSupabaseBrowserClient().auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: redirectTo.toString() },
  });

  return !error;
}
