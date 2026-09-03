import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Deno Edge Functions run outside the Next.js toolchain.
    "supabase/functions/**",
    // Archived full-project snapshot (serves earlier-phase test reporting).
    // Its own tooling output and `.env*` secrets must never be linted.
    "supabase/migrations/spidey-bot/**",
  ]),
]);

export default eslintConfig;
