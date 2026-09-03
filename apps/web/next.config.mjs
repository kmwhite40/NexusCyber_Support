/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Emit a self-contained server bundle for the Docker runtime image.
  output: 'standalone',
  // Build output directory. Defaults to .next (dev, CI, Docker all use it). A production
  // `next build` on a machine where `next dev` is running must set NEXT_DIST_DIR to an
  // isolated dir (e.g. .next-deploy) so it never clobbers the dev server's .next cache.
  distDir: process.env.NEXT_DIST_DIR || '.next',
};
export default nextConfig;
