# Dependency update review — 2026-11-17

Reviewed all seven open pull requests in `rusux64-bit/Ripcord` against local
commit `35878d9`. This checkout has only an `origin` remote; the repository is
not marked as a fork. All seven PR heads had successful CI checks at review time.

| PR | Update | Assessment |
| --- | --- | --- |
| [#38](https://github.com/rusux64-bit/Ripcord/pull/38) | dotenv 18.0.9 → 18.0.10 | Applicable; CLI entry-point fix preserves our `config()` usage. |
| [#37](https://github.com/rusux64-bit/Ripcord/pull/37) | express-rate-limit 8.7.1 → 8.7.4 | Applicable; fixes expired counters, reset races, and error forwarding. |
| [#35](https://github.com/rusux64-bit/Ripcord/pull/35) | globals 17.13.0 → 17.14.0 | Applicable; our Node/browser lint environments pass. |
| [#34](https://github.com/rusux64-bit/Ripcord/pull/34) | ESLint 10.13.0 → 10.14.0 | Applicable, but superseded locally by 10.15.0 and its patched minimatch dependencies. |
| [#33](https://github.com/rusux64-bit/Ripcord/pull/33) | docker/metadata-action v5 → v6 | Applicable; existing tag inputs remain compatible. |
| [#32](https://github.com/rusux64-bit/Ripcord/pull/32) | actions/checkout v4 → v7 | Applicable; CI uses `pull_request`, and publishing follows main-branch runs. No unsafe-checkout opt-in is needed. |
| [#31](https://github.com/rusux64-bit/Ripcord/pull/31) | actions/setup-python v5 → v7 | Applicable on the hosted Ubuntu runner; existing inputs remain supported. |

Additional local updates:

- Axios 1.21.0 → 1.21.1, including follow-redirects 1.16.1 → 1.16.3.
  [Release notes](https://github.com/axios/axios/releases/tag/v1.21.1) describe a
  credential-forwarding security fix in the Node HTTP adapter.
- Declare ffmpeg-static ^5.3.0 and Helmet ^8.3.0, matching the versions already
  resolved in the original lockfile.
- Align CI with publishing: setup-buildx v4 and build-push v7; update setup-node
  v4 → v7. Existing inputs avoid the removed options and registry-token behavior.
- yt-dlp 2026.10.21 → 2026.10.26, with its published SHA-256 checksum.
  [Release notes](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.10.26) require
  Python 3.11+, which the Bookworm container provides.
- FontTools 4.67.0 → 4.68.0; the icon check passes with the updated package.

Node 24, Debian Bookworm, and Python 3.11 remain the runtime targets. This update
refreshes dependencies within that stack; it does not migrate runtime majors or
create an application release. Archiver, Express, and node-id3 already resolve
to their latest stable npm releases. All direct npm dependencies are current.

## Remaining audit finding

`npm audit` reports three moderate package entries in one existing dependency
chain: Archiver → readdir-glob → minimatch 10.x
([GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249)).
There are no high or critical findings. The advisory requires attacker-controlled
glob patterns; Ripcord's archive path uses `file()` and `append()`, with no
`glob()` or `directory()` calls. Static inspection found no route into the
affected pattern-processing API.

Deferred: npm's proposed remedy downgrades Archiver to v7, which is incompatible
with our v8 `ZipArchive` named import. No forced downgrade or cross-major
transitive override was applied. Recheck by 2026-11-24 or when an upstream
Archiver/readdir-glob patch becomes available, whichever comes first.

## Verification

- Baseline: 35/35 tests and lint passed.
- Runtime package updates individually passed the test suite; lint-tool updates
  individually passed lint.
- Updated stack: 35/35 tests, syntax, imports, lint, icon validation, and
  actionlint passed. `npm outdated --json` returned `{}`.
- Clean `npm ci --ignore-scripts`: 35/35 tests passed.
- Docker build passed with `--pull`, including yt-dlp checksum verification.
- Container health and readiness endpoints returned HTTP 200 with a read-only
  root filesystem, dropped capabilities, and writable temporary/cache mounts.
  Readiness verified yt-dlp 2026.10.26, FFmpeg, and temporary storage. A ZIP
  creation smoke check also passed. This build verified the host architecture;
  the full amd64/arm64 publishing matrix remains a GitHub Actions check.

No existing GitHub PR was merged or modified during this review.
