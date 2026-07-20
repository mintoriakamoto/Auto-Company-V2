#!/usr/bin/env bash
# ============================================================
# Auto Company — Build release artifacts for Ubuntu (amd64)
# ============================================================
# Produces into dist/:
#   auto-company_<version>_<arch>.deb        Debian package
#   auto-company-<version>-linux-<arch>.tar.gz  Portable workspace tarball
#   SHA256SUMS                               Checksums for both
#
# Target platform: Ubuntu 26.04 LTS x86_64 (amd64). The payload is
# shell/Python only, so the build itself runs on any Linux with
# dpkg-deb; CI builds and smoke-tests inside an ubuntu:26.04
# container to pin the target userspace.
#
# Config (env vars):
#   AUTO_COMPANY_DEB_ARCH=amd64   Debian Architecture field
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$PROJECT_DIR/dist"
ARCH="${AUTO_COMPANY_DEB_ARCH:-amd64}"

if [ ! -f "$PROJECT_DIR/VERSION" ]; then
    echo "Error: VERSION file not found at repo root." >&2
    exit 1
fi
VERSION="$(tr -d ' \n' < "$PROJECT_DIR/VERSION")"
if ! echo "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([+~.-][A-Za-z0-9.+~-]+)?$'; then
    echo "Error: VERSION '$VERSION' is not a valid version string." >&2
    exit 1
fi

command -v dpkg-deb >/dev/null 2>&1 || {
    echo "Error: dpkg-deb not found. Install with: apt-get install dpkg-dev" >&2
    exit 1
}

STAGE="$(mktemp -d)"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

echo "Building auto-company $VERSION ($ARCH) ..."

# --- 1. Assemble the runtime payload ------------------------------
# Ship only the runtime skeleton: no logs, no live memories, no
# generated role docs, no incubated projects, no git history.
PAYLOAD_DIR="$STAGE/payload"
mkdir -p "$PAYLOAD_DIR"

PAYLOAD_ITEMS=(
    CLAUDE.md
    PROMPT.md
    INDEX.md
    README.md
    README-ZH.md
    ONBOARDING.md
    LICENSE
    Makefile
    VERSION
    .auto-loop.env.example
    .gitignore
    .gitattributes
    .claude
    scripts
    dashboard
    tests
    docs
)

missing=0
for item in "${PAYLOAD_ITEMS[@]}"; do
    if [ ! -e "$PROJECT_DIR/$item" ]; then
        echo "Error: payload item missing: $item" >&2
        missing=1
    fi
done
[ "$missing" -eq 0 ] || exit 1

tar -C "$PROJECT_DIR" \
    --exclude='.git' \
    --exclude='node_modules' \
    --exclude='__pycache__' \
    --exclude='*.pyc' \
    --exclude='.ci-artifacts' \
    -cf - "${PAYLOAD_ITEMS[@]}" | tar -C "$PAYLOAD_DIR" -xf -

# Prune generated docs; recreate runtime-state skeleton with only the
# tracked seed baton (no live consensus/history).
mkdir -p "$PAYLOAD_DIR/memories"
touch "$PAYLOAD_DIR/memories/.gitkeep"
if [ -f "$PROJECT_DIR/memories/consensus.seed.md" ]; then
    cp "$PROJECT_DIR/memories/consensus.seed.md" "$PAYLOAD_DIR/memories/consensus.seed.md"
fi
find "$PAYLOAD_DIR/docs" -type f \
    ! -name '.gitkeep' \
    ! -name 'windows-setup.md' \
    ! -name 'ubuntu-build-release.md' \
    ! -name 'growth-playbook.md' \
    -delete
mkdir -p "$PAYLOAD_DIR/projects"
touch "$PAYLOAD_DIR/projects/.gitkeep"

# Normalize permissions: directories 755, files 644, scripts 755.
find "$PAYLOAD_DIR" -type d -exec chmod 755 {} +
find "$PAYLOAD_DIR" -type f -exec chmod 644 {} +
find "$PAYLOAD_DIR" -type f -name '*.sh' -exec chmod 755 {} +
chmod 755 "$PAYLOAD_DIR/dashboard/server.py"

# --- 2. Build the Debian package ----------------------------------
PKG_ROOT="$STAGE/pkgroot"
mkdir -p "$PKG_ROOT/DEBIAN" \
         "$PKG_ROOT/opt/auto-company" \
         "$PKG_ROOT/usr/bin" \
         "$PKG_ROOT/usr/share/doc/auto-company"

sed -e "s/@VERSION@/$VERSION/" -e "s/@ARCH@/$ARCH/" \
    "$SCRIPT_DIR/deb/control.in" > "$PKG_ROOT/DEBIAN/control"

cp -a "$PAYLOAD_DIR" "$PKG_ROOT/opt/auto-company/share"
install -m 755 "$SCRIPT_DIR/deb/auto-company" "$PKG_ROOT/usr/bin/auto-company"
install -m 644 "$PROJECT_DIR/README.md" "$PKG_ROOT/usr/share/doc/auto-company/README.md"

mkdir -p "$DIST_DIR"
DEB_PATH="$DIST_DIR/auto-company_${VERSION}_${ARCH}.deb"
dpkg-deb --build --root-owner-group "$PKG_ROOT" "$DEB_PATH" >/dev/null
echo "Built: $DEB_PATH"

# --- 3. Build the portable tarball --------------------------------
# The tarball IS a ready-to-run workspace: extract and `make start`.
TAR_NAME="auto-company-${VERSION}-linux-${ARCH}"
TAR_PATH="$DIST_DIR/${TAR_NAME}.tar.gz"
mkdir -p "$STAGE/tarroot"
cp -a "$PAYLOAD_DIR" "$STAGE/tarroot/$TAR_NAME"
tar -C "$STAGE/tarroot" -czf "$TAR_PATH" "$TAR_NAME"
echo "Built: $TAR_PATH"

# --- 4. Checksums --------------------------------------------------
(
    cd "$DIST_DIR"
    sha256sum "$(basename "$DEB_PATH")" "$(basename "$TAR_PATH")" > SHA256SUMS
)
echo "Built: $DIST_DIR/SHA256SUMS"

# --- 5. Sanity checks ----------------------------------------------
dpkg-deb --info "$DEB_PATH" | sed -n '1,12p'
DEB_CONTENTS="$(dpkg-deb --contents "$DEB_PATH")"
echo "$DEB_CONTENTS" | grep -q 'opt/auto-company/share/scripts/core/auto-loop.sh' || {
    echo "Error: auto-loop.sh missing from package contents." >&2
    exit 1
}
echo "$DEB_CONTENTS" | grep -q 'usr/bin/auto-company' || {
    echo "Error: launcher missing from package contents." >&2
    exit 1
}

echo ""
echo "Release artifacts ready in dist/ (version $VERSION, arch $ARCH)."
