FROM node:20-alpine
RUN apk add --no-cache ffmpeg && addgroup -S app && adduser -S -G app -u 10001 app
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY test ./test
USER app
EXPOSE 8095
CMD ["node", "server.js"]
