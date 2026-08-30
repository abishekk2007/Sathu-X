import { NextResponse, type NextRequest } from "next/server";

import { createSupabaseRouteHandlerClient } from "@/lib/supabase/route-handler";

/**
 * Supabase OAuth/PKCE callback. Exchanges the one-time ?code for a session
 * and persists it in the SSR cookies, then continues to `next` (default /chat).
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const nextParam = searchParams.get("next") ?? "/chat";
  const next = nextParam.startsWith("/") ? nextParam : "/chat";

  if (!code) {
    // User hit the callback directly or the provider returned an error.
    return NextResponse.redirect(new URL("/login?error=oauth", origin));
  }

  try {
    const supabase = await createSupabaseRouteHandlerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      console.error("OAuth exchange failed:", error.message);
      return NextResponse.redirect(new URL("/login?error=oauth", origin));
    }
  } catch (error) {
    console.error("OAuth callback error:", error);
    return NextResponse.redirect(new URL("/login?error=oauth", origin));
  }

  return NextResponse.redirect(new URL(next, origin));
}
