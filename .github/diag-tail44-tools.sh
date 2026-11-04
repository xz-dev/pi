set -euo pipefail
# Replaces the original privileged package-install step: no system packages, no /usr writes. Prefer runner tools; otherwise one
# pinned upstream musl binary per tool, verified before extraction, written only to a job-private directory.
out="$RUNNER_TEMP/diag-tail44"
bin="$out/bin"
mkdir -p "$bin" "$out/archives"
fetch_pinned() {
  local name="$1" url="$2" size="$3" archive_sha="$4" member="$5" binary_sha="$6"
  local archive="$out/archives/${url##*/}"
  curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 -o "$archive" "$url"
  [[ "$(stat -c %s "$archive")" == "$size" ]]
  echo "$archive_sha  $archive" | sha256sum --check --strict --quiet -
  [[ "$(tar -tzf "$archive" | grep -cxF "$member")" == 1 ]]
  [[ "$(tar -tvzf "$archive" "$member" | cut -c1)" == - ]]
  tar -xOzf "$archive" "$member" > "$bin/$name.tmp"
  echo "$binary_sha  $bin/$name.tmp" | sha256sum --check --strict --quiet -
  chmod 0755 "$bin/$name.tmp"
  mv "$bin/$name.tmp" "$bin/$name"
}
if command -v fd >/dev/null; then
  fd_source=runner-fd
elif command -v fdfind >/dev/null; then
  # Private equivalent of the original /usr/local/bin/fd symlink.
  ln -s "$(command -v fdfind)" "$bin/fd"
  fd_source=runner-fdfind-private-alias
else
  fetch_pinned fd https://github.com/sharkdp/fd/releases/download/v10.3.0/fd-v10.3.0-x86_64-unknown-linux-musl.tar.gz \
    1759301 2b6bfaae8c48f12050813c2ffe1884c61ea26e750d803df9c9114550a314cd14 \
    fd-v10.3.0-x86_64-unknown-linux-musl/fd 9f48273b6c780a5f4f084ef30bc67d98cbd7d10c55c4605cf3a6ee29b741af87
  fd_source=pinned-archive
fi
if command -v rg >/dev/null; then
  rg_source=runner
else
  fetch_pinned rg https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/ripgrep-15.1.0-x86_64-unknown-linux-musl.tar.gz \
    2263077 1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599 \
    ripgrep-15.1.0-x86_64-unknown-linux-musl/rg ebeaf56f8a25e102e9419933423738b3a2a613a444fd749d695e15eba53f71f2
  rg_source=pinned-archive
fi
echo "$bin" >> "$GITHUB_PATH"
PATH="$bin:$PATH"
echo "fd: $fd_source $(fd --version | head -n1)"
echo "rg: $rg_source $(rg --version | head -n1)"
