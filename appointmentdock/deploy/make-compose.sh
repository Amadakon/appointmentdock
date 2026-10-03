#!/bin/sh
# Builds a self-contained docker-compose.yml for the Hostinger VPS Docker manager.
# The app is minified with esbuild and embedded as a gzipped tarball in an
# environment variable, so the server needs no git access or build step.
#   deploy/make-compose.sh > /tmp/appointmentdock-compose.yml
set -eu
cd "$(dirname "$0")/.."
ESBUILD=${ESBUILD:-npx --yes esbuild@0.25}
OUT=$(mktemp -d)
mkdir -p "$OUT/src" "$OUT/public/static"
$ESBUILD src/server.js --bundle --platform=node --format=esm --minify --target=node22 --outfile="$OUT/src/server.js" --log-level=warning
$ESBUILD public/static/book.js public/static/dashboard.js public/static/login.js public/static/setup.js public/static/manage.js public/static/index.js \
  --bundle --splitting --minify --format=esm --target=es2022 --outdir="$OUT/public/static" --chunk-names=c-[hash] --log-level=warning
$ESBUILD public/static/app.css --minify --outfile="$OUT/public/static/app.css" --log-level=warning
cp public/*.html "$OUT/public/"
cp public/static/favicon.svg "$OUT/public/static/"
echo '{"type":"module"}' > "$OUT/package.json"
BUNDLE=$(cd "$OUT" && tar --sort=name --owner=0 --group=0 --mtime='2026-01-01' -cf - . | gzip -9n | base64 -w 120 | sed 's/^/        /')
rm -rf "$OUT"
VERSION=$(git rev-parse --short HEAD 2>/dev/null || echo dev)
awk -v b="$BUNDLE" -v v="$VERSION" '{ if ($0 ~ /__BUNDLE__/) print b; else { gsub(/__VERSION__/, v); print } }' deploy/compose.template.yml
