# Squire Notes: builds the frontend, then runs the Python server, which serves both the
# app and the API on port 8765. The notebook (notes, trash and settings) is the
# /data/notebook folder: mount it as a volume, or nothing is kept when the container goes.

FROM node:24-alpine AS frontend
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html env.d.ts vite.config.ts tsconfig*.json ./
COPY public ./public
COPY src ./src
RUN npm run build

FROM python:3.13-slim
WORKDIR /app
COPY server ./server
COPY --from=frontend /build/dist ./dist

ENV NOTEBOOK_DIR=/data/notebook \
    STATIC_DIR=/app/dist \
    HOST=0.0.0.0 \
    PORT=8765 \
    PYTHONUNBUFFERED=1

VOLUME /data/notebook
EXPOSE 8765

CMD ["python", "server/server.py"]
