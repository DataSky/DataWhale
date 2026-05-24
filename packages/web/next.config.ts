import type { NextConfig } from "next"

const config: NextConfig = {
  output: "export",
  distDir: "out",
  trailingSlash: true,
  images: { unoptimized: true },
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
}

export default config
