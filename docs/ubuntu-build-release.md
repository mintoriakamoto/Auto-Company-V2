# Ubuntu 26.04 (amd64) Build & Release

Target platform: **Ubuntu 26.04 LTS x86_64 (amd64)**. The runtime is shell +
Python, so the artifacts are architecture-independent in content; `amd64` is the
declared and tested target.

## Artifacts

`make build` (or `./packaging/build-release.sh`) produces into `dist/`:

| Artifact | What it is |
|---|---|
| `auto-company_<version>_amd64.deb` | Debian package: payload in `/opt/auto-company/share`, launcher at `/usr/bin/auto-company` |
| `auto-company-<version>-linux-amd64.tar.gz` | Portable ready-to-run workspace (extract, then `make start`) |
| `SHA256SUMS` | Checksums for both artifacts |

The version comes from the root `VERSION` file (single source of truth; keep
`package.json` in sync when bumping).

## Local build

```bash
sudo apt-get install dpkg-dev   # build dependency
make build
```

## Install and run (.deb)

```bash
sudo apt install ./auto-company_<version>_amd64.deb
auto-company init            # creates ~/auto-company (or $AUTO_COMPANY_HOME)
auto-company start           # foreground loop
auto-company install-daemon  # or run as systemd --user daemon
```

The package payload is read-only under `/opt/auto-company/share`; the loop
writes state (logs, memories, PID files) into the per-user workspace that
`auto-company init` creates. All loop subcommands (`start`, `stop`, `status`,
`last`, `cycles`, `monitor`, `install-daemon`, `uninstall-daemon`) operate on
the resolved workspace.

Runtime dependencies declared by the package: `bash`, `git`, `jq`, `curl`,
`python3` (`nodejs`/`npm` recommended). The engine CLI (Claude Code or Codex)
is **not** packaged — install and authenticate it separately.

## CI pipeline

`.github/workflows/ubuntu-build-release.yml`:

1. **lint** — `bash -n` on all shell scripts; `shellcheck` (blocking for
   `packaging/`, advisory for legacy `scripts/`).
2. **test** — dashboard unit tests (`unittest`) and loop-core tests
   (`bats tests/loop/`) inside an `ubuntu:26.04` container.
3. **build** — builds the `.deb` + tarball inside an `ubuntu:26.04` container
   (asserts `VERSION_ID=26.04`), runs `lintian` (advisory), uploads `dist/*`.
4. **smoke** — fresh `ubuntu:26.04` container: verifies checksums, installs the
   `.deb` via `apt`, runs `auto-company init`, syntax-checks installed scripts,
   and asserts `start` fails fast without an engine CLI.
5. **release** — on `v*` tags only: verifies the tag matches `VERSION`, then
   publishes a GitHub Release with the `.deb`, tarball, and `SHA256SUMS`.

The container pin (`container: ubuntu:26.04`) guarantees the target userspace
even where a `ubuntu-26.04` hosted-runner label is not yet available.

## Cutting a release

```bash
# 1. Bump VERSION (and package.json), commit
# 2. Tag and push
git tag v$(cat VERSION)
git push origin v$(cat VERSION)
```

The workflow builds, smoke-tests, and publishes the release automatically.
