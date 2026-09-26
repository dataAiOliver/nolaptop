import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ssh2 and the Prisma engine are native/CJS — keep them out of the bundler.
  serverExternalPackages: ["ssh2", "@prisma/client"],
  experimental: { esmExternals: true },
};

export default nextConfig;
