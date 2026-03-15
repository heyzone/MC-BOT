FROM node:18

# 创建工作目录
WORKDIR /app

# 复制 package 文件
COPY package*.json ./

# 安装依赖
RUN npm install

# 复制所有文件
COPY . .

# 暴露端口
EXPOSE 7860

# 设置环境变量
ENV SERVER_PORT=7860

# 启动
CMD ["npm", "start"]
