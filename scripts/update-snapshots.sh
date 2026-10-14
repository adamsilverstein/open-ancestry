#!/usr/bin/env bash
# Regenerates the Linux visual baselines in e2e/__screenshots__ inside the
# official Playwright Docker image, so they match the ubuntu CI runner.
# The repo is copied into the container (native modules are rebuilt for Linux);
# only the screenshots are written back.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
version="$(node -p "require('$root/node_modules/@playwright/test/package.json').version")"
image="mcr.microsoft.com/playwright:v${version}-noble"

# amd64 matches the GitHub runner, so font rasterization matches too (emulated on Apple silicon).
docker run --rm --ipc=host --platform linux/amd64 \
  -v "$root:/src:ro" \
  -v "$root/e2e/__screenshots__:/out" \
  -w /work \
  "$image" \
  bash -euo pipefail -c '
    tar -C /src --exclude=node_modules --exclude=dist --exclude=coverage \
      --exclude=test-results --exclude=playwright-report --exclude=.git -cf - . | tar -xf -
    # better-sqlite3 may need compiling when no prebuild matches this Node ABI.
    apt-get update -qq && apt-get install -y -qq build-essential python3 >/dev/null
    npm ci --no-audit --no-fund --loglevel=error
    npm run build
    CI=1 npx playwright test -c e2e design.spec.ts --project chromium \
      -g "visual snapshots" --update-snapshots=all --reporter=list
    cp -R e2e/__screenshots__/. /out/
  '
