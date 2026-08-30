"use client";

import { useCallback, useSyncExternalStore } from "react";

const STORAGE_KEY = "spidey-sidebar-collapsed";

let cachedValue: boolean | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): boolean {
  if (cachedValue === null) {
    try {
      cachedValue = window.localStorage.getItem(STORAGE_KEY) === "true";
    } catch {
      cachedValue = false;
    }
  }
  return cachedValue;
}

function getServerSnapshot(): boolean {
  return false;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Persisted sidebar collapse state (UI-only, localStorage-backed store). */
export function useSidebarCollapsed() {
  const collapsed = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const update = useCallback((value: boolean) => {
    cachedValue = value;
    try {
      window.localStorage.setItem(STORAGE_KEY, String(value));
    } catch {
      // storage unavailable — keep in-memory value
    }
    listeners.forEach((notify) => notify());
  }, []);

  return [collapsed, update] as const;
}
