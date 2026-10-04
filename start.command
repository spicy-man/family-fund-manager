#!/bin/bash

# 自动切换到当前脚本所在的目录
cd "$(dirname "$0")"

echo "=================================================="
echo "      正在准备启动家庭基金账目管理系统..."
echo "=================================================="

# 1. 检查 Node.js 是否安装
if ! command -v node &> /dev/null
then
    echo "[错误] 未检测到 Node.js 环境！"
    echo "请先前往 https://nodejs.org/ 下载并安装 Node.js。"
    echo "安装完成后，请重新双击运行此脚本。"
    echo
    read -p "按回车键退出..."
    exit 1
fi

# 2. 检查 node_modules 是否存在，若不存在则自动运行 npm install
if [ ! -d "node_modules" ]; then
    echo "[提示] 检测到本地依赖未安装，正在为您自动配置环境，请稍候..."
    echo
    npm install
    if [ $? -ne 0 ]; then
        echo "[错误] 依赖安装失败，请检查您的网络连接后重试！"
        read -p "按回车键退出..."
        exit 1
    fi
    echo "[成功] 依赖安装完成！"
    echo
fi

# 3. 启动服务，成功监听后由服务打开浏览器，避免固定延时导致首次连接失败
echo "[提示] 正在启动后端服务..."
echo
npm start -- --open-browser
