# Benchmark 选集

Benchmark 只保存对版本化 Case 的成员引用，不复制 Case 正文。计划维护 `smoke-v1.json` 与 `full-v1.json`；只有成员均已核验可运行时才创建文件。P1 当前未声明正式 smoke，因为 Live 正常 Case 尚未执行。

启用后的命令为：

```powershell
bun run eval -- run --benchmark smoke-v1
bun run eval -- run --benchmark full-v1
```

当前 CLI 未实现 `--benchmark`，调用会失败；其实现属于综合数据集启用任务，不能把目录存在当成 Benchmark 可用。
