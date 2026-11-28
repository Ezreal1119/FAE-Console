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

打开 http://127.0.0.1:4173。可用 `HOST`、`PORT` 和 `DATA_DIR` 修改监听地址、端口和数据目录。默认数据目录为项目下的 `data/`，其中 `db.json` 保存账号、人员档案、任务、需求、会话和附件索引。附件内容保存在公司 SFTP，备份时应同时保留索引和 SFTP 文件。这个 JSON 数据库由单个服务进程写入。

项目阶段需求保存在数据库中，管理员在项目详情里维护各自的清单，在「项目管理 → 项目配置」维护新建项目使用的模板。首次部署时，将从「内部」工作表整理的 `npi-stage-seed.json` 放入服务数据目录并重启。服务会一次性为已有项目写入独立清单，并以当时的模板初始化后续新项目。清单写入后可以移除种子文件。

超级管理员可在「人员管理 → 成员档案」授权或撤销管理员权限。成员继续使用自己的账号和密码，权限变更后需要重新登录。管理员建号或重置密码时，界面会显示生成的临时密码，成员登录后须修改。默认开启自助注册，设置 `ALLOW_REGISTRATION=0` 可以关闭。

## 阿里云部署配置

在 `/opt/fae-console` 拉取代码后，运行 `npm ci --omit=dev` 安装依赖，再启动或重启 Web 服务。

- `deploy/fae-console.service` 由 systemd 管理，假定项目位于 `/opt/fae-console`。运行数据写入 `/var/lib/fae-console`，超级管理员凭证由项目根目录的 `/opt/fae-console/.env` 提供。环境文件应只允许 root 读取，并包含 `ADMIN_ACCOUNT` 和 `ADMIN_PASSWORD`。已有实例升级时，将旧环境文件里的值带到项目根目录，再重新安装服务定义并执行 `systemctl daemon-reload` 和 `systemctl restart fae-console`。
- `deploy/fae-console.conf` 为 `fae-work-console.patrick-shenzhen.cn` 提供入口，并将网页和 API 一并转发至 `127.0.0.1:4173`。启用前请确认 DNS 和服务器防火墙，HTTPS 由 Certbot 配置。
- systemd 配置要求通过 HTTPS 使用登录会话。用本地端口检查服务时，首页仍可访问。
- 需求文件和交付文件单文件最多 50 MiB，每批最多 12 个。周任务可导出 ZIP，内含 CSV 和有权限下载的文件。原桌面版的本地附件需从原电脑重新上传。

## 附件存储

在现有的服务环境文件中设置 `SFTP_HOST`、`SFTP_PORT`、`SFTP_USERNAME`、`SFTP_PASSWORD` 和 `SFTP_HOST_FINGERPRINT`。根目录 `SFTP_ROOT` 默认为 `/FAE-Console`。当前公司端点还需要 `SFTP_LEGACY_SSH=1`。部署时运行 `node --env-file=.env backend/attachment-maintenance.mjs prepare` 初始化目录。

迁移旧版本的本地服务器附件时，停止服务并保留一份带原所有权的 `db.json` 备份。用 root 运行 `node --env-file=.env backend/attachment-maintenance.mjs migrate <DATA_DIR>`，随后运行同一命令的 `purge <DATA_DIR>` 子命令。清理前会重新校验每个历史附件。用 `chown --reference=<备份文件> <DATA_DIR>/db.json` 恢复索引所有权，再启动服务。

## 一次性导入工程中心 WBS

先部署本版代码并启动一次服务，以便读到最新的项目和分类配置。在服务器创建权限为 `0700` 的仓库外目录，例如 `$HOME/fae-wbs-import`。用 SFTP 上传原始 `工程中心WBS.xlsx` 到该目录，原表、数据库副本和预览报告都保存在这个目录。下面的 `admin` 请换成系统中已有的管理员登录账号。

```bash
cd /opt/fae-console
umask 077
wbs_work="$HOME/fae-wbs-import"
wbs_db=/var/lib/fae-console/db.json
wbs_admin=admin
sudo cat "$wbs_db" > "$wbs_work/preview-db.json"
node backend/import-wbs.mjs preview \
  --file "$wbs_work/工程中心WBS.xlsx" --db "$wbs_work/preview-db.json" \
  --admin "$wbs_admin" --report "$wbs_work/preview.json"
```

查看 `preview.json` 的 `totals` 和 `rows`，核对待导入任务、未匹配的负责人、重复行和日期提醒。报告的 `confirm` 是本次导入的校验码。确认后停服务并保存最终备份，再执行写入。以下命令会生成一个新的数据库副本，供确认后替换。

```bash
wbs_confirm='填写预览报告里的 confirm'
sudo systemctl stop fae-console &&
  wbs_backup=$(mktemp "$wbs_work/before-import-db.XXXXXX") &&
  sudo cat "$wbs_db" > "$wbs_backup" &&
  node backend/import-wbs.mjs apply \
    --file "$wbs_work/工程中心WBS.xlsx" --db "$wbs_backup" \
    --admin "$wbs_admin" --confirm "$wbs_confirm" --output "$wbs_work/imported-db.json"
```

导入成功且 `imported` 大于零时，把新副本以原数据库的所有者和权限放回原位置，再启动服务。校验码不一致时，使用 `$wbs_backup` 和新的报告文件重新预览。导入失败或没有需要导入的记录时，可直接启动服务。

```bash
wbs_next=$(sudo mktemp /var/lib/fae-console/.wbs-db.XXXXXX) &&
  sudo cp "$wbs_work/imported-db.json" "$wbs_next" &&
  sudo chown --reference="$wbs_db" "$wbs_next" &&
  sudo chmod --reference="$wbs_db" "$wbs_next" &&
  sudo mv -T "$wbs_next" "$wbs_db" &&
  sudo systemctl start fae-console
```

重启后在任务中心抽查负责人、状态和日期。保留 `$wbs_backup` 指向的文件作为备份。需要回滚时，停服务后用同样的替换步骤恢复这个备份。

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

管理员在「人员管理 → 登录账号」为需要接收提醒的成员绑定企业微信通讯录里的 UserID。需求首次派发或任务转交时，系统会提醒接手的负责人。群消息只包含事件、任务编号和任务链接，链接要求登录并按现有任务权限显示详情。没有已绑定接收人时跳过该消息。发送失败可用 `journalctl -u fae-console -n 50 --no-pager` 查看。

## 行为规范

规范正文放在项目根目录的 `private/guidelines.json`，整个 `private/` 目录由 Git 忽略。阿里云部署时将文件单独复制到 `/opt/fae-console/private/guidelines.json`。目录和文件使用 `root:root`，权限分别设为 `0700` 和 `0600`。服务启动时由 systemd 将正文只读提供给服务进程，网页通过登录接口读取。部署内部规范前请在项目 `.env` 中设置 `ALLOW_REGISTRATION=0`。

首次上线规范时，安装新版 `deploy/fae-console.service`，执行 `systemctl daemon-reload` 后重启 `fae-console`。以后更新规范只需替换正文文件并重启服务。

## Windows 免安装版

桌面版在 Electron 窗口中打开线上工作台，并加载经典浅色侧栏样式。网页和桌面使用同一个前端、API 和线上账号。网页业务功能上线后，桌面用户重新打开即可加载更新。桌面外壳、桌面专用样式或 Electron 版本有改动时，需要重新打包。

```bash
npm --prefix desktop ci
npm --prefix desktop run build:win
```

在 `desktop/dist/` 取 `工程小管家-<版本>.exe`。在 Windows x64 上双击运行，登录时需联网。桌面源码和锁文件随 Git 维护，生成的二进制单独交付。

## macOS 调试版

在 Mac 上运行以下命令，打包当前 Mac 架构的应用。

```bash
npm --prefix desktop ci
npm --prefix desktop run build:mac
```

Apple 芯片版本位于 `desktop/dist/mac-arm64/工程小管家.app`，Intel 版本位于 `desktop/dist/mac/工程小管家.app`。双击打开，使用同一套线上账号登录。调试时可按 `⌥⌘I` 打开开发者工具。此构建使用临时签名，供本机调试。

```bash
npm run check
```
