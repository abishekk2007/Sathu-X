import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Mark native Node.js modules as server-external so Turbopack doesn't try
  // to bundle their native .node/.js bindings into ESM chunks.
  serverExternalPackages: ["@napi-rs/canvas"],
};

export default nextConfig;
