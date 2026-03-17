# B站直播弹幕连接 — 学习笔记

> 参考项目：https://github.com/Minteea/bilibili-live-danmaku (v0.7.15)

---

## 一、完整连接流程

```
1. 初始化 Cookie
   GET  https://www.bilibili.com/               → 种植初始 cookie
   POST .../bilibili.api.ticket.v1.Ticket/GenWebTicket → 获取 bili_ticket + WBI 签名密钥
   GET  .../x/frontend/finger/spi               → 获取 buvid4
   POST .../x/internal/gaia-gateway/ExClimbWuzhi → 激活 buvid（模拟指纹）

2. 获取弹幕服务器信息（需要 WBI 签名）
   GET https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?id={roomId}
   响应：{ token, host_list: [{ host, wss_port, ws_port }] }

3. 建立 WebSocket 连接
   wss://{host_list[0].host}/sub
   fallback: wss://broadcastlv.chat.bilibili.com/sub

4. onopen → 发送 AUTH 包（op=7）
5. 收到 op=8 (CONNECT_SUCCESS) → 立即发送一次心跳（op=2）
6. 每次收到 op=3 (HEARTBEAT_REPLY) → 30秒后发下一次心跳
7. 收到 op=5 (MESSAGE) → 解析弹幕数据
```

---

## 二、二进制包格式（16字节包头）

```
┌──────────┬──────────┬──────────┬──────────┬──────────┐
│  0–3     │  4–5     │  6–7     │  8–11    │  12–15   │
│ 包总长度  │ 头部长度  │ 协议版本  │ 操作码   │ 序列号   │
│ uint32   │ uint16   │ uint16   │ uint32   │ uint32   │
│ (BE)     │ 固定=16  │ ver      │ op       │ 固定=1   │
└──────────┴──────────┴──────────┴──────────┴──────────┘
│ 16+ bytes: body (JSON 字符串 或 压缩数据)              │
└────────────────────────────────────────────────────────┘
```

### 操作码 (op)
| op | 名称 | 方向 | 说明 |
|----|------|------|------|
| 2 | HEARTBEAT | 客→服 | 心跳包，body 为空 |
| 3 | HEARTBEAT_REPLY | 服→客 | 心跳回应，body 是 uint32 在线人数 |
| 5 | MESSAGE | 服→客 | 弹幕/通知消息 |
| 7 | USER_AUTHENTICATION | 客→服 | 进房认证包 |
| 8 | CONNECT_SUCCESS | 服→客 | 认证成功 |

### 协议版本 (ver)
| ver | 说明 | 解压方式 |
|-----|------|---------|
| 0 | 原始 JSON | 直接 `JSON.parse` |
| 1 | uint32 | `DataView.getUint32(0)` |
| 2 | zlib 压缩包束 | `pako.inflate()` → 递归解包 |
| 3 | brotli 压缩包束 | `BrotliDecode()` → 递归解包 |

> ver=2/3 解压后包含**多个子包**拼接，需按每个包头的 totalLen 逐个切割。

---

## 三、认证包 (op=7) 的 body 字段

```json
{
  "uid": 0,
  "roomid": 12345678,
  "protover": 3,
  "platform": "web",
  "type": 2,
  "key": "<token from getDanmuInfo>",
  "buvid": "<buvid3 cookie>"
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| uid | 是 | 未登录填 0 |
| roomid | 是 | 真实房间号（非短号） |
| protover | 是 | 推荐 3（brotli），或 2（zlib） |
| platform | 是 | 固定 `"web"` |
| type | 是 | 固定 `2` |
| key | 是 | getDanmuInfo 返回的 token |
| buvid | 推荐 | buvid3 cookie 值，不填可能被限流 |

---

## 四、心跳逻辑

```
onopen
  └─ 发送 AUTH (op=7)

收到 op=8 (CONNECT_SUCCESS)
  └─ 立即发送第一次心跳 (op=2, body='')

收到 op=3 (HEARTBEAT_REPLY)
  ├─ 清除上次计时器
  └─ 30秒后发送下次心跳 (op=2)
```

**重点**：心跳是在收到 op=3 后才重排计时，而不是固定 setInterval。
这样即使因网络延迟导致心跳回复慢，也不会提前发第二次心跳。

---

## 五、getDanmuInfo API

```
GET https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo
    ?id={roomId}
    &w_rid=xxx   ← WBI 签名参数
    &wts=xxx
```

响应：
```json
{
  "code": 0,
  "data": {
    "token": "L_DSj3cX...",
    "host_list": [
      { "host": "tx-gz-live-comet.chat.bilibili.com", "wss_port": 443, "ws_port": 2244 },
      { "host": "broadcastlv.chat.bilibili.com", "wss_port": 443, "ws_port": 2244 }
    ]
  }
}
```

也可使用旧版 `getConf`（无需 WBI 签名，但已被标记为 deprecated）：
```
GET https://api.live.bilibili.com/room/v1/Danmu/getConf?room_id={roomId}&platform=h5
```

---

## 六、与我们现有实现的差异

| 对比项 | 我们现在 | 参考项目 | 建议 |
|--------|---------|---------|------|
| API | `getConf`（老接口） | `getDanmuInfo`（新接口） | 可选，两个都能用 |
| WBI 签名 | 有（之前因 -352 移除） | 有 | 如果遇到 -352 可用 getConf |
| `protover` | 2（zlib） | 3（brotli）或 2 | 先用 2，brotli 需 polyfill |
| auth 字段 | 缺少 `platform`、`buvid` | 有 `platform: "web"`、`buvid` | **需补充** |
| 心跳方式 | `setInterval` 固定 30s | 收到 op=3 后计时 30s | 建议改为 op=3 驱动 |
| buvid3 | 未传入 auth | 作为 `buvid` 字段传入 auth | **需补充** |

---

## 七、我们代码需要的改进

### 1. 补充 auth 字段
```ts
const authBody = JSON.stringify({
  uid: 0,
  roomid: roomId,
  protover: 2,
  platform: 'web',    // ← 缺少
  type: 2,
  key: token,
  buvid: buvid3,      // ← 缺少（从 AsyncStorage 读取）
});
```

### 2. 心跳改为 op=3 驱动
```ts
// 收到 op=8 → 立即发第一次心跳
if (pkt.op === 8) {
  sendHeartbeat();
}
// 收到 op=3 → 30秒后再发
if (pkt.op === 3) {
  clearTimeout(heartbeatTimer);
  heartbeatTimer = setTimeout(sendHeartbeat, 30000);
}
```

### 3. ver=3 (brotli) 解压支持
如果 protover 设为 3，需要引入 brotli 解码库（React Native 需要 polyfill）。
建议暂时保持 protover=2（zlib），pako 已支持。

---

## 八、弹幕消息 cmd 类型

op=5 的 body 是 JSON，`cmd` 字段标识消息类型：

| cmd | 说明 |
|-----|------|
| `DANMU_MSG` | 弹幕消息，`info[1]` 是文字 |
| `SEND_GIFT` | 送礼物 |
| `GUARD_BUY` | 上舰 |
| `SUPER_CHAT_MESSAGE` | SC 醒目留言 |
| `INTERACT_WORD` | 进入直播间/关注 |
| `WATCHED_CHANGE` | 观看人数变化 |
| `ONLINE_RANK_COUNT` | 在线排名人数 |
| `ROOM_CHANGE` | 直播间信息变更 |
| `LIVE` | 开播 |
| `PREPARING` | 下播 |

---

## 九、DANMU_MSG info 数组结构

```
info[0][2]  弹幕颜色（十进制 RGB）
info[1]     弹幕文字内容
info[2][0]  用户 uid
info[2][1]  用户名
info[2][2]  是否房管（1=是）
info[3][0]  粉丝勋章等级
info[3][1]  粉丝勋章名
info[7]     舰长等级（0无，1总督，2提督，3舰长）
```
