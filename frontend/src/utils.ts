import type { BackgroundStar, ScreenPoint, CurvePoint } from './types';

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function distance(p1: ScreenPoint, p2: ScreenPoint): number {
  const dx = p1.x - p2.x;
  const dy = p1.y - p2.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function generateBackgroundStars(count: number, width: number, height: number): BackgroundStar[] {
  const stars: BackgroundStar[] = [];
  const colors = [
    '#ffffff', '#f8f7ff', '#e8f4ff', '#fff4e6',
    '#ffe8e8', '#e8ffe8', '#f0f0ff'
  ];

  for (let i = 0; i < count; i++) {
    const z = Math.random();
    stars.push({
      x: Math.random() * width * 2 - width * 0.5,
      y: Math.random() * height * 2 - height * 0.5,
      z,
      size: 0.3 + z * 1.8,
      baseBrightness: 0.2 + z * 0.6,
      twinkleSpeed: 0.5 + Math.random() * 2,
      twinkleOffset: Math.random() * Math.PI * 2,
      color: colors[Math.floor(Math.random() * colors.length)]
    });
  }
  return stars;
}

export function smoothPath(points: CurvePoint[], tension: number = 0.5): CurvePoint[] {
  if (points.length < 3) return [...points];

  const result: CurvePoint[] = [];
  const n = points.length;

  result.push({ x: points[0].x, y: points[0].y, t: 0 });

  for (let i = 0; i < n - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[Math.min(n - 1, i + 1)];
    const p3 = points[Math.min(n - 1, i + 2)];

    const steps = 12;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const t2 = t * t;
      const t3 = t2 * t;

      const x =
        tension * 2 * p1.x +
        (-p0.x + p2.x) * tension * t +
        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * tension * t2 +
        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * tension * t3;

      const y =
        tension * 2 * p1.y +
        (-p0.y + p2.y) * tension * t +
        (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * tension * t2 +
        (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * tension * t3;

      result.push({ x, y });
    }
  }

  return result;
}

export function quadraticBezier(
  p0: ScreenPoint,
  p1: ScreenPoint,
  p2: ScreenPoint,
  steps: number = 30
): CurvePoint[] {
  const result: CurvePoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = (1 - t) * (1 - t) * p0.x + 2 * (1 - t) * t * p1.x + t * t * p2.x;
    const y = (1 - t) * (1 - t) * p0.y + 2 * (1 - t) * t * p1.y + t * t * p2.y;
    result.push({ x, y, t });
  }
  return result;
}

export function cubicBezier(
  p0: ScreenPoint,
  p1: ScreenPoint,
  p2: ScreenPoint,
  p3: ScreenPoint,
  steps: number = 40
): CurvePoint[] {
  const result: CurvePoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const t2 = t * t;
    const t3 = t2 * t;
    const mt = 1 - t;
    const mt2 = mt * mt;
    const mt3 = mt2 * mt;

    const x = mt3 * p0.x + 3 * mt2 * t * p1.x + 3 * mt * t2 * p2.x + t3 * p3.x;
    const y = mt3 * p0.y + 3 * mt2 * t * p1.y + 3 * mt * t2 * p2.y + t3 * p3.y;
    result.push({ x, y, t });
  }
  return result;
}

export function simplifyPath(points: ScreenPoint[], tolerance: number = 3): ScreenPoint[] {
  if (points.length < 3) return [...points];

  const result: ScreenPoint[] = [points[0]];
  let lastAdded = points[0];

  for (let i = 1; i < points.length - 1; i++) {
    const d = distance(points[i], lastAdded);
    if (d >= tolerance) {
      result.push(points[i]);
      lastAdded = points[i];
    }
  }

  result.push(points[points.length - 1]);
  return result;
}

export function rotatePoint(
  point: ScreenPoint,
  center: ScreenPoint,
  angle: number
): ScreenPoint {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos
  };
}

export function colorToRgb(color: string): { r: number; g: number; b: number } {
  const hex = color.replace('#', '');
  return {
    r: parseInt(hex.substring(0, 2), 16),
    g: parseInt(hex.substring(2, 4), 16),
    b: parseInt(hex.substring(4, 6), 16)
  };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
