#!/bin/bash
# ============================================
# 德州扑克 - 自动监测主分支更新并部署脚本
# 在服务器上运行，自动 git pull + PM2 restart
#
# 用法:
#   bash auto-deploy.sh           # 单次检查
#   bash auto-deploy.sh --watch   # 持续监测，每60秒检查一次
# ============================================

# ---- 配置 ----
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
REMOTE="origin"
BRANCH="main"
PM2_PROCESSES="poker-online poker-online-4000"
LOG_FILE="$PROJECT_DIR/deploy.log"
CHECK_INTERVAL=60

# ---- 颜色 ----
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() {
    local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $1"
    echo -e "$msg"
    echo "$msg" >> "$LOG_FILE" 2>/dev/null
}

deploy() {
    log "${GREEN}>>> 开始本地部署...${NC}"

    # 安装依赖（如果 package.json 有变化）
    if [ -f "$PROJECT_DIR/package.json" ]; then
        log "  检查依赖..."
        cd "$PROJECT_DIR" && npm install --production 2>&1 | tail -1 | tee -a "$LOG_FILE"
    fi

    # 重启 PM2 进程
    log "  重启 PM2 进程..."
    for proc in $PM2_PROCESSES; do
        pm2 restart "$proc" 2>/dev/null || log "  ${YELLOW}⚠ 进程 $proc 未找到，跳过${NC}"
    done
    sleep 2
    pm2 list --no-color 2>&1 | tee -a "$LOG_FILE"

    log "${GREEN}>>> 部署完成！${NC}"
    return 0
}

check_and_deploy() {
    cd "$PROJECT_DIR" || { log "${RED}无法进入项目目录: $PROJECT_DIR${NC}"; return 1; }

    # 获取当前本地 commit
    local local_hash=$(git rev-parse HEAD 2>/dev/null)
    if [ -z "$local_hash" ]; then
        log "${RED}无法获取本地 commit hash${NC}"
        return 1
    fi

    # fetch 远端最新
    log "正在检查远端更新 (fetch $REMOTE $BRANCH)..."
    git fetch "$REMOTE" "$BRANCH" 2>/dev/null
    if [ $? -ne 0 ]; then
        log "${RED}git fetch 失败，跳过本次检查${NC}"
        return 1
    fi

    # 获取远端 commit
    local remote_hash=$(git rev-parse "$REMOTE/$BRANCH" 2>/dev/null)
    if [ -z "$remote_hash" ]; then
        log "${RED}无法获取远端 commit hash${NC}"
        return 1
    fi

    # 比较
    if [ "$local_hash" = "$remote_hash" ]; then
        log "${GREEN}✓ 主分支无更新 (当前: ${local_hash:0:7})${NC}"
        return 0
    fi

    # 有更新
    local new_commits=$(git rev-list --count "HEAD..$REMOTE/$BRANCH" 2>/dev/null)
    log "${YELLOW}>>> 发现主分支有 $new_commits 个新提交！${NC}"
    log "  本地: ${local_hash:0:7}  →  远端: ${remote_hash:0:7}"

    # 显示新增提交
    log "  新增提交:"
    git log --oneline "HEAD..$REMOTE/$BRANCH" 2>/dev/null | while read line; do
        log "    - $line"
    done

    # 拉取更新
    log "正在拉取更新 (git pull $REMOTE $BRANCH)..."
    git pull "$REMOTE" "$BRANCH" --no-edit 2>&1 | tee -a "$LOG_FILE"
    if [ ${PIPESTATUS[0]} -ne 0 ]; then
        log "${RED}  ✗ git pull 失败，可能存在冲突，请手动处理${NC}"
        git merge --abort 2>/dev/null
        return 1
    fi
    log "  ✓ 代码拉取成功"

    # 部署
    deploy
    return $?
}

# ---- 主逻辑 ----
echo "============================================"
echo " 德州扑克自动部署脚本 (服务端)"
echo " 项目: $PROJECT_DIR"
echo " 分支: $REMOTE/$BRANCH"
echo "============================================"

if [ "$1" = "--watch" ]; then
    log "${YELLOW}进入持续监测模式 (间隔 ${CHECK_INTERVAL}s, Ctrl+C 退出)${NC}"
    while true; do
        check_and_deploy
        sleep "$CHECK_INTERVAL"
    done
else
    check_and_deploy
    exit $?
fi
