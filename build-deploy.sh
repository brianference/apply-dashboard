#!/usr/bin/env bash
#
# Build the directory that actually gets deployed, then deploy it.
#
# The deployed site is NOT this repository root. Pages serves the shared header
# from /shared/site-nav.js, but the source lives at web/shared/site-nav.js, so
# deploying "." makes that URL fall through to index.html. The browser then
# refuses it for having a text/html MIME type, the header module never runs,
# and anything waiting on it silently never renders. The README documented
# `wrangler pages deploy .` and that command has never been the one that works.
#
# So web/* is flattened to the root of .deploy/ and that is what ships.
#
#   ./build-deploy.sh          build .deploy only
#   ./build-deploy.sh --deploy build and push to production
#
set -euo pipefail
cd "$(dirname "$0")"

OUT=.deploy
rm -rf "$OUT"
mkdir -p "$OUT"

cp index.html _headers "$OUT"/

# Stamp the build so a page served from an older deploy says so rather than
# looking identical to a fresh one. A ranking rule once changed in code without
# the rows being re-scored, and nothing on the page distinguished the two.
STAMP="$(date -u '+%Y-%m-%d %H:%MZ')"
node -e '
  const fs = require("fs");
  const file = process.argv[1];
  const stamp = process.argv[2];
  const html = fs.readFileSync(file, "utf8");
  if (!html.includes("__BUILD_STAMP__")) {
    console.error("FAIL: __BUILD_STAMP__ placeholder is missing from index.html");
    process.exit(1);
  }
  fs.writeFileSync(file, html.split("__BUILD_STAMP__").join(stamp));
' "$OUT/index.html" "$STAMP"
echo "stamped build $STAMP"
cp ./*.png "$OUT"/ 2>/dev/null || true
cp -r functions "$OUT"/functions
for d in web/*/; do
  cp -r "$d" "$OUT/$(basename "$d")"
done

# The header module is the thing that breaks when this is done wrong, so prove
# it landed rather than trusting the copy.
test -f "$OUT/shared/site-nav.js" || { echo "FAIL: $OUT/shared/site-nav.js missing"; exit 1; }
test -f "$OUT/index.html"         || { echo "FAIL: $OUT/index.html missing"; exit 1; }
echo "built $OUT: $(find "$OUT" -type f | wc -l) files"

if [ "${1:-}" = "--deploy" ]; then
  # --branch main matters: this project's production branch is main, and a
  # mismatch silently publishes a PREVIEW that nobody is looking at.
  npx wrangler pages deploy "$OUT" --project-name apply-dashboard --branch main
fi
