# AirScan-QR 📡

**AirScan-QR** 是一款专为**物理隔离环境 (Air-gapped)** 及 **跨端受限网络** 设计的高效文件传输方案。它通过动态二维码序列流，利用“屏幕+摄像头”的视觉链路，彻底打破物理与协议的边界。

## 🌟 核心场景

在无法连接互联网、禁用 U 盘、或无法建立局域网共享的场景下，AirScan-QR 是你的最佳选择：

* **封闭开发/实验室环境**：从物理隔离的内网 PC 中取出日志、代码片段或小文件。
* **跨设备“无协议”互传**：手机与手机之间、Android 与 iOS 之间，无需蓝牙或 WiFi，开码即传。
* **远程桌面/VPN 穿透**：直接通过摄像头扫描远程桌面窗口中的二维码，将文件从远程服务器“拿”回本地 PC。
* **无痕传输**：无需安装驱动，无需注册账号，所有逻辑在浏览器本地执行，不留物理痕迹。


## 🚀 快速上手

### 方案 A：手机 ↔ 手机（移动互传）

1. 两台设备均访问：[https://topcss.github.io/AirScan-QR/](https://topcss.github.io/AirScan-QR/)
2. **发送方**：点击“选择文件” -> 设置帧率 -> 开始广播。
3. **接收方**：点击“开始扫描” -> 对准发送方屏幕 -> 完成后自动触发下载。

### 方案 B：PC → 手机（内网提取）

1. 内网 PC 打开本项目（可通过 HTML 离线文件）。
2. 发送方选择文件并广播。
3. 手机扫码接收，实现文件“出网”。

### 方案 C：远程 PC → 本机 PC（穿透 VPN/远程桌面）

1. 在远程窗口中运行发送端并显示二维码。
2. 本机 PC 接收中，选择屏幕录制，选择对应的应用窗口，即可接收文件。


## 📸 界面预览 (UI Preview)

| 发送端界面 (Sender) | 接收端界面 (Receiver) |
| :---: | :---: |
| ![发送端](send.png) | ![接收端](receive.png) |
| **功能**：文件切片、动态帧率调节、实时广播 | **功能**：扫码识别、分片重组、自动下载 |


## ✨ 功能亮点

* ⚡ **高速流传输**：基于 `qrious` 优化算法，支持 1-30 FPS 动态帧率调节。
* 🧩 **动态分片技术**：单帧容量支持 200-800 Byte 自由调节，适配不同性能的扫描端。
* 🔄 **智能补帧机制**：可视化缺失帧矩阵，点击特定帧即可单点重传，攻克环境光干扰导致的跳帧难题。
* 📄 **元数据保留**：支持超长文件名及后缀名的无损还原，确保文件开箱即用。
* 🎨 **极简交互**：基于 Tailwind CSS 构建，适配手机与 PC 端，支持深色模式。



## 🛠️ 技术原理

项目采用**二维码流水线协议 (QR-Pipeline Protocol)**：
`TaskID | FileName | TotalFrames | CurrentIndex | DataPayload`

* **数据编码**：将文件转化为 Base64 后进行切片分段。
* **索引校验**：通过数组索引重组分片，确保文件合并顺序 100% 准确。
* **零服务器依赖**：纯客户端逻辑，数据不经过中转，隐私安全无忧。



## 📦 部署与使用

由于采用单 HTML 架构，你可以根据需求选择：

1. **在线访问**：通过 GitHub Pages 直接使用。
2. **本地携带**：下载 [release/index-embedded.html](release/index-embedded.html) 或 [release/airscan-fountain-embedded.html](release/airscan-fountain-embedded.html)，单文件版本可放入 U 盘随身携带。
3. **内网分发**：直接将 HTML 文件部署在内网静态服务器或共享文件夹中。

## 版本介绍

两个版本均支持直接输入文字发送：接收后在网页显示原文（保留换行），可点击「复制文本」，无需下载。通过「选文件」发送的内容（包括 `.txt` 文件）仍按文件接收、保存。离线 embedded 版本行为相同。新接收端会将旧发送端未标注类型的数据继续作为文件处理。

手机中转时，完整接收后直接切换到「发送」，本次文本会自动填入输入框，文件会自动成为待发送文件（保留原文件名和内容），再点击开始发送即可转发，无需下载或重新选择。载入后可编辑文本、取消文件或另选文件；再次切换标签不会覆盖这些修改。

1. [index.html](https://topcss.github.io/AirScan-QR/index.html): 正式版，技术路线为单码循环播放传文件，支持摄像头扫码和pc跨应用扫码。
2. [airscan-fountain.html](https://topcss.github.io/AirScan-QR/airscan-fountain.html) 喷泉版，技术路线为四码同传，解决了丢帧需要重传的问题，极高的提升了传输效率。

## 生成 embedded 离线版本

需要 Python 3.10 或更高版本。在项目目录执行：

```bash
python build_embedded.py
```

脚本将源 HTML 中的四个 CDN 脚本（QRious、html5-qrcode、jsQR、Tailwind）内嵌到页面，保留界面和业务逻辑，生成：

```text
release/
├── index-embedded.html
└── airscan-fountain-embedded.html
```

每次运行都联网重新下载全部依赖，并重新构建两个版本。

日常只修改根目录的 `index.html` 和 `airscan-fountain.html`，然后重新运行脚本，并将源文件与 `release/` 中生成的文件一起提交。

转换脚本的测试可通过 `python -m unittest discover -s tests -v` 运行。

文本/文件传输回归测试可通过 `node --test tests/test_transfer.cjs` 运行（需要 Node.js 18 或更高版本）。

## 📜 许可证

MIT License © [Jack/topcss]
