# WXClawBot 部署说明

本文档说明如何把 WXClawBot 部署到 Linux 服务器或 Android Termux。

## 先说结论

推荐优先部署到 Linux 服务器。服务器后台更稳定，微信桥接、定时 check-in、日志和长期运行都更可靠。

Termux 也可以部署，但它会受 Android 后台限制、电量管理、网络切换和手机重启影响。适合临时运行、测试、随身演示，不太适合长期无人值守。

## 存储占用

当前 Windows 本地安装后大约：

- 仓库和源码：约 5 MB
- `.git`：约 3 MB
- `node_modules`：约 171 MB
- 整个项目目录：约 177 MB

Linux/Termux 上因为 npm 缓存、pm2 日志、系统包和二进制差异，建议至少预留：

- Linux 服务器：1 GB 可用空间
- Termux：1 GB 可用空间，2 GB 更舒服

`.env`、微信登录态、日志和本地数据默认放在运行环境的 `~/.cyberboss` 或项目目录，不会很大，但长期使用会慢慢增长。

## 安全注意

- `.env` 已加入 `.gitignore`，不要把 API key 提交到 GitHub。
- 不要使用 `Pro/...` 开头的 SiliconFlow 模型，避免触发余额或 key 风险。
- 当前推荐默认模型：`deepseek-ai/DeepSeek-V4-Flash`。
- 微信登录态保存在部署机器本地，所以服务器和 Termux 都需要各自扫码登录一次。

## 一键部署到 Linux 服务器

适用：Ubuntu/Debian 服务器。

最短命令：

```bash
curl -fsSL https://raw.githubusercontent.com/chnsheg/WXClawBot/main/scripts/deploy-server.sh | bash
```

如果仓库是私有的，先在服务器上配置好 GitHub token 或 SSH key，再用：

```bash
git clone https://github.com/chnsheg/WXClawBot.git
cd WXClawBot
bash scripts/deploy-server.sh
```

脚本会做这些事：

- 安装或检查 Git、curl、Node.js 22+
- 拉取仓库
- 创建 `.env`
- 安装 npm 依赖
- 执行微信扫码登录
- 用 pm2 启动 `node ./bin/cyberboss.js start --checkin`

也可以用环境变量全自动运行：

```bash
OPENAI_API_KEY="YOUR_API_KEY_HERE" \
APP_DIR="$HOME/WXClawBot" \
REPO_URL="https://github.com/chnsheg/WXClawBot.git" \
bash scripts/deploy-server.sh
```

常用运维命令：

```bash
pm2 status
pm2 logs wxclawbot
pm2 restart wxclawbot
pm2 stop wxclawbot
```

## 一键部署到 Termux

先在 Android 安装 Termux。建议使用 F-Droid 版本。不要用长期不更新的旧版安装源。

在 Termux 里运行：

```bash
pkg update -y
pkg install -y curl
curl -fsSL https://raw.githubusercontent.com/chnsheg/WXClawBot/main/scripts/deploy-termux.sh | bash
```

脚本会做这些事：

- 安装 Git、Node.js、OpenSSH、termux-api
- 拉取仓库
- 创建 `.env`
- 安装 npm 依赖
- 获取 wake lock，降低后台被杀概率
- 执行微信扫码登录
- 用 pm2 启动 `node ./bin/cyberboss.js start --checkin`
- 写入 Termux:Boot 启动脚本

Termux 扫码登录提示：

- 如果微信也在同一台手机上，直接扫码会不方便。
- 可以用另一台设备扫码。
- 或截图二维码后，用微信扫一扫从相册识别，但二维码可能过期，需要动作快一点。

Termux 长期运行建议：

- 安装 Termux:Boot。
- 给 Termux 关闭电池优化。
- 保持网络稳定。
- 运行 `termux-wake-lock`。
- 手机重启后打开一次 Termux 或让 Termux:Boot 执行启动脚本。

常用 Termux 运维命令：

```bash
pm2 status
pm2 logs wxclawbot
pm2 restart wxclawbot
termux-wake-lock
termux-wake-unlock
```

## 手动切换模型

编辑 `.env`：

```bash
CYBERBOSS_OPENAI_MODEL=deepseek-ai/DeepSeek-V4-Flash
```

然后重启：

```bash
pm2 restart wxclawbot
```

如果没有用 pm2：

```bash
npm run start:checkin
```

## 排错

查看当前配置：

```bash
npm run doctor
```

查看日志：

```bash
pm2 logs wxclawbot
```

常见问题：

- `30001`：通常是用了 Pro 模型或 key 余额/套餐问题。
- `401`：API key 错误或没有传入。
- 微信二维码过期：重新运行 `npm run login`。
- Termux 后台断开：检查电池优化、wake lock、Termux:Boot。
