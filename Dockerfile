FROM node:24-alpine

# docker CLI solo para hostMetrics.source=docker (lab: docker exec a un
# contenedor hermano). En producción se lee /proc por local o ssh.
# Si el mirror de Alpine no resuelve (DNS transitorio), el paquete "no existe"
# y no debe tumbar la imagen del colector.
RUN ok=0; \
    for i in 1 2 3 4 5; do \
      if apk add --no-cache docker-cli; then ok=1; break; fi; \
      echo "apk docker-cli intento ${i} fallo; reintento en 8s"; \
      sleep 8; \
    done; \
    if [ "$ok" != 1 ]; then \
      echo "aviso: docker-cli no quedo instalado. hostMetrics.source=docker no va a funcionar."; \
    fi

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
