# 运行取消与完成状态：正式产物 UI 回归

`browser.mjs` 先将当前应用构建到独立临时目录，再用 preview 服务和实际模块 Worker 验证。
不是开发服务器测试，也不以模拟 Worker 代替浏览器执行。临时产物运行结束后清理，不改写项目 `dist/`。

```powershell
pnpm test:runtime:browser
$env:RUNTIME_BROWSERS = 'chromium,firefox,webkit'
pnpm test:runtime:browser
Remove-Item Env:RUNTIME_BROWSERS
```

默认 Chromium；Windows 用本机 Chrome。请求的引擎缺失或启动失败会让命令失败，不静默跳过。
Linux CI 先安装三引擎与系统依赖；配置位于 `.github/workflows/pilot-ast-e2e.yml`。
本地可用 `RUNTIME_SCREENSHOT` 指定截图路径，`{width}` 替换为 1440 / 390。

覆盖桌面与窄屏下的长轨迹关键帧实际计时参数、末尾 / 开头往返、停止、编辑取消、示例替换、真实超时后恢复、集合展示上限与执行截断区分、
C++ 固定示例的独立资源加载 / 只读回放 / 返回 JS，以及 Worker 恰好终止一次。
回放检查点、差量写入及完整递归栈的正确性另由 Vitest 逐帧验证；不把截图当作性能测量。

## 2026-11-16 本地记录（Windows）

- `pnpm test`：175 项应用测试通过（其中一项追加的深递归栈回归也已单独通过）。
- `pnpm build`：类型检查和生产构建通过；C++ 四份示例各自为独立的按需资源。
- `pnpm pilot:ast`：241 个有界差分用例及既有语法 / 输入 / 示例门槛通过。
- `pnpm pilot:cpp`：17 项本地原生采集测试通过。
- `pnpm pilot:cpp:browser`：Chromium 下桌面与 390px 各 7 组导入 / 回退 / 异常 / JS 恢复检查通过。
- 新增运行 UI 回归：Chromium、WebKit 均在 1440px / 390px 通过，截图已检查；
  请求 Firefox 时，Playwright 在启动 `firefox-1555/firefox/firefox.exe` 时返回 `spawn UNKNOWN`。
  因此要求三引擎的整条命令以失败结束，**不能报告三引擎通过**。
- `pnpm pilot:production-e2e`：Chromium、WebKit 各 9 组正式产物与冻结 Babel 参考的 UI/Worker 对照通过，
  各 3 组拒绝及超时恢复通过；同样在 Firefox 启动处失败，整条命令不算通过。
- `pnpm pilot:build`：正式 / 参考模块图门槛通过；全部 JS（含 Worker、按需样例）为
  467,504 B raw / 148,400 B gzip，对照冻结 Babel 为 1,127,912 B / 310,747 B。
  该差值主要来自此前已集成的 AST 迁移，**不是本轮回放缓存节约的包体积**，也不是首屏传输测量。
- `pnpm bench:trace`：3,902 条事件、127 次跳转逐帧一致；回放应用事件数 409,707 → 35,947，
  7 次耗时中位数约 129ms → 14ms，12 个检查点合计 8,085 B 序列化数据。
  这是本机微基准，不是浏览器 FPS 或 JS 堆测量，复测结果会随负载变化。
- 部署工具：Windows 可运行的 10 项测试通过，另 5 项因 POSIX 符号链接语义跳过；未做 Linux 部署验收。

本轮未提交、推送、发布或连接生产服务器，GitHub CI 未实跑新改动。
Firefox 仍需在可启动它的环境完成同一门槛，不降低检查或使用 v0.1.3 的历史记录代替。
Worker 和本地 C++ 采集都只用于可信代码，取消 / 超时不是恶意代码安全沙箱。

## 2026-11-18：检查点复核与长轨迹节奏

- `pnpm test`：191 项通过，含新增的检查点位置 / 淘汰、保守计费 / 提前退出、关键帧节奏测试。位置边界测试在原实现上已通过，不宣称修复了错位缺陷。
- `pnpm build`：TypeScript 检查及生产构建通过。
- `RUNTIME_BROWSERS=chromium,webkit pnpm test:runtime:browser`：两引擎各在 1440px / 390px 通过。新增密集写入用例保留超过 1,000 个关键帧，观察正式 App 实际传入原生 `setTimeout` 的等待值（不替换时钟），并验证暂停后末尾 → 开头 → 末尾的时间轴位置及最终数组。第一帧可能早于数组被追踪，不应硬要求它已经显示 `[0]`。
- 本机起初缺少对应 WebKit 可执行文件，安装匹配版本后重跑上述完整双引擎命令通过。本次没有重跑 Firefox，也没有使用此前的跨引擎记录代替本轮结果。
- 检查点 / 节奏微基准及计量口径见 `../trace-playback/README.md`。定时器等待总量不是实际播放时长承诺；保守字节计费不是实际堆内存用量。

这些新改动仅在本地分支，未提交 / 推送，尚无对应 GitHub CI 运行；未发布或部署。
