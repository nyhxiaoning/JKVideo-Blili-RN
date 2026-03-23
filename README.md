<div align="center">
我用 React Native 做了一个功能完整的 B 站客户端，为了规避法律问题，所以具体代码我重新写了一遍。
从 DASH 解码、弹幕系统到 WBI 签名，一个人把该踩的坑全踩了一遍

先看效果
截图预览
转存失败，建议直接上传图片文件
<sub>首页热门 · 内联视频 · 穿插直播</sub>	转存失败，建议直接上传图片文件
<sub>视频详情 · 简介 · 推荐视频</sub>	转存失败，建议直接上传图片文件
<sub>竖屏播放 · 4K HDR · 多清晰度</sub>
转存失败，建议直接上传图片文件
<sub>下载管理 · 局域网分享二维码</sub>	转存失败，建议直接上传图片文件
<sub>直播 Tab · 关注主播在线 · 分区筛选</sub>	转存失败，建议直接上传图片文件
<sub>直播详情 · 实时弹幕 · 舰长标记</sub>
全宽内联视频、飘屏弹幕、实时直播、扫码登录、离线下载……大部分你在官方客户端能用到的核心功能，这个项目基本都有。

跨平台运行，Android / iOS / Web 三端一套代码，Expo Go 扫码 5 分钟就能跑起来，不需要任何编译环境。

为什么做这个
B 站的开放接口虽然没有官方文档，但社区里已经有大量逆向分析的积累。我想验证一件事：用 React Native 能不能做出一个体验接近原生的视频应用，并且把视频播放、弹幕、直播这些最硬核的部分都做到位。

结论是：可以，但需要踩很多坑。

技术架构
React Native 0.83 + Expo SDK 55
├── 路由        expo-router v4 （文件系统路由）
├── 状态管理    Zustand
├── 网络请求    Axios （自动注入 Cookie / WBI 签名）
├── 视频播放    react-native-video （ DASH MPD / HLS / MP4 ）
├── 降级播放    react-native-webview （ HTML5 video 注入）
├── 页面滑动    react-native-pager-view
└── 本地存储    @react-native-async-storage/async-storage
整体是标准的文件系统路由结构，app/ 下每个文件对应一个页面，Stack 导航管理跳转层级。状态全部走 Zustand ，没有用 Redux 那一套，轻量很多。

最硬的部分：DASH 视频播放
B 站的高清视频走的是 DASH 协议，服务端返回的是分离的 video stream 和 audio stream ，需要客户端自己做 mux 。

浏览器的 <video> 标签支持 MSE （ Media Source Extensions ），可以直接喂 DASH 数据。但 React Native 里的 react-native-video 底层走的是 Android ExoPlayer ，它需要一个标准的 .mpd 文件才能工作。

B 站接口返回的是 JSON ，不是 MPD ，所以我手写了一个转换器：

// utils/dash.ts
export function buildDashMpdUri(dashData: DashData): string {
  const videoRep = dashData.video
    .map(v => `
      <Representation id="${v.id}" bandwidth="${v.bandwidth}"
        codecs="${v.codecs}" width="${v.width}" height="${v.height}" frameRate="${v.frameRate}">
        <BaseURL>${escapeXml(v.baseUrl)}</BaseURL>
        <SegmentBase indexRange="${v.segmentBase.indexRange}">
          <Initialization range="${v.segmentBase.initialization}"/>
        </SegmentBase>
      </Representation>`)
    .join('');

  const audioRep = dashData.audio
    .map(a => `
      <Representation id="${a.id}" bandwidth="${a.bandwidth}" codecs="${a.codecs}">
        <BaseURL>${escapeXml(a.baseUrl)}</BaseURL>
        <SegmentBase indexRange="${a.segmentBase.indexRange}">
          <Initialization range="${a.segmentBase.initialization}"/>
        </SegmentBase>
      </Representation>`)
    .join('');

  const mpd = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" ...>
  ...${videoRep}${audioRep}...
</MPD>`;

  // 转成 data URI ，直接喂给 react-native-video
  return `data:application/dash+xml;base64,${btoa(unescape(encodeURIComponent(mpd)))}`;
}
生成的 MPD data URI 直接传给 <Video source={{ uri: mpdUri }} />，ExoPlayer 拿到合法的 MPD 就能正确解码 1080P+ / 4K HDR 内容。

WBI 签名：纯 TypeScript 手写 MD5
B 站在 2023 年给核心 API 加了 WBI 签名校验。每次请求需要：

从 /x/web-interface/nav 拉取 img_url 和 sub_url，从路径中提取密钥字符
按固定顺序重排密钥，取前 32 位拼出 mixin_key
在请求参数里加入 wts（当前时间戳），用 mixin_key 对参数做 MD5 签名，附上 w_rid
关键在于 MD5——React Native 环境里没有 Node.js 的 crypto 模块，npm 上的 MD5 库又大多依赖 Buffer ，在 Hermes 引擎上会有兼容问题。

最终选择自己实现了一个精简版 MD5 ，纯字符串操作，零外部依赖，在所有平台上跑得很稳。nav 接口结果缓存 12 小时，避免频繁请求。

弹幕系统：两套机制，一套界面
视频弹幕
通过 /x/v1/dm/list.so 拉取 XML 格式的全量弹幕，解析后得到带时间戳的弹幕列表。播放时按当前进度 drip （逐帧滴入）到飘屏层。

飘屏层（DanmakuOverlay）维护 5 条轨道，每条弹幕根据文字长度计算飞行时间，自动选择未被占用的轨道，避免重叠。颜色、字号、舰长标记全部还原。

直播弹幕
完全不同的机制——WebSocket 长连接，B 站直播弹幕走的是私有二进制协议（头部 16 字节，含包长度、协议版本、操作码、序列号）。

useLiveDanmaku Hook 处理连接建立、心跳保活（每 30 秒发一次 [object Object] 心跳包）、Zlib 解压和数据包解析。支持普通弹幕、礼物事件、进场通知，舰长弹幕有独立标记和颜色。直播弹幕实时追加，保留最近 500 条。

首页内联视频：BigVideoCard
列表里的精选视频直接内联播放，静音自动开始，可见时播放、离屏时暂停。

额外实现了水平手势快进：用 PanResponder 监听水平滑动，每 dx 像素对应一定秒数的快进/快退，滑动时显示浮层时间标签，松手跳转。进度条和缓冲条实时更新，和视频状态完全同步。

全局迷你播放器
这是体验细节里比较难做的一个功能。要求是：从视频详情页退出后，底部出现迷你播放器，续播当前视频，不会因为页面卸载而中断。

实现方式：videoStore（ Zustand ）保存当前播放视频的元数据和播放状态，MiniPlayer 组件挂载在根布局 _layout.tsx 里，与路由层级完全解耦。视频详情页卸载时不销毁播放器，只是把控制权交给 MiniPlayer ，播放状态无缝衔接。

扫码登录
完整实现了 B 站的 OAuth 扫码流程：

调用 generateQRCode() 获取 qrcode_key 和二维码内容
用第三方二维码渲染服务生成图片展示给用户
每 2 秒轮询 pollQRCode，监听 code 字段变化
扫码确认后（code === 0），从响应头的 set-cookie 字段提取 SESSDATA
写入 AsyncStorage ，后续所有请求自动携带
登录状态通过 authStore 持久化，App 启动时自动恢复。

离线下载 + 局域网分享
下载功能支持多清晰度选择（ 720P / 1080P / 1080P+），后台队列下载，进度实时显示在导航栏角标。

有一个比较有意思的功能：下载完成后，可以一键启动内置 HTTP 服务器，生成局域网访问二维码。同一 Wi-Fi 下的任意设备扫码，直接在浏览器播放已下载的视频，不需要任何额外 App 。



<img src="https://img.shields.io/badge/JKVideo-仿B站客户端-00AEEC?style=for-the-badge&logo=bilibili&logoColor=white" alt="JKVideo"/>

# JKVideo

**高颜值第三方 B 站 React Native 客户端**

*A feature-rich Bilibili-like app with DASH playback, real-time danmaku, WBI signing & live streaming*

---

[![React Native](https://img.shields.io/badge/React_Native-0.83-61DAFB?logo=react)](https://reactnative.dev)
[![Expo](https://img.shields.io/badge/Expo-SDK_55-000020?logo=expo)](https://expo.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript)](https://www.typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Android%20%7C%20iOS%20%7C%20Web-lightgrey)](README.md)

[English](README.en.md) · [快速开始](#快速开始) · [功能亮点](#功能亮点) · [贡献](CONTRIBUTING.md)

</div>

---

## 截图预览

<table>
  <tr>
    <td align="center"><img src="public/p1.jpg" width="180"/><br/><sub>首页热门 · 内联视频 · 穿插直播</sub></td>
    <td align="center"><img src="public/p2.jpg" width="180"/><br/><sub>视频详情 · 简介 · 推荐视频</sub></td>
    <td align="center"><img src="public/p3.jpg" width="180"/><br/><sub>竖屏播放 · 4K HDR · 多清晰度</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="public/p4.jpg" width="180"/><br/><sub>下载管理 · 局域网分享二维码</sub></td>
    <td align="center"><img src="public/p5.jpg" width="180"/><br/><sub>直播 Tab · 关注主播在线 · 分区筛选</sub></td>
    <td align="center"><img src="public/p6.jpg" width="180"/><br/><sub>直播详情 · 实时弹幕 · 舰长标记</sub></td>
  </tr>
</table>

## 演示视频

https://github.com/tiajinsha/JKVideo/releases/download/v1.0.0/6490dcd9dba9a243a7cd8f00359cc285.mp4

---

## 功能亮点

🎬 **DASH 完整播放**
Bilibili DASH 流 → `buildDashMpdUri()` 生成本地 MPD → ExoPlayer 原生解码，支持 1080P+ 4K HDR

💬 **完整弹幕系统**
视频弹幕 XML 时间轴同步 + 5 车道飘屏覆盖；直播弹幕 WebSocket 实时接收 + 舰长标记 + 礼物计数

🔐 **WBI 签名实现**
纯 TypeScript 手写 MD5，无任何外部加密依赖，nav 接口 12h 自动缓存

🏠 **智能首页排布**
BigVideoCard 内联 DASH 静音自动播放 + 水平手势快进 + 直播卡片穿插 + 双列混排

📺 **全局迷你播放器**
切换页面后底部浮层续播，VideoStore 跨组件状态同步

🔑 **扫码登录**
二维码生成 + 2s 轮询 + 响应头 Cookie 自动提取 SESSDATA

📥 **下载 + 局域网分享**
多清晰度后台下载，内置 HTTP 服务器生成局域网 QR 码，同 Wi-Fi 设备扫码直接播放

🌐 **跨平台运行**
Android · iOS · Web，Expo Go 扫码 5 分钟运行，Dev Build 解锁完整 DASH 播放

---

## 技术架构

| 层 | 技术 |
|---|---|
| 框架 | React Native 0.83 + Expo SDK 55 |
| 路由 | expo-router v4（文件系统路由，Stack 导航） |
| 状态管理 | Zustand |
| 网络请求 | Axios |
| 本地存储 | @react-native-async-storage/async-storage |
| 视频播放 | react-native-video（DASH MPD / HLS / MP4） |
| 降级播放 | react-native-webview（HTML5 video 注入） |
| 页面滑动 | react-native-pager-view |
| 图标 | @expo/vector-icons（Ionicons） |

---

## 快速开始

### 方式一：Expo Go（5 分钟，无需编译）

> 部分清晰度受限，视频播放降级为 WebView 方案

```bash
git clone https://github.com/tiajinsha/JKVideo.git
cd JKVideo
npm install
npx expo start
```

用 Expo Go App（[Android](https://expo.dev/go) / [iOS](https://expo.dev/go)）扫描终端二维码即可运行。

### 方式二：Dev Build（完整功能，推荐）

> 支持 DASH 1080P+ 原生播放、完整弹幕系统

```bash
npm install
npx expo run:android   # Android
npx expo run:ios       # iOS（需 macOS + Xcode）
```

### 方式三：Web 端

```bash
npm install
npx expo start --web
```

> Web 端图片需本地代理服务器绕过防盗链：`node scripts/proxy.js`（端口 3001）

### 直接安装（Android）

前往 [Releases](https://github.com/tiajinsha/JKVideo/releases/latest) 下载最新 APK，无需编译，安装即用。

> 需在 Android 设置中开启「安装未知来源应用」

---

## 项目结构

```
app/
  index.tsx            # 首页（PagerView 热门/直播 Tab）
  video/[bvid].tsx     # 视频详情（播放 + 简介/评论/弹幕）
  live/[roomId].tsx    # 直播详情（HLS 播放 + 实时弹幕）
  search.tsx           # 搜索页
  downloads.tsx        # 下载管理页
  settings.tsx         # 设置页（画质 + 退出登录）

components/            # UI 组件（播放器、弹幕、卡片等）
hooks/                 # 数据 Hooks（视频列表、播放流、弹幕等）
services/              # Bilibili API 封装（axios + Cookie 拦截）
store/                 # Zustand 状态（登录、下载、播放、设置）
utils/                 # 工具函数（格式化、图片代理、MPD 构建）
```

---

## 已知限制

| 限制 | 原因 |
|---|---|
| 4K / 1080P+ 需要大会员账号登录 | B 站 API 策略限制 |
| FLV 直播流不支持 | HTML5 / ExoPlayer 均不支持 FLV，已自动选 HLS |
| Web 端需本地代理 | B 站图片防盗链（Referer 限制） |
| 动态流 / 投稿 / 点赞 | 需要 `bili_jct` CSRF Token，暂未实现 |
| 二维码 10 分钟过期 | 关闭登录弹窗重新打开即可刷新 |

---

## 贡献

欢迎提交 Issue 和 PR！请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 免责声明

本项目仅供个人学习研究使用，不得用于商业用途。
所有视频内容版权归原作者及哔哩哔哩所有。
本项目与哔哩哔哩官方无任何关联。

---

## License

[MIT](LICENSE) © 2026 JKVideo Contributors

---

<div align="center">

如果这个项目对你有帮助，欢迎点一个 ⭐ Star！

---

## 请作者喝杯咖啡 ☕

如果这个项目对你有所帮助，欢迎请作者喝杯咖啡，你的支持是持续开发的最大动力，感谢每一位愿意打赏的朋友！

<table>
  <tr>
    <td align="center">
      <img src="public/wxpay.jpg" width="180"/><br/>
      <sub>微信支付</sub>
    </td>
    <td align="center">
      <img src="public/alipay.jpg" width="180"/><br/>
      <sub>支付宝</sub>
    </td>
  </tr>
</table>

</div>
