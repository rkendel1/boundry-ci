# Tests

| Command | Needs | Duration |
|---|---|---|
| `npm test` | `FELTDB_SERVER_BIN` (feltdb-server built from rkendel1/flow_db) | ~5 s |
| `npm run test:e2e` | + Docker daemon, network to github.com, `mirror.gcr.io/library/node:22-bookworm-slim` | ~1 min |
| `npm run test:deploy` | + Docker Compose, root, images below, `appboundry/deploy/boundry/image-identity.mjs` (`BCI_IDENTITY_SCRIPT`) | ~5 min |

Images for `test:deploy` (suites skip with a reason when one is missing; nothing is faked):

```bash
docker build --build-arg BCI_REVISION=$(printf 'a%.0s' {1..40}) -f deploy/Dockerfile -t boundry-ci:test-a .
```

```bash
docker build --build-arg BCI_REVISION=$(printf 'b%.0s' {1..40}) -f deploy/Dockerfile -t boundry-ci:test-b .
```

`bci-test-feltdb:local`: an image with the same entrypoint, user model and paths as the `control-plane`
target of `flow_db/deploy/Dockerfile` (or that target itself). The canary image is
`mirror.gcr.io/library/node@sha256:e9f565d3…` (override with `BCI_CANARY_IMAGE`).
Behind a TLS-intercepting proxy add `--secret id=build_ca,src=<ca bundle>` to the builds.
