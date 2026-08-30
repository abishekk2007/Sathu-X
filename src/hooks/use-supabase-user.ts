"use client";

import * as React from "react";
import type { Session } from "@supabase/supabase-js";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";

export interface SupabaseUserSummary {
  id: string;
  email: string;
  /** Best-available display name (profiles -> metadata -> email username). */
  fullName: string;
  /** Best-available avatar image (profiles -> metadata), or null. */
  avatarUrl: string | null;
}

function resolveIdentity(
  authUser: NonNullable<Session["user"]>,
  profile?: { full_name: string | null; avatar_url: string | null } | null
): SupabaseUserSummary {
  const email = authUser.email ?? "";
  const meta = (authUser.user_metadata ?? {}) as Record<string, unknown>;

  const metaFullName = typeof meta.full_name === "string" ? meta.full_name : "";
  const metaName = typeof meta.name === "string" ? meta.name : "";
  const emailUsername = email.includes("@") ? email.split("@")[0] : "";

  const fullName =
    profile?.full_name?.trim() ||
    metaFullName.trim() ||
    metaName.trim() ||
    emailUsername ||
    "User";

  const metaAvatar = typeof meta.avatar_url === "string" ? meta.avatar_url : "";
  const metaPicture = typeof meta.picture === "string" ? meta.picture : "";

  const avatarUrl =
    profile?.avatar_url?.trim() || metaAvatar.trim() || metaPicture.trim() || null;

  return { id: authUser.id, email, fullName, avatarUrl };
}

/** Tracks the authenticated user client-side (session is refreshed by proxy). */
export function useSupabaseUser(): {
  user: SupabaseUserSummary | null;
  loading: boolean;
} {
  const [user, setUser] = React.useState<SupabaseUserSummary | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    let active = true;

    /** Fetches the profiles row so DB values win over OAuth metadata. */
    const hydrateProfile = async (authUser: NonNullable<Session["user"]>) => {
      try {
        const { data } = await supabase
          .from("profiles")
          .select("full_name,avatar_url")
          .eq("id", authUser.id)
          .maybeSingle();
        if (!active) return;
        setUser((current) =>
          current && current.id === authUser.id
            ? resolveIdentity(authUser, data)
            : current
        );
      } catch {
        // Profile lookup is best-effort — metadata fallbacks already applied.
      }
    };

    const applySession = (session: Session | null) => {
      const authUser = session?.user;
      if (!authUser) {
        setUser(null);
        return;
      }
      setUser(resolveIdentity(authUser));
      void hydrateProfile(authUser);
    };

    const init = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!active) return;
      applySession(session);
      setLoading(false);
    };
    void init();

    const { data } = supabase.auth.onAuthStateChange(
      (_event: unknown, session: Session | null) => {
        applySession(session);
        setLoading(false);
      }
    );

    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, []);

  return { user, loading };
}
