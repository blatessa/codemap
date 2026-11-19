#!/bin/sh
# Installs the latest codemap release:
#
#   curl -fsSL https://raw.githubusercontent.com/blatessa/codemap/main/install.sh | sh
#
# Environment:
#   CODEMAP_VERSION      a release tag such as v0.1.0 (default: the latest release)
#   CODEMAP_INSTALL_DIR  where to put the binary (default: ~/.local/bin)
set -eu

repo="blatessa/codemap"
dir="${CODEMAP_INSTALL_DIR:-$HOME/.local/bin}"

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) echo "codemap: unsupported OS $(uname -s); build from source with: go install github.com/$repo/cmd/codemap@latest" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=amd64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) echo "codemap: unsupported CPU $(uname -m); build from source with: go install github.com/$repo/cmd/codemap@latest" >&2; exit 1 ;;
esac

if [ -n "${CODEMAP_VERSION:-}" ]; then
  base="https://github.com/$repo/releases/download/$CODEMAP_VERSION"
else
  base="https://github.com/$repo/releases/latest/download"
fi
base="${CODEMAP_BASE_URL:-$base}" # for testing against a local copy
file="codemap_${os}_${arch}.tar.gz"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "Downloading ${file}..."
curl -fsSL "$base/$file" -o "$tmp/$file"
curl -fsSL "$base/checksums.txt" -o "$tmp/checksums.txt"

want="$(grep " $file\$" "$tmp/checksums.txt" | cut -d' ' -f1)"
if command -v sha256sum >/dev/null 2>&1; then
  got="$(sha256sum "$tmp/$file" | cut -d' ' -f1)"
else
  got="$(shasum -a 256 "$tmp/$file" | cut -d' ' -f1)"
fi
if [ -z "$want" ] || [ "$want" != "$got" ]; then
  echo "codemap: checksum mismatch for $file" >&2
  exit 1
fi

tar -xzf "$tmp/$file" -C "$tmp"
mkdir -p "$dir"
mv "$tmp/codemap" "$dir/codemap"
chmod +x "$dir/codemap"
echo "Installed $("$dir/codemap" version) to $dir/codemap"

case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "Add $dir to your PATH, for example: echo 'export PATH=\"$dir:\$PATH\"' >> ~/.profile" ;;
esac
if ! command -v git >/dev/null 2>&1; then echo "Note: codemap needs git for comparing revisions."; fi
echo "Next: cd into a repo and run 'codemap serve'."
