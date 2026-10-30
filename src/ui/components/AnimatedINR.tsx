import React, { useEffect, useRef, useState } from 'react';
import { Text, type TextStyle } from 'react-native';
import { formatINR } from '../../core/money.ts';

// Count-up for headline figures: 700ms ease-out from the previous value.
// Text is re-rendered per frame - only used for one or two hero numbers, so
// the cost is trivial.
export function AnimatedINR({ minor, style, duration = 700 }: { minor: number; style?: TextStyle; duration?: number }) {
  const [shown, setShown] = useState(minor);
  const prev = useRef(minor);
  useEffect(() => {
    const from = prev.current;
    const to = minor;
    prev.current = minor;
    if (from === to) { setShown(to); return; }
    let raf = 0;
    const t0 = Date.now();
    const tick = () => {
      const p = Math.min(1, (Date.now() - t0) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setShown(Math.round(from + (to - from) * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [minor, duration]);
  return <Text style={style}>{formatINR(shown)}</Text>;
}
