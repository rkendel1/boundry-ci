# Boundry CI control-plane image. Built off-host (never on the shared server) and shipped with
# appboundry/deploy/boundry/ship-images.sh, which refuses mutable tags.
FROM mirror.gcr.io/library/node@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
WORKDIR /app
COPY package.json package-lock.json ./
# Optional build-time CA (e.g. a TLS-intercepting egress proxy): supplied as a BuildKit secret, never stored in a layer.
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY bin ./bin
COPY src ./src
COPY schema ./schema
# The source commit this image was built from. Health checks require the running revision to equal the release's.
ARG BCI_REVISION
RUN test -n "$BCI_REVISION" || (echo "BCI_REVISION build arg is required" >&2; exit 1)
ENV BCI_REVISION=$BCI_REVISION
LABEL org.opencontainers.image.revision=$BCI_REVISION org.opencontainers.image.source=https://github.com/rkendel1/boundry-ci
USER 21030:21030
ENV NODE_ENV=production
ENTRYPOINT ["node", "bin/boundry-ci.ts"]
CMD ["control"]
