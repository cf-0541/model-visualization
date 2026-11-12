# C++17 本地调试采样与动画回放（实验）

这不是浏览器 C++ 编译器，也不是公开的代码运行服务。流程是：

```text
自己信任的单文件 C++ → 本机 g++ -O0 -g → GDB Python 行间采样
                   → 版本化 JSON → 网页导入校验 → 现有状态编译器 / 动画 / 时间轴
```

## 使用

需要 Python 3、g++，以及启用了 Python 的 GDB，三者均在 PATH 上。
目前本地验证工具链为 Windows MinGW-w64 g++ 16.1 / GDB 17.2（内嵌 Python 3.9）。
只依赖 Python 标准库；不需要安装 Python 包。

```powershell
# 仅在自己的工具确实位于此目录时使用；其他环境改成实际工具目录。
$env:PATH = 'C:\Users\lmy\Downloads\mingw64\bin;' + $env:PATH

# 文件名必须尚不存在；不覆盖原有报告。
python experiments/cpp/run.py experiments/cpp/fixtures/bubble.cpp --watch numbers --trusted --output bubble-trace.json
python experiments/cpp/run.py experiments/cpp/fixtures/grid.cpp --watch dp --trusted --output grid-trace.json
python experiments/cpp/run.py experiments/cpp/fixtures/recursion.cpp --watch answer --result answer --trusted --output recursion-trace.json
python experiments/cpp/run.py experiments/cpp/fixtures/vector.cpp --watch numbers --trusted --output vector-trace.json
```

打开应用，点击 **“导入 C++ 轨迹（实验）”**，选取生成的 JSON 即可回放。
文件只由浏览器读取、校验，不上传服务器，不执行内含源码，不启动 JS Worker。
输入框和重新运行按钮在 C++ 回放期间不可用，源码只读，分享链接也禁用以免把 C++ 当成 JS 分享。
**“返回 JavaScript”** 恢复原来的 JS 源码与输入；选择 JS 示例也会离开 C++ 回放。

也可以导入 `samples/` 中的报告：这些是从可信 fixtures 实际采集后保存的**固定回放样本**，
不是浏览器现场运行的结果；其中 duration 已归零以便版本稳定，不能用于性能比较。

## 可以承诺的实验范围

- g++ C++17 模式，单文件，允许标准库头文件；源码会复制到临时目录，本地相对头文件不受支持。
- 显式指定 1–8 个不同的、非 static 的**全局变量**；仅接受简单标识符，不接受表达式或函数调用。
- 被观察值支持 bool、最多 32 位的整数 / 枚举、零起始定长数组，以及 **libstdc++ 布局的 `std::vector<int>`**。
- 每层集合最多 120 项，最多 3 层嵌套，单变量快照最多 1024 个值节点；入门示例实际覆盖 1D / 2D 数组。
- 记录 track、line、call、return、write 和 done / error。标量参数能显示在 call.args；指针、引用等不隐式解引用。
- 数组 / 二维 DP / vector 可使用现有动画，状态写入按索引差量重放；vector 长度变化使用 `arrayPatch`。
- 递归样例验证调用顺序、调用深度和全局 answer；没有新增通用递归可视化模型。
  只有标量的程序可能显示“未识别数据结构”，这不是执行失败，不会硬猜成数组。
- `--result` 可选择已观察的全局变量作为 done.result；不指定时结果是 `{ "exitCode": 0 }`，
  **不是自动捕获任意函数的返回值**。正常 main 返回且退出码 0 才可报告 complete。

没有接入 C++ 源码结构分析；模型自动识别只使用已验证的轨迹启发式，必要时可手动选模型。
当前不支持 stdin 交互、任意局部变量、指针 / 堆对象图、任意 STL / 自定义对象、线程等通用程序追踪。
不承诺 MSVC / libc++ 的容器内部布局，不承诺未列入回归的工具链。

## 采样语义：不要当作每次操作的完整插桩

GDB 停在源码行时读取指定全局变量，下一次停止后比较净变化：

- 同一行的多次写入可能合并；“写后还原”的中间值可能完全不可见。
- **不产生 read / branch 事件**，没有完整的读依赖 / 分支动画。
- write.line 使用前一个调试停点，只表示近似采样区间归属；跨函数时可能落在函数返回行，
  而非调用方的赋值行，不能宣称写入行号精确。
- 跳过库内部执行，库调用期间执行的用户回调可能遗漏；同名栈帧替换也可能无法区分。
- return.value 的 null 表示**没有采集返回值**，不是 C++ 返回了 null。界面明确显示“调用离开 / 未采集返回值”。
- duration 是调试采集时间，包含调试器开销，不是原生运行时间；不应拿来做算法性能对比。
- 每个调试停点仍需读取受限快照；报告传输和回放是差量，不代表原生采集完全不拍快照。

## 限额与失败

默认 1200 个调试步、4000 个事件、20 秒采集时间；可调范围分别是 1–5000、8–10000、1–60 秒。
源文件最多 64 KiB / 4096 行；报告最多 8 MiB。导入还验证序号、行号、路径、调用配对、补丁前值、
终止状态等，并限制累计快照解析预算为 200000 个值节点，超限会明确拒绝导入。

触顶报告 `truncated` + 终止 error，非零退出码、信号或不支持的观察类型报告 error；不会伪造 done。
部分轨迹可以导入回放，但始终标记“未完成”，不提供成功结果。
编译错误、父进程超时或诊断输出超限可能只有 CLI 失败，没有可回放 JSON；CLI 非零退出不能算通过。
父进程还设置编译 / 调试超时和 1 MiB 诊断输出上限，失败时清理自己启动的进程树及临时目录。

## 安全范围

**本地 C++ 原生执行完全不是沙箱，只运行自己检查过的可信代码。**
`--trusted` 是用户确认，不是权限隔离；程序仍然拥有当前账户的文件、进程和网络权限。
超时 / 步数 / 事件限额只能约束普通意外，不防恶意代码，也不保证恶意子进程一定被清理。
不要把 `run_pilot` 包装成网站访客可调用的 API，不要把普通 Docker 当成恶意代码安全边界。

调试器禁用用户 init、自动加载和远程 debuginfo，且只查找指定全局符号，不求值任意表达式，
但这些设置都不改变原生程序自身的权限。JSON 校验只保障回放数据结构边界，不能证明被采集程序安全。
报告包含源码、参数和变量值，不要导入、提交或分享含密钥及隐私的报告。

## 自动化回归

```powershell
# 原生回归；工具缺失会失败，不会静默跳过并声称已测。
pnpm pilot:cpp

# 跨平台固定报告 → importCppTrace → compileTrace / createTraceCursor 回放。
pnpm test
pnpm build

# 重新构建真正的生产产物，然后自动操作已有 UI。
# Windows Chromium 默认使用本机 Chrome；Linux 使用 Playwright Chromium。
pnpm pilot:cpp:browser

# 可选：明确指定引擎，不会静默降级；未安装浏览器会失败。
$env:CPP_BROWSERS = 'chromium,firefox,webkit'
pnpm pilot:cpp:browser
```

原生测试用例固定在仓库内，不自动发现或执行用户的其他 C++ 文件。
覆盖四个入门示例的最终状态、递归参数、vector 伸缩、步数和事件截断、缺失全局变量、
不支持类型、非零退出、信号、stdout、编译失败、CLI 确认 / 防覆盖、父进程限额及同行还原边界。
TS 回归覆盖现有动画编译器的正放 / 回退 / 懒快照，以及畸形 JSON、污染键、非法补丁、伪成功等拒绝路径。
生产 UI 回归覆盖四种报告、模型与终态、播放 / 暂停 / 回退、失败保留旧轨迹、未完成提示，以及恢复 JS Worker 执行。

如需从本机工具链重新生成固定样本，显式设置 `CPP_PILOT_EXPORT=1` 后运行原生测试；这会覆盖 `samples/`，
应检查差异。CI 的独立 `cpp-pilot.yml` 会先从可信 fixtures 生成**当次 Linux 原生轨迹**，
再让 TS 和生产浏览器回归消费这些轨迹，而不只验证旧样本。该工作流只配置门槛，不发布 / 部署。
本地通过不等于 GitHub CI 已通过；需提交 / 推送后查看实际运行。

本轮本地验证记录（2026-11-12）：Windows 原生回归与 Chrome 生产 UI（桌面和 390px 窄屏）通过。
Edge 的额外启动尝试在建立测试页面前退出，**未进入回归，不能算通过**；此处不宣称已完成跨引擎或 Linux 验收。
CI 已配置，但本轮未提交 / 推送，尚无该改动的 GitHub 运行结果。
