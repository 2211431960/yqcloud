# GitHub + Render 免费部署（比临时隧道更稳）

## 为什么比 localhost.run 隧道稳
| 方案 | 地址 | 稳定性 | 数据 |
|---|---|---|---|
| localhost.run 隧道（当前测试中） | 临时随机域名 | 断线需重开、地址会变 | 本机 SQLite 持久 |
| **GitHub + Render 免费 Web Service** | **固定 `*.onrender.com`** | 云端 24/7 在线、HTTPS、自动部署 | **注意：免费层无持久磁盘**，每次重新部署/服务重建数据会重置（正式建议升级持久盘或上云主机） |

免费实例特性：约 15 分钟无访问会休眠（休眠后首次打开需冷启动 30~60 秒），每月 750 小时免费额度（一个实例够用）。适合：给客户看演示、联调网关。

## 三步上线（需要你的 GitHub 账号，我只能帮你准备到"就差你授权"）

### 第 1 步：推到 GitHub（两种方式任选）
- **方式 A（推荐，最简单）**：安装 GitHub CLI → 浏览器登录一次：
  ```powershell
  winget install --id GitHub.cli
  gh auth login
  cd C:\Users\f2211\Desktop\平台
  git init && git add -A && git commit -m "yqcloud v1"
  gh repo create yqcloud --private --source . --remote origin --push
  ```
- **方式 B**：到 github.com 新建私有仓库 → 复制仓库地址后：
  ```powershell
  git remote add origin https://github.com/<你的账号>/yqcloud.git
  git push -u origin master
  ```
  （推送时按提示输入 GitHub 用户名与 Personal Access Token，token 在 GitHub → Settings → Developer settings 生成，勾 repo 权限）

### 第 2 步：Render 自动部署（2 分钟）
1. 打开 https://render.com → 用 **GitHub** 登录（免费，无需绑卡）；
2. New → **Web Service** → Connect 你的 yqcloud 仓库；
3. 文件 `render.yaml` 会自动被识别（Runtime=Node、启动命令、健康检查、环境变量全部预置）→ 直接 **Deploy**；
4. 约 1 分钟构建完成，得到固定地址：`https://yqcloud.onrender.com`（HTTPS，手机/客户直接访问）。

### 第 3 步：上线后建议
- 环境变量（Settings → Environment）：`ALLOW_REGISTER=0` 关闭注册（或保留）；`DATA_KEEP_DAYS=30` 默认即可；
- `NODE_ENV=production` 已预置（指令回执的 DEMO_ACK 自动关闭，只认真实网关）
- 因为免费层无持久盘：每次 push 会重建服务并清空数据库（首次部署为空库自动种子）；需要长期数据时升级持久磁盘或让客户注册国内云主机再迁移（`docs/DEPLOY.md` 有完整迁移/HTTPS/域名指引）。

## 备注
- 本项目零 npm 依赖：GitHub/Render 构建无需 `npm install`，`node backend/server.js` 直接起（Node 22.5+，见 `.node-version`）；
- 健康检查 `/api/health` 已接入 Render（含数据库与外部服务自检）；
- 若以后想换 Railway/Fly.io，也可直接复用 `Dockerfile`（项目根目录已提供）。
