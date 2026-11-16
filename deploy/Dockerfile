# Boundry CI control-plane image. Built off-host (never on the shared server) and shipped with
# appboundry/deploy/boundry/ship-images.sh, which refuses mutable tags.
FROM mirror.gcr.io/library/node@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY bin ./bin
COPY src ./src
COPY schema ./schema
USER 21030:21030
ENV NODE_ENV=production
ENTRYPOINT ["node", "bin/boundry-ci.ts"]
CMD ["control"]
