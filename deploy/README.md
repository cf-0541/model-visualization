# Ubuntu / Nginx 部署手册

当前适用于 Ubuntu 24.04 + 系统 Nginx + Python 3，只部署可信构建产物。算法仍在访客浏览器中执行；不要将上传的算法源码放到服务器执行。部署脚本以 root 运行，因此不要使用他人提供的脚本或压缩包。

## 域名、备案、HTTPS：先确认信息，不自动购买或签发

- 准备本人可管理 DNS 的域名，并完成所需的域名实名认证。
- 北京实例的公开网站按接入商要求办理 ICP 备案；当前 IP 能访问不是免备案依据。主体、域名、接入资源是否符合要求，以阿里云备案控制台实时校验为准。
- 备案所需个人资料只提交给官方控制台，不放到 GitHub 或聊天里。
- 备案完成后配置域名 A 记录到实例公网 IPv4，确认解析和 80/443 防火墙规则。
- 确认域名解析正确后，选择受信任证书并配置 HTTPS、自动续期及续期后的 Nginx 重载。当前模板只是 HTTP 引导配置，**不是已配置 HTTPS**。
- HTTPS 配置完成并验证后再将公开 HTTP 请求跳转到 HTTPS；保留本机 8080 健康检查块，不在云防火墙放行 8080。
- 在实际域名确定前，不生成假域名证书配置、不创建部署密钥，不承诺备案完成时间。

官方参考：阿里云备案 https://beian.aliyun.com/ ，Nginx HTTPS https://nginx.org/en/docs/http/configuring_https_servers.html ，Certbot https://certbot.eff.org/ 。具体 HTTPS 命令待域名和 DNS 控制方式确认后提供。

## 目录与回滚约定

```text
/var/www/algorithm-motion-lab/
  releases/<release-id>/  # 每次独立构建，禁止覆盖同一 release-id
  shared-assets/         # 只增不改的哈希资源，旧标签页的懒加载不失效
  current -> releases/<release-id>
  previous -> releases/<previous-id>
```

切换只原子替换符号链接，不覆盖正在服务的 index.html。脚本串行锁定部署；检查本机 8080 上首页及本次每个资源的实际 HTTP 内容，失败时恢复 current，成功时更新 previous。不自动删除旧版本和旧资源。健康检查不等于跨浏览器 UI 验收，也不证明公网、域名、证书已配置。

## 本地准备

在项目根目录 PowerShell 执行；先测试和构建，再打包。包根目录必须直接是 index.html 和 assets/，不能多套一层 dist/。不要上传 .git、node_modules、.env 或个人文件。

```powershell
pnpm test
# 确认测试成功后再构建
pnpm build
# 示例版本号；每次发布使用新的 release-id，不能覆盖旧编号
$release = "20261105-6a590f9"
tar -czf "dist/site-$release.tar.gz" -C dist index.html assets
```

用已登录的 Workbench 文件管理，将构建包及 deploy_site.py 上传至 /home/admin。首次还需上传 nginx-http.conf。无需在聊天中传密码或 SSH 私钥。

## 首次从 /var/www/html 迁移（手动确认执行，不会由脚本修改 Nginx）

先确认 `sudo nginx -T` 中原站点确实是默认配置、没有已有业务；若不是，停止并单独评估。确保 `127.0.0.1:8080` 没被其他服务占用。下面以已上传的首个包为例。各阶段逐段执行，有错误立即停下。

1. 只准备版本，不改变当前网站：

```bash
sudo python3 /home/admin/deploy_site.py stage /home/admin/site-6a590f9.tar.gz 20261105-6a590f9
# 仅首次使用；若 current 已存在，ln 会失败，不要加 -f 强制覆盖。
sudo ln -s releases/20261105-6a590f9 /var/www/algorithm-motion-lab/current
```

2. 备份当前 Nginx 配置。下方备份命名仅作一次迁移使用；已有备份不覆盖：

```bash
sudo test ! -e /home/admin/nginx-default.before-managed.conf && \
sudo cp -L /etc/nginx/sites-enabled/default /home/admin/nginx-default.before-managed.conf
```

3. 只有确认备份成功后再安装配置。安装失败或 nginx -t 报错时，立即执行下一节的恢复命令，不要反复刷新或重启：

```bash
sudo install -m 644 /home/admin/nginx-http.conf /etc/nginx/sites-available/default && \
sudo nginx -t && \
sudo systemctl reload nginx && \
sudo python3 /home/admin/deploy_site.py activate 20261105-6a590f9
```

首次迁移恢复原 Nginx 配置（不删除网站文件）：

```bash
sudo cp /home/admin/nginx-default.before-managed.conf /etc/nginx/sites-available/default && \
sudo nginx -t && sudo systemctl reload nginx
```

首次迁移不依赖 previous；后续成功更新后才有 previous 可回退。

## 后续更新与回滚

上传新包、使用全新 release-id，然后执行：

```bash
sudo python3 /home/admin/deploy_site.py deploy /home/admin/site-NEW_ID.tar.gz NEW_ID
sudo python3 /home/admin/deploy_site.py status
```

检查失败会恢复链接，不自动删除失败版本，方便排查。失败后重试可用 `activate NEW_ID`，不要反复覆盖同名目录。

上一版本回滚：

```bash
sudo python3 /home/admin/deploy_site.py rollback
```

回滚也会做 HTTP 内容检查，失败恢复回滚前版本；成功后 previous 指向刚才版本，可再次切回。不自动清理历史以免破坏回滚与旧标签页。定期检查磁盘使用，清理策略需要单独设计。

每次上线仍需从公网测试首页、四种模型、Worker、步进、分享链接。接入 HTTPS 后验证域名证书链、跳转与自动续期。没有实际访问验证，不能只凭脚本返回成功宣称发布验收通过。

## 测试与 CI

```bash
python3 -m unittest discover -s deploy -p 'test_*.py' -v
```

Windows 上依赖 POSIX 符号链接的 5 项测试会明确跳过，不能作为部署验证通过；发布前必须在 Linux 上运行全部测试且无跳过。例如可先在服务器临时目录上传两个 Python 文件，以普通用户执行上述命令，不需要 sudo，也不会改动网站。

构建 CI 仅校验部署脚本，不自动连接服务器。测试用临时目录和 HTTP mock；真实 Ubuntu/Nginx、首次迁移和 HTTPS 仍需实际环境验证。后续接 GitHub Actions 部署前，单独确认 SSH 主机指纹、专用部署用户、最小 sudo 权限、环境审批及 secrets。不要使用 root 私钥，不关闭 SSH 主机校验，不把账户密码提交到仓库。
