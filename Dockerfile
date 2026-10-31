# Optional: run MGI anywhere with Docker (VPS, Railway, etc.)
FROM node:20-alpine AS build
WORKDIR /app
COPY frontend/package*.json frontend/
RUN npm ci --prefix frontend
COPY frontend frontend
RUN npm run build --prefix frontend

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY backend/package*.json backend/
RUN npm ci --prefix backend --omit=dev
COPY backend backend
COPY --from=build /app/frontend/dist frontend/dist
EXPOSE 8080
CMD ["node", "backend/src/server.js"]
