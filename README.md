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
        └─── 话筒 ────▶ TalkbackMixin（本插件）──▶ 摄像头 TCP:554（MULTITRANS 直连）
```

**各组件职责：**

| 组件 | 职责 |
|------|------|
| **Scrypted ONVIF 插件** | 视频流、人体检测、动作侦测、云台、快照 |
| **本插件（TalkbackMixin）** | 双向音频：直连摄像头 MULTITRANS 协议 |

只需要：摄像头网络可达 + Scrypted 已通过 ONVIF 接入摄像头。

---

## 最终用户使用指南

### 前提条件

- Scrypted 已通过 ONVIF 插件添加 TP-Link 摄像头，视频流正常
- Scrypted 服务器与摄像头在同一局域网
- 摄像头的 TCP 554 端口可被 Scrypted 服务器访问

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
   | Username | 摄像头登录用户名（通常为 `admin`） |
   | Password | 摄像头登录密码 |

5. 保存后话筒按钮即可正常使用

### 使用对讲

- 在 Scrypted 或 HomeKit 中点击话筒按钮，即可向摄像头端说话
- 为 `half_duplex` 模式，说话期间无法同时收听摄像头声音

---

## 开发者指南

### 环境准备

```bash
# 克隆项目
git clone <repo>
cd scrypted-tplink-ipc

# 安装依赖
npm install

# 登录 Scrypted（仅需一次）
npx scrypted login <SCRYPTED_IP>:10443
```


### 开发工作流

```bash
# 构建
npm run build

# 部署到 Scrypted（构建 + 推送，无需重启）
npm run build && npx scrypted-deploy <SCRYPTED_IP>
```

修改代码后重新执行上面的命令即可，Scrypted 会热加载插件。

### 本地验证协议

在部署前，可用测试脚本直接验证摄像头的 MULTITRANS 握手和音频传输：

```bash
node test-talkback.mjs <摄像头IP> <用户名> <密码>

# 例：
node test-talkback.mjs 192.168.1.100 admin yourpassword
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


---

## 参考资料

- [hass-tplink-ipc](https://github.com/bingooo/hass-tplink-ipc) — Home Assistant 版本
- [go2rtc multitrans](https://github.com/AlexxIT/go2rtc/blob/master/internal/multitrans/README.md) — go2rtc
- [Scrypted Developer Docs](https://developer.scrypted.app)
