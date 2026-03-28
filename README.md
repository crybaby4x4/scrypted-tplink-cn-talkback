# TP-Link IPC CN Two-Way Audio — Scrypted Plugin

为中国版 TP-Link IPC 摄像头添加真正的双向音频（对讲）支持。

> 适用于：TP-Link IPC 系列（中国版），不适用于国际版 Tapo。

---

## 背景

中国版 TP-Link IPC 摄像头使用私有的 **MULTITRANS 协议**实现双向音频，而非标准 ONVIF backchannel。通过 Scrypted 的 ONVIF 插件接入后，设备显示话筒按钮，但点击无效。

本插件以 **MixinProvider** 方式追加在已有 ONVIF 摄像头上，无需重新添加设备，原有的人体检测、云台控制、动作侦测等功能完全保留。

---

## 系统架构

本插件**完全独立**，不依赖 go2rtc 或任何第三方流媒体服务。

```
HomeKit / Scrypted UI
        │
        ├─── 视频流 ──▶ Scrypted ONVIF 插件 ──▶ 摄像头（直连）
        │
        └─── 话筒 ────▶ TalkbackMixin（本插件）──▶ 摄像头 TCP（MULTITRANS 直连，默认 554）
```

**各组件职责：**

| 组件 | 职责 |
|------|------|
| **Scrypted ONVIF 插件** | 视频流、人体检测、动作侦测、云台、快照 |
| **本插件（TalkbackMixin）** | 双向音频：直连摄像头 MULTITRANS 协议 |

### Mixin 架构

```
Scrypted ONVIF 设备（保留所有原有功能）
  └── TalkbackMixin（本插件追加）
        ├── 覆盖 Intercom 接口 → MULTITRANS 协议
        └── 代理 Settings 接口 → 合并显示 ONVIF + Talkback 配置
```

只需要：摄像头网络可达 + Scrypted 已通过 ONVIF 接入摄像头。

---

## 使用指南

### 前提条件

- Scrypted 已通过 ONVIF 插件添加 TP-Link 摄像头，视频流正常
- Scrypted 服务器与摄像头在同一局域网
- 摄像头的 RTSP 端口（默认 554）可被 Scrypted 服务器访问

### 安装插件

在 Scrypted 管理界面（`https://你的IP:10443`）：

1. 左侧菜单 → **Plugins**
2. 搜索 `@crybaby4x4/scrypted-tplink-cn-talkback`，点击安装

### 启用双向音频

1. 打开目标摄像头设备
2. 进入 **Extensions（扩展）** 标签
3. 找到 **TP-Link IPC CN Two-Way Audio** → 点击启用
4. 在设备 **Settings** 页面，滚动到 **TP-Link Talkback** 分组：

   | 字段 | 说明 |
   |------|------|
   | Camera IP Address | 摄像头 IP，通常与 ONVIF 的 IP 相同 |
   | RTSP Port | MULTITRANS 协议端口，默认 `554` |
   | Username | 摄像头登录用户名（通常为 `admin`） |
   | Password | 摄像头登录密码 |

5. 保存后话筒按钮即可正常使用

### 使用对讲

- 在 Scrypted 或 HomeKit 中点击话筒按钮，即可向摄像头端说话
- 为 `half_duplex` 模式，说话期间无法同时收听摄像头声音

---

## MULTITRANS 协议说明

中国版 TP-Link IPC 的双向音频通过 RTSP 端口上的私有协议实现。

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

> **注意**：不同固件版本行为不同。部分摄像头直接返回 200（无需认证），部分需要 Digest。代码已兼容两种情况。

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

## 已知限制

- 仅支持 `half_duplex` 模式（说话时无法同时听，符合对讲机惯例）
- 不支持 HTTP API（镜头遮蔽等功能），如需要可参考 [hass-tplink-ipc](https://github.com/bingooo/hass-tplink-ipc)

---

## 开发者指南

### 环境准备

```bash
git clone <repo>
cd scrypted-tplink-cn-talkback
npm install
npx scrypted login <SCRYPTED_IP>:10443   # 仅需一次
```

### 开发工作流

```bash
# 构建
npm run build

# 构建 + 部署（Scrypted 热加载，无需重启）
npm run build && npx scrypted-deploy <SCRYPTED_IP>
```

### 本地验证协议

```bash
node test-talkback.mjs <摄像头IP> <用户名> <密码>
```

输出示例：
```
=== MULTITRANS Handshake Test ===
[1/3] TCP connected ✓
[2/3] No auth required (200 OK on first request)
      session="04603BE0"
[3/3] Channel open response: RTSP/1.0 200 OK
      body: {"type":"response", "seq":0, "params":{"error_code":0}}
✅ Handshake SUCCESS
FFmpeg done. Sent 134 RTP packets to camera.
```

### 项目结构

```
src/
├── main.ts       # MixinProvider 入口
├── mixin.ts      # Intercom 实现 + Settings 代理
├── talkback.ts   # MULTITRANS 协议（握手 + 音频传输）
└── digest.ts     # HTTP Digest 认证工具
test-talkback.mjs # 独立协议验证脚本
```

---

## 参考资料与致谢

MULTITRANS 协议实现基于以下开源项目的逆向工程成果：

- **[hass-tplink-ipc](https://github.com/bingooo/hass-tplink-ipc)**（作者：bingooo）
  - Home Assistant 版本的 Python 实现，是本插件的核心协议参考
  - 握手三步流程、JSON payload 格式、`half_duplex` 模式、PCM A-law 8kHz 音频格式均来源于此
  - 感谢作者对该私有协议的逆向分析工作

- **[go2rtc multitrans](https://github.com/AlexxIT/go2rtc/blob/master/internal/multitrans/README.md)**（作者：AlexxIT）
  - 补充了 RTSP interleaved frame 封装格式的细节
  - 验证了协议的整体结构

- **[Scrypted Developer Docs](https://developer.scrypted.app)**

本插件在上述参考基础上新增：
- TypeScript/Node.js 实现
- 200/401 双认证流程兼容（部分固件跳过 Digest 认证直接返回 200）
- Scrypted MixinProvider 集成（保留 ONVIF 原有功能）
