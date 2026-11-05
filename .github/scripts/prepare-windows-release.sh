#!/usr/bin/env bash
set -euo pipefail

shopt -s nullglob
linux_archives=(dist/*-linux64.tar.gz)
checksums=(dist/*-checksums.txt)
if (( ${#linux_archives[@]} != 1 || ${#checksums[@]} != 1 )); then
  echo "Expected one Linux archive and one checksum file in dist/" >&2
  exit 1
fi
if [[ ! -f work/windows-app/streamlink-twitch-gui.exe ]]; then
  echo "The compiled Windows application is missing" >&2
  exit 1
fi
(cd dist && sha256sum --check "${checksums[0]#dist/}")

windows_archive="${linux_archives[0]%-linux64.tar.gz}-win64.zip"
rm -f "$windows_archive"
bash "${BASH_SOURCE[0]%/*}/../../build/resources/archive/zip.sh" \
  work/windows-app "$windows_archive" streamlink-twitch-gui

(cd dist && sha256sum "${linux_archives[0]#dist/}" "${windows_archive#dist/}") \
  > "${checksums[0]}"
