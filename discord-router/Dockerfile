FROM node:22-alpine

WORKDIR /app

# Install dependencies
COPY package.json ./
RUN npm install --omit=dev

# Install tsx for running TypeScript directly
RUN npm install tsx

COPY router.ts ./

# Expose ports
EXPOSE 7777
EXPOSE 7778

CMD ["node", "--import", "tsx/esm", "router.ts"]
