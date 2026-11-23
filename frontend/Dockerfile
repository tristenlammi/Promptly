# syntax=docker/dockerfile:1.6

# ---- Base: deps ----
FROM node:22-alpine AS base
WORKDIR /app
COPY package.json package-lock.json* ./
# The spreadsheet library's fixes go in right after the install ("postinstall"
# in package.json), so the script has to be here before it. "prebuild" runs it
# again, which changes nothing when it's already done.
COPY scripts/patch-fortune-sheet.mjs scripts/
RUN npm install --no-audit --no-fund

# ---- Development target (Vite dev server w/ HMR) ----
FROM base AS dev
COPY . .
EXPOSE 80
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "80"]

# ---- Build stage ----
FROM base AS build
COPY . .
# Auth provider is baked at build time (Vite inlines import.meta.env). Defaults
# keep the built app on the custom JWT auth; pass VITE_AUTH_PROVIDER=clerk +
# the publishable key to build the Clerk variant.
ARG VITE_AUTH_PROVIDER=custom
ARG VITE_CLERK_PUBLISHABLE_KEY=
ENV VITE_AUTH_PROVIDER=$VITE_AUTH_PROVIDER
ENV VITE_CLERK_PUBLISHABLE_KEY=$VITE_CLERK_PUBLISHABLE_KEY
# The production build needs about 4 GB of JavaScript heap. Node sizes its
# default limit from the machine: about 2 GB on anything under 16 GB of RAM
# (which includes Docker Desktop's default 8 GB), where the build died with
# "JavaScript heap out of memory". Say it outright, with room to grow.
ENV NODE_OPTIONS=--max-old-space-size=6144
RUN npm run build

# ---- Production target (nginx serving built SPA) ----
FROM nginx:alpine AS prod
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.spa.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
