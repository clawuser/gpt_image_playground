#!/bin/sh

# 用环境变量替换默认 API URL
API_URL=${API_URL:-https://api.openai.com}

# 查找所有 js 文件并将占位符替换为实际的 API_URL
find /usr/share/nginx/html/assets -type f -name "*.js" -exec sed -i "s|__VITE_DEFAULT_API_URL_PLACEHOLDER__|$API_URL|g" {} +

exec "$@"
