FROM node:18-slim

# 只安装 mineflayer 需要的基础依赖即可
RUN apt-get update && apt-get install -y \
    ca-certificates \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 7860
ENV SERVER_PORT=7860

CMD ["npm", "start"]
