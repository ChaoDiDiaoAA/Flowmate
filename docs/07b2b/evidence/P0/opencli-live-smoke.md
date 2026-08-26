# OpenCLI 公开检索 Smoke Evidence

> 日期：2026-08-26  
> 项目：Flowmate P0 真实公开数据采集前置验证

## 环境

```text
opencli v1.8.6
Browser Bridge extension v1.0.23
Daemon: running on port 19825
Connectivity: connected
```

## 验证命令

```powershell
opencli list -f json
opencli doctor -v
opencli brave search "site:huggingface.co/datasets invoice OCR dataset license" --limit 10 -f json
npm run data:discover
```

## 关键结果

当前 Registry 中 `brave/search` 为 `access=read`、`strategy=public`。公开检索返回了目标数据集：

```text
title: Voxel51/high-quality-invoice-images-for-ocr · Datasets at Hugging Face
url: https://huggingface.co/datasets/Voxel51/high-quality-invoice-images-for-ocr
```

结果还明确标注该数据集为 synthetic data only；后续下载仍须执行 Source Policy、License、Privacy、Quality 和去重门禁。

本次未使用 cookie、登录态或写入类命令；未将 Token、Cookie 或其他凭证写入证据。
