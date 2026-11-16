| Repository | Workflow | Job | Triggers | Needs | Runs on | Matrix | Capabilities | Toolchains | Secrets | Destinations | Artifacts |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2fx | bench.yml | bench | workflow_dispatch, push(branches=main), pull_request |  | "ubuntu-latest" | 1 | linux-build | bun, python, zig |  |  | yes |
| 2fx | bench.yml | long-turn-memory | workflow_dispatch, push(branches=main), pull_request |  | "ubuntu-latest" | 1 | linux-build | python, zig |  |  | yes |
| 2fx | bench.yml | libfx-ttft | workflow_dispatch, push(branches=main), pull_request |  | "ubuntu-latest" | 1 | linux-build | bun, node, zig |  |  | yes |
| 2fx | bench.yml | signed-macos | workflow_dispatch, push(branches=main), pull_request |  | "macos-15" | 1 | macos-arm64 | bun, python, xcode |  | homebrew | yes |
| 2fx | bench.yml | pgso-artifacts | workflow_dispatch, push(branches=main), pull_request |  | "macos-15" | 1 | macos-arm64 | bun |  |  | yes |
| 2fx | binary-size.yml | compare | pull_request |  | "${{ matrix.runner }}" | 4 | linux-arm64, linux-build, macos-arm64, macos-x64 | python, zig |  |  | yes |
| 2fx | cdn-backfill.yml | backfill | workflow_dispatch |  | "ubuntu-latest" | 1 | linux-small, release |  | BLOB_READ_WRITE_TOKEN | github-releases |  |
| 2fx | ci.yml | zig_mode | workflow_dispatch, push(branches=main), pull_request |  | "ubuntu-latest" | 1 | linux-build | python, zig |  |  |  |
| 2fx | ci.yml | zig | workflow_dispatch, push(branches=main), pull_request | zig_mode | "ubuntu-latest" | 1 | linux-small |  |  |  |  |
| 2fx | ci.yml | sdk-node-wasm | workflow_dispatch, push(branches=main), pull_request |  | "ubuntu-latest" | 1 | linux-build | node, zig |  |  |  |
| 2fx | ci.yml | sdk-node-napi | workflow_dispatch, push(branches=main), pull_request |  | "ubuntu-latest" | 1 | linux-build | node, zig |  |  |  |
| 2fx | ci.yml | sdk-bun | workflow_dispatch, push(branches=main), pull_request |  | "ubuntu-latest" | 1 | linux-build | bun, node, oci-build, pnpm, python, zig |  |  | yes |
| 2fx | ci.yml | sdk-browser-wasm | workflow_dispatch, push(branches=main), pull_request |  | "ubuntu-latest" | 1 | linux-browser, linux-build | node, zig |  |  |  |
| 2fx | ci.yml | e2e_mode | workflow_dispatch, push(branches=main), pull_request |  | "ubuntu-latest" | 1 | linux-build | bun, node, zig |  |  |  |
| 2fx | ci.yml | e2e | workflow_dispatch, push(branches=main), pull_request | e2e_mode | "ubuntu-latest" | 1 | linux-small |  |  |  |  |
| 2fx | ci.yml | cross-target | workflow_dispatch, push(branches=main), pull_request |  | "ubuntu-latest" | 4 | linux-build | zig |  |  |  |
| 2fx | ci.yml | lint-scripts | workflow_dispatch, push(branches=main), pull_request |  | "ubuntu-latest" | 1 | linux-small |  |  |  |  |
| 2fx | ci.yml | e2e_acp_full_mode | workflow_dispatch, push(branches=main), pull_request |  | "ubuntu-latest" | 1 | linux-build | bun, zig | AI_GATEWAY_API_KEY |  |  |
| 2fx | ci.yml | e2e-acp-full | workflow_dispatch, push(branches=main), pull_request | e2e_acp_full_mode | "ubuntu-latest" | 1 | linux-small |  |  |  |  |
| 2fx | dev-release.yml | build | workflow_run(branches=main,types=completed,after=CI) |  | "ubuntu-latest" | 4 | linux-build | zig |  |  | yes |
| 2fx | dev-release.yml | web | workflow_run(branches=main,types=completed,after=CI) |  | "ubuntu-latest" | 1 | linux-build | zig |  |  | yes |
| 2fx | dev-release.yml | publish | workflow_run(branches=main,types=completed,after=CI) | build, web | "ubuntu-latest" | 1 | deploy, linux-small | zig | BLOB_READ_WRITE_TOKEN, FX_WEB_DEPLOY_HOOK_URL |  |  |
| 2fx | examples.yml | examples | pull_request(paths), push(branches=main,paths) |  | "ubuntu-24.04" | 4 | linux-small | node |  |  |  |
| 2fx | full-ci.yml | native | workflow_dispatch, push |  | "${{ matrix.platform.runner }}" | 4 | linux-arm64, linux-build, macos-arm64, macos-x64 | python, zig |  |  |  |
| 2fx | full-ci.yml | e2e | workflow_dispatch, push |  | "${{ matrix.platform.runner }}" | 16 | linux-arm64, linux-build, macos-arm64, macos-x64 | bun, zig |  | homebrew |  |
| 2fx | full-ci.yml | full-suite | workflow_dispatch, push | native, e2e | "ubuntu-24.04" | 4 | linux-small |  |  |  |  |
| 2fx | pgso-macos-arm64.yml | seed | workflow_call, workflow_dispatch, pull_request(paths) |  | "macos-15" | 1 | macos-arm64 | bun, python |  |  | yes |
| 2fx | pgso-macos-arm64.yml | train | workflow_call, workflow_dispatch, pull_request(paths) | seed | "macos-15" | 1 | macos-arm64 | bun, python |  |  | yes |
| 2fx | pgso-macos-arm64.yml | candidate | workflow_call, workflow_dispatch, pull_request(paths) | seed, train | "macos-15" | 1 | macos-arm64 | python |  |  | yes |
| 2fx | pgso-macos-arm64.yml | behavior | workflow_call, workflow_dispatch, pull_request(paths) | seed, candidate | "macos-15" | 1 | macos-arm64 | bun, python, zig |  |  | yes |
| 2fx | pgso-macos-arm64.yml | startup | workflow_call, workflow_dispatch, pull_request(paths) | seed, candidate | "macos-15" | 1 | macos-arm64 | python |  |  | yes |
| 2fx | pgso-macos-arm64.yml | heavy | workflow_call, workflow_dispatch, pull_request(paths) | seed, candidate | "macos-15" | 1 | macos-arm64 | python |  |  | yes |
| 2fx | pgso-macos-arm64.yml | aggregate | workflow_call, workflow_dispatch, pull_request(paths) | candidate, behavior, startup, heavy | "macos-15" | 1 | macos-arm64 | python |  |  | yes |
| 2fx | prepare-release.yml | prepare | workflow_dispatch |  | "ubuntu-latest" | 1 | deploy, linux-small | python, zig | AI_GATEWAY_API_KEY, GITHUB_TOKEN | github-releases |  |
| 2fx | publish-libfx.yml | metadata | workflow_run(branches=main,types=completed,after=CI\|Release), workflow_dispatch |  | "ubuntu-latest" | 1 | linux-small | zig |  |  |  |
| 2fx | publish-libfx.yml | native | workflow_run(branches=main,types=completed,after=CI\|Release), workflow_dispatch | metadata | "${{ matrix.runner }}" | 4 | linux-arm64, linux-build, macos-arm64, macos-x64 | node, oci-build, python, zig |  |  | yes |
| 2fx | publish-libfx.yml | wasm | workflow_run(branches=main,types=completed,after=CI\|Release), workflow_dispatch | metadata | "ubuntu-24.04" | 1 | linux-build | node, zig |  |  | yes |
| 2fx | publish-libfx.yml | package | workflow_run(branches=main,types=completed,after=CI\|Release), workflow_dispatch | metadata, native, wasm | "ubuntu-24.04" | 1 | linux-small | bun, node, pnpm, zig |  |  | yes |
| 2fx | publish-libfx.yml | publish | workflow_run(branches=main,types=completed,after=CI\|Release), workflow_dispatch | metadata, package | "ubuntu-24.04" | 1 | linux-small, release | node |  | npm |  |
| 2fx | publish-libfx.yml | verify-published | workflow_run(branches=main,types=completed,after=CI\|Release), workflow_dispatch | metadata, publish | "ubuntu-24.04" | 1 | linux-small | node, pnpm |  | npm | yes |
| 2fx | release.yml | check-version | push(branches=main), workflow_dispatch |  | "ubuntu-latest" | 1 | linux-small | zig |  |  |  |
| 2fx | release.yml | build-linux | push(branches=main), workflow_dispatch | check-version | "ubuntu-latest" | 2 | linux-build | python, zig |  |  | yes |
| 2fx | release.yml | build-macos-x86_64 | push(branches=main), workflow_dispatch | check-version | "macos-15-intel" | 1 | linux-build, macos-x64 | python, xcode, zig | APPLE_DEVELOPER_ID_P12_BASE64, APPLE_DEVELOPER_ID_P12_PASSWORD, APPLE_NOTARY_ISSUER_ID, APPLE_NOTARY_KEY_ID, APPLE_NOTARY_KEY_P8_BASE64 |  | yes |
| 2fx | release.yml | build-macos-arm64 → ./.github/workflows/pgso-macos-arm64.yml | push(branches=main), workflow_dispatch | check-version | null | 1 | linux-small |  |  |  |  |
| 2fx | release.yml | sign-macos-arm64 | push(branches=main), workflow_dispatch | check-version, build-macos-arm64 | "macos-15" | 1 | macos-arm64 | python, xcode | APPLE_DEVELOPER_ID_P12_BASE64, APPLE_DEVELOPER_ID_P12_PASSWORD, APPLE_NOTARY_ISSUER_ID, APPLE_NOTARY_KEY_ID, APPLE_NOTARY_KEY_P8_BASE64 |  | yes |
| 2fx | release.yml | release | push(branches=main), workflow_dispatch | check-version, build-linux, build-macos-x86_64, sign-macos-arm64 | "ubuntu-latest" | 1 | linux-small, release |  | BLOB_READ_WRITE_TOKEN | github-releases |  |
| 3fx | appport-benchmark-live.yml | live | workflow_dispatch |  | "ubuntu-24.04" | 1 | linux-build | bun, node, zig | AI_GATEWAY_API_KEY, AI_PLATFORM_API_KEY, FX_BENCHMARK_PROVIDER_TOKEN, FX_BENCHMARK_SETTINGS_JSON |  | yes |
| 3fx | appport-benchmark.yml | appport | pull_request(paths), workflow_dispatch |  | "ubuntu-24.04" | 1 | linux-build | bun, node, zig |  |  |  |
| 3fx | release.yml | release | push(branches=main,paths), workflow_dispatch |  | "ubuntu-latest" | 1 | linux-build | bun, node, zig |  | npm |  |
| 3fx | sdk-ci.yml | packed-consumer | pull_request(paths), workflow_dispatch |  | "${{ matrix.os }}" | 2 | linux-build, macos-arm64 | bun, node, zig |  |  |  |
| OpenDotsFeltDB | ci.yml | check | push, pull_request |  | "ubuntu-latest" | 1 | linux-small | node |  |  |  |
| OpenDotsFeltDB | ci.yml | no-sqlite | push, pull_request |  | "ubuntu-latest" | 1 | linux-small | node |  |  |  |
| OpenDotsFeltDB | ci.yml | contract | push, pull_request |  | "ubuntu-latest" | 1 | linux-small | node |  |  |  |
| OpenDotsFeltDB | ci.yml | release | push, pull_request |  | "ubuntu-latest" | 1 | linux-small | node |  |  |  |
| appboundry | appboundry-publish.yml | publish | workflow_dispatch |  | "ubuntu-24.04" | 1 | linux-small, release | node, pnpm | NPM_TOKEN | npm | yes |
| appboundry | appboundry-release.yml | appboundry-release | workflow_dispatch, push(tags=appboundry-v*) |  | "ubuntu-latest" | 1 | linux-small | node, pnpm |  |  |  |
| appboundry | boundry-images.yml | build-amd64 | workflow_dispatch |  | "ubuntu-24.04" | 1 | deploy, linux-small | oci-build | AUTHBOUNDRY_READ_TOKEN, FELTDB_READ_TOKEN |  | yes |
| appboundry | ci.yml | build | push(branches=main), pull_request |  | "ubuntu-latest" | 1 | linux-small | node, pnpm, python |  |  |  |
| appboundry | cloud-portal.yml | portal | push(branches=main,paths), pull_request(paths) |  | "ubuntu-22.04" | 1 | linux-browser | node, playwright, pnpm |  |  |  |
| appboundry | feltkit-deploy-acceptance.yml | feltkit-deploy-acceptance | workflow_dispatch, push(branches=hosting-migration), pull_request |  | "ubuntu-24.04" | 1 | deploy, linux-small | node, oci-build, pnpm | FELTKIT_READ_TOKEN | ssh-host | yes |
| appboundry | host-build-compatibility.yml | documented-host-build | workflow_dispatch, push(branches=hosting-migration), pull_request(paths) |  | "ubuntu-24.04" | 1 | deploy, linux-small | node, oci-build, pnpm |  | ssh-host | yes |
| appport | agent-benchmark.yml | harness-tests | pull_request(paths), workflow_dispatch |  | "ubuntu-latest" | 1 | linux-small | node |  |  |  |
| appport | appport-conformance-repair.yml | reproduce | pull_request(paths), workflow_dispatch |  | "ubuntu-24.04" | 1 | linux-small | go, node |  |  |  |
| appport | appport-native-agent.yml | reproduce | pull_request(paths), workflow_dispatch |  | "ubuntu-24.04" | 1 | linux-small | go, node |  |  |  |
| appport | appport-native-generation.yml | reproduce | pull_request(paths), workflow_dispatch |  | "ubuntu-24.04" | 1 | linux-small | go, node |  |  |  |
| appport | appport-native-scaling.yml | reproduce | pull_request(paths), workflow_dispatch |  | "ubuntu-24.04" | 1 | linux-small | go, node |  |  |  |
| appport | capability-reuse.yml | reproduce | pull_request(paths), workflow_dispatch |  | "ubuntu-24.04" | 1 | linux-small | go, node |  |  | yes |
| appport | ci.yml | build | push(branches=main), pull_request |  | "ubuntu-latest" | 1 | linux-browser | node, pnpm, python |  |  |  |
| appport | evidence-gated-completion.yml | reproduce | pull_request(paths), workflow_dispatch |  | "ubuntu-24.04" | 1 | linux-small | go, node |  |  | yes |
| appport | graph-guided-discovery.yml | reproduce | pull_request(paths), workflow_dispatch |  | "ubuntu-24.04" | 1 | linux-small | go, node |  |  | yes |
| appport | legacy-migration.yml | migration-proof | pull_request(paths), workflow_dispatch |  | "ubuntu-24.04" | 1 | linux-small | node |  |  |  |
| appport | legacy-migration.yml | migration-proof-workspace-packages | pull_request(paths), workflow_dispatch |  | "ubuntu-24.04" | 1 | linux-small | node, pnpm |  |  |  |
| appport-services | ci.yml | test | push(branches=main), pull_request |  | "ubuntu-24.04" | 1 | linux-browser | node, playwright |  |  |  |
| appworks | ci.yml | check | push(branches=main), pull_request |  | "ubuntu-latest" | 1 | linux-small | node, pnpm |  |  |  |
| appworks | ci.yml | memos | push(branches=main), pull_request |  | "ubuntu-latest" | 1 | linux-small | go, node, pnpm |  |  |  |
| authboundry | architecture-invariants.yml | verify | pull_request, push |  | "ubuntu-latest" | 1 | linux-build | go, node, rust |  |  |  |
| authboundry | cli-smoke.yml | cli-smoke | pull_request, push |  | "${{ matrix.os }}" | 4 | linux-arm64, macos-arm64, macos-x64 | node |  |  |  |
| authboundry | deploy-fly.yml | retired | workflow_dispatch |  | "ubuntu-latest" | 1 | deploy, linux-small |  |  |  |  |
| authboundry | portal.yml | portal | push(branches=main,paths), pull_request(paths) |  | "ubuntu-22.04" | 1 | linux-browser, linux-build | go, node, playwright, rust |  |  |  |
| authboundry | release.yml | validate | workflow_dispatch |  | "ubuntu-latest" | 1 | linux-small | node |  |  |  |
| authboundry | release.yml | test | workflow_dispatch | validate | "ubuntu-latest" | 1 | linux-build | go, node, rust |  |  |  |
| authboundry | release.yml | build-native | workflow_dispatch | validate | "${{ matrix.os }}" | 4 | linux-arm64, linux-build, macos-arm64, macos-x64 | node, rust |  |  | yes |
| authboundry | release.yml | publish | workflow_dispatch | validate, test, build-native | "ubuntu-latest" | 1 | linux-small, release | node | GITHUB_TOKEN, NPM_TOKEN | github-releases, npm | yes |
| boundry | ci.yml | build | pull_request, push(branches=main) |  | "ubuntu-latest" | 1 | linux-small | node |  |  |  |
| boundry | ci.yml | intelligence | pull_request, push(branches=main) |  | "ubuntu-latest" | 1 | linux-small | node |  |  |  |
| boundry-intel | ci.yml | test | pull_request, push(branches=main) |  | "ubuntu-latest" | 2 | linux-small | node |  |  |  |
| boundry-maint | publish-pages.yml | build | push(branches=main,paths), workflow_dispatch, workflow_call |  | "ubuntu-latest" | 1 | linux-small | node |  |  |  |
| boundry-maint | publish-pages.yml | deploy | push(branches=main,paths), workflow_dispatch, workflow_call | build | "ubuntu-latest" | 1 | deploy, linux-small |  |  | github-pages |  |
| boundry-maint | scan.yml | scan | push(branches=main,paths), repository_dispatch(types=scan\|package-released\|project-pushed\|maintenance-started), workflow_dispatch, workflow_call |  | "ubuntu-latest" | 1 | linux-small | node | MAINTENANCE_READ_TOKEN |  |  |
| boundry-maint | scan.yml | publish → ./.github/workflows/publish-pages.yml | push(branches=main,paths), repository_dispatch(types=scan\|package-released\|project-pushed\|maintenance-started), workflow_dispatch, workflow_call | scan | null | 1 | linux-small |  |  | github-pages |  |
| boundry-maint | scheduled.yml | scan → ./.github/workflows/scan.yml | schedule(23 7 * * *) |  | null | 1 | linux-small |  |  | github-pages |  |
| chip-rs | laya.yml | laya | workflow_dispatch, pull_request(paths) |  | "ubuntu-latest" | 1 | linux-build | go, rust |  |  |  |
| chip-rs | live-compute.yml | live-compute | workflow_dispatch |  | "ubuntu-latest" | 1 | linux-build | go, rust |  |  |  |
| chip-rs | live-model.yml | live-model | workflow_dispatch |  | "ubuntu-latest" | 1 | linux-build | go, rust | CHIP_API_KEY, CHIP_ENDPOINT, CHIP_MODEL, CHIP_PROVIDER |  |  |
| chip-rs | local-ml.yml | local-ml | workflow_dispatch, pull_request(paths) |  | "ubuntu-latest" | 1 | linux-build | go, rust |  |  |  |
| chip-rs | release.yml | release | push(tags=chip-v*) |  | "ubuntu-latest" | 1 | linux-build, release | go, rust, wasm |  | github-releases |  |
| chip-rs | rust.yml | ci | push(branches=main), pull_request(branches=main), workflow_dispatch |  | "ubuntu-latest" | 1 | linux-build, release | go, python, rust, wasm |  |  |  |
| chip-rs | rust.yml | product | push(branches=main), pull_request(branches=main), workflow_dispatch | ci | "ubuntu-latest" | 1 | linux-build | go, rust |  |  | yes |
| chip-rs | rust.yml | session-memory-experiment | push(branches=main), pull_request(branches=main), workflow_dispatch |  | "ubuntu-latest" | 1 | linux-build | go, rust | FLOW_DB_TOKEN |  |  |
| compute | chip-fx-integration.yml | harness | workflow_dispatch, pull_request(paths), push(branches=main,paths) |  | "ubuntu-latest" | 1 | linux-build | go, rust, wasm |  |  |  |
| compute | cloudflare-live.yml | live | workflow_dispatch |  | "ubuntu-latest" | 1 | linux-build | go, rust | CLOUDFLARE_API_TOKEN, COMPUTE_CLOUDFLARE_LIVE_ACCOUNT_ID | cloudflare |  |
| compute | configured-compatibility.yml | published-registry-stack | pull_request(paths), push(branches=main,paths), workflow_dispatch, schedule(17 7 * * 1) |  | "ubuntu-latest" | 1 | linux-small | node |  | npm | yes |
| compute | distribution-certification.yml | certify-linux-x86_64 | workflow_call, workflow_dispatch, push(tags=v*) |  | "ubuntu-22.04" | 1 | linux-build | go, node, rust, wasm |  | cloudflare | yes |
| compute | distribution-certification.yml | validate-macos-aarch64-preview | workflow_call, workflow_dispatch, push(tags=v*) |  | "macos-15" | 1 | linux-build, macos-arm64 | go, node, rust |  | cloudflare, homebrew | yes |
| compute | distribution-certification.yml | publish-release | workflow_call, workflow_dispatch, push(tags=v*) | certify-linux-x86_64, validate-macos-aarch64-preview | "ubuntu-latest" | 1 | linux-small, release |  | GITHUB_TOKEN, HOMEBREW_TAP_TOKEN | github-releases, homebrew |  |
| compute | feltdb-consumer.yml | certify | workflow_dispatch, pull_request, push(branches=main) |  | "ubuntu-latest" | 1 | linux-build | go, node, rust |  |  |  |
| compute | live-tap.yml | live-tap | workflow_dispatch, schedule(17 6 * * *) |  | "ubuntu-latest" | 1 | linux-small |  | GITHUB_TOKEN |  |  |
| compute | microvm.yml | microvm | workflow_dispatch, pull_request(paths), push(branches=main) |  | "ubuntu-latest" | 1 | linux-build | go, rust |  |  | yes |
| compute | microvm.yml | container-engine | workflow_dispatch, pull_request(paths), push(branches=main) |  | "ubuntu-latest" | 1 | linux-build | go, oci-build, rust |  |  |  |
| compute | release-tag-guard.yml | refuse | push(tags=V*\|[0-9]*) |  | "ubuntu-latest" | 1 | linux-small |  |  |  |  |
| compute | stack.yml | contract | workflow_dispatch, schedule(17 6 * * *), pull_request(paths), push(branches=main,paths) |  | "ubuntu-latest" | 1 | linux-build | go, rust |  |  |  |
| compute | stack.yml | candidate | workflow_dispatch, schedule(17 6 * * *), pull_request(paths), push(branches=main,paths) |  | "ubuntu-latest" | 1 | linux-build | go, node, pnpm, rust | STACK_SOURCES_TOKEN |  | yes |
| compute | test.yml | workspace | workflow_dispatch, pull_request, push(branches=main) |  | "ubuntu-latest" | 1 | linux-build | go, node, rust |  | cloudflare, homebrew |  |
| compute | test.yml | browser | workflow_dispatch, pull_request, push(branches=main) |  | "ubuntu-latest" | 1 | linux-browser, linux-build | go, node, playwright, rust |  |  |  |
| distribution-protocol | ci.yml | test | pull_request, workflow_dispatch, push(branches=**) |  | "ubuntu-latest" | 3 | linux-small | node |  |  |  |
| distribution-protocol | ci.yml | package | pull_request, workflow_dispatch, push(branches=**) |  | "ubuntu-latest" | 1 | linux-small | node |  |  |  |
| felt-ops | ci.yml | verify | push, pull_request, workflow_dispatch |  | "ubuntu-latest" | 1 | linux-small | node |  |  | yes |
| felt-session | bun-dependency-submission.yml | submit | push(branches=main,paths), workflow_dispatch |  | "ubuntu-slim" | 1 | linux-small | bun | GITHUB_TOKEN |  |  |
| felt-session | ci.yml | check | pull_request, push(branches=main), workflow_dispatch |  | "ubuntu-latest" | 1 | deploy, linux-small | bun |  |  |  |
| felt-session | ci.yml | installer | pull_request, push(branches=main), workflow_dispatch |  | "${{ matrix.os }}" | 2 | macos-arm64 | bun |  |  |  |
| felt-session | ci.yml | runner-windows | pull_request, push(branches=main), workflow_dispatch |  | "windows-latest" | 1 | windows | bun |  |  |  |
| felt-session | dependency-audit.yml | audit | pull_request(paths), push(branches=main,paths), schedule(23 7 * * 1), workflow_dispatch |  | "ubuntu-latest" | 1 | linux-small | bun |  |  |  |
| felt-session | os1-chrome-release.yml | release | push(branches=main,paths), workflow_dispatch |  | "ubuntu-latest" | 1 | deploy, linux-small, release |  | OS1_CHROME_CRX_KEY | github-releases |  |
| felt-session | os1-ios-testflight.yml | build | push(branches=main,paths), workflow_dispatch |  | "macos-26" | 1 | deploy, macos-arm64 | xcode | ASC_API_KEY_P8_BASE64, ASC_ISSUER_ID, ASC_KEY_ID, OS1_IOS_DIST_P12_BASE64, OS1_IOS_DIST_P12_PASSWORD | app-store, homebrew | yes |
| felt-session | os1-ios-testflight.yml | testflight | push(branches=main,paths), workflow_dispatch | build | "ubuntu-latest" | 1 | linux-small |  | ASC_API_KEY_P8_BASE64, ASC_ISSUER_ID, ASC_KEY_ID | app-store |  |
| felt-session | os1-ios-testflight.yml | cooldown | push(branches=main,paths), workflow_dispatch | testflight | "ubuntu-latest" | 1 | linux-small |  |  | app-store |  |
| felt-session | os1-mac-release.yml | release | push(tags=v[0-9]+.[0-9]+.[0-9]+*), workflow_dispatch |  | "macos-26" | 1 | macos-arm64, release | bun, xcode | APPLE_APP_PASSWORD, APPLE_CERTIFICATES_P12, APPLE_CERTIFICATES_PASSWORD, APPLE_ID, OS1_PROVISIONING_PROFILE_BASE64 | github-releases | yes |
| felt-session | os1-mac-testflight.yml | testflight | push(branches=main,paths), workflow_dispatch |  | "macos-26" | 1 | deploy, macos-arm64 | xcode | ASC_API_KEY_P8_BASE64, ASC_ISSUER_ID, ASC_KEY_ID, OS1_IOS_DIST_P12_BASE64, OS1_IOS_DIST_P12_PASSWORD, OS1_MAC_INSTALLER_P12_BASE64, OS1_MAC_INSTALLER_P12_PASSWORD, OS1_MAC_PROVISIONING_PROFILE_BASE64 | app-store, homebrew |  |
| felt-session | os1-mac-testflight.yml | cooldown | push(branches=main,paths), workflow_dispatch | testflight | "ubuntu-latest" | 1 | linux-small |  |  | app-store |  |
| felt-session | os1-native-ci.yml | build-and-test | pull_request(paths) |  | "macos-26" | 1 | macos-arm64 | xcode |  | homebrew |  |
| felt-session | release-finalize.yml | publish | workflow_run(types=completed,after=Release\|Release Open Session for Mac) |  | "ubuntu-latest" | 1 | linux-small, release |  |  | github-releases |  |
| felt-session | release.yml | artefacts | push(tags=v*), workflow_dispatch |  | "ubuntu-latest" | 1 | linux-small, release | bun |  | github-releases |  |
| felt-session | sandbox-release.yml | runner-image | release(types=published), workflow_dispatch |  | "ubuntu-latest" | 1 | deploy, linux-build, release | oci-build | GITHUB_TOKEN | ghcr |  |
| felt-session | sandbox-release.yml | microvm-golden | release(types=published), workflow_dispatch |  | "${{ fromJSON(matrix.runner) }}" | 2 | deploy, linux-small, release | bun | GITHUB_TOKEN | github-releases |  |
| felt-session | secret-scan.yml | gitleaks | pull_request, push(branches=main), workflow_dispatch |  | "ubuntu-latest" | 1 | linux-small |  |  |  |  |
| feltgit | check-style.yml | check-style | pull_request(types=opened\|synchronize) |  | "ubuntu-latest" | 1 | linux-small |  |  |  |  |
| feltgit | check-whitespace.yml | check-whitespace | pull_request(types=opened\|synchronize) |  | "ubuntu-latest" | 1 | linux-small |  |  |  |  |
| feltgit | coverity.yml | coverity | push |  | "${{ matrix.os }}" | dynamic | linux-small |  | COVERITY_SCAN_EMAIL, COVERITY_SCAN_TOKEN |  |  |
| feltgit | l10n.yml | git-po-helper | push, pull_request_target |  | "ubuntu-latest" | 1 | linux-small | go | GITHUB_TOKEN |  |  |
| feltgit | main.yml | ci-config | push, pull_request |  | "ubuntu-latest" | 1 | linux-small |  | GITHUB_TOKEN |  |  |
| feltgit | main.yml | windows-build | push, pull_request | ci-config | "windows-latest" | 1 | windows |  |  |  | yes |
| feltgit | main.yml | windows-test | push, pull_request | ci-config, windows-build | "windows-latest" | 10 | windows |  |  |  | yes |
| feltgit | main.yml | vs-build | push, pull_request | ci-config | "windows-latest" | 1 | windows |  |  |  | yes |
| feltgit | main.yml | vs-test | push, pull_request | ci-config, vs-build | "windows-latest" | 10 | windows |  |  |  | yes |
| feltgit | main.yml | windows-meson-build | push, pull_request | ci-config | "windows-latest" | 1 | windows | python |  |  | yes |
| feltgit | main.yml | windows-meson-test | push, pull_request | ci-config, windows-meson-build | "windows-latest" | 10 | windows | python |  |  | yes |
| feltgit | main.yml | regular | push, pull_request | ci-config | "${{matrix.vector.pool}}" | 4 | macos-arm64 |  |  |  | yes |
| feltgit | main.yml | fuzz-smoke-test | push, pull_request | ci-config | "ubuntu-latest" | 1 | linux-small |  |  |  |  |
| feltgit | main.yml | dockerized | push, pull_request | ci-config | "ubuntu-latest" | 13 | linux-small |  |  |  | yes |
| feltgit | main.yml | static-analysis | push, pull_request | ci-config | "ubuntu-latest" | 1 | linux-small |  |  |  |  |
| feltgit | main.yml | rust-analysis | push, pull_request | ci-config | "ubuntu-latest" | 1 | linux-small |  |  |  |  |
| feltgit | main.yml | sparse | push, pull_request | ci-config | "ubuntu-22.04" | 1 | linux-small |  |  |  |  |
| feltgit | main.yml | documentation | push, pull_request | ci-config | "ubuntu-latest" | 1 | linux-small |  |  |  |  |
| feltkit | ci.yml | isolation | push(branches=main), pull_request, workflow_dispatch |  | "ubuntu-latest" | 1 | linux-small | node |  |  |  |
| feltkit | ci.yml | test | push(branches=main), pull_request, workflow_dispatch |  | "ubuntu-latest" | 1 | linux-browser | node, playwright |  |  |  |
| feltkit | ci.yml | e2e | push(branches=main), pull_request, workflow_dispatch |  | "ubuntu-latest" | 1 | linux-browser | node, playwright |  |  |  |
| feltkit | ci.yml | e2e-feltdb | push(branches=main), pull_request, workflow_dispatch |  | "ubuntu-latest" | 1 | deploy, linux-build | go, node, rust | FLOW_DB_READ_TOKEN |  |  |
| feltkit | publish.yml | publish | workflow_dispatch, push(branches=main\|claude/concave-platform-mvp-d7lcwi) |  | "ubuntu-latest" | 1 | linux-browser | node, playwright | NPM_TOKEN | npm |  |
| flow_db | architecture-conformance.yml | conformance | pull_request(branches=main\|develop), push(branches=main\|develop) |  | "ubuntu-latest" | 1 | linux-small | node | TYPESAFE_API_TOKEN, TYPESAFE_API_URL |  | yes |
| flow_db | ci.yml | test-rust | push(branches=main\|develop), pull_request(branches=main\|develop) |  | "ubuntu-latest" | 1 | linux-build | go, rust, wasm |  |  |  |
| flow_db | ci.yml | build-packages | push(branches=main\|develop), pull_request(branches=main\|develop) |  | "ubuntu-latest" | 1 | linux-browser, linux-build | go, node, playwright, rust, wasm |  |  | yes |
| flow_db | ci.yml | build-container | push(branches=main\|develop), pull_request(branches=main\|develop) |  | "ubuntu-latest" | 1 | deploy, linux-build | go, oci-build, rust |  |  | yes |
| flow_db | ci.yml | package-manager-matrix | push(branches=main\|develop), pull_request(branches=main\|develop) | build-packages | "ubuntu-latest" | 3 | linux-small | bun, node, pnpm |  |  | yes |
| flow_db | ci.yml | create-feltdb-test | push(branches=main\|develop), pull_request(branches=main\|develop) | build-packages | "ubuntu-latest" | 1 | linux-small | node |  |  |  |
| flow_db | ci.yml | e2e-acceptance-test | push(branches=main\|develop), pull_request(branches=main\|develop) | build-packages, create-feltdb-test | "ubuntu-latest" | 1 | linux-build | node, rust |  |  |  |
| flow_db | ci.yml | attest | push(branches=main\|develop), pull_request(branches=main\|develop) | test-rust, build-packages, build-container, e2e-acceptance-test, create-feltdb-test | "ubuntu-latest" | 1 | linux-small |  |  | github-releases | yes |
| flow_db | disaster-recovery.yml | restore-drill | workflow_dispatch, schedule(17 6 1 * *) |  | "ubuntu-latest" | 1 | linux-build | go, rust |  |  | yes |
| flow_db | fly-deploy.yml | report-skipped-deploy | workflow_dispatch, workflow_run(branches=main,types=completed,after=CI) |  | "ubuntu-latest" | 1 | deploy, linux-small |  |  |  |  |
| flow_db | fly-deploy.yml | deploy | workflow_dispatch, workflow_run(branches=main,types=completed,after=CI) |  | "ubuntu-latest" | 1 | deploy, linux-small |  | FLY_API_TOKEN | fly.io |  |
| flow_db | proof-qualification.yml | hostile-node | schedule(17 4 * * *), workflow_dispatch |  | "ubuntu-latest" | 1 | deploy, linux-browser, linux-build | node, oci-build, playwright |  |  | yes |
| flow_db | proof-qualification.yml | managed-disposable | schedule(17 4 * * *), workflow_dispatch |  | "ubuntu-latest" | 1 | linux-small | node | FELTDB_PROOF_MANAGED_EMAIL, FELTDB_PROOF_MANAGED_PASSWORD |  | yes |
| flow_db | release.yml | authorize | workflow_dispatch |  | "ubuntu-latest" | 1 | linux-small |  |  |  |  |
| flow_db | release.yml | verify | workflow_dispatch | authorize | "ubuntu-latest" | 1 | linux-small |  | GITHUB_TOKEN |  | yes |
| flow_db | release.yml | publish-npm | workflow_dispatch | verify | "ubuntu-latest" | 1 | linux-small | node |  | npm |  |
| flow_db | release.yml | verify-published | workflow_dispatch | verify, publish-npm | "ubuntu-latest" | 1 | linux-small | node | GITHUB_TOKEN |  |  |
| flow_db | release.yml | promote-container | workflow_dispatch | verify | "ubuntu-latest" | 1 | linux-small, release | oci-build | GITHUB_TOKEN | ghcr |  |
| flow_db | rust-crate-publish.yml | eligibility | workflow_dispatch |  | "ubuntu-latest" | 1 | linux-build | rust |  |  |  |
| flow_db | rust-crate-publish.yml | validate → ./.github/workflows/rust-crate-validate.yml | workflow_dispatch | eligibility | null | 1 | linux-small |  |  |  |  |
| flow_db | rust-crate-publish.yml | dry-run | workflow_dispatch | eligibility, validate | "ubuntu-latest" | 1 | linux-build, release | rust |  | crates.io |  |
| flow_db | rust-crate-publish.yml | publish | workflow_dispatch | eligibility, validate, dry-run | "ubuntu-latest" | 1 | linux-build, release | rust | CARGO_REGISTRY_TOKEN | crates.io |  |
| flow_db | rust-crate-validate.yml | guards | pull_request(paths), workflow_dispatch, workflow_call |  | "ubuntu-latest" | 1 | linux-build | node, rust |  |  |  |
| flow_db | rust-crate-validate.yml | plan | pull_request(paths), workflow_dispatch, workflow_call |  | "ubuntu-latest" | 1 | linux-small |  |  |  |  |
| flow_db | rust-crate-validate.yml | validate | pull_request(paths), workflow_dispatch, workflow_call | guards, plan | "ubuntu-latest" | dynamic | linux-build | rust, wasm |  |  |  |
| flow_db | studio-deploy.yml | deploy | workflow_dispatch |  | "ubuntu-latest" | 1 | deploy, linux-small | node | VERCEL_ORG_ID, VERCEL_PROJECT_ID, VERCEL_TOKEN |  |  |
| fx | agent-parity.yml | harness | push(paths), pull_request(paths), workflow_dispatch |  | "ubuntu-24.04" | 1 | linux-small | python |  |  |  |
| fx | agent-parity.yml | parity | push(paths), pull_request(paths), workflow_dispatch |  | "ubuntu-24.04" | 1 | linux-build | go, python, rust, zig |  |  | yes |
| fx | bench.yml | bench | workflow_dispatch, push(branches=main), pull_request |  | "ubuntu-latest" | 1 | linux-build | python, zig |  |  |  |
| fx | binary-size.yml | compare | pull_request |  | "${{ matrix.runner }}" | 4 | linux-arm64, linux-build, macos-arm64, macos-x64 | python, zig |  |  | yes |
| fx | cdn-backfill.yml | backfill | workflow_dispatch |  | "ubuntu-latest" | 1 | linux-small, release |  | BLOB_READ_WRITE_TOKEN | github-releases |  |
| fx | ci.yml | zig_mode | workflow_dispatch, push(branches=main), pull_request |  | "ubuntu-latest" | 1 | linux-build | python, zig |  |  |  |
| fx | ci.yml | zig | workflow_dispatch, push(branches=main), pull_request | zig_mode | "ubuntu-latest" | 1 | linux-small |  |  |  |  |
| fx | ci.yml | sdk-node-wasm | workflow_dispatch, push(branches=main), pull_request |  | "ubuntu-latest" | 1 | linux-build | node, zig |  |  |  |
| fx | ci.yml | sdk-node-napi | workflow_dispatch, push(branches=main), pull_request |  | "ubuntu-latest" | 1 | linux-build | node, zig |  |  |  |
| fx | ci.yml | sdk-browser-wasm | workflow_dispatch, push(branches=main), pull_request |  | "ubuntu-latest" | 1 | linux-browser, linux-build | node, zig |  |  |  |
| fx | ci.yml | e2e_mode | workflow_dispatch, push(branches=main), pull_request |  | "ubuntu-latest" | 1 | linux-build | bun, node, zig |  |  |  |
| fx | ci.yml | e2e | workflow_dispatch, push(branches=main), pull_request | e2e_mode | "ubuntu-latest" | 1 | linux-small |  |  |  |  |
| fx | ci.yml | cross-target | workflow_dispatch, push(branches=main), pull_request |  | "ubuntu-latest" | 4 | linux-build | zig |  |  |  |
| fx | ci.yml | lint-scripts | workflow_dispatch, push(branches=main), pull_request |  | "ubuntu-latest" | 1 | linux-small |  |  |  |  |
| fx | ci.yml | e2e_acp_full_mode | workflow_dispatch, push(branches=main), pull_request |  | "ubuntu-latest" | 1 | linux-build | bun, zig | AI_GATEWAY_API_KEY |  |  |
| fx | ci.yml | e2e-acp-full | workflow_dispatch, push(branches=main), pull_request | e2e_acp_full_mode | "ubuntu-latest" | 1 | linux-small |  |  |  |  |
| fx | dev-release.yml | build | workflow_run(branches=main,types=completed,after=CI) |  | "ubuntu-latest" | 4 | linux-build | zig |  |  | yes |
| fx | dev-release.yml | web | workflow_run(branches=main,types=completed,after=CI) |  | "ubuntu-latest" | 1 | linux-build | zig |  |  | yes |
| fx | dev-release.yml | publish | workflow_run(branches=main,types=completed,after=CI) | build, web | "ubuntu-latest" | 1 | deploy, linux-small | zig | BLOB_READ_WRITE_TOKEN, FX_WEB_DEPLOY_HOOK_URL |  |  |
| fx | full-ci.yml | native | workflow_dispatch, push |  | "${{ matrix.platform.runner }}" | 4 | linux-arm64, linux-build, macos-arm64, macos-x64 | zig |  |  |  |
| fx | full-ci.yml | e2e | workflow_dispatch, push |  | "${{ matrix.platform.runner }}" | 16 | linux-arm64, linux-build, macos-arm64, macos-x64 | bun, zig |  | homebrew |  |
| fx | full-ci.yml | full-suite | workflow_dispatch, push | native, e2e | "ubuntu-24.04" | 4 | linux-small |  |  |  |  |
| fx | host-bridge.yml | rust-host | push(paths), pull_request(paths), workflow_dispatch |  | "${{ matrix.os }}" | 2 | linux-build, macos-arm64 | go, rust, wasm |  |  |  |
| fx | host-bridge.yml | wasm-abi | push(paths), pull_request(paths), workflow_dispatch |  | "${{ matrix.os }}" | 2 | linux-build, macos-arm64 | go, rust, wasm |  |  |  |
| fx | host-bridge.yml | node-host | push(paths), pull_request(paths), workflow_dispatch |  | "${{ matrix.os }}" | 3 | linux-build, macos-arm64 | go, node, rust, wasm |  |  |  |
| fx | native-provider.yml | native-provider | push(paths), pull_request(paths), workflow_dispatch |  | "${{ matrix.os }}" | 2 | linux-build, macos-arm64 | go, python, rust, wasm |  |  |  |
| fx | native-provider.yml | parity | push(paths), pull_request(paths), workflow_dispatch |  | "${{ matrix.os }}" | 2 | linux-build, macos-arm64 | go, node, rust, wasm |  |  |  |
| fx | pgso-macos-arm64.yml | seed | workflow_call, workflow_dispatch, pull_request(paths) |  | "macos-15" | 1 | macos-arm64 | bun, python |  |  | yes |
| fx | pgso-macos-arm64.yml | train | workflow_call, workflow_dispatch, pull_request(paths) | seed | "macos-15" | 1 | macos-arm64 | bun, python |  |  | yes |
| fx | pgso-macos-arm64.yml | candidate | workflow_call, workflow_dispatch, pull_request(paths) | seed, train | "macos-15" | 1 | macos-arm64 | python |  |  | yes |
| fx | pgso-macos-arm64.yml | behavior | workflow_call, workflow_dispatch, pull_request(paths) | seed, candidate | "macos-15" | 1 | macos-arm64 | bun, python, zig |  |  | yes |
| fx | pgso-macos-arm64.yml | startup | workflow_call, workflow_dispatch, pull_request(paths) | seed, candidate | "macos-15" | 1 | macos-arm64 | python |  |  | yes |
| fx | pgso-macos-arm64.yml | heavy | workflow_call, workflow_dispatch, pull_request(paths) | seed, candidate | "macos-15" | 1 | macos-arm64 | python |  |  | yes |
| fx | pgso-macos-arm64.yml | aggregate | workflow_call, workflow_dispatch, pull_request(paths) | candidate, behavior, startup, heavy | "macos-15" | 1 | macos-arm64 | python |  |  | yes |
| fx | prepare-release.yml | prepare | workflow_dispatch |  | "ubuntu-latest" | 1 | deploy, linux-small | python, zig | AI_GATEWAY_API_KEY, GITHUB_TOKEN | github-releases |  |
| fx | publish-libfx.yml | metadata | workflow_run(branches=main,types=completed,after=CI\|Release), workflow_dispatch |  | "ubuntu-latest" | 1 | linux-small | zig |  |  |  |
| fx | publish-libfx.yml | native | workflow_run(branches=main,types=completed,after=CI\|Release), workflow_dispatch | metadata | "${{ matrix.runner }}" | 4 | linux-arm64, linux-build, macos-arm64, macos-x64 | node, zig |  |  | yes |
| fx | publish-libfx.yml | wasm | workflow_run(branches=main,types=completed,after=CI\|Release), workflow_dispatch | metadata | "ubuntu-24.04" | 1 | linux-build | node, zig |  |  | yes |
| fx | publish-libfx.yml | publish | workflow_run(branches=main,types=completed,after=CI\|Release), workflow_dispatch | metadata, native, wasm | "ubuntu-24.04" | 1 | linux-small, release | node, zig |  | npm |  |
| fx | release.yml | check-version | push(branches=main), workflow_dispatch |  | "ubuntu-latest" | 1 | linux-small | zig |  |  |  |
| fx | release.yml | build | push(branches=main), workflow_dispatch | check-version | "ubuntu-latest" | 3 | linux-build | zig |  |  | yes |
| fx | release.yml | build-macos-arm64 → ./.github/workflows/pgso-macos-arm64.yml | push(branches=main), workflow_dispatch | check-version | null | 1 | linux-small |  |  |  |  |
| fx | release.yml | release | push(branches=main), workflow_dispatch | check-version, build, build-macos-arm64 | "ubuntu-latest" | 1 | linux-small, release |  | BLOB_READ_WRITE_TOKEN | github-releases |  |
| fx | rust-core.yml | check | push(paths), pull_request(paths), workflow_dispatch |  | "${{ matrix.os }}" | 2 | linux-build, macos-arm64 | go, rust, wasm |  |  |  |
| fx | rust-core.yml | single-attempt | push(paths), pull_request(paths), workflow_dispatch |  | "${{ matrix.os }}" | 2 | linux-build, macos-arm64 | go, rust, wasm |  |  |  |
| fx | session-interop.yml | interop | push(paths), pull_request(paths), workflow_dispatch |  | "ubuntu-24.04" | 1 | linux-build | go, python, rust, zig |  |  |  |
| fx | unified-runtime.yml | chip-over-fx | push(paths), pull_request(paths), workflow_dispatch |  | "ubuntu-24.04" | 1 | linux-build | go, node, python, rust, wasm, zig |  |  |  |
| homebrew-compute | sync.yml | formula | schedule(17 * * * *), workflow_dispatch |  | "ubuntu-latest" | 1 | linux-small |  |  | homebrew |  |
| homebrew-compute | tests.yml | install-linux-x86_64 | pull_request, push(branches=main), workflow_dispatch |  | "ubuntu-latest" | 1 | linux-small |  |  | homebrew |  |
| homebrew-compute | tests.yml | upgrade-preserves-state | pull_request, push(branches=main), workflow_dispatch |  | "ubuntu-latest" | 1 | linux-small |  |  | homebrew |  |
| homebrew-compute | tests.yml | configured-linux-x86_64 | pull_request, push(branches=main), workflow_dispatch |  | "ubuntu-latest" | 1 | linux-small |  |  | homebrew |  |
| homebrew-compute | tests.yml | install-macos-aarch64-preview | pull_request, push(branches=main), workflow_dispatch |  | "macos-15" | 1 | macos-arm64 |  |  | homebrew |  |
| pax | release.yml | check | push(tags=v*), workflow_dispatch |  | "ubuntu-latest" | 1 | linux-build | go, rust |  |  |  |
| pax | release.yml | build | push(tags=v*), workflow_dispatch | check | "${{ matrix.runner }}" | 5 | linux-build, macos-arm64, windows | go, rust |  |  | yes |
| pax | release.yml | release | push(tags=v*), workflow_dispatch | build | "ubuntu-latest" | 1 | linux-small, release |  |  | github-releases |  |
| personalOS | ci.yml | check | push(branches=main), pull_request |  | "ubuntu-latest" | 1 | linux-browser | node, playwright |  |  | yes |
| personalOS | ios.yml | build | push(paths), pull_request(paths), workflow_dispatch |  | "macos-15" | 1 | macos-arm64 | xcode |  | homebrew | yes |
| resolver | ci.yml | test | push, pull_request |  | "ubuntu-latest" | 1 | linux-small | node |  |  |  |
| resolver | ci.yml | browser | push, pull_request |  | "ubuntu-latest" | 1 | linux-browser | node, playwright |  |  |  |
| resolver | publish.yml | publish | workflow_dispatch |  | "ubuntu-latest" | 1 | linux-small | node | NPM_TOKEN | npm |  |
| stack-agent | ci.yml | ci | push(branches=main), pull_request, workflow_dispatch |  | "ubuntu-latest" | 1 | linux-build | go, python, rust, wasm, zig |  |  |  |
| stack-agent | ci.yml | release-scripts | push(branches=main), pull_request, workflow_dispatch |  | "${{ matrix.os }}" | 2 | linux-build, macos-arm64 | oci-build, python, rust |  |  |  |
| stack-agent | release.yml | build | push(tags=v*), workflow_dispatch |  | "${{ matrix.os }}" | 2 | linux-build, macos-arm64 | go, rust, xcode |  |  | yes |
| stack-agent | release.yml | linux-compat | push(tags=v*), workflow_dispatch | build | "ubuntu-22.04" | 3 | linux-small | oci-build |  |  |  |
| stack-agent | release.yml | linux-floor | push(tags=v*), workflow_dispatch |  | "ubuntu-22.04" | 2 | linux-small | oci-build |  |  |  |
| stack-agent | release.yml | provenance-check | push(tags=v*), workflow_dispatch | build, linux-compat, linux-floor | "ubuntu-22.04" | 1 | linux-small |  |  |  |  |
| stack-agent | release.yml | publish | push(tags=v*), workflow_dispatch | build, linux-compat, linux-floor | "ubuntu-22.04" | 1 | linux-small, release |  |  | github-releases |  |
| stack-intel | publish.yml | publish | schedule(17 8 * * *), workflow_dispatch |  | "ubuntu-latest" | 1 | linux-small | node | INTEL_READER_TOKEN, INTEL_URL |  |  |
| stack-ui | ci.yml | test | push(branches=main), pull_request |  | "ubuntu-latest" | 1 | linux-browser | node, playwright, pnpm |  |  | yes |
| stack-ui | release.yml | PARSE ERROR | Nested mappings are not allowed in compact mappings at line 41, column 14: |||||||||
| supply-desk | ci.yml | check | push, pull_request |  | "ubuntu-latest" | 1 | linux-small | node |  |  |  |
| tableOS | ci.yml | check | push, pull_request |  | "ubuntu-latest" | 1 | linux-small | node |  |  |  |
| wasm-agent-env | ci.yml | test | push, pull_request |  | "ubuntu-latest" | 1 | linux-build | go, rust, wasm |  |  | yes |
