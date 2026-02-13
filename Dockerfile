FROM oven/bun:1-alpine AS base
WORKDIR /app

FROM base AS install
RUN mkdir -p /temp/dev /temp/prod
COPY package.json bun.lock /temp/dev/
RUN cd /temp/dev && bun install --frozen-lockfile
COPY package.json bun.lock /temp/prod/
RUN cd /temp/prod && bun install --frozen-lockfile --production --omit optional --omit peer

FROM base AS build
COPY --from=install /temp/dev/node_modules ./node_modules
COPY . .
RUN bun run build

FROM base AS runtime
ARG LURK_VERSION=dev
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV LURK_DATA_DIR=/data
ENV LURK_VERSION=${LURK_VERSION}

COPY --from=install /temp/prod/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/package.json ./package.json

RUN mkdir -p /data /app/logs && chown -R bun:bun /app /data

USER bun
EXPOSE 3000/tcp

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
	CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT ?? '3000')+'/api/health').then((res)=>process.exit(res.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "build/index.js"]
