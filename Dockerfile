# 陇药步云 · 云监控平台 镜像（Node >= 22，内置 node:sqlite，零 npm 依赖）
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8600 \
    HOST=0.0.0.0 \
    YQ_DB=/app/data/yqcloud.db

# 先复制源码（无 node_modules 依赖，构建极快）
COPY . .

RUN mkdir -p /app/data/logs

VOLUME ["/app/data"]

EXPOSE 8600

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8600/api/auth/me').then(r=>process.exit(r.status===401?0:1)).catch(()=>process.exit(1))"

CMD ["node", "backend/server.js"]
