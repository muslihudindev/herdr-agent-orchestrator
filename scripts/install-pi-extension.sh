#!/usr/bin/env bash
set -euo pipefail

target_dir="${1:-$PWD}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target_pi_dir="$target_dir/.pi/extensions"
target_extension="$target_pi_dir/herdr-orchestration.ts"
source_extension="$repo_root/.pi/extensions/herdr-orchestration.ts"

mkdir -p "$target_pi_dir"
cat > "$target_extension" <<EOF
export { default } from "${source_extension}";
EOF

echo "Installed HerdR orchestration Pi extension:"
echo "  $target_extension"
echo
echo "Run from the target project:"
echo "  herdr"
echo "  pi --approve"
