#!/bin/bash
# ============================================
# 德州扑克 Online — 阿里云一键部署脚本
# ============================================
set -e

echo "🃏 德州扑克 Online 部署开始"
echo ""

# 1. 检查 Docker
if ! command -v docker &> /dev/null; then
    echo "📦 安装 Docker..."
    curl -fsSL https://get.docker.com | sh
    systemctl enable docker && systemctl start docker
    echo "✅ Docker 安装完成"
fi

if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
    echo "📦 安装 Docker Compose..."
    curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
    chmod +x /usr/local/bin/docker-compose
    echo "✅ Docker Compose 安装完成"
fi

# 2. 部署方式选择
echo ""
echo "选择部署方式："
echo "  1) 直接部署 (端口 3000，适合测试)"
echo "  2) Nginx 反向代理部署 (端口 80，适合生产)"
read -p "请输入选择 [1/2]: " choice

if [ "$choice" = "2" ]; then
    echo "🚀 使用 Nginx 反向代理部署..."
    docker compose -f docker-compose.prod.yml up -d --build
    echo ""
    echo "✅ 部署完成！"
    echo "🌐 访问地址: http://$(curl -s ifconfig.me 2>/dev/null || echo '你的服务器IP')"
    echo ""
    echo "如需 HTTPS，请："
    echo "  1. 将 SSL 证书放入 nginx/ssl/ 目录"
    echo "  2. 修改 nginx/default.conf 添加 SSL 配置"
    echo "  3. 取消 docker-compose.prod.yml 中 SSL 卷的注释"
    echo "  4. 重新运行: docker compose -f docker-compose.prod.yml up -d --build"
else
    echo "🚀 直接部署到端口 3000..."
    docker compose up -d --build
    echo ""
    echo "✅ 部署完成！"
    echo "🌐 访问地址: http://$(curl -s ifconfig.me 2>/dev/null || echo '你的服务器IP'):3000"
fi

echo ""
echo "📋 常用命令："
echo "  查看日志:   docker compose logs -f poker"
echo "  重启服务:   docker compose restart"
echo "  停止服务:   docker compose down"
echo "  更新部署:   git pull && docker compose up -d --build"
