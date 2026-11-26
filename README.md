# 工程小管家 Web

需要 Node.js 22.9 或更高版本。Web 页面和 API 在同一个 Node.js 进程内运行。

## 本地启动

在仓库根目录的 `.env` 中设置超级管理员凭证。

```dotenv
ADMIN_ACCOUNT=admin
ADMIN_PASSWORD=填写至少12位的自选密码
```

服务每次启动都会读取这两个变量，修改后重启生效。首次启动会创建超级管理员和空业务库。已有库会保留原管理员 ID 和业务记录，并将该账号识别为超级管理员。超级管理员在服务重启后需要重新登录。可选的 `ADMIN_NAME` 用于指定超级管理员账号的显示姓名。

```bash
npm ci --omit=dev
npm start
```

打开 http://127.0.0.1:4173。可用 `HOST`、`PORT` 和 `DATA_DIR` 修改监听地址、端口和数据目录。默认数据目录为项目下的 `data/`，其中 `db.json` 保存账号、人员档案、任务、需求和会话，`attachments/` 保存任务附件。备份应同时包含两者。这个 JSON 数据库由单个服务进程写入。

超级管理员可在「人员管理 → 成员档案」授权或撤销管理员权限。成员继续使用自己的账号和密码，权限变更后需要重新登录。管理员建号或重置密码时，界面会显示生成的临时密码，成员登录后须修改。默认开启自助注册，设置 `ALLOW_REGISTRATION=0` 可以关闭。

## 阿里云部署配置

在 `/opt/fae-console` 拉取代码后，运行 `npm ci --omit=dev` 安装依赖，再启动或重启 Web 服务。

- `deploy/fae-console.service` 由 systemd 管理，假定项目位于 `/opt/fae-console`。运行数据写入 `/var/lib/fae-console`，超级管理员凭证由项目根目录的 `/opt/fae-console/.env` 提供。环境文件应只允许 root 读取，并包含 `ADMIN_ACCOUNT` 和 `ADMIN_PASSWORD`。已有实例升级时，将旧环境文件里的值带到项目根目录，再重新安装服务定义并执行 `systemctl daemon-reload` 和 `systemctl restart fae-console`。
- `deploy/fae-console.conf` 为 `fae-work-console.patrick-shenzhen.cn` 提供入口，并将网页和 API 一并转发至 `127.0.0.1:4173`。启用前请确认 DNS 和服务器防火墙，HTTPS 由 Certbot 配置。
- systemd 配置要求通过 HTTPS 使用登录会话。用本地端口检查服务时，首页仍可访问。
- 附件单文件最多 20 MB。周任务可导出 ZIP，内含 CSV 和有权限下载的附件。原桌面版的本地附件需从原电脑重新上传。

## 企业微信机器人

`fae-wecom-bridge.service` 独立运行，通过企业微信智能机器人的 WebSocket 长连接收发消息。在机器人会话里发送 `/test`，机器人回复 `hello`。

在 `/opt/fae-console/.env` 增加以下配置，使用专门为 FAE 配置的智能机器人长连接凭据。

```dotenv
WECOM_ENABLED=true
WECOM_BOT_ID=你的机器人ID
WECOM_BOT_SECRET=你的机器人Secret
```

首次安装 Bridge 需要在项目根目录运行 `npm ci --omit=dev`，安装 `deploy/fae-wecom-bridge.service` 并执行 `systemctl daemon-reload`。配置或更换凭据后执行 `systemctl restart fae-wecom-bridge`。运行日志可用 `journalctl -u fae-wecom-bridge -n 30 --no-pager` 查看。本地测试用 `npm run wecom:bridge`。

### 任务群通知

在目标企业微信群的「消息推送 → 自定义消息推送」里添加机器人，复制生成的 Webhook 地址。把完整地址写入 VPS 项目根目录的 `/opt/fae-console/.env`，然后执行 `systemctl restart fae-console`。

```dotenv
WECOM_GROUP_WEBHOOK_URL="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=替换为实值"
```

管理员在「人员管理 → 登录账号」为需要接收提醒的成员绑定企业微信通讯录里的 UserID。需求首次派发时提醒负责人及初始合作者，更换负责人时提醒新负责人，增加合作者时提醒新加入的人。群消息只包含事件、任务编号和任务链接，链接要求登录并按现有任务权限显示详情。没有已绑定接收人时跳过该消息。发送失败可用 `journalctl -u fae-console -n 50 --no-pager` 查看。

## 行为规范

规范正文放在项目根目录的 `private/guidelines.json`，整个 `private/` 目录由 Git 忽略。阿里云部署时将文件单独复制到 `/opt/fae-console/private/guidelines.json`。目录和文件使用 `root:root`，权限分别设为 `0700` 和 `0600`。服务启动时由 systemd 将正文只读提供给服务进程，网页通过登录接口读取。部署内部规范前请在项目 `.env` 中设置 `ALLOW_REGISTRATION=0`。

首次上线规范时，安装新版 `deploy/fae-console.service`，执行 `systemctl daemon-reload` 后重启 `fae-console`。以后更新规范只需替换正文文件并重启服务。

## Windows 免安装版

桌面版在 Electron 窗口中打开线上工作台，并加载经典浅色侧栏样式。网页和桌面使用同一个前端、API 和线上账号。网页业务功能上线后，桌面用户重新打开即可加载更新。桌面外壳、桌面专用样式或 Electron 版本有改动时，需要重新打包。

```bash
npm --prefix desktop ci
npm --prefix desktop run build:win
```

在 `desktop/dist/` 取 `FAE-Console-Windows-x64-Portable-<版本>.exe`。在 Windows x64 上双击运行，登录时需联网。桌面源码和锁文件随 Git 维护，生成的二进制单独交付。

```bash
npm run check
```
