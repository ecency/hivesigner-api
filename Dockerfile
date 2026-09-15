FROM node:18.19.1-alpine

WORKDIR /var/app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --non-interactive --production=true

COPY . .

# The usage history lives here, and the runtime is non-root. A named volume
# mounted on a path the image does not own is created ROOT-owned and every write
# fails silently; Docker seeds a fresh volume from the image, so creating it
# here with the right owner is what makes the mount writable.
RUN mkdir -p /var/app/data && chown -R node:node /var/app/data

# Drop root for the runtime. The app only reads from the image, so nothing here
# needs write access; the install above already ran as root and is complete.
# `node` is a non-root user the official image ships.
USER node

ENV API_PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${API_PORT}/_health" || exit 1

# node DIRECTLY, not `npm start`. As PID 1, npm does not forward SIGTERM to its
# child, so the signal never reached the app: `docker stop` waited out the full
# grace period and then SIGKILLed it - measured at 30s, and true of every deploy
# this service has had. For a broadcast API that means in-flight requests were
# being killed on each release. Flags mirror the `start` script.
CMD ["node", "--experimental-modules", "--experimental-json-modules", "--es-module-specifier-resolution=node", "start.js"]
