# CLAUDE.md — scrypted-tplink-ipc

## 项目概览

Scrypted **MixinProvider** 插件，为中国版 TP-Link IPC 摄像头（非 Tapo）添加双向音频支持。

中国版 TP-Link IPC 不走标准 ONVIF backchannel，而是使用私有 **MULTITRANS 协议**。Scrypted 的 ONVIF 插件不支持该协议，导致话筒按钮存在但无法实际对讲。本插件以 Mixin 方式挂载在已有 ONVIF 设备上，在不破坏 PTZ、人体检测、动作侦测等原有功能的前提下，覆盖 `Intercom` 接口实现真正的双向音频。

---

## 系统架构

本插件**完全独立**，不依赖 go2rtc 或任何第三方流媒体服务。

```
HomeKit / Scrypted UI
        │
        ├─── 视频流 ──▶ Scrypted ONVIF 插件 ──▶ 摄像头（直连）
        │
        └─── 话筒 ────▶ TalkbackMixin（本插件）──▶ 摄像头 TCP:554（MULTITRANS 直连）
```

唯一前提：
- 摄像头已通过 Scrypted ONVIF 插件接入
- Scrypted 服务器可访问摄像头的 TCP 554 端口

### Mixin 架构

```
Scrypted ONVIF 设备（保留所有原有功能）
  └── TalkbackMixin（本插件追加）
        ├── 覆盖 Intercom 接口 → MULTITRANS 协议
        └── 代理 Settings 接口 → 合并显示 ONVIF + Talkback 配置
```

**不需要**创建新设备，不影响：
- ONVIF 人体检测 / 动作侦测事件
- 云台（PTZ）控制
- 快照
- 视频流

---

## 文件结构

```
src/
├── main.ts       MixinProvider 入口，canMixin 判断适用设备
├── mixin.ts      TalkbackMixin：实现 Intercom + Settings 代理
├── talkback.ts   MULTITRANS 协议核心（TCP 握手 + RTP 音频转发）
└── digest.ts     HTTP Digest MD5 认证工具函数
out/
└── plugin.zip    scrypted-webpack 打包产物（由构建生成，勿手动修改）
```

---

## MULTITRANS 协议说明

中国版 TP-Link IPC 的双向音频通过 RTSP 端口 554 上的私有协议实现。

### 握手流程

```
客户端  →  MULTITRANS rtsp://ip/multitrans RTSP/1.0
           CSeq: 0  X-Client-UUID: <uuid>

摄像头  →  200 OK（部分固件）或 401（需要 Digest 认证）
           Session: <session_id>

客户端  →  MULTITRANS ... + Session + Content-Type: application/json
           {"type":"request","seq":0,"params":{"method":"get","talk":{"mode":"half_duplex"}}}

摄像头  →  200 OK  {"error_code":0, "session_id":"2"}
```

> **注意**：不同固件版本行为不同。部分摄像头直接返回 200（无需认证），部分需要 Digest。代码已兼容两种情况（见 `talkback.ts` Step 1 分支）。

### 音频格式

| 参数 | 值 |
|------|-----|
| 编码 | PCM A-law (`pcm_alaw`) |
| 采样率 | 8000 Hz |
| 声道 | 单声道 (mono) |
| 传输 | RTP over UDP → 封装为 RTSP interleaved frame → TCP |

RTSP interleaved 帧格式：`$ | channel(0x01) | length(2B BE) | rtp_payload`

### FFmpeg 转码参数

```
-af aresample=8000,pan=mono|c0=c0,adelay=300:all=1,arealtime
-acodec pcm_alaw -ar 8000 -ac 1
-f rtp rtp://127.0.0.1:<udp_port>
```

---

## 开发环境

### 依赖要求

- Node.js 20+（通过 nvm 管理，确保 WSL 下 Linux node 优先于 Windows）
- nvm 已配置（见 `~/.zshrc` 和 `~/.zshenv`）

### WSL 注意事项

WSL 下 Windows PATH 中可能存在 Windows 版 node/npm，需确保 nvm 在 PATH 前加载：
- `~/.zshenv` 中有 nvm 非交互式初始化
- `~/.zshrc` 中 nvm 在工具链区加载，早于 WSL PATH 处理

### 构建命令

```bash
# 构建（生成 out/plugin.zip）
npm run build

# 登录 Scrypted（首次，仅需一次）
npx scrypted login <IP>:10443

# 部署到 Scrypted 服务器
npx scrypted-deploy <IP>

# 一键构建 + 部署
npm run build && npx scrypted-deploy <IP>
```

> 注意：不要使用 `npm run deploy`，直接用 `npx scrypted-deploy <IP>`。

---

## MixinProvider 关键设计决策

### 1. canMixin 条件
以 `VideoCamera` 接口作为判断条件，适用于所有摄像头类型（ONVIF、RTSP 等），不限定具体插件。

### 2. Settings 代理
Mixin 实现 `Settings` 时必须代理底层设备的设置，否则 ONVIF 原有配置会消失：
- `getSettings()` = 底层设备 settings + 自己的 talkback 设置
- `putSetting()` 按 key 前缀 `talkback:` 区分归属，未命中则转发给底层设备

### 3. 认证兼容性
握手时先发送无认证请求，根据响应状态码（200 / 401）决定是否走 Digest 流程，兼容不同固件版本。

---

## 已知限制

- 仅支持 `half_duplex` 模式（说话时无法同时听，符合对讲机惯例）
- 不支持 HTTP API（镜头遮蔽等功能），如需要可参考 `hass-tplink-ipc` 项目
- 本地验证脚本：`node test-talkback.mjs <ip> <user> <password>`

---

## 参考资料与致谢

MULTITRANS 协议实现基于以下开源项目的逆向工程成果：

- **[hass-tplink-ipc](https://github.com/bingooo/hass-tplink-ipc)**（作者：bingooo）
  - Home Assistant 版本的 Python 实现，是本插件的核心协议参考
  - 握手三步流程、JSON payload 格式、`half_duplex` 模式、PCM A-law 8kHz 音频格式均来源于此
  - 感谢作者对该私有协议的逆向分析工作

- **[go2rtc multitrans](https://github.com/AlexxIT/go2rtc/blob/master/internal/multitrans/README.md)**（作者：AlexxIT）
  - 补充了 RTSP interleaved frame 封装格式的细节（`$ | channel | length | rtp_payload`）
  - 验证了协议的整体结构

本插件在上述参考基础上新增：
- TypeScript/Node.js 实现
- 200/401 双认证流程兼容（部分固件跳过 Digest 认证直接返回 200）
- Scrypted MixinProvider 集成（保留 ONVIF 原有功能）
