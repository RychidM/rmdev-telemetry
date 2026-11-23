#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  patch|minor|major) bump=$1 ;;
  *) echo "Usage: npm run release:pr -- patch|minor|major" >&2; exit 2 ;;
esac

repo=RychidM/rmdev-telemetry
git fetch origin main
worktree=$(mktemp -d)
git worktree add --detach "$worktree" origin/main
trap 'git worktree remove --force "$worktree"' EXIT

(
  cd "$worktree"
  tag=$(npm version "$bump" --no-git-tag-version --ignore-scripts)
  branch="release/$tag"
  notes="docs/releases/$tag.md"
  mkdir -p docs/releases
  gh api "repos/$repo/releases/generate-notes" -f tag_name="$tag" \
    -f target_commitish="$(git rev-parse HEAD)" --jq .body > "$notes"
  test -s "$notes"
  git add package.json package-lock.json "$notes"
  git commit -m "Release $tag"
  git push origin "HEAD:refs/heads/$branch"
  gh pr create --repo "$repo" --base main --head "$branch" --title "Release $tag" --body-file "$notes"
)
