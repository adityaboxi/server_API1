FROM node:20-alpine
WORKDIR /app
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001
COPY --chown=nodejs:nodejs package*.json ./
RUN npm install --omit=dev --legacy-peer-deps && npm cache clean --force
COPY --chown=nodejs:nodejs src ./src
USER nodejs
EXPOSE 4000
CMD ["node", "src/index.js"]