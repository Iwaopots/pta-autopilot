# 升级说明

每个版本升级时需要注意的事。按版本倒序；没列出的版本直接重装即可。

通用步骤：

```
git pull
npm install            # 只装测试用 devDependencies
npm run gate:offline   # 先确认仓库本身是绿的
plugin_manager remove_bundle dsh-pta
plugin_manager install_bundle <本目录绝对路径>
npm run gate           # 带本机 ping：确认装上的版本号和仓库一致
```

## 0.4.0

- **状态文件**：`tasks.json` 仍是 version 2，新增 `paused` 字段和任务上的 `reason` / `lastError`。0.3.x 能读 0.4 写出的文件（未知字段会被忽略），可以放心回退。
- **工具**：`pta_finish` 多了可选参数 `reason`；不传时从 `error` 文本推断，旧会话照常工作。
- **HTTP**：新增 `tasks.resume`；`tasks.clear` 支持可选 `status`（只清 done / failed / cancelled 之一）；`tasks.board` 多了 `paused`。只加不改，`apiVersion` 仍为 1。
- **行为变化**：登录失效的任务不再白白重试 3 次，而是直接失败并暂停该账号的队列；在面板重登或「校验」通过后自动继续。题集未开放 / 无权限的不再被「全部完成」派发。
- **测试**：`test/panel-render.mjs` 缺 react / jsdom 时改为失败。先 `npm install`。临时跳过可设 `PTA_ALLOW_SKIP=1`，但闸门会报红。
- **安装体积**：`npm install` 会在本目录生成 `node_modules`（约 68 个包，只用于测试）。如果 `install_bundle` 会连同 `node_modules` 一起拷贝，安装前先 `npm prune --omit=dev`，或从一份没装依赖的干净检出安装。
- **版本号**：`/_pta/ping` 的 `version` 现在直接读 `package.json`。0.3.1 的 ping 仍报 0.3.0，是旧版写死常量导致的。

## 0.3.0

- `tasks.json` 从 v1 裸数组迁移到 v2；旧队列里的 pending / running 迁成 cancelled，不会自动开跑。
