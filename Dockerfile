FROM node:20-slim

ENV NODE_ENV=production
WORKDIR /app

# Install production dependencies only, as the unprivileged `node` user.
COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev

COPY --chown=node:node . .

# Never run the API as root inside the container.
USER node

ENV PORT=5000
EXPOSE 5000

CMD ["npm", "start"]
