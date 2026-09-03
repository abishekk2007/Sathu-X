# One-time welcome email — setup & operation

Sends a branded welcome email to a user **exactly once**, after their **first
successful Google OAuth signup**. Everything is server-side and the database
is the source of truth, so re-logins and repeated auth events never re-send.

## Architecture

```
Google OAuth
   ↓ Supabase auth + hosted OAuth
/auth/callback (Next.js Route Handler, server-side)
   ↓ exchanges ?code for session
enqueueWelcomeEmailForGoogleSignup()  (src/lib/supabase/welcome-email.ts)
   ↓ bounded, fail-safe invoke with the user's own JWT
supabase/functions/welcome-email  (Deno Edge Function)
   ↓ checks public.profiles.welcome_email_sent  (atomic claim)
Resend API (RESEND_API_KEY from Supabase secrets)
   ↓ on success: welcome_email_sent_at = now()
```

- The Edge Function reads the caller's identity **only from the Authorization
  bearer JWT** (validated via `auth.getUser(token)`). The request body carries
  nothing — one user can never trigger emails for another address.
- Only `app_metadata.provider === "google"` sessions are eligible.
- The claim is an atomic `UPDATE profiles SET welcome_email_sent = true WHERE
  welcome_email_sent = false` — concurrent events/OAuth callbacks cannot
  double-send. On Resend failure the claim is reverted so the next login
  retries. If the `RESEND_API_KEY` secret is missing, nothing is claimed and
  nothing is sent (503).

## Required secret

```sh
supabase secrets set RESEND_API_KEY=re_xxxxxxxxxxxx
```

`SUPABASE_URL` / `SUPABASE_ANON_KEY` are injected automatically by the CLI;
do not add a service-role key anywhere.

## Deploy the Edge Function

Prereqs: Supabase CLI installed and project linked.

```sh
# 1. install the CLI (macOS/Linux/WSL recommended; binary from
#    https://supabase.com/docs/guides/cli)
# 2. link to the cloud project used by NEXT_PUBLIC_SUPABASE_URL
supabase login
supabase link --project-ref tjdqdrfmcioakhteglg

# 3. set the secret (once)
supabase secrets set RESEND_API_KEY=re_xxxxxxxxxxxx

# 4. apply the tracking migration
supabase db push        # applies supabase/migrations/20260830120000_welcome_email.sql

# 5. deploy the function
supabase functions deploy welcome-email

# optional local smoke test (RESEND key must also exist locally:
#   copy it into supabase/functions/welcome-email/.env as RESEND_API_KEY=...)
# supabase functions serve welcome-email --env-file supabase/functions/welcome-email/.env
```

## Sender requirements

- **Development** — `onboarding@resend.dev` is the default sender. Resend
  allows sending **to one verified recipient** (your account email) on this
  address; other addresses must first be verified in the Resend dashboard.
- **Production** — verify a custom domain in Resend and add its `from`
  address (e.g. `hello@yourdomain.com`). Update `SENDER` in
  `supabase/functions/welcome-email/index.ts`:
  `SENDER = "Sathux Spidey Bot <hello@yourdomain.com>"` then redeploy.

## Local development

- The trigger fires in `/auth/callback` after a successful Google exchange.
- Without the CLI running or the function deployed, `functions.invoke` fails
  silently (logged at `console.warn`) — **authentication is never affected**.
- Run the helper tests with `npx tsx test-welcome-email.ts`.

## Verification checklist

1. New Google account → sign up once → exactly one email; profile now
   `welcome_email_sent = true` with `welcome_email_sent_at` set.
2. Same account logs in again → no email (flag already true).
3. Resend failure (bad key / sender not verified) → user still logs in;
   flag stays `false`; next login retries.
4. Refresh the app after login → no extra email (no client-side trigger).
5. Callback fires twice / two concurrent requests → one email (atomic claim).

## Security notes

- `RESEND_API_KEY` lives only in Supabase secrets / the function env — never
  in client bundles, `NEXT_PUBLIC_*`, or the repository.
- Emails only go to the authenticated user's own verified email.
- Logs never print keys or tokens.