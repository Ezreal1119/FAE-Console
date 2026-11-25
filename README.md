# 工程小管家 Web

需要 Node.js 22.9 或更高版本。Web 页面和 API 在同一个 Node.js 进程内运行。

## 本地启动

在仓库根目录的 `.env.local` 中设置管理员凭证。

```dotenv
ADMIN_ACCOUNT=admin
ADMIN_PASSWORD=填写至少12位的自选密码
```

服务每次启动都会读取这两个变量，修改后重启生效。首次启动会创建管理员和空业务库。已有库会保留管理员 ID 和业务记录，同时清除数据库里的旧管理员密码哈希。管理员在服务重启后需要重新登录。可选的 `ADMIN_NAME` 用于指定管理员账号的显示姓名。

```bash
npm start
```

打开 http://127.0.0.1:4173。可用 `HOST`、`PORT` 和 `DATA_DIR` 修改监听地址、端口和数据目录。默认数据目录为项目下的 `data/`，其中 `db.json` 保存账号、人员档案、任务、需求和会话，`attachments/` 保存任务附件。备份应同时包含两者。这个 JSON 数据库由单个服务进程写入。

普通成员继续在网页上修改密码。管理员建号或重置密码时，界面会显示生成的临时密码，成员登录后须修改。默认开启自助注册，设置 `ALLOW_REGISTRATION=0` 可以关闭。

## 阿里云部署配置

- `deploy/fae-console.service` 由 systemd 管理，假定项目位于 `/opt/fae-console`。运行数据写入 `/var/lib/fae-console`，管理员凭证由 `/etc/fae-console.env` 提供。环境文件应只允许 root 读取。升级已有实例前，请先确保该文件同时包含 `ADMIN_ACCOUNT` 和 `ADMIN_PASSWORD`。
- `deploy/fae-console.conf` 为 `fae-work-console.patrick-shenzhen.cn` 提供入口，并将网页和 API 一并转发至 `127.0.0.1:4173`。启用前请确认 DNS 和服务器防火墙，HTTPS 由 Certbot 配置。
- systemd 配置要求通过 HTTPS 使用登录会话。用本地端口检查服务时，首页仍可访问。
- 附件单文件最多 20 MB。周任务可导出 ZIP，内含 CSV 和有权限下载的附件。原桌面版的本地附件需从原电脑重新上传。

```bash
npm run check
```
