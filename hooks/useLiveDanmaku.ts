import { useState, useEffect, useRef } from 'react';
import { getLiveDanmakuHistory } from '../services/bilibili';
import type { DanmakuItem } from '../services/types';

const POLL_INTERVAL = 3000;

// 匹配 admin 消息中的礼物信息，如 "xxx 赠送了 辣条 x5" 或 "xxx 投喂 小心心 ×1"
const GIFT_PATTERN = /(?:赠送|投喂)\s*(?:了\s*)?(.+?)\s*[xX×]\s*(\d+)/;

// 常见礼物名列表，用于匹配
const KNOWN_GIFTS = new Set([
  '辣条', '小心心', '打call', '干杯', '比心',
  '吃瓜', '花式夸夸', '告白气球', '小电视飞船',
]);

export function useLiveDanmaku(roomId: number): {
  danmakus: DanmakuItem[];
  giftCounts: Record<string, number>;
} {
  const [danmakus, setDanmakus] = useState<DanmakuItem[]>([]);
  const [giftCounts, setGiftCounts] = useState<Record<string, number>>({});
  const seenTextsRef = useRef<Set<string>>(new Set());
  const seenAdminRef = useRef<Set<string>>(new Set());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!roomId) return;
    setDanmakus([]);
    setGiftCounts({});
    seenTextsRef.current.clear();
    seenAdminRef.current.clear();
    let cancelled = false;

    async function poll() {
      try {
        const { danmakus: items, adminMsgs } = await getLiveDanmakuHistory(roomId);
        if (cancelled) return;

        // 去重弹幕
        const newItems = items.filter(item => {
          const key = `${item.uname ?? ''}:${item.text}`;
          if (seenTextsRef.current.has(key)) return false;
          seenTextsRef.current.add(key);
          return true;
        });
        if (newItems.length > 0) {
          setDanmakus(prev => [...prev, ...newItems]);
        }

        // 解析 admin 消息中的礼物
        const newGifts: Record<string, number> = {};
        for (const msg of adminMsgs) {
          console.log(msg,123)
          // 去重 admin 消息
          if (seenAdminRef.current.has(msg)) continue;
          seenAdminRef.current.add(msg);

          const match = msg.match(GIFT_PATTERN);
          if (match) {
            const giftName = match[1].trim();
            const count = parseInt(match[2], 10);
            if (KNOWN_GIFTS.has(giftName) && count > 0) {
              newGifts[giftName] = (newGifts[giftName] ?? 0) + count;
            }
          }
        }
        if (Object.keys(newGifts).length > 0) {
          setGiftCounts(prev => {
            const next = { ...prev };
            for (const [name, count] of Object.entries(newGifts)) {
              next[name] = (next[name] ?? 0) + count;
            }
            return next;
          });
        }

        // 防止 seen set 无限增长
        if (seenTextsRef.current.size > 2000) {
          const arr = Array.from(seenTextsRef.current);
          seenTextsRef.current = new Set(arr.slice(-1000));
        }
        if (seenAdminRef.current.size > 500) {
          const arr = Array.from(seenAdminRef.current);
          seenAdminRef.current = new Set(arr.slice(-250));
        }
      } catch (e) {
        console.warn('[danmaku] poll failed:', e);
      }
      if (!cancelled) {
        timerRef.current = setTimeout(poll, POLL_INTERVAL);
      }
    }

    poll();

    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [roomId]);

  return { danmakus, giftCounts };
}
