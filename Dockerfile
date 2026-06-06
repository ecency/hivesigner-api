FROM node:18.19.1-alpine

WORKDIR /var/app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --non-interactive --production=true

COPY . .

ENV API_PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${API_PORT}/_health" || exit 1

CMD ["npm", "start"]
