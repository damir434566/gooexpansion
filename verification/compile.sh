#!/usr/bin/env bash
# Compile the repo's real parser modules for the verification harness.
#
# The tests here import the SHIPPING modules, not copies of them, so they have
# to be compiled first: `verification/compiled/` is a plain CommonJS build of
# `src/`, and the harness maps the project's "@/…" alias onto it at require
# time (see the top of test-server-logic.js).
#
# Point GOO_FASHION at a goo-fashion checkout with this patch applied. It
# defaults to the sibling path the session used, so an ordinary run needs no
# arguments:
#
#   GOO_FASHION=~/code/goo-fashion ./verification/compile.sh
set -euo pipefail

GOO_FASHION="${GOO_FASHION:-/home/user/darakhamia/goo-fashion}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/compiled"

if [ ! -d "$GOO_FASHION/src" ]; then
  echo "No checkout at $GOO_FASHION — set GOO_FASHION to one." >&2
  exit 1
fi

CONFIG="$(mktemp "$GOO_FASHION/tsconfig.verify.XXXXXX.json")"
trap 'rm -f "$CONFIG"' EXIT

cat > "$CONFIG" <<JSON
{
  "compilerOptions": {
    "target": "es2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "lib": ["es2023", "dom"],
    "jsx": "react-jsx",
    "baseUrl": ".",
    "paths": { "@/*": ["./src/*"] },
    "outDir": "$OUT",
    "rootDir": "./src",
    "skipLibCheck": true,
    "noEmitOnError": false,
    "declaration": false,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "types": ["node"]
  },
  "files": [
    "src/lib/server/fx.ts",
    "src/lib/server/product-fields.ts",
    "src/lib/server/parser/robots.ts",
    "src/lib/server/parser/plan-collection.ts",
    "src/lib/server/parser/parse-page.ts",
    "src/lib/server/parser/variant-group.ts",
    "src/lib/server/parser/same-item.ts",
    "src/lib/style-keywords.ts",
    "src/lib/data/db.ts"
  ]
}
JSON

rm -rf "$OUT"
# Type errors from Next-specific globals in files we only need at runtime are
# expected here and do not stop the emit; the project's own `tsc --noEmit` is
# what guards types.
(cd "$GOO_FASHION" && npx tsc -p "$CONFIG" > /dev/null 2>&1) || true

if [ ! -f "$OUT/lib/server/parser/parse-page.js" ]; then
  echo "Compile produced no parse-page.js — check the checkout at $GOO_FASHION." >&2
  exit 1
fi
echo "compiled → $OUT"
