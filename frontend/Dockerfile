# syntax=docker/dockerfile:1.6

# ---- Base: deps ----
FROM node:20-alpine AS base
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install

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
RUN npm run build

# ---- Production target (nginx serving built SPA) ----
FROM nginx:alpine AS prod
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.spa.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
