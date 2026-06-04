# 清何 BFD 匿名使用统计后台

这个目录提供一套轻量后台：

- `worker.js`：Cloudflare Worker，接收插件匿名事件并提供统计 API。
- `schema.sql`：Cloudflare D1 数据库表结构。
- `dashboard/`：GitHub Pages 静态看板。

## 收集什么

插件端只发送：

- 匿名 `install_id`，后端会加盐哈希后保存。
- 事件：`app_start`、`detect_start`、`detect_done`、`app_close`。
- 插件版本、Resolve 版本、系统平台、会话时长、检测模式摘要。

不上传工程名、素材名、时间线内容、文件路径、原始 IP。地区由 Cloudflare 根据请求自动给出国家/城市，数据库只保存粗略地区。

## 部署 Worker + D1

1. 安装 Wrangler：

```bash
npm i -g wrangler
wrangler login
```

2. 创建 D1：

```bash
cd analytics_backend
wrangler d1 create qinghe_bfd_analytics
```

把输出的 `database_id` 填进 `wrangler.toml`。

3. 建表：

```bash
wrangler d1 execute qinghe_bfd_analytics --file schema.sql
```

4. 设置后台密钥：

```bash
wrangler secret put ADMIN_TOKEN
wrangler secret put INSTALL_HASH_SALT
```

5. 发布：

```bash
wrangler deploy
```

发布后得到类似：

```text
https://qinghe-bfd-analytics.xxx.workers.dev
```

插件里把 `ANALYTICS_ENDPOINT_URL` 改为：

```python
ANALYTICS_ENDPOINT_URL = "https://qinghe-bfd-analytics.xxx.workers.dev/collect"
```

## 部署 GitHub Pages 看板

1. 复制配置：

```bash
cp dashboard/config.example.js dashboard/config.js
```

2. 把 `config.js` 里的 `API_BASE` 改成 Worker 地址，不带 `/collect`：

```js
window.QINGHE_ANALYTICS_CONFIG = {
  API_BASE: "https://qinghe-bfd-analytics.xxx.workers.dev",
};
```

3. 把 `dashboard/` 推到 GitHub 仓库，启用 GitHub Pages。

4. 打开看板网页，输入 `ADMIN_TOKEN` 即可查看数据。

## 隐私提示

如果发布给用户，建议在插件说明或首次启动提示里写明：

```text
本插件可选择发送匿名使用统计，用于了解版本使用情况、地区分布、启动次数、检测次数和会话时长；不会上传工程文件、素材路径、时间线内容或原始 IP。
```
