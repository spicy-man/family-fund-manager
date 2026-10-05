#!/bin/bash

# Compatible with the Bash 3.2 shipped with macOS.
set -euo pipefail
export COPYFILE_DISABLE=1

NO_PAUSE=0
if [ "${1:-}" = "--no-pause" ]; then
    NO_PAUSE=1
elif [ "$#" -gt 0 ]; then
    echo "用法：bash 一键打包.command [--no-pause]" >&2
    exit 1
fi

PACKAGE_TMP=""
finish() {
    local result=$?
    trap - EXIT
    if [ -n "$PACKAGE_TMP" ]; then
        rm -rf "$PACKAGE_TMP"
    fi
    if [ "$result" -ne 0 ]; then
        echo "[错误] 打包失败，已有发布包未被替换。" >&2
    fi
    if [ "$NO_PAUSE" -eq 0 ] && [ -t 0 ]; then
        printf '\n按回车键退出...'
        read -r _ || true
    fi
    exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cd "$(dirname "$0")"
PROJECT_ROOT="$(pwd -P)"

echo "=================================================="
echo "      家庭基金账目管理系统 · macOS 一键打包"
echo "=================================================="

for tool in git node zip; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "[错误] 未找到 $tool，请先安装并确保它在 PATH 中。" >&2
        exit 1
    fi
done

if [ ! -f package.json ]; then
    echo "[错误] 请将此脚本放在项目根目录，与 package.json 同级。" >&2
    exit 1
fi

PROJECT_NAME="$(node -e 'const p = require("./package.json"); if (typeof p.name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(p.name)) throw new Error("项目名称无效"); process.stdout.write(p.name);')"
VERSION="$(node -e 'const p = require("./package.json"); if (typeof p.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(p.version)) throw new Error("版本号无效"); process.stdout.write(p.version);')"

echo "正在校验版本号..."
node test/test-version.js

if ! git diff --quiet HEAD --; then
    echo "[提示] 有尚未提交的修改，将使用当前工作区文件打包。"
fi

if [ ! -d node_modules ]; then
    echo "[错误] 缺少 node_modules，请先执行 npm install，再打包离线发布版。" >&2
    exit 1
fi

ARCHIVE_NAME="${PROJECT_NAME}_v${VERSION}.zip"
ARCHIVE="$PROJECT_ROOT/$ARCHIVE_NAME"
PACKAGE_TMP="$(mktemp -d "${TMPDIR:-/tmp}/fund-release.XXXXXX")"
STAGING="$PACKAGE_TMP/project"
mkdir -p "$STAGING"

echo "正在收集项目文件与依赖..."
git ls-files -z > "$PACKAGE_TMP/files"
if [ ! -s "$PACKAGE_TMP/files" ]; then
    echo "[错误] Git 中没有可打包的项目文件。" >&2
    exit 1
fi
while IFS= read -r -d '' file; do
    # Exclude local data even if it was accidentally tracked.
    case "$file" in
        data/.gitkeep) ;;
        data/*|backups/*|.git/*|.env|.env.*|*.env|*.zip|node_modules/*) continue ;;
    esac
    if [ -f "$file" ] || [ -L "$file" ]; then
        mkdir -p "$STAGING/$(dirname "$file")"
        cp -pP "$file" "$STAGING/$file"
    fi
done < "$PACKAGE_TMP/files"

# Include this launcher even before its first Git commit.
cp -pP "$PROJECT_ROOT/一键打包.command" "$STAGING/一键打包.command"
cp -pR node_modules "$STAGING/node_modules"

echo "正在生成 $ARCHIVE_NAME ..."
(
    cd "$STAGING"
    # Preserve executable permissions and symlinks; suppress macOS metadata.
    zip -qry "$PACKAGE_TMP/$ARCHIVE_NAME" .
)
mv -f "$PACKAGE_TMP/$ARCHIVE_NAME" "$ARCHIVE"

echo
echo "[成功] 发布包已生成：$ARCHIVE"
echo "版本标签：v$VERSION"
echo "大小：$(du -h "$ARCHIVE" | cut -f1)"
echo
echo "GitHub Release Markdown："
printf '[**%s**](https://github.com/kamen-exaid/family-fund-manager/releases/download/v%s/%s)\n' "$ARCHIVE_NAME" "$VERSION" "$ARCHIVE_NAME"
