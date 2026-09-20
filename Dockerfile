FROM node:20-alpine

WORKDIR /app

# 先安装依赖，利用层缓存
COPY package.json ./
RUN npm install --omit=dev

# 拷贝应用代码
COPY server.js ./
COPY lib ./lib
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
