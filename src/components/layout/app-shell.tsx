"use client";

import * as React from "react";
import { MenuIcon } from "lucide-react";

import { cn } from "@/lib/utils";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { AppSidebar } from "@/components/layout/app-sidebar";
import {
  CommandPaletteProvider,
} from "@/components/layout/command-palette";
import { NotificationsPopover } from "@/components/layout/notifications-popover";
import { ProfileMenu } from "@/components/layout/profile-menu";
import { SpideyLogo } from "@/components/branding/spidey-logo";
import { useSidebarCollapsed } from "@/hooks/use-sidebar-collapsed";

export function AppShell({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useSidebarCollapsed();
  const [mobileOpen, setMobileOpen] = React.useState(false);

  return (
    <CommandPaletteProvider>
      <div className="flex h-dvh overflow-hidden bg-background">
        <aside
          className={cn(
            "hidden shrink-0 border-r border-sidebar-border transition-[width] duration-200 lg:block",
            collapsed ? "w-16" : "w-64"
          )}
        >
          <AppSidebar
            collapsed={collapsed}
            onToggleCollapsed={() => setCollapsed(!collapsed)}
          />
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* Mobile top bar */}
          <header className="flex h-14 shrink-0 items-center gap-1.5 border-b px-3 lg:hidden">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Open menu"
              onClick={() => setMobileOpen(true)}
            >
              <MenuIcon />
            </Button>
            <SpideyLogo />
            <span className="ml-auto flex items-center gap-1">
              <NotificationsPopover />
              <ProfileMenu />
            </span>
          </header>

          <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
        </div>

        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetContent
            side="left"
            className="w-72 gap-0 p-0"
            aria-describedby={undefined}
          >
            <SheetHeader className="sr-only">
              <SheetTitle>Navigation</SheetTitle>
            </SheetHeader>
            <AppSidebar isDesktop={false} onNavigate={() => setMobileOpen(false)} />
          </SheetContent>
        </Sheet>
      </div>
    </CommandPaletteProvider>
  );
}
