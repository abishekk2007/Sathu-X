"use client";

import * as React from "react";
import { Loader2Icon } from "lucide-react";
import { toast } from "sonner";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useProfile } from "@/hooks/use-profile";
import type { AiMode, ProfileRecord } from "@/types";
import { cn } from "@/lib/utils";

function initialsFor(name: string | null, email: string | null): string {
  const source = name?.trim() || email || "";
  if (!source) return "··";
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  const letters =
    parts.length >= 2 ? parts[0][0] + parts[1][0] : source.slice(0, 2);
  return letters.toUpperCase() || "··";
}

interface FormValues {
  fullName: string;
  bio: string;
  college: string;
  course: string;
  year: string;
  preferredMode: AiMode;
  department: string;
  semester: string;
  academicGoal: string;
  learningStyle: string;
  preferredLanguage: string;
  targetScore: string;
}

function toFormValues(profile: ProfileRecord): FormValues {
  return {
    fullName: profile.fullName ?? "",
    bio: profile.bio ?? "",
    college: profile.college ?? "",
    course: profile.course ?? "",
    year: profile.year ?? "",
    preferredMode: profile.preferredMode ?? "general",
    department: profile.department ?? "",
    semester: profile.semester ?? "",
    academicGoal: profile.academicGoal ?? "",
    learningStyle: profile.learningStyle ?? "",
    preferredLanguage: profile.preferredLanguage ?? "",
    targetScore: profile.targetScore ?? "",
  };
}

type SaveStatus = "idle" | "saving" | "saved" | "error";

/**
 * Real profile editor backed by /api/profile. Replaces the Phase 3 demo
 * fields inside Settings → Account.
 */
export function ProfileEditor() {
  const { profile, loading, error, reload, save } = useProfile();

  if (loading) {
    return (
      <section className="space-y-4 rounded-2xl border bg-card p-5" aria-busy="true">
        <div className="h-4 w-24 animate-pulse rounded bg-muted" />
        <div className="flex items-center gap-4">
          <div className="size-14 animate-pulse rounded-full bg-muted" />
          <div className="h-9 w-28 animate-pulse rounded-md bg-muted" />
        </div>
        {[0, 1, 2].map((row) => (
          <div key={row} className="space-y-1.5">
            <div className="h-3 w-20 animate-pulse rounded bg-muted" />
            <div className="h-9 w-full animate-pulse rounded-md bg-muted" />
          </div>
        ))}
        <p className="sr-only">Loading your profile…</p>
      </section>
    );
  }

  if (error || !profile) {
    return (
      <section className="space-y-3 rounded-2xl border border-destructive/40 bg-destructive/5 p-5">
        <p className="text-sm font-medium text-destructive">
          Unable to load your profile.
        </p>
        <p className="text-xs text-muted-foreground">
          Check your connection and try again.
        </p>
        <Button size="sm" variant="outline" onClick={() => void reload()}>
          Retry
        </Button>
      </section>
    );
  }

  // Keyed remount so arriving profile data initializes the form exactly once.
  return (
    <ProfileForm
      key={`${profile.email}-${profile.fullName}-${profile.bio?.length ?? 0}`}
      initial={toFormValues(profile)}
      avatarUrl={profile.avatarUrl}
      email={profile.email}
      onSave={save}
    />
  );
}

function ProfileForm({
  initial,
  email,
  avatarUrl,
  onSave,
}: {
  initial: FormValues;
  avatarUrl: string | null;
  email: string | null;
  onSave: (patch: Record<string, string>) => Promise<{ ok: boolean }>;
}) {
  const [values, setValues] = React.useState<FormValues>(initial);
  const [status, setStatus] = React.useState<SaveStatus>("idle");
  const savedTimer = React.useRef<number | null>(null);

  React.useEffect(() => {
    return () => {
      if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
    };
  }, []);

  const dirty =
    values.fullName !== initial.fullName ||
    values.bio !== initial.bio ||
    values.college !== initial.college ||
    values.course !== initial.course ||
    values.year !== initial.year ||
    values.preferredMode !== initial.preferredMode ||
    values.department !== initial.department ||
    values.semester !== initial.semester ||
    values.academicGoal !== initial.academicGoal ||
    values.learningStyle !== initial.learningStyle ||
    values.preferredLanguage !== initial.preferredLanguage ||
    values.targetScore !== initial.targetScore;

  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]) => {
    setValues((previous) => ({ ...previous, [key]: value }));
  };

  const handleSave = async () => {
    if (status === "saving") return;
    setStatus("saving");
    const result = await onSave({
      fullName: values.fullName.trim(),
      bio: values.bio.trim(),
      college: values.college.trim(),
      course: values.course.trim(),
      year: values.year.trim(),
      preferredMode: values.preferredMode,
      department: values.department.trim(),
      semester: values.semester.trim(),
      academicGoal: values.academicGoal.trim(),
      learningStyle: values.learningStyle.trim(),
      preferredLanguage: values.preferredLanguage.trim(),
      targetScore: values.targetScore.trim(),
    });
    if (result.ok) {
      setStatus("saved");
      toast.success("Profile saved");
      if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
      savedTimer.current = window.setTimeout(() => setStatus("idle"), 2500);
    } else {
      setStatus("error");
      toast.error("Could not save your profile. Please try again.");
    }
  };

  const initials = initialsFor(values.fullName || initial.fullName, email);

  return (
    <section className="space-y-4 rounded-2xl border bg-card p-5">
      <div>
        <h2 className="text-sm font-semibold">Profile</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          How Spidey Bot knows you — used to personalize replies.
        </p>
      </div>

      <div className="flex items-center gap-4">
        <Avatar className="size-14">
          {avatarUrl ? <AvatarImage src={avatarUrl} alt="" /> : null}
          <AvatarFallback className="bg-primary/15 text-lg font-medium text-primary">
            {initials}
          </AvatarFallback>
        </Avatar>
        {/* Avatar upload arrives with Supabase storage in a later phase. */}
        <Button variant="outline" size="sm" disabled>
          Change image
        </Button>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="profile-name">Full name</Label>
        <Input
          id="profile-name"
          value={values.fullName}
          maxLength={80}
          placeholder="Your name"
          onChange={(event) => set("fullName", event.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="profile-email">Email</Label>
        <Input
          id="profile-email"
          type="email"
          value={email ?? ""}
          disabled
          aria-readonly="true"
        />
        <p className="text-[11px] text-muted-foreground">
          Managed by your sign-in method and cannot be changed here.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="profile-college">College</Label>
          <Input
            id="profile-college"
            value={values.college}
            maxLength={120}
            placeholder="e.g. Panimalar Engineering College"
            onChange={(event) => set("college", event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="profile-course">Course</Label>
          <Input
            id="profile-course"
            value={values.course}
            maxLength={120}
            placeholder="e.g. Computer Science"
            onChange={(event) => set("course", event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="profile-year">Year</Label>
          <Input
            id="profile-year"
            value={values.year}
            maxLength={40}
            placeholder="e.g. 1st Year"
            onChange={(event) => set("year", event.target.value)}
          />
        </div>
      </div>

      <div className="space-y-3 rounded-xl border bg-muted/30 p-4">
        <div>
          <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Academic context
          </h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Optional — helps Student mode personalize explanations.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="profile-department">Department</Label>
            <Input
              id="profile-department"
              value={values.department}
              maxLength={80}
              placeholder="e.g. CSE"
              onChange={(event) => set("department", event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="profile-semester">Semester</Label>
            <Input
              id="profile-semester"
              value={values.semester}
              maxLength={40}
              placeholder="e.g. 3"
              onChange={(event) => set("semester", event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="profile-goal">Academic goal</Label>
            <Input
              id="profile-goal"
              value={values.academicGoal}
              maxLength={200}
              placeholder="e.g. Improve semester performance"
              onChange={(event) => set("academicGoal", event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="profile-learning-style">Learning style</Label>
            <Input
              id="profile-learning-style"
              value={values.learningStyle}
              maxLength={120}
              placeholder="e.g. Examples first, then theory"
              onChange={(event) => set("learningStyle", event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="profile-language">Preferred language</Label>
            <Input
              id="profile-language"
              value={values.preferredLanguage}
              maxLength={40}
              placeholder="e.g. English"
              onChange={(event) => set("preferredLanguage", event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="profile-target-score">Target score</Label>
            <Input
              id="profile-target-score"
              value={values.targetScore}
              maxLength={40}
              placeholder="e.g. CGPA 9"
              onChange={(event) => set("targetScore", event.target.value)}
            />
          </div>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="profile-bio">Bio</Label>
        <Textarea
          id="profile-bio"
          value={values.bio}
          maxLength={500}
          rows={3}
          placeholder="A sentence or two about you."
          onChange={(event) => set("bio", event.target.value)}
        />
        <p className="text-right text-[11px] text-muted-foreground">
          {values.bio.length}/500
        </p>
      </div>

      <div className="space-y-1.5">
        <Label>Preferred AI mode</Label>
        <Select
          value={values.preferredMode}
          onValueChange={(value) => set("preferredMode", value as AiMode)}
        >
          <SelectTrigger className="w-full sm:max-w-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="general">General</SelectItem>
            <SelectItem value="student">Student</SelectItem>
            <SelectItem value="assistant">Assistant</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground">
          Default mode for new conversations.
        </p>
      </div>

      <div className="flex items-center justify-end gap-3 pt-1">
        <span
          aria-live="polite"
          className={cn(
            "text-xs",
            status === "saved" && "text-emerald-500",
            status === "error" && "text-destructive"
          )}
        >
          {status === "saving"
            ? "Saving…"
            : status === "saved"
              ? "Saved ✓"
              : status === "error"
                ? "Not saved"
                : ""}
        </span>
        <Button
          size="sm"
          onClick={() => void handleSave()}
          disabled={!dirty && status !== "error"}
        >
          {status === "saving" ? (
            <>
              <Loader2Icon className="animate-spin" />
              Saving…
            </>
          ) : (
            "Save changes"
          )}
        </Button>
      </div>
    </section>
  );
}
