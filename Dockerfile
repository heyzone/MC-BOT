FROM node:18-slim

# 1. 安装 Chromium 及其所需的系统底层依赖
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# 2. 设置环境变量，告诉 Puppeteer 跳过自带浏览器下载，并指定 Chromium 路径
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# 创建工作目录
WORKDIR /app

# 复制 package 文件并安装依赖
COPY package*.json ./
RUN npm install --omit=dev

# 复制所有文件
COPY . .

# 暴露端口
EXPOSE 7860
ENV SERVER_PORT=7860

# 启动
CMD ["npm", "start"]
