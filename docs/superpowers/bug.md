# Bug Report

> 最后更新：2026-03-10

---

## CRITICAL

### BUG-01 · `video.stat` 空指针崩溃
**文件**: `app/video/[bvid].tsx` 第 72–75、94 行
**类型**: Logic Bug

`VideoItem.stat` 在类型定义中为可选字段（`stat?: {...}`），但代码直接访问 `video.stat.view` 等属性，无任何空值保护。当 B站 API 返回的视频数据不含 `stat` 字段时，页面会崩溃。

```tsx
// 当前（危险）
<StatBadge icon="play" count={video.stat.view} />
评论 {video.stat.reply > 0 ? ...}

// 修复
<StatBadge icon="play" count={video.stat?.view ?? 0} />
评论 {(video.stat?.reply ?? 0) > 0 ? ...}
```

---

### BUG-02 · 切换视频时评论不重置
**文件**: `hooks/useComments.ts`、`app/video/[bvid].tsx` 第 31–33 行
**类型**: Logic Bug

`useComments` hook 内部没有重置机制。当用户从视频 A（aid=123，已加载 3 页）跳转到视频 B（aid=456）时：
- `comments` 数组仍含视频 A 的内容
- `page` 仍为 4，视频 B 的评论从第 4 页开始请求
- 结果：视频 A 和视频 B 的评论混在一起显示

`useComments` 缺少一个 `reset()` 方法，`[bvid].tsx` 也没有在 `bvid` 变化时调用清理。

```ts
// hooks/useComments.ts 需要增加
const reset = useCallback(() => {
  setComments([]);
  setPage(1);
  setHasMore(true);
}, []);

// app/video/[bvid].tsx 需要在 bvid 变化时调用
useEffect(() => {
  clearVideo();
  resetComments(); // 缺失
}, [bvid]);
```

---

### BUG-03 · `useComments` 跨视频 `page` 状态污染
**文件**: `hooks/useComments.ts` 第 24 行
**类型**: Race Condition

`load` 回调将 `page`、`loading`、`hasMore` 列入 `useCallback` 依赖数组。当 `aid` 变化（切换视频）时，`page` 仍是上一个视频的值，新 `load` 调用会从错误的页码请求评论。与 BUG-02 同根，但原因不同：即使父组件调用 `reset`，旧 `load` 闭包内的 `page` 可能仍是旧值。

```ts
// 当前
}, [aid, page, loading, hasMore]); // page 污染导致跨视频分页错误

// 修复：用 ref 追踪 page，不纳入依赖
const pageRef = useRef(1);
const load = useCallback(async () => {
  ...
  const data = await getComments(aid, pageRef.current);
  pageRef.current += 1;
}, [aid]); // 只依赖 aid
```

---

## MAJOR

### BUG-04 · 视频加载失败无任何用户反馈
**文件**: `app/video/[bvid].tsx` 第 22 行
**类型**: UX

`useVideoDetail` 返回 `error` 字段，但 `[bvid].tsx` 完全忽略它。网络错误、API 403、视频下架等场景下，用户看到的是永久的 loading 动画或空白页，无法知晓发生了什么。

```tsx
// 当前（error 被解构但从未使用）
const { video, playData, loading: videoLoading, qualities, currentQn, changeQuality } = useVideoDetail(bvid);

// 修复：增加 error 处理
const { video, playData, loading: videoLoading, error, qualities, currentQn, changeQuality } = useVideoDetail(bvid);
// 在 ScrollView 内渲染
{error && <Text style={styles.errorTxt}>加载失败：{error}</Text>}
```

---

### BUG-05 · `Promise.all` 导致热力图和缩略图互相阻断
**文件**: `components/NativeVideoPlayer.tsx`（heatmap useEffect）
**类型**: Error Handling

热力图（`getHeatmap`）和视频截图（`getVideoShot`）使用 `Promise.all` 并行请求。任意一个失败，另一个的结果也会被丢弃。对于没有热力图的视频，缩略图也无法加载。

```ts
// 当前
Promise.all([getHeatmap(bvid), getVideoShot(bvid, cid)]).then(...)

// 修复：独立处理各自失败
Promise.allSettled([getHeatmap(bvid), getVideoShot(bvid, cid)]).then(([heatRes, shotRes]) => {
  if (heatRes.status === 'fulfilled' && heatRes.value?.pb_data) { ... }
  if (shotRes.status === 'fulfilled' && shotRes.value?.image?.length) { ... }
});
```

---

### BUG-06 · LoginModal `pollQRCode` 无错误处理
**文件**: `components/LoginModal.tsx`（setInterval 回调）
**类型**: Error Handling

`setInterval` 内的 `await pollQRCode(qrKey)` 若抛出异常（网络断开、超时等），错误被静默丢弃，定时器继续运行。用户看到的是二维码一直停在"等待扫码"状态，没有任何提示。

```ts
// 修复：增加 try-catch
pollRef.current = setInterval(async () => {
  try {
    const result = await pollQRCode(qrKey);
    ...
  } catch {
    // 网络异常时更新状态提示用户
    setStatus('error');
  }
}, 2000);
```

---

### BUG-07 · `utils/buildMpd.ts` 死代码
**文件**: `utils/buildMpd.ts`
**类型**: Code Quality

该文件定义了 `buildMpd()` 函数，但全项目无任何 import。实际 MPD 构建逻辑在 `utils/dash.ts` 中实现。`buildMpd.ts` 中的 `SegmentBase` 使用硬编码的 `range="0-999"` 而非真实的 byte range，直接使用会导致 ExoPlayer 播放失败。应删除该文件。

---

## MINOR

### BUG-08 · `expo-file-system/legacy` 废弃导入
**文件**: `utils/dash.ts` 第 1 行
**类型**: Deprecation

```ts
import * as FileSystem from 'expo-file-system/legacy'; // 废弃路径
```

新版 expo-file-system 将 legacy API 移至子路径是临时过渡方案，后续版本可能移除。需跟进 expo-file-system 更新，迁移至正式 API。

---

### BUG-09 · 进度条 `measureInWindow` 异步竞态
**文件**: `components/NativeVideoPlayer.tsx`（`measureTrack`）
**类型**: Race Condition

控制层从隐藏变为显示时，`trackWrapper` 重新挂载，`onLayout` 触发 `measureInWindow`（异步）。若用户在 `measureInWindow` 回调返回前立即拖动进度条，`barOffsetX.current` 为旧值（0 或上次值），导致 `touchX` 计算偏差，缩略图位置和 seek 位置偏移。

---

### BUG-10 · "加载更多评论"按钮在首次加载前不可见
**文件**: `app/video/[bvid].tsx` 第 108–112 行
**类型**: UX

按钮渲染条件为 `!cmtLoading && comments.length > 0`。首次进入视频详情时，评论需要用户手动点击"加载更多"触发，但在 `loadComments` 被 `useEffect` 自动调用（第 32 行）完成前，按钮不存在。若自动加载失败，用户无法重试。

---

### BUG-11 · `useVideoDetail` 登录态变化时不重置 loading
**文件**: `hooks/useVideoDetail.ts` 第 53–57 行
**类型**: UX

登录/登出时触发 `fetchPlayData` 重新拉取清晰度，但未设置 `loading = true`。用户看不到加载状态变化，若请求耗时较长，可能出现短暂的旧清晰度视频在播放的情况。

---

## 汇总

| ID | 文件 | 严重度 | 类型 | 一句话描述 |
|----|------|--------|------|-----------|
| BUG-01 | `app/video/[bvid].tsx` | CRITICAL | Logic Bug | `video.stat` 无空值保护，可能崩溃 |
| BUG-02 | `hooks/useComments.ts` | CRITICAL | Logic Bug | 切换视频时评论状态不清空 |
| BUG-03 | `hooks/useComments.ts` | CRITICAL | Race Condition | `page` 状态跨视频污染 |
| BUG-04 | `app/video/[bvid].tsx` | MAJOR | UX | 视频加载失败无任何用户反馈 |
| BUG-05 | `components/NativeVideoPlayer.tsx` | MAJOR | Error Handling | `Promise.all` 导致热力图/缩略图互相阻断 |
| BUG-06 | `components/LoginModal.tsx` | MAJOR | Error Handling | 二维码轮询网络异常被静默吞掉 |
| BUG-07 | `utils/buildMpd.ts` | MAJOR | Code Quality | 死代码，硬编码错误 byte range |
| BUG-08 | `utils/dash.ts` | MINOR | Deprecation | `expo-file-system/legacy` 废弃导入 |
| BUG-09 | `components/NativeVideoPlayer.tsx` | MINOR | Race Condition | 进度条测量异步竞态导致拖动偏差 |
| BUG-10 | `app/video/[bvid].tsx` | MINOR | UX | 首次加载失败无重试入口 |
| BUG-11 | `hooks/useVideoDetail.ts` | MINOR | UX | 登录态变化时不显示重新加载状态 |
