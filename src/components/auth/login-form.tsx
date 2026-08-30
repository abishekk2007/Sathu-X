"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { GoogleMark } from "@/components/auth/google-mark";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { startGoogleSignIn } from "@/lib/supabase/oauth";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [showPassword, setShowPassword] = React.useState(false);
  const [errors, setErrors] = React.useState<{ email?: string; password?: string }>({});
  const [submitting, setSubmitting] = React.useState(false);

  // OAuth failures come back as /login?error=oauth from the callback route.
  React.useEffect(() => {
    if (new URLSearchParams(window.location.search).get("error") === "oauth") {
      toast.error("Google sign-in failed or was cancelled. Please try again.");
    }
  }, []);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const nextErrors: typeof errors = {};
    if (!emailPattern.test(email)) nextErrors.email = "Enter a valid email address.";
    if (password.length < 8) nextErrors.password = "Password must be at least 8 characters.";
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setSubmitting(true);
    const { error } = await getSupabaseBrowserClient().auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setSubmitting(false);
      if (error.message === "Invalid login credentials") {
        setErrors({ password: "Incorrect email or password." });
      } else if (error.message === "Email not confirmed") {
        toast.error("Please confirm your email first, then sign in.");
      } else {
        toast.error("Could not sign in. Please try again.");
      }
      return;
    }

    toast.success("Welcome back!");
    router.push("/chat");
    router.refresh();
  };

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          aria-invalid={Boolean(errors.email)}
        />
        {errors.email ? (
          <p role="alert" className="text-xs text-destructive">
            {errors.email}
          </p>
        ) : null}
      </div>

      <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">Password</Label>
            <button
              type="button"
              onClick={() => toast.info("Password reset is coming in a later phase.")}
              className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              Forgot password?
            </button>
          </div>
        <div className="relative">
          <Input
            id="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            placeholder="••••••••"
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
        {errors.password ? (
          <p role="alert" className="text-xs text-destructive">
            {errors.password}
          </p>
        ) : null}
      </div>

      <Button type="submit" className="h-9 w-full" disabled={submitting}>
        {submitting ? "Signing in..." : "Sign in"}
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

      <p className="pt-2 text-center text-sm text-muted-foreground">
        New to Spidey Bot?{" "}
        <Link href="/signup" className="font-medium text-primary underline-offset-4 hover:underline">
          Create an account
        </Link>
      </p>
    </form>
  );
}
