# Boundry toolchain image: Rust with the components recipes use (build, test, fmt, clippy).
# Built off-host, pinned by digest in src/recipes/catalog.ts. Optional build CA as a BuildKit secret.
FROM mirror.gcr.io/library/rust@sha256:7c7d4eb4d05b7781187a327809466cfddf29753f6defdc3d19a0e291951b7a37
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -f /run/secrets/build_ca ]; then export SSL_CERT_FILE=/run/secrets/build_ca CURL_CA_BUNDLE=/run/secrets/build_ca; fi; \
    rustup component add rustfmt clippy && cargo fmt --version && cargo clippy --version \
    && chmod -R a+rX /usr/local/rustup /usr/local/cargo
LABEL org.opencontainers.image.source=https://github.com/rkendel1/boundry-ci org.opencontainers.image.title="boundry toolchain: rust"
