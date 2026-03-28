# TP-Link IPC CN Two-Way Audio — Scrypted Plugin

为国内版 TP-Link IPC 摄像头添加真正的双向音频（对讲）支持。

> 适用于：TP-Link IPC 系列（国内版），不适用于国际版 Tapo。

---

## 特性

本插件以 **MixinProvider** 方式追加在已有 ONVIF 摄像头上，无需重新添加设备，原有的人体检测、云台控制、动作侦测等功能完全保留。

---

## 系统架构

```
HomeKit / Scrypted UI
        │
        ├─── 视频流 ──▶ Scrypted ONVIF 插件 ──▶ 摄像头（直连）
        │
        └─── 话筒 ────▶ TalkbackMixin（本插件）──▶ 摄像头 TCP（MULTITRANS 直连，默认 554）
```

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

国内TP-Link 双语音私有协议

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

> **注意**：不同固件版本行为不同。部分摄像头直接返回 200（无需认证），部分需要 Digest。已兼容两种情况。

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

- 仅支持 `half_duplex` 模式（说话时无法同时听）

---

## 参考资料与致谢

MULTITRANS 协议实现基于以下开源项目的逆向工程成果：

- **[hass-tplink-ipc](https://github.com/bingooo/hass-tplink-ipc)**（作者：bingooo）
  - Home Assistant 版本的 Python 实现

- **[go2rtc multitrans](https://github.com/AlexxIT/go2rtc/blob/master/pkg/multitrans/client.go)**（作者：AlexxIT）
  - go2rtc中 的 go 版本实现

- **[Scrypted Developer Docs](https://developer.scrypted.app)**
  - 插件开发指南

本插件在上述参考基础上新增：
- TypeScript/Node.js 实现
- 200/401 双认证流程兼容（部分固件跳过 Digest 认证直接返回 200）
- Scrypted MixinProvider 集成（保留 ONVIF 原有功能）
