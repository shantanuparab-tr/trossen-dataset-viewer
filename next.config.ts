import type { NextConfig } from "next";
import packageJson from "./package.json";

const nextConfig: NextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  transpilePackages: ["three"],
  // DATASET_URL is read from client components, which only see variables
  // inlined at build time. Without this the browser bundle falls back to
  // huggingface.co and a local dataset root is silently ignored.
  env: {
    DATASET_URL: process.env.DATASET_URL ?? "https://huggingface.co/datasets",
  },
  // Avoid the 200-800ms cold-start cost of barrel-file imports.
  // react-icons re-exports thousands of icon components from /fa, etc.;
  // recharts and @huggingface/hub also have wide entry surfaces.
  experimental: {
    optimizePackageImports: ["react-icons", "recharts", "@huggingface/hub"],
  },
  generateBuildId: () => packageJson.version,
  // The browser talks to one origin only. `/data/*` is forwarded to the file
  // server at request time, so a build carries no hostname and the same image
  // runs on any machine, port or LAN address. DATASET_URL is then the relative
  // path `/data` rather than an absolute URL.
  async rewrites() {
    return [
      {
        source: "/data/:path*",
        destination: `${process.env.DATA_SERVER_URL ?? "http://127.0.0.1:8080"}/:path*`,
      },
    ];
  },
};

export default nextConfig;
