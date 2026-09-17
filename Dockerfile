FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
ENV NODE_ENV=production
USER node
EXPOSE 18800
CMD ["node", "src/server.js"]
