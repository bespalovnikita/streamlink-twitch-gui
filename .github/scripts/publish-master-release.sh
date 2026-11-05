#!/usr/bin/env bash
set -euo pipefail

: "${GH_REPO:?GH_REPO is required}"
: "${GITHUB_SHA:?GITHUB_SHA is required}"
[[ "$GITHUB_SHA" =~ ^[a-f0-9]{40}$ ]] || exit 1

shopt -s nullglob
archives=(dist/*.tar.gz)
checksums=(dist/*-checksums.txt)
if (( ${#archives[@]} != 1 || ${#checksums[@]} != 1 )); then
  echo "Expected one Linux archive and one checksum file in dist/" >&2
  exit 1
fi
(cd dist && sha256sum --check "${checksums[0]#dist/}")

version="$(node -p 'require("./package.json").version')"
tag="v${version}-master.g${GITHUB_SHA}"
notes_file="$(mktemp)"
trap 'rm -f "$notes_file"' EXIT

printf 'Предварительная сборка master для Linux x64.\n\nКоммит: `%s`.\n\nАрхив и SHA256 взяты из артефакта того же запуска CI после успешных проверок Linux и Windows.\n\nДля просмотра трансляций отдельно установите Streamlink и совместимый видеопроигрыватель.\n' \
  "$GITHUB_SHA" > "$notes_file"

if ! release_sha="$(gh api "repos/${GH_REPO}/commits/${tag}" --jq .sha 2>/dev/null)"; then
  gh api --method POST "repos/${GH_REPO}/git/refs" \
    -f "ref=refs/tags/${tag}" -f "sha=${GITHUB_SHA}" > /dev/null
  release_sha="$GITHUB_SHA"
fi
if [[ "$release_sha" != "$GITHUB_SHA" ]]; then
  echo "Release tag does not point to the tested commit" >&2
  exit 1
fi

if ! is_draft="$(gh release view "$tag" --json isDraft --jq .isDraft 2>/dev/null)"; then
  gh release create "$tag" \
    --target "$GITHUB_SHA" \
    --title "Сборка master (${GITHUB_SHA:0:8})" \
    --notes-file "$notes_file" \
    --verify-tag --draft --prerelease --latest=false
  is_draft=true
fi

if [[ "$is_draft" == true ]]; then
  # Only a draft can be resumed; published assets remain unchanged on retries.
  gh release upload "$tag" "${archives[@]}" "${checksums[@]}" --clobber
  gh release edit "$tag" --draft=false --prerelease --latest=false
elif [[ "$is_draft" != false ]]; then
  echo "Unexpected release state" >&2
  exit 1
fi

release_url="$(gh release view "$tag" --json url --jq .url)"
printf '%s\n' "$release_url"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  printf '[Скачать сборку Linux x64](%s)\n' "$release_url" >> "$GITHUB_STEP_SUMMARY"
fi
