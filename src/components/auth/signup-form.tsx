"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import { GoogleMark } from "@/components/auth/google-mark";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { startGoogleSignIn } from "@/lib/supabase/oauth";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Non-secret failure categories for signUp(). Dev mode surfaces the category
 * tag so configuration problems are diagnosable without exposing anything.
 */
type SignUpErrorCategory =
  | "email_not_allowed"
  | "user_already_registered"
  | "rate_limited"
  | "signups_disabled"
  | "database_error"
  | "network_error"
  | "unexpected_response"
  | "unknown";

function classifySignUpError(error: {
  status?: number;
  message?: string;
}): SignUpErrorCategory {
  const status = error?.status;
  const message = (error?.message ?? "").toLowerCase();

  if (message.includes("already registered")) return "user_already_registered";
  // GoTrue rejects addresses outside the project's allow-listed domains with
  // "Email address \"…\" is invalid" BEFORE any database work happens.
  if (message.includes("invalid") && message.includes("email")) {
    return "email_not_allowed";
  }
  if (message.includes("rate limit") || message.includes("too many")) {
    return "rate_limited";
  }
  if (message.includes("signups not allowed") || message.includes("sign-up")) {
    return "signups_disabled";
  }
  if (
    message.includes("database error saving new user") ||
    status === 500 ||
    status === 502 ||
    status === 503
  ) {
    return "database_error";
  }
  if (message.includes("failed to fetch") || message.includes("network")) {
    return "network_error";
  }
  if (status === 429) return "rate_limited";
  return "unknown";
}

const isDev = process.env.NODE_ENV !== "production";

function scorePassword(password: string): number {
  let score = 0;
  if (password.length >= 8) score++;
  if (password.length >= 12) score++;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score++;
  if (/\d/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;
  return Math.min(score, 4);
}

const strengthMeta = [
  { label: "Too weak", className: "bg-red-500" },
  { label: "Weak", className: "bg-red-400" },
  { label: "Fair", className: "bg-amber-500" },
  { label: "Good", className: "bg-lime-500" },
  { label: "Strong", className: "bg-emerald-500" },
] as const;

export function SignupForm() {
  const router = useRouter();
  const [fullName, setFullName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [agreedToTerms, setAgreedToTerms] = React.useState(false);
  const [showPassword, setShowPassword] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string | undefined>>({});
  const [submitting, setSubmitting] = React.useState(false);

  const strength = password ? scorePassword(password) : -1;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const nextErrors: Record<string, string> = {};
    if (fullName.trim().length < 2) nextErrors.fullName = "Enter your full name.";
    if (!emailPattern.test(email)) nextErrors.email = "Enter a valid email address.";
    if (strength < 2) nextErrors.password = "Use 8+ characters with mixed case and a number.";
    if (confirmPassword !== password) nextErrors.confirmPassword = "Passwords don't match.";
    if (!agreedToTerms) nextErrors.terms = "Please accept the terms to continue.";
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setSubmitting(true);
    const { data, error } = await getSupabaseBrowserClient().auth.signUp({
      email,
      password,
      options: {
        data: { full_name: fullName.trim() },
      },
    });

    if (error) {
      setSubmitting(false);
      const category = classifySignUpError(error);
      const devTag = isDev ? ` [signup:${category}]` : "";

      switch (category) {
        case "user_already_registered":
          nextErrors.email = "An account with this email already exists.";
          setErrors(nextErrors);
          return;
        case "email_not_allowed":
          toast.error(
            "This email domain is not accepted. The project restricts sign-ups to allow-listed domains." +
              devTag
          );
          return;
        case "rate_limited":
          toast.error(
            "Too many attempts — please wait a few minutes and try again." + devTag
          );
          return;
        case "signups_disabled":
          toast.error("Sign-ups are currently disabled for this project." + devTag);
          return;
        case "database_error":
          toast.error(
            "Account could not be saved (profile-creation step failed). " +
              "Run supabase/migrations/20260823200000_phase3_auth_repair.sql if this persists." +
              devTag
          );
          return;
        case "network_error":
          toast.error("Network problem — check your connection and try again." + devTag);
          return;
        default:
          toast.error("Could not create your account. Please try again." + devTag);
          return;
      }
    }

    // Defensive: some configurations return neither session nor user.
    if (!data.session && !data.user) {
      setSubmitting(false);
      toast.error(
        "Sign-up did not return an account. Check the project's auth settings." +
          (isDev ? " [signup:unexpected_response]" : "")
      );
      return;
    }

    // Session present immediately when email confirmation is disabled.
    if (data.session) {
      toast.success("Welcome to Spidey Bot!");
      router.push("/chat");
      router.refresh();
      return;
    }

    // Otherwise Supabase sends a confirmation email first.
    toast.success("Account created! Check your inbox to confirm your email.");
    router.push("/login");
  };

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="fullName">Full name</Label>
        <Input
          id="fullName"
          autoComplete="name"
          placeholder="Ada Lovelace"
          value={fullName}
          onChange={(event) => setFullName(event.target.value)}
          aria-invalid={Boolean(errors.fullName)}
        />
        {errors.fullName ? <p role="alert" className="text-xs text-destructive">{errors.fullName}</p> : null}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="signup-email">Email</Label>
        <Input
          id="signup-email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          aria-invalid={Boolean(errors.email)}
        />
        {errors.email ? <p role="alert" className="text-xs text-destructive">{errors.email}</p> : null}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="signup-password">Password</Label>
        <div className="relative">
          <Input
            id="signup-password"
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            placeholder="Create a strong password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={Boolean(errors.password)}
            className="pr-10"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={showPassword ? "Hide password" : "Show password"}
            className="absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground"
            onClick={() => setShowPassword((value) => !value)}
          >
            {showPassword ? <EyeOffIcon /> : <EyeIcon />}
          </Button>
        </div>
        {strength >= 0 ? (
          <div className="flex items-center gap-2 pt-1">
            <div className="flex flex-1 gap-1" aria-hidden="true">
              {[0, 1, 2, 3].map((segment) => (
                <span
                  key={segment}
                  className={`h-1 flex-1 rounded-full ${
                    segment < strength ? strengthMeta[strength].className : "bg-muted"
                  }`}
                />
              ))}
            </div>
            <span className="text-[11px] text-muted-foreground">
              {strengthMeta[strength].label}
            </span>
          </div>
        ) : null}
        {errors.password ? <p role="alert" className="text-xs text-destructive">{errors.password}</p> : null}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="confirm-password">Confirm password</Label>
        <Input
          id="confirm-password"
          type={showPassword ? "text" : "password"}
          autoComplete="new-password"
          placeholder="Repeat your password"
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          aria-invalid={Boolean(errors.confirmPassword)}
        />
        {errors.confirmPassword ? (
          <p role="alert" className="text-xs text-destructive">{errors.confirmPassword}</p>
        ) : null}
      </div>

      <div className="space-y-1.5 pt-1">
        <label className="flex items-start gap-2.5 text-sm text-muted-foreground">
          <Checkbox
            checked={agreedToTerms}
            onCheckedChange={(checked) => setAgreedToTerms(checked === true)}
            aria-label="Agree to terms"
            className="mt-0.5"
          />
          <span>
            I agree to the{" "}
            <Link href="#" className="font-medium text-primary underline-offset-4 hover:underline">
              Terms
            </Link>{" "}
            and{" "}
            <Link href="#" className="font-medium text-primary underline-offset-4 hover:underline">
              Privacy Policy
            </Link>
            .
          </span>
        </label>
        {errors.terms ? <p role="alert" className="text-xs text-destructive">{errors.terms}</p> : null}
      </div>

      <Button type="submit" className="h-9 w-full" disabled={submitting}>
        {submitting ? "Creating account..." : "Create account"}
      </Button>

      <div className="flex items-center gap-3 py-1">
        <Separator className="flex-1" />
        <span className="text-[11px] tracking-wide text-muted-foreground uppercase">or</span>
        <Separator className="flex-1" />
      </div>

      <Button
        type="button"
        variant="outline"
        className="h-9 w-full"
        disabled={submitting}
        onClick={() => void startGoogleSignIn("/chat")}
      >
        <GoogleMark />
        Continue with Google
      </Button>

      <p className="pt-1 text-center text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-primary underline-offset-4 hover:underline">
          Sign in
        </Link>
      </p>
    </form>
  );
}
