# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Étape 1 : construction. Contient les outils de compilation (better-sqlite3,
# lot 1) ; rien de cette étape ne finit dans l'image finale sauf ce qu'on copie.
# ---------------------------------------------------------------------------
FROM node:24-bookworm AS build
WORKDIR /app

# Les manifestes d'abord : la couche des dépendances reste en cache tant
# qu'ils ne changent pas.
COPY package.json package-lock.json tsconfig.base.json ./
COPY app/server/package.json app/server/
COPY app/client/package.json app/client/
RUN npm ci

COPY app/server app/server
COPY app/client app/client
RUN npm run build

# Dépendances de production seules, pour l'image finale.
RUN npm prune --omit=dev

# ---------------------------------------------------------------------------
# Étape 2 : image finale. Pas de compilateur, pas de sources TypeScript.
# bookworm-slim (glibc) et non alpine : binaires précompilés (ADR-0008).
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime

# tzdata : sans base de fuseaux, tout le traitement des dates serait faux.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tzdata \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    TZ=Europe/Paris \
    ATTROUPE_DATA_DIR=/data

WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/app/server/package.json ./app/server/package.json
COPY --from=build /app/app/server/dist ./app/server/dist
COPY --from=build /app/app/client/dist ./app/client/dist

# Le dossier de données appartient à l'utilisateur non root. Avec un volume monté depuis
# l'hôte (./data), c'est le dossier de l'hôte qui compte : le serveur refuse de démarrer
# s'il n'est pas inscriptible (voir DOCUMENTATION.md, section 5).
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/sante').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "--enable-source-maps", "app/server/dist/index.js"]
