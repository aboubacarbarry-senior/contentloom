# Review app. CONTENTLOOM_API is read by next.config.js at build time for the /api rewrite.
FROM node:20-alpine AS build
WORKDIR /app
ARG CONTENTLOOM_API=http://api:3001
ENV CONTENTLOOM_API=$CONTENTLOOM_API NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY . .
RUN npx next build

FROM node:20-alpine
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/next.config.js ./
USER node
EXPOSE 3002
CMD ["npx", "next", "start", "-p", "3002"]
