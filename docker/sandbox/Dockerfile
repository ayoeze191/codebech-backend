FROM node:22-alpine

RUN apk add --no-cache python3 py3-pip

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

WORKDIR /app

COPY runner.js .
COPY executors ./executors

RUN chown -R nodejs:nodejs /app


USER nodejs

CMD ["node", "runner.js"]
