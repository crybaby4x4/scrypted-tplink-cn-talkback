# CLAUDE.md

Scrypted MixinProvider 插件，为中国版 TP-Link IPC 摄像头添加双向音频（MULTITRANS 协议）。

## 文件结构

```
src/
├── main.ts       MixinProvider 入口，canMixin 判断适用设备
├── mixin.ts      TalkbackMixin：Intercom 实现 + Settings 代理
├── talkback.ts   MULTITRANS 协议核心（TCP 握手 + RTP 音频转发）
└── digest.ts     HTTP Digest MD5 认证工具函数
```

## 构建与部署

```bash
npm run build                              # 构建（生成 out/plugin.zip）
npx scrypted login <IP>:10443              # 登录 Scrypted（首次）
npm run build && npx scrypted-deploy <IP>  # 构建 + 部署
```

> 不要使用 `npm run deploy`，直接用 `npx scrypted-deploy <IP>`。

本地协议验证：`node test-talkback.mjs <ip> <user> <password>`

## 开发环境

- Node.js 20+（nvm 管理）
- WSL 下确保 nvm 在 PATH 前加载，避免使用 Windows 版 node

## 关键设计决策

### canMixin 条件
以 `VideoCamera` 接口判断，适用于所有摄像头类型（ONVIF、RTSP 等），不限定具体插件。

### Settings 代理
Mixin 必须代理底层设备设置，否则 ONVIF 原有配置会消失：
- `getSettings()` = 底层 settings + talkback settings
- `putSetting()` 按 `talkback:` 前缀区分归属，未命中则转发给底层设备

### 认证兼容性
握手先发无认证请求，按响应 200/401 决定是否走 Digest，兼容不同固件版本。
