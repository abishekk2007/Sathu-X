"use client";

import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import {
  BrainIcon,
  KeyboardIcon,
  LaptopIcon,
  LogOutIcon,
  MoonIcon,
  SettingsIcon,
  SunIcon,
  UserIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSupabaseUser } from "@/hooks/use-supabase-user";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

function initialsFor(name: string | null, email: string): string {
  const source = name?.trim() || email;
  const parts = source.split(/[\s@.]+/).filter(Boolean);
  return (parts.length >= 2 ? parts[0][0] + parts[1][0] : source.slice(0, 2))
    .toUpperCase();
}

export function ProfileMenu({
  className,
  showName = false,
}: {
  className?: string;
  showName?: boolean;
}) {
  const router = useRouter();
  const { setTheme } = useTheme();
  const { user, loading } = useSupabaseUser();

  const handleSignOut = async () => {
    const { error } = await getSupabaseBrowserClient().auth.signOut();
    if (error) {
      toast.error("Could not sign out. Please try again.");
      return;
    }
    router.push("/login");
    router.refresh();
  };

  const displayName = user?.fullName ?? user?.email ?? "";
  const initials = user ? initialsFor(user.fullName, user.email) : "··";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size={showName ? "default" : "icon"}
          aria-label="Open profile menu"
          className={cn("gap-2", className)}
        >
          <Avatar className="size-6">
            <AvatarFallback className="bg-primary/15 text-[11px] font-medium text-primary">
              {initials}
            </AvatarFallback>
          </Avatar>
          {showName ? (
            <span className="truncate text-sm font-medium">{displayName}</span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="flex flex-col gap-0.5 py-1.5">
          <span className="text-sm font-medium text-foreground">
            {loading ? "Loading…" : displayName}
          </span>
          {user?.email ? (
            <span className="text-xs font-normal">{user.email}</span>
          ) : null}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onSelect={() => router.push("/settings")}>
            <UserIcon />
            Profile
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => router.push("/settings")}>
            <SettingsIcon />
            Settings
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => router.push("/memory")}>
            <BrainIcon />
            Memory
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => toast.info("Press Ctrl + K to search from anywhere.")}
          >
            <KeyboardIcon />
            Keyboard shortcuts
            <span className="ml-auto text-xs tracking-widest text-muted-foreground">⌘K</span>
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <SunIcon className="dark:hidden" />
            <MoonIcon className="hidden dark:block" />
            Theme
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem onClick={() => setTheme("light")}>
              <SunIcon />
              Light
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setTheme("dark")}>
              <MoonIcon />
              Dark
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setTheme("system")}>
              <LaptopIcon />
              System
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => void handleSignOut()}>
          <LogOutIcon />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
