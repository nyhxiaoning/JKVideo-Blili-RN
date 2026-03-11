# Player UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重写 NativeVideoPlayer，将热度进度条 + 缩略图预览整合进统一自定义控制层（tap-to-show/3s 自动隐藏），删除播放器下方独立的 HeatProgressBar。

**Architecture:** 关闭 react-native-video 原生控制栏（`controls={false}`），用绝对定位 LinearGradient overlay 实现顶部栏 + 中心播放按钮 + 底部进度条控制栏。HeatProgressBar 的热度图解码和缩略图逻辑搬入 NativeVideoPlayer，`bvid`/`cid` 新增为 props 向下透传。VideoPlayer 和 [bvid].tsx 相应删减 state 和旧 props。

**Tech Stack:** React Native 0.83, react-native-video 6.x, expo-linear-gradient, PanResponder, Ionicons

---

## Task 1: 重写 NativeVideoPlayer

**Files:**
- Modify: `components/NativeVideoPlayer.tsx` (完全重写)

- [ ] **Step 1: 用以下完整代码替换 NativeVideoPlayer.tsx**

```tsx
import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, StyleSheet, Dimensions, TouchableOpacity, TouchableWithoutFeedback,
  Text, Modal, Image, PanResponder,
} from 'react-native';
import Video, { VideoRef } from 'react-native-video';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import type { PlayUrlResponse, VideoShotData } from '../services/types';
import { buildDashMpdUri } from '../utils/dash';
import { getHeatmap, getVideoShot } from '../services/bilibili';

const { width: SCREEN_W } = Dimensions.get('window');
const VIDEO_H = SCREEN_W * 0.5625;
const BAR_H = 3;
const BALL = 12;
const BALL_ACTIVE = 16;
const SEGMENTS = 100;
const HIDE_DELAY = 3000;

const HEADERS = {
  Referer: 'https://www.bilibili.com',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function heatColor(v: number): string {
  if (v < 0.5) {
    const t = v * 2;
    return `rgb(${Math.round(t * 255)},174,236)`;
  }
  const t = (v - 0.5) * 2;
  return `rgb(251,${Math.round((1 - t) * 114)},${Math.round((1 - t) * 153)})`;
}

function decodeFloats(base64: string): number[] {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  const floats: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    const tag = bytes[i++];
    const wt = tag & 0x7;
    if (wt === 5) { floats.push(view.getFloat32(i, true)); i += 4; }
    else if (wt === 0) { while (i < bytes.length && (bytes[i++] & 0x80)); }
    else if (wt === 1) { i += 8; }
    else if (wt === 2) {
      let len = 0, shift = 0;
      do { const b = bytes[i++]; len |= (b & 0x7f) << shift; shift += 7; if (!(b & 0x80)) break; } while (true);
      i += len;
    } else break;
  }
  return floats;
}

function downsample(data: number[], n: number): number[] {
  if (!data.length) return Array(n).fill(0);
  const out = Array.from({ length: n }, (_, i) => data[Math.floor((i / n) * data.length)]);
  const max = Math.max(...out);
  return max ? out.map(v => v / max) : out;
}

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
}

interface Props {
  playData: PlayUrlResponse | null;
  qualities: { qn: number; desc: string }[];
  currentQn: number;
  onQualityChange: (qn: number) => void;
  onFullscreen: () => void;
  onMiniPlayer?: () => void;
  style?: object;
  bvid?: string;
  cid?: number;
}

export function NativeVideoPlayer({
  playData, qualities, currentQn, onQualityChange, onFullscreen, onMiniPlayer, style,
  bvid, cid,
}: Props) {
  const [resolvedUrl, setResolvedUrl] = useState<string | undefined>();
  const isDash = !!playData?.dash;

  const [showControls, setShowControls] = useState(true);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [paused, setPaused] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const durationRef = useRef(0);

  const [showQuality, setShowQuality] = useState(false);

  const [isSeeking, setIsSeeking] = useState(false);
  const isSeekingRef = useRef(false);
  const [touchX, setTouchX] = useState<number | null>(null);
  const barOffsetX = useRef(0);
  const barWidthRef = useRef(SCREEN_W);
  const trackRef = useRef<View>(null);

  const [heatSegments, setHeatSegments] = useState<number[]>([]);
  const [shots, setShots] = useState<VideoShotData | null>(null);

  const videoRef = useRef<VideoRef>(null);
  const currentDesc = qualities.find(q => q.qn === currentQn)?.desc ?? String(currentQn || 'HD');

  // URL resolution
  useEffect(() => {
    if (!playData) { setResolvedUrl(undefined); return; }
    if (isDash) {
      buildDashMpdUri(playData, currentQn)
        .then(setResolvedUrl)
        .catch(() => setResolvedUrl(playData.dash!.video[0]?.baseUrl));
    } else {
      setResolvedUrl(playData.durl?.[0]?.url);
    }
  }, [playData, currentQn]);

  // Heatmap + shots
  useEffect(() => {
    if (!bvid || !cid) return;
    let cancelled = false;
    Promise.all([getHeatmap(bvid), getVideoShot(bvid, cid)]).then(([heatmap, shotData]) => {
      if (cancelled) return;
      if (heatmap?.pb_data) {
        try { setHeatSegments(downsample(decodeFloats(heatmap.pb_data), SEGMENTS)); }
        catch { setHeatSegments([]); }
      }
      if (shotData?.image?.length) setShots(shotData);
    });
    return () => { cancelled = true; };
  }, [bvid, cid]);

  useEffect(() => { durationRef.current = duration; }, [duration]);

  const resetHideTimer = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (!isSeekingRef.current) {
      hideTimer.current = setTimeout(() => setShowControls(false), HIDE_DELAY);
    }
  }, []);

  const showAndReset = useCallback(() => {
    setShowControls(true);
    resetHideTimer();
  }, [resetHideTimer]);

  const handleTap = useCallback(() => {
    setShowControls(prev => {
      if (!prev) { resetHideTimer(); return true; }
      if (hideTimer.current) clearTimeout(hideTimer.current);
      return false;
    });
  }, [resetHideTimer]);

  // Start hide timer on mount
  useEffect(() => { resetHideTimer(); return () => { if (hideTimer.current) clearTimeout(hideTimer.current); }; }, []);

  const measureTrack = useCallback(() => {
    trackRef.current?.measureInWindow((x, _y, w) => {
      barOffsetX.current = x;
      barWidthRef.current = w;
    });
  }, []);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (_, gs) => {
        isSeekingRef.current = true;
        setIsSeeking(true);
        setShowControls(true);
        if (hideTimer.current) clearTimeout(hideTimer.current);
        setTouchX(clamp(gs.x0 - barOffsetX.current, 0, barWidthRef.current));
      },
      onPanResponderMove: (_, gs) => {
        setTouchX(clamp(gs.moveX - barOffsetX.current, 0, barWidthRef.current));
      },
      onPanResponderRelease: (_, gs) => {
        const ratio = clamp((gs.moveX - barOffsetX.current) / barWidthRef.current, 0, 1);
        const t = ratio * durationRef.current;
        videoRef.current?.seek(t);
        setCurrentTime(t);
        setTouchX(null);
        isSeekingRef.current = false;
        setIsSeeking(false);
        // use setTimeout to avoid stale resetHideTimer closure
        setTimeout(() => {
          if (hideTimer.current) clearTimeout(hideTimer.current);
          hideTimer.current = setTimeout(() => setShowControls(false), HIDE_DELAY);
        }, 0);
      },
      onPanResponderTerminate: () => {
        setTouchX(null);
        isSeekingRef.current = false;
        setIsSeeking(false);
      },
    })
  ).current;

  const touchRatio = touchX !== null ? clamp(touchX / barWidthRef.current, 0, 1) : null;
  const progressRatio = duration > 0 ? clamp(currentTime / duration, 0, 1) : 0;

  const renderThumbnail = () => {
    if (touchRatio === null || !shots) return null;
    const { img_x_size: TW, img_y_size: TH, img_x_len, img_y_len, image } = shots;
    const totalFrames = img_x_len * img_y_len * image.length;
    const framesPerSheet = img_x_len * img_y_len;
    const frameIdx = Math.floor(touchRatio * (totalFrames - 1));
    const sheetIdx = Math.floor(frameIdx / framesPerSheet);
    const local = frameIdx % framesPerSheet;
    const col = local % img_x_len;
    const row = Math.floor(local / img_x_len);
    const left = clamp((touchX ?? 0) - TW / 2, 0, barWidthRef.current - TW);
    return (
      <View style={[styles.thumbPreview, { left, width: TW }]}>
        <View style={{ width: TW, height: TH, overflow: 'hidden', borderRadius: 4 }}>
          <Image
            source={{ uri: image[sheetIdx] }}
            style={{ position: 'absolute', width: TW * img_x_len, height: TH * img_y_len, left: -col * TW, top: -row * TH }}
          />
        </View>
        <Text style={styles.thumbTime}>{formatTime((touchRatio ?? 0) * duration)}</Text>
      </View>
    );
  };

  return (
    <TouchableWithoutFeedback onPress={handleTap}>
      <View style={[styles.container, style]}>
        {resolvedUrl ? (
          <Video
            key={resolvedUrl}
            ref={videoRef}
            source={isDash
              ? { uri: resolvedUrl, type: 'mpd', headers: HEADERS }
              : { uri: resolvedUrl, headers: HEADERS }
            }
            style={StyleSheet.absoluteFill}
            resizeMode="contain"
            controls={false}
            paused={paused}
            onProgress={({ currentTime: ct, seekableDuration: dur }) => {
              setCurrentTime(ct);
              if (dur > 0) setDuration(dur);
            }}
          />
        ) : (
          <View style={styles.placeholder} />
        )}

        {showControls && (
          <>
            {/* Top bar */}
            <LinearGradient colors={['rgba(0,0,0,0.55)', 'transparent']} style={styles.topBar} pointerEvents="box-none">
              {onMiniPlayer && (
                <TouchableOpacity onPress={() => { onMiniPlayer(); }} style={styles.topBtn}>
                  <Ionicons name="tablet-portrait-outline" size={20} color="#fff" />
                </TouchableOpacity>
              )}
            </LinearGradient>

            {/* Center play/pause */}
            <TouchableOpacity
              style={styles.centerBtn}
              onPress={() => { setPaused(p => !p); showAndReset(); }}
            >
              <View style={styles.centerBtnBg}>
                <Ionicons name={paused ? 'play' : 'pause'} size={28} color="#fff" />
              </View>
            </TouchableOpacity>

            {/* Bottom bar */}
            <LinearGradient colors={['transparent', 'rgba(0,0,0,0.7)']} style={styles.bottomBar} pointerEvents="box-none">
              {/* Thumbnail area */}
              <View style={styles.thumbArea} pointerEvents="none">
                {renderThumbnail()}
              </View>

              {/* Progress track */}
              <View
                ref={trackRef}
                style={styles.trackWrapper}
                onLayout={measureTrack}
                {...panResponder.panHandlers}
              >
                <View style={styles.track}>
                  {heatSegments.length > 0
                    ? heatSegments.map((v, i) => (
                        <View key={i} style={[styles.seg, { backgroundColor: heatColor(v), width: `${100 / SEGMENTS}%` as any }]} />
                      ))
                    : <View style={[styles.seg, { flex: 1, backgroundColor: '#00AEEC' }]} />
                  }
                  <View style={[styles.playedOverlay, { width: `${progressRatio * 100}%` as any }]} />
                </View>
                {/* Balls */}
                {isSeeking && touchX !== null ? (
                  <View style={[styles.ball, styles.ballActive, { left: touchX - BALL_ACTIVE / 2 }]} />
                ) : (
                  <View style={[styles.ball, { left: progressRatio * barWidthRef.current - BALL / 2 }]} />
                )}
              </View>

              {/* Controls row */}
              <View style={styles.ctrlRow}>
                <TouchableOpacity onPress={() => { setPaused(p => !p); showAndReset(); }} style={styles.ctrlBtn}>
                  <Ionicons name={paused ? 'play' : 'pause'} size={16} color="#fff" />
                </TouchableOpacity>
                <Text style={styles.timeText}>{formatTime(currentTime)}</Text>
                <View style={{ flex: 1 }} />
                <Text style={styles.timeText}>{formatTime(duration)}</Text>
                <TouchableOpacity style={styles.ctrlBtn} onPress={() => setShowQuality(true)}>
                  <Text style={styles.qualityText}>{currentDesc}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.ctrlBtn} onPress={onFullscreen}>
                  <Ionicons name="expand" size={16} color="#fff" />
                </TouchableOpacity>
              </View>
            </LinearGradient>
          </>
        )}

        {/* Quality modal */}
        <Modal visible={showQuality} transparent animationType="fade">
          <TouchableOpacity style={styles.modalOverlay} onPress={() => setShowQuality(false)}>
            <View style={styles.qualityList}>
              <Text style={styles.qualityTitle}>选择清晰度</Text>
              {qualities.map(q => (
                <TouchableOpacity
                  key={q.qn}
                  style={styles.qualityItem}
                  onPress={() => { setShowQuality(false); onQualityChange(q.qn); showAndReset(); }}
                >
                  <Text style={[styles.qualityItemText, q.qn === currentQn && styles.qualityItemActive]}>
                    {q.desc}
                  </Text>
                  {q.qn === currentQn && <Ionicons name="checkmark" size={16} color="#00AEEC" />}
                </TouchableOpacity>
              ))}
            </View>
          </TouchableOpacity>
        </Modal>
      </View>
    </TouchableWithoutFeedback>
  );
}

const styles = StyleSheet.create({
  container: { width: SCREEN_W, height: VIDEO_H, backgroundColor: '#000' },
  placeholder: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000' },
  // Top bar
  topBar: { position: 'absolute', top: 0, left: 0, right: 0, height: 56, paddingHorizontal: 12, paddingTop: 10, flexDirection: 'row', justifyContent: 'flex-end' },
  topBtn: { padding: 6 },
  // Center
  centerBtn: { position: 'absolute', top: '50%', left: '50%', transform: [{ translateX: -28 }, { translateY: -28 }] },
  centerBtnBg: { width: 56, height: 56, borderRadius: 28, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' },
  // Bottom bar
  bottomBar: { position: 'absolute', bottom: 0, left: 0, right: 0, paddingBottom: 8, paddingTop: 32 },
  thumbArea: { position: 'relative', height: 80, marginHorizontal: 8 },
  thumbPreview: { position: 'absolute', bottom: 4, alignItems: 'center' },
  thumbTime: { color: '#fff', fontSize: 11, fontWeight: '600', marginTop: 2, textShadowColor: 'rgba(0,0,0,0.7)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 2 },
  // Track
  trackWrapper: { marginHorizontal: 8, height: BAR_H + BALL_ACTIVE, justifyContent: 'center', position: 'relative' },
  track: { height: BAR_H, flexDirection: 'row', borderRadius: 2, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.3)' },
  seg: { height: BAR_H },
  playedOverlay: { position: 'absolute', top: 0, left: 0, height: BAR_H, backgroundColor: 'rgba(255,255,255,0.3)' },
  ball: { position: 'absolute', top: (BAR_H + BALL_ACTIVE) / 2 - BALL / 2, width: BALL, height: BALL, borderRadius: BALL / 2, backgroundColor: '#fff', elevation: 3 },
  ballActive: { width: BALL_ACTIVE, height: BALL_ACTIVE, borderRadius: BALL_ACTIVE / 2, backgroundColor: '#00AEEC', top: 0 },
  // Controls row
  ctrlRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, marginTop: 4 },
  ctrlBtn: { paddingHorizontal: 8, paddingVertical: 4 },
  timeText: { color: '#fff', fontSize: 11, marginHorizontal: 4 },
  qualityText: { color: '#fff', fontSize: 11, fontWeight: '600' },
  // Quality modal
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },
  qualityList: { backgroundColor: '#fff', borderRadius: 12, paddingVertical: 8, paddingHorizontal: 16, minWidth: 180 },
  qualityTitle: { fontSize: 15, fontWeight: '700', color: '#212121', paddingVertical: 10, textAlign: 'center' },
  qualityItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#eee' },
  qualityItemText: { fontSize: 14, color: '#333' },
  qualityItemActive: { color: '#00AEEC', fontWeight: '700' },
});
```

- [ ] **Step 2: 验证 TypeScript 无报错**

```bash
cd C:/claude-code-studly/reactBilibiliApp && npx tsc --noEmit 2>&1 | grep NativeVideoPlayer
```

Expected: no output (no errors)

- [ ] **Step 3: Commit**

```bash
git add components/NativeVideoPlayer.tsx
git commit -m "feat: rewrite NativeVideoPlayer with unified custom controls overlay"
```

---

## Task 2: 更新 VideoPlayer.tsx

**Files:**
- Modify: `components/VideoPlayer.tsx`

- [ ] **Step 1: 添加 bvid/cid props，移除 onProgress/seekTo，向下透传**

将 VideoPlayer.tsx 完整替换为：

```tsx
import React, { useState } from 'react';
import { View, StyleSheet, Dimensions, Text, Platform, Modal, TouchableOpacity, StatusBar } from 'react-native';
import { NativeVideoPlayer } from './NativeVideoPlayer';
import type { PlayUrlResponse } from '../services/types';

const { width } = Dimensions.get('window');
const VIDEO_HEIGHT = width * 0.5625;

interface Props {
  playData: PlayUrlResponse | null;
  qualities: { qn: number; desc: string }[];
  currentQn: number;
  onQualityChange: (qn: number) => void;
  onMiniPlayer?: () => void;
  bvid?: string;
  cid?: number;
}

export function VideoPlayer({ playData, qualities, currentQn, onQualityChange, onMiniPlayer, bvid, cid }: Props) {
  const [fullscreen, setFullscreen] = useState(false);

  if (!playData) {
    return (
      <View style={[styles.container, styles.placeholder]}>
        <Text style={styles.placeholderText}>视频加载中...</Text>
      </View>
    );
  }

  if (Platform.OS === 'web') {
    const url = playData.durl?.[0]?.url ?? '';
    return (
      <View style={styles.container}>
        <video
          src={url}
          style={{ width: '100%', height: '100%', backgroundColor: '#000' } as any}
          controls
          playsInline
        />
      </View>
    );
  }

  return (
    <>
      <NativeVideoPlayer
        playData={playData}
        qualities={qualities}
        currentQn={currentQn}
        onQualityChange={onQualityChange}
        onFullscreen={() => setFullscreen(true)}
        onMiniPlayer={onMiniPlayer}
        bvid={bvid}
        cid={cid}
      />

      <Modal visible={fullscreen} animationType="fade" statusBarTranslucent>
        <StatusBar hidden />
        <View style={styles.fullscreenContainer}>
          <NativeVideoPlayer
            playData={playData}
            qualities={qualities}
            currentQn={currentQn}
            onQualityChange={onQualityChange}
            onFullscreen={() => setFullscreen(false)}
            bvid={bvid}
            cid={cid}
            style={{ width: '100%', height: '100%' } as any}
          />
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  container: { width, height: VIDEO_HEIGHT, backgroundColor: '#000' },
  placeholder: { justifyContent: 'center', alignItems: 'center' },
  placeholderText: { color: '#fff', fontSize: 14 },
  fullscreenContainer: { flex: 1, backgroundColor: '#000' },
});
```

- [ ] **Step 2: 验证 TypeScript 无报错**

```bash
cd C:/claude-code-studly/reactBilibiliApp && npx tsc --noEmit 2>&1 | grep -E "VideoPlayer|NativeVideoPlayer"
```

Expected: no new errors

- [ ] **Step 3: Commit**

```bash
git add components/VideoPlayer.tsx
git commit -m "refactor: VideoPlayer adds bvid/cid props, removes onProgress/seekTo"
```

---

## Task 3: 清理 [bvid].tsx

**Files:**
- Modify: `app/video/[bvid].tsx`

- [ ] **Step 1: 删除 HeatProgressBar 相关内容**

1. 删除 import 行：`import { HeatProgressBar } from '../../components/HeatProgressBar';`
2. 删除 3 个 state：`currentTime`, `duration`, `seekCmd`
3. 删除 `onProgress` 和 `seekTo` props（从 VideoPlayer 调用处）
4. 新增 `bvid={bvid as string}` 和 `cid={video?.cid}` 到 VideoPlayer
5. 删除整个 `<HeatProgressBar .../>` JSX 块

VideoPlayer 调用改为：
```tsx
<VideoPlayer
  playData={playData}
  qualities={qualities}
  currentQn={currentQn}
  onQualityChange={changeQuality}
  onMiniPlayer={handleMiniPlayer}
  bvid={bvid as string}
  cid={video?.cid}
/>
```

- [ ] **Step 2: 验证 TypeScript 无报错**

```bash
cd C:/claude-code-studly/reactBilibiliApp && npx tsc --noEmit 2>&1 | grep bvid
```

Expected: no errors referencing bvid.tsx

- [ ] **Step 3: Commit**

```bash
git add app/video/[bvid].tsx
git commit -m "refactor: remove HeatProgressBar from video detail page, pass bvid/cid to VideoPlayer"
```

---

## Task 4: 删除 HeatProgressBar.tsx

**Files:**
- Delete: `components/HeatProgressBar.tsx`

- [ ] **Step 1: 删除文件**

```bash
cd C:/claude-code-studly/reactBilibiliApp && rm components/HeatProgressBar.tsx
```

- [ ] **Step 2: 确认无残留引用**

```bash
cd C:/claude-code-studly/reactBilibiliApp && grep -r "HeatProgressBar" --include="*.tsx" --include="*.ts" .
```

Expected: no output

- [ ] **Step 3: 全量 TypeScript 检查**

```bash
cd C:/claude-code-studly/reactBilibiliApp && npx tsc --noEmit 2>&1 | grep -v "video.stat"
```

Expected: 只有既有的 `video.stat` 错误，无新增错误

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: unified player controls with heatmap progress bar and thumbnail preview"
```

---

## 完成标志

- [ ] 打开视频详情页，播放器内有控制层（顶部 pip 按钮 + 中心播放/暂停 + 底部进度条 + 清晰度 + 全屏）
- [ ] 3 秒后控制层自动隐藏，点击视频区域重新显示
- [ ] 拖拽进度条时显示缩略图预览（需要视频有截图数据）
- [ ] 切换清晰度正常工作
- [ ] 播放器下方无独立的 HeatProgressBar


