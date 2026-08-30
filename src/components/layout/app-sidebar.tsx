"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { MessageSquarePlusIcon, PanelLeftIcon, SearchIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SidebarUserCard } from "@/components/layout/sidebar-user-card";
import {
  primaryNav,
  settingsNav,
  type NavItem,
} from "@/components/layout/nav-config";
import { SpideyLogo } from "@/components/branding/spidey-logo";
import { useCommandPalette } from "@/components/layout/command-palette";
import { cn } from "@/lib/utils";

function NavLink({
  item,
  collapsed,
  active,
  onNavigate,
}: {
  item: NavItem;
  collapsed: boolean;
  active: boolean;
  onNavigate?: () => void;
}) {
  const link = (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm font-medium text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        collapsed && "justify-center px-0",
        active &&
          "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary"
      )}
    >
      <item.icon className="size-4 shrink-0" />
      {!collapsed && <span className="truncate">{item.title}</span>}
    </Link>
  );

  if (!collapsed) return link;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={12}>
        {item.title}
      </TooltipContent>
    </Tooltip>
  );
}

export function AppSidebar({
  collapsed = false,
  isDesktop = true,
  onToggleCollapsed,
  onNavigate,
}: {
  collapsed?: boolean;
  isDesktop?: boolean;
  onToggleCollapsed?: () => void;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const { setOpen: setPaletteOpen } = useCommandPalette();
  const isActive = (href: string) => pathname.startsWith(href);

  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground">
      <div
        className={cn(
          "flex h-14 shrink-0 items-center gap-1 border-b border-sidebar-border px-3",
          collapsed && "justify-center px-2"
        )}
      >
        <Link href="/chat" onClick={onNavigate} aria-label="Spidey Bot home">
          <SpideyLogo compact={collapsed} className={collapsed ? "" : "pr-2"} />
        </Link>
        {isDesktop && !collapsed && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto text-muted-foreground"
            onClick={onToggleCollapsed}
            aria-label="Collapse sidebar"
          >
            <PanelLeftIcon />
          </Button>
        )}
      </div>

      <div className={cn("flex shrink-0 flex-col gap-1 p-3", collapsed && "px-2")}>
        <Button
          size="sm"
          className={cn("h-9 justify-start gap-2", collapsed && "justify-center")}
          onClick={() => onNavigate?.()}
          asChild
        >
          <Link href="/chat?new=1">
            <MessageSquarePlusIcon />
            {!collapsed && "New chat"}
          </Link>
        </Button>
        {collapsed ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Search chats"
                onClick={() => {
                  onNavigate?.();
                  setPaletteOpen(true);
                }}
              >
                <SearchIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={12}>
              Search chats · Ctrl K
            </TooltipContent>
          </Tooltip>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="h-9 justify-start gap-2 text-muted-foreground"
            onClick={() => {
              onNavigate?.();
              setPaletteOpen(true);
            }}
          >
            <SearchIcon />
            Search chats
            <span className="ml-auto text-[11px] tracking-widest text-muted-foreground/70">
              CTRL K
            </span>
          </Button>
        )}
      </div>

      <nav
        aria-label="Primary"
        className={cn(
          "min-h-0 flex-1 overflow-y-auto scrollbar-slim p-3 pt-1",
          collapsed && "px-2"
        )}
      >
        <ul className="flex flex-col gap-1">
          {primaryNav.map((item) => (
            <li key={item.href}>
              <NavLink
                item={item}
                collapsed={collapsed}
                active={isActive(item.href)}
                onNavigate={onNavigate}
              />
            </li>
          ))}
        </ul>
        <div className="my-3 border-t border-sidebar-border" />
        <ul className="flex flex-col gap-1">
          <li>
            <NavLink
              item={settingsNav}
              collapsed={collapsed}
              active={isActive(settingsNav.href)}
              onNavigate={onNavigate}
            />
          </li>
        </ul>
      </nav>

      <div
        className={cn(
          "shrink-0 border-t border-sidebar-border p-3",
          collapsed && "flex justify-center px-2"
        )}
      >
        <SidebarUserCard collapsed={collapsed} />
      </div>
    </div>
  );
}
