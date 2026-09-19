FROM node:24-alpine

# docker CLI for hostMetrics.source=docker (lab: docker exec into Maria containers)
RUN apk add --no-cache docker-cli

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/core/package.json      packages/core/
COPY packages/checks/package.json    packages/checks/
COPY packages/store/package.json     packages/store/
COPY apps/collector/package.json     apps/collector/
COPY apps/cli/package.json           apps/cli/
# npm ci exige el package.json de cada workspace del lockfile, aunque esta
# imagen no corra la web.
COPY apps/web/package.json           apps/web/

# Sin --omit=dev: el colector corre con tsx, que es devDependency de la raíz.
RUN npm ci

COPY tsconfig.base.json tsconfig.json ./
COPY packages/ packages/
COPY apps/ apps/

ENV NODE_ENV=production
CMD ["npx", "tsx", "apps/collector/src/main.ts"]
