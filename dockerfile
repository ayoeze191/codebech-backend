FROM node:22-bullseye
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY prisma.config.js ./
RUN ls -la /app/prisma.config.js
COPY prisma ./prisma
RUN ls -la prisma/
ARG DATABASE_URL=postgresql://placeholder:placeholder@localhost:5432/placeholder
ENV DATABASE_URL=$DATABASE_URL
RUN npx prisma generate --schema=./prisma/schema.prisma
RUN npx prisma generate --schema=./prisma/schema.prisma
RUN ls -la node_modules/.prisma/client || echo "❌ Prisma Client generation failed"
COPY . .
EXPOSE 3000
CMD ["npm", "start"]