"use client";

import { useRouter } from "next/navigation";
import {
  BrainIcon,
  ChevronUpIcon,
  LogOutIcon,
  SettingsIcon,
  UserIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSupabaseUser } from "@/hooks/use-supabase-user";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

function initialsFor(name: string, email: string): string {
  const source = name?.trim() && name !== "User" ? name : email;
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  const letters = parts.length >= 2 ? parts[0][0] + parts[1][0] : source.slice(0, 2);
  return letters.toUpperCase() || "··";
}

/**
 * Bottom-of-sidebar account section. Expanded shows avatar + name + email +
 * chevron; collapsed shows just the avatar. The menu opens ABOVE the card.
 */
export function SidebarUserCard({ collapsed = false }: { collapsed?: boolean }) {
  const router = useRouter();
  const { user, loading } = useSupabaseUser();

  const handleSignOut = async () => {
    // Clears the local session (cookies) server- and client-side; Supabase
    // rows are untouched — signing back in restores every conversation.
    const { error } = await getSupabaseBrowserClient().auth.signOut();
    if (error) {
      toast.error("Could not sign out. Please try again.");
      return;
    }
    router.push("/login");
    router.refresh();
  };

  const displayName = user?.fullName ?? "";
  const email = user?.email ?? "";
  const initials = user ? initialsFor(displayName, email) : "··";

  const menu = (
    <DropdownMenuContent
      side="top"
      align="start"
      sideOffset={8}
      className="w-60"
    >
      <DropdownMenuLabel className="flex flex-col gap-0.5 py-1.5">
        <span className="truncate text-sm font-medium text-foreground">
          {loading ? "Loading…" : displayName}
        </span>
        {email ? <span className="truncate text-xs font-normal">{email}</span> : null}
      </DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuItem onSelect={() => router.push("/settings")}>
          <UserIcon />
          Profile
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => router.push("/memory")}>
          <BrainIcon />
          Memory
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => router.push("/settings")}>
          <SettingsIcon />
          Settings
        </DropdownMenuItem>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" onSelect={() => void handleSignOut()}>
        <LogOutIcon />
        Log out
      </DropdownMenuItem>
    </DropdownMenuContent>
  );

  if (collapsed) {
    return (
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Open account menu"
                title="Account"
                className="flex size-9 items-center justify-center rounded-lg transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Avatar className="size-7">
                  {user?.avatarUrl ? (
                    <AvatarImage src={user.avatarUrl} alt="" />
                  ) : null}
                  <AvatarFallback className="bg-primary/15 text-[11px] font-medium text-primary">
                    {initials}
                  </AvatarFallback>
                </Avatar>
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={12}>
            Account
          </TooltipContent>
        </Tooltip>
        {menu}
      </DropdownMenu>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Open account menu"
          className={cn(
            "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors",
            "hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          )}
        >
          <Avatar className="size-8 shrink-0">
            {user?.avatarUrl ? <AvatarImage src={user.avatarUrl} alt="" /> : null}
            <AvatarFallback className="bg-primary/15 text-xs font-medium text-primary">
              {initials}
            </AvatarFallback>
          </Avatar>
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-sm font-medium text-sidebar-foreground">
              {loading ? "Loading…" : displayName}
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              {email}
            </span>
          </span>
          <ChevronUpIcon
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground"
          />
        </button>
      </DropdownMenuTrigger>
      {menu}
    </DropdownMenu>
  );
}
