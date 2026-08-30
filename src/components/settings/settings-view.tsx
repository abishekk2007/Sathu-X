"use client";

import * as React from "react";
import Link from "next/link";
import { useTheme } from "next-themes";
import {
  BrainIcon,
  LaptopIcon,
  MoonIcon,
  SettingsIcon,
  SunIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/shared/page-header";
import { ProfileEditor } from "@/components/settings/profile-editor";
import { cn } from "@/lib/utils";

const tabs = [
  { value: "account", label: "Account" },
  { value: "appearance", label: "Appearance" },
  { value: "ai", label: "AI Preferences" },
  { value: "memory", label: "Memory" },
  { value: "notifications", label: "Notifications" },
  { value: "privacy", label: "Privacy" },
  { value: "danger", label: "Danger Zone" },
] as const;

type TabValue = (typeof tabs)[number]["value"];

export function SettingsView() {
  const [tab, setTab] = React.useState<TabValue>("account");

  return (
    <div className="h-full overflow-y-auto scrollbar-slim">
      <div className="mx-auto max-w-4xl space-y-6 px-4 py-6 sm:px-6">
        <PageHeader
          icon={SettingsIcon}
          title="Settings"
          description="Tune Spidey Bot to work the way you do."
        />

        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as TabValue)}
          orientation="vertical"
          className="flex-col gap-4 lg:flex-row lg:gap-8"
        >
          <TabsList className="h-fit w-full flex-row justify-start overflow-x-auto scrollbar-slim lg:w-44 lg:flex-col lg:justify-center">
            {tabs.map((item) => (
              <TabsTrigger
                key={item.value}
                value={item.value}
                className={cn(
                  "px-3 py-1.5 whitespace-nowrap",
                  item.value === "danger" && "text-destructive data-active:text-destructive"
                )}
              >
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <div className="min-w-0 flex-1">
            <TabsContent value="account" className="space-y-5">
              <ProfileEditor />
            </TabsContent>

            <TabsContent value="appearance" className="space-y-5">
              <SettingsSection title="Theme" description="Dark is tuned first — pick what suits your eyes.">
                <ThemePicker />
              </SettingsSection>
            </TabsContent>

            <TabsContent value="ai" className="space-y-5">
              <SettingsSection title="AI preferences" description="Defaults applied to every conversation.">
                <SettingField label="Response style">
                  <SelectDemo options={["Concise", "Balanced", "Detailed"]} defaultValue="Balanced" />
                </SettingField>
                <SettingField label="Response length">
                  <SelectDemo options={["Short", "Medium", "Long"]} defaultValue="Medium" />
                </SettingField>
                <SettingField label="Preferred language">
                  <SelectDemo options={["English", "हिन्दी", "தமிழ்"]} defaultValue="English" />
                </SettingField>
                <ToggleRow
                  label="Student mode by default"
                  hint="Open new chats with exam-focused answers."
                  defaultChecked
                />
                <div className="flex justify-end pt-1">
                  <SaveButton />
                </div>
              </SettingsSection>
            </TabsContent>

            <TabsContent value="memory" className="space-y-5">
              <SettingsSection title="Memory" description="What Spidey Bot remembers between chats.">
                <div className="rounded-xl border bg-muted/30 p-4 text-sm leading-relaxed text-muted-foreground">
                  When you ask Spidey Bot to remember something — &ldquo;Remember that I
                  prefer concise explanations&rdquo; — it saves that fact for future
                  chats. Nothing else is stored, secrets are never kept, and you can
                  review or delete everything in{" "}
                  <Link href="/memory" className="font-medium text-primary underline-offset-4 hover:underline">
                    Spidey Memory
                  </Link>
                  .
                </div>
              </SettingsSection>
            </TabsContent>

            <TabsContent value="notifications" className="space-y-5">
              <SettingsSection title="Notifications" description="Choose which nudges reach you.">
                <ToggleRow
                  icon={<BrainIcon className="size-4 text-primary" />}
                  label="Study notifications"
                  hint="Progress nudges toward daily study goals."
                  defaultChecked
                />
                <ToggleRow label="Reminders" hint="Alerts at the exact time you set." defaultChecked />
                <ToggleRow label="Document updates" hint="When uploads finish processing." />
                <div className="flex justify-end pt-1">
                  <SaveButton />
                </div>
              </SettingsSection>
            </TabsContent>

            <TabsContent value="privacy" className="space-y-5">
              <SettingsSection title="Privacy & data" description="Your data belongs to you.">
                {/* Demo actions — real data controls arrive with the backend. */}
                <ActionRow
                  label="Export your data"
                  hint="Download conversations, tasks and memories as JSON."
                  action={
                    <Button variant="outline" size="sm" onClick={() => toast.info("Export will be available once the backend connects.")}>
                      Export
                    </Button>
                  }
                />
                <Separator />
                <ActionRow
                  label="Delete chat history"
                  hint="Permanently removes all conversations."
                  action={
                    <DeleteConfirmDialog
                      trigger={<Button variant="destructive" size="sm">Delete history</Button>}
                      title="Delete all chat history?"
                      description="This permanently removes every conversation. This action cannot be undone."
                      onConfirm={() => toast.success("Chat history deleted (demo)")}
                    />
                  }
                />
              </SettingsSection>
            </TabsContent>

            <TabsContent value="danger" className="space-y-5">
              <div className="rounded-2xl border border-destructive/40 bg-destructive/5 p-5">
                <p className="font-medium text-destructive">Danger zone</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Deleting your account removes your profile, chats, documents,
                  memories and schedules forever.
                </p>
                <DeleteConfirmDialog
                  trigger={
                    <Button variant="destructive" size="sm" className="mt-4">
                      Delete account
                    </Button>
                  }
                  title="Delete your account?"
                  description="This permanently deletes your account and all associated data. This action cannot be undone."
                  confirmLabel="Yes, delete my account"
                  onConfirm={() => toast.success("Account deletion requested (demo)")}
                />
              </div>
            </TabsContent>
          </div>
        </Tabs>
      </div>
    </div>
  );
}

function SaveButton() {
  return (
    <Button size="sm" onClick={() => toast.success("Settings saved")}>
      Save changes
    </Button>
  );
}

function ThemePicker() {
  const { theme, setTheme } = useTheme();
  const themes = [
    { value: "light", label: "Light", icon: SunIcon },
    { value: "dark", label: "Dark", icon: MoonIcon },
    { value: "system", label: "System", icon: LaptopIcon },
  ] as const;

  return (
    <div className="grid grid-cols-3 gap-2.5" role="radiogroup" aria-label="Theme">
      {themes.map((item) => (
        <button
          key={item.value}
          type="button"
          role="radio"
          aria-checked={theme === item.value}
          onClick={() => setTheme(item.value)}
          className={cn(
            "flex flex-col items-center gap-2 rounded-xl border bg-background p-4 text-sm font-medium transition-colors hover:border-primary/40",
            theme === item.value && "border-primary ring-1 ring-primary"
          )}
        >
          <span
            className={cn(
              "flex size-9 items-center justify-center rounded-lg",
              theme === item.value ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
            )}
          >
            <item.icon className="size-4.5" />
          </span>
          {item.label}
        </button>
      ))}
    </div>
  );
}

function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4 rounded-2xl border bg-card p-5">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

function SettingField({
  id,
  label,
  children,
}: {
  id?: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

function SelectDemo({
  options,
  defaultValue,
}: {
  options: string[];
  defaultValue?: string;
}) {
  const [value, setValue] = React.useState(defaultValue ?? options[0]);
  return (
    <Select value={value} onValueChange={setValue}>
      <SelectTrigger className="w-full sm:max-w-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option} value={option}>
            {option}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ToggleRow({
  label,
  hint,
  icon,
  defaultChecked = false,
}: {
  label: string;
  hint?: string;
  icon?: React.ReactNode;
  defaultChecked?: boolean;
}) {
  const [checked, setChecked] = React.useState(defaultChecked);
  return (
    <div className="flex items-center justify-between gap-4 py-1">
      <span className="flex items-start gap-2.5">
        {icon ? <span className="mt-0.5">{icon}</span> : null}
        <span>
          <span className="block text-sm font-medium">{label}</span>
          {hint ? <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span> : null}
        </span>
      </span>
      <Switch checked={checked} onCheckedChange={setChecked} aria-label={`Toggle ${label}`} />
    </div>
  );
}

function ActionRow({
  label,
  hint,
  action,
}: {
  label: string;
  hint?: string;
  action: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-1">
      <span>
        <span className="block text-sm font-medium">{label}</span>
        {hint ? <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span> : null}
      </span>
      {action}
    </div>
  );
}

function DeleteConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel = "Delete",
  onConfirm,
}: {
  trigger: React.ReactElement<{ onClick?: () => void }>;
  title: string;
  description: string;
  confirmLabel?: string;
  onConfirm: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {React.cloneElement(trigger, { onClick: () => setOpen(true) })}
      <DialogContent showCloseButton={false} className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              setOpen(false);
              onConfirm();
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
