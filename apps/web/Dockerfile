# Web image. NEXT_PUBLIC_* values are compiled into the browser bundle, so every instance
# (normal / ai) is its own image, built with its own build args. See docs/deploy.md.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
COPY e2e/package.json e2e/
RUN npm ci -w apps/web --include-workspace-root
COPY apps/web apps/web

ARG NEXT_PUBLIC_AI_FEATURES=false
ARG NEXT_PUBLIC_API_URL=http://localhost:8080/api
ARG NEXT_PUBLIC_WS_URL=ws://localhost:8080/ws
ARG NEXT_PUBLIC_DEV_LOGIN=false
ENV NEXT_PUBLIC_AI_FEATURES=$NEXT_PUBLIC_AI_FEATURES \
    NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL \
    NEXT_PUBLIC_DEV_LOGIN=$NEXT_PUBLIC_DEV_LOGIN \
    NEXT_OUTPUT=standalone \
    NEXT_TELEMETRY_DISABLED=1
RUN npm run build -w apps/web

FROM node:22-alpine
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
