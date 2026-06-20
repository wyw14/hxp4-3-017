import type {
  GameState,
  AnchorPoint,
  Connection,
  DrawState,
  ScreenPoint,
  CurvePoint,
  BackgroundStar,
  LevelData
} from './types';
import { Renderer } from './renderer';
import { getLevel, verifyEdge } from './api';
import {
  generateBackgroundStars,
  smoothPath,
  simplifyPath,
  distance,
  clamp,
  rotatePoint
} from './utils';

const SAMPLE_INTERVAL = 16;
const NARROW_SCREEN_THRESHOLD = 768;
const DEFAULT_SNAP_DISTANCE = 35;
const NARROW_SNAP_DISTANCE = 60;
const TOUCH_ASSIST_MAGNIFICATION = 2.5;
const TOUCH_ASSIST_RADIUS = 80;
const TOUCH_ASSIST_OFFSET_Y = -110;

interface TouchAssistState {
  enabled: boolean;
  isTouching: boolean;
  touchPos: ScreenPoint | null;
  canvasTouchPos: ScreenPoint | null;
}

export class Game {
  private canvas: HTMLCanvasElement;
  private renderer: Renderer;
  private state: GameState;
  private backgroundStars: BackgroundStar[] = [];
  private lastTime: number = 0;
  private animationFrameId: number = 0;
  private listeners: Array<() => void> = [];
  private completionTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private isTouchDevice: boolean = false;
  private isNarrowScreen: boolean = false;
  private touchAssist: TouchAssistState = {
    enabled: false,
    isTouching: false,
    touchPos: null,
    canvasTouchPos: null
  };
  private assistCanvas: HTMLCanvasElement | null = null;
  private assistCtx: CanvasRenderingContext2D | null = null;
  private assistContainer: HTMLElement | null = null;

  private onLevelChange?: (level: LevelData) => void;
  private onProgressChange?: (current: number, total: number) => void;
  private onComplete?: (desc: string) => void;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new Renderer(canvas);

    this.state = {
      currentLevel: 1,
      levelData: null,
      connections: [],
      completedEdges: new Set(),
      drawState: this.createEmptyDrawState(),
      rotationOffset: 0,
      time: 0,
      showFrequencies: false,
      isComplete: false,
      snapTargetId: null
    };

    this.isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    this.checkScreenSize();
    this.initTouchAssist();
    this.resize();
    this.bindEvents();
  }

  private initTouchAssist(): void {
    this.touchAssist.enabled = this.isTouchDevice;
    if (!this.touchAssist.enabled) return;

    this.assistContainer = document.getElementById('touch-assist-container');
    this.assistCanvas = document.getElementById('touch-assist-canvas') as HTMLCanvasElement | null;

    if (this.assistCanvas) {
      const ctx = this.assistCanvas.getContext('2d');
      if (ctx) {
        this.assistCtx = ctx;
        this.resizeAssistCanvas();
      }
    }
  }

  private resizeAssistCanvas(): void {
    if (!this.assistCanvas) return;
    const dpr = window.devicePixelRatio || 1;
    const size = TOUCH_ASSIST_RADIUS * 2;
    this.assistCanvas.width = size * dpr;
    this.assistCanvas.height = size * dpr;
    this.assistCanvas.style.width = `${size}px`;
    this.assistCanvas.style.height = `${size}px`;
    this.assistCtx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private checkScreenSize(): void {
    this.isNarrowScreen = window.innerWidth < NARROW_SCREEN_THRESHOLD;
  }

  private getSnapDistance(): number {
    return this.isNarrowScreen ? NARROW_SNAP_DISTANCE : DEFAULT_SNAP_DISTANCE;
  }

  private createEmptyDrawState(): DrawState {
    return {
      isDrawing: false,
      startAnchorId: null,
      currentPos: null,
      points: [],
      lastSampleTime: 0
    };
  }

  setCallbacks(callbacks: {
    onLevelChange?: (level: LevelData) => void;
    onProgressChange?: (current: number, total: number) => void;
    onComplete?: (desc: string) => void;
  }): void {
    this.onLevelChange = callbacks.onLevelChange;
    this.onProgressChange = callbacks.onProgressChange;
    this.onComplete = callbacks.onComplete;
  }

  private resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.checkScreenSize();
    this.renderer.resize(w, h);
    this.backgroundStars = generateBackgroundStars(400, w, h);
    this.resizeAssistCanvas();
  }

  private bindEvents(): void {
    window.addEventListener('resize', () => this.resize());

    this.canvas.addEventListener('mousedown', (e) => this.handleMouseDown(e));
    this.canvas.addEventListener('mousemove', (e) => this.handleMouseMove(e));
    this.canvas.addEventListener('mouseup', () => this.handleMouseUp());
    this.canvas.addEventListener('mouseleave', () => this.handleMouseUp());

    this.canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      this.isTouchDevice = true;
      this.touchAssist.enabled = true;
      if (e.touches.length > 0) {
        const t = e.touches[0];
        this.touchAssist.isTouching = true;
        this.touchAssist.touchPos = { x: t.clientX, y: t.clientY };
        this.touchAssist.canvasTouchPos = this.getCanvasPos({ clientX: t.clientX, clientY: t.clientY } as MouseEvent);
        this.handleMouseDown({ clientX: t.clientX, clientY: t.clientY } as MouseEvent);
      }
    }, { passive: false });
    this.canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      if (e.touches.length > 0) {
        const t = e.touches[0];
        this.touchAssist.touchPos = { x: t.clientX, y: t.clientY };
        this.touchAssist.canvasTouchPos = this.getCanvasPos({ clientX: t.clientX, clientY: t.clientY } as MouseEvent);
        this.handleMouseMove({ clientX: t.clientX, clientY: t.clientY } as MouseEvent);
      }
    }, { passive: false });
    this.canvas.addEventListener('touchend', (e) => {
      e.preventDefault();
      this.touchAssist.isTouching = false;
      this.touchAssist.touchPos = null;
      this.touchAssist.canvasTouchPos = null;
      this.handleMouseUp();
      this.hideTouchAssist();
    }, { passive: false });
  }

  private getCanvasPos(e: MouseEvent): ScreenPoint {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    };
  }

  private findNearestAnchor(pos: ScreenPoint): AnchorPoint | null {
    if (!this.state.levelData) return null;

    let nearest: AnchorPoint | null = null;
    let nearestDist = Infinity;
    const snapDist = this.getSnapDistance();

    for (const anchor of this.state.levelData.anchorPoints) {
      const anchorPos = this.renderer.getAnchorScreenPos(anchor, this.state.rotationOffset);
      const d = distance(pos, anchorPos);

      if (d < snapDist && d < nearestDist) {
        const isValidAnchor = anchor.id.startsWith('a') || anchor.id.startsWith('b') || anchor.id.startsWith('c');
        if (isValidAnchor) {
          nearest = anchor;
          nearestDist = d;
        }
      }
    }

    return nearest;
  }

  private showTouchAssist(): void {
    if (!this.touchAssist.enabled || !this.assistContainer || !this.touchAssist.touchPos) return;
    this.assistContainer.style.display = 'block';
    const assistSize = TOUCH_ASSIST_RADIUS * 2;
    let left = this.touchAssist.touchPos.x - assistSize / 2;
    let top = this.touchAssist.touchPos.y + TOUCH_ASSIST_OFFSET_Y;
    const maxLeft = window.innerWidth - assistSize - 10;
    const maxTop = window.innerHeight - assistSize - 10;
    left = clamp(left, 10, maxLeft);
    top = clamp(top, 10, maxTop);
    this.assistContainer.style.left = `${left}px`;
    this.assistContainer.style.top = `${top}px`;
    this.updateTouchAssistLabel();
  }

  private hideTouchAssist(): void {
    if (this.assistContainer) {
      this.assistContainer.style.display = 'none';
    }
    const labelEl = document.getElementById('touch-assist-label');
    if (labelEl) labelEl.textContent = '';
  }

  private updateTouchAssistLabel(): void {
    const labelEl = document.getElementById('touch-assist-label');
    if (!labelEl) return;
    if (this.state.snapTargetId && this.state.levelData) {
      const anchor = this.state.levelData.anchorPoints.find(a => a.id === this.state.snapTargetId);
      if (anchor && anchor.name) {
        labelEl.textContent = anchor.name;
      } else if (anchor) {
        labelEl.textContent = `吸附目标: ${anchor.frequency.toFixed(1)}Hz`;
      } else {
        labelEl.textContent = '';
      }
    } else {
      labelEl.textContent = '';
    }
  }

  private drawTouchAssist(): void {
    if (!this.touchAssist.enabled || !this.touchAssist.isTouching || !this.assistCtx || !this.touchAssist.canvasTouchPos || !this.state.levelData) {
      return;
    }

    this.showTouchAssist();

    const ctx = this.assistCtx;
    const size = TOUCH_ASSIST_RADIUS * 2;
    const centerX = TOUCH_ASSIST_RADIUS;
    const centerY = TOUCH_ASSIST_RADIUS;
    const mag = TOUCH_ASSIST_MAGNIFICATION;
    const srcCenter = this.touchAssist.canvasTouchPos;

    ctx.clearRect(0, 0, size, size);

    ctx.save();
    ctx.beginPath();
    ctx.arc(centerX, centerY, TOUCH_ASSIST_RADIUS - 2, 0, Math.PI * 2);
    ctx.clip();

    const bgGrad = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, TOUCH_ASSIST_RADIUS);
    bgGrad.addColorStop(0, 'rgba(5, 10, 30, 0.95)');
    bgGrad.addColorStop(1, 'rgba(0, 0, 15, 0.9)');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, size, size);

    const drawBgStars = this.backgroundStars.filter(star => {
      const rotated = rotatePoint(
        { x: star.x, y: star.y },
        { x: 0, y: 0 },
        this.state.rotationOffset * star.z
      );
      const cx = this.canvas.width / (window.devicePixelRatio || 1) / 2 + rotated.x * (0.3 + star.z * 0.8);
      const cy = this.canvas.height / (window.devicePixelRatio || 1) / 2 + rotated.y * (0.3 + star.z * 0.8);
      const d = distance({ x: cx, y: cy }, srcCenter);
      return d < TOUCH_ASSIST_RADIUS / mag * 1.5;
    });

    for (const star of drawBgStars) {
      const rotated = rotatePoint(
        { x: star.x, y: star.y },
        { x: 0, y: 0 },
        this.state.rotationOffset * star.z
      );
      const cw = this.canvas.width / (window.devicePixelRatio || 1);
      const ch = this.canvas.height / (window.devicePixelRatio || 1);
      const px = cw / 2 + rotated.x * (0.3 + star.z * 0.8);
      const py = ch / 2 + rotated.y * (0.3 + star.z * 0.8);
      const tx = centerX + (px - srcCenter.x) * mag;
      const ty = centerY + (py - srcCenter.y) * mag;

      if (tx < 0 || tx > size || ty < 0 || ty > size) continue;

      const twinkle = Math.sin(this.state.time * star.twinkleSpeed + star.twinkleOffset);
      const brightness = star.baseBrightness * (0.6 + 0.4 * twinkle);
      const sSize = star.size * mag * 0.8;

      ctx.beginPath();
      ctx.arc(tx, ty, sSize, 0, Math.PI * 2);
      ctx.fillStyle = `${star.color}${this.alphaToHex(brightness)}`;
      ctx.fill();
    }

    const connectedIds = new Set<string>();
    this.state.connections.filter(c => c.valid).forEach(c => {
      connectedIds.add(c.from);
      connectedIds.add(c.to);
    });

    for (const anchor of this.state.levelData.anchorPoints) {
      const anchorPos = this.renderer.getAnchorScreenPos(anchor, this.state.rotationOffset);
      const d = distance(anchorPos, srcCenter);
      if (d > TOUCH_ASSIST_RADIUS / mag * 1.5) continue;

      const tx = centerX + (anchorPos.x - srcCenter.x) * mag;
      const ty = centerY + (anchorPos.y - srcCenter.y) * mag;

      const twinkle = Math.sin(this.state.time * anchor.frequency * 0.8) * 0.3 + 0.7;
      const brightness = (anchor.baseBrightness ?? 0.7) * twinkle;
      const isAnchor = anchor.id.startsWith('a') || anchor.id.startsWith('b') || anchor.id.startsWith('c');
      const baseColor = isAnchor ? { r: 200, g: 220, b: 255 } : { r: 180, g: 180, b: 200 };
      const isConnected = connectedIds.has(anchor.id);
      const connColor = isConnected ? { r: 255, g: 215, b: 100 } : baseColor;
      const isHighlighted = this.state.snapTargetId === anchor.id;
      const sizeMult = (isHighlighted ? 2.2 : 1.4) * mag;
      const aSize = (anchor.size ?? 3) * sizeMult;

      const glowR = aSize * 6;
      const glow = ctx.createRadialGradient(tx, ty, 0, tx, ty, glowR);
      glow.addColorStop(0, `rgba(${connColor.r}, ${connColor.g}, ${connColor.b}, ${brightness * 0.6})`);
      glow.addColorStop(0.4, `rgba(${connColor.r}, ${connColor.g}, ${connColor.b}, ${brightness * 0.2})`);
      glow.addColorStop(1, `rgba(${connColor.r}, ${connColor.g}, ${connColor.b}, 0)`);
      ctx.beginPath();
      ctx.arc(tx, ty, glowR, 0, Math.PI * 2);
      ctx.fillStyle = glow;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(tx, ty, aSize, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${connColor.r}, ${connColor.g}, ${connColor.b}, ${brightness})`;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(tx, ty, aSize * 0.4, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();

      if (isHighlighted) {
        ctx.beginPath();
        ctx.arc(tx, ty, aSize * 2.5, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255, 255, 255, ${0.6 + Math.sin(this.state.time * 6) * 0.3})`;
        ctx.lineWidth = 2.5;
        ctx.setLineDash([5, 5]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      if (this.state.showFrequencies && isAnchor) {
        ctx.font = `${Math.round(11 * mag)}px monospace`;
        ctx.textAlign = 'center';
        ctx.fillStyle = `rgba(160, 196, 255, ${brightness * 0.95})`;
        ctx.fillText(`${anchor.frequency.toFixed(1)}Hz`, tx, ty - aSize - 8 * mag);
      }
    }

    if (this.state.drawState.isDrawing && this.state.drawState.currentPos && this.state.drawState.startAnchorId) {
      const startAnchor = this.state.levelData.anchorPoints.find(a => a.id === this.state.drawState.startAnchorId);
      if (startAnchor) {
        const startPos = this.renderer.getAnchorScreenPos(startAnchor, this.state.rotationOffset);
        const fullPath: CurvePoint[] = [{ x: startPos.x, y: startPos.y }, ...this.state.drawState.points, this.state.drawState.currentPos];
        const magPath: CurvePoint[] = fullPath.map(p => ({
          x: centerX + (p.x - srcCenter.x) * mag,
          y: centerY + (p.y - srcCenter.y) * mag
        }));
        const clippedPath = magPath.filter(p =>
          Math.hypot(p.x - centerX, p.y - centerY) < TOUCH_ASSIST_RADIUS - 5
        );
        if (clippedPath.length >= 2) {
          const wave = Math.sin(this.state.time * 8) * 0.2 + 0.8;
          this.drawAssistCurve(clippedPath, '#a0c4ff', 2.5 * mag * 0.8, wave);
        }
      }
    }

    ctx.restore();

    ctx.beginPath();
    ctx.arc(centerX, centerY, TOUCH_ASSIST_RADIUS - 2, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(100, 150, 255, 0.6)';
    ctx.lineWidth = 2;
    ctx.stroke();

    const borderGlow = ctx.createRadialGradient(centerX, centerY, TOUCH_ASSIST_RADIUS - 10, centerX, centerY, TOUCH_ASSIST_RADIUS);
    borderGlow.addColorStop(0, 'rgba(100, 150, 255, 0)');
    borderGlow.addColorStop(1, 'rgba(100, 150, 255, 0.3)');
    ctx.beginPath();
    ctx.arc(centerX, centerY, TOUCH_ASSIST_RADIUS, 0, Math.PI * 2);
    ctx.strokeStyle = borderGlow;
    ctx.lineWidth = 4;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(centerX, centerY, 4, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(centerX, centerY, 8, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  private drawAssistCurve(points: CurvePoint[], color: string, lineWidth: number, opacity: number): void {
    if (!this.assistCtx || points.length < 2) return;
    const ctx = this.assistCtx;

    for (let pass = 3; pass >= 1; pass--) {
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      const alpha = opacity * (0.15 / pass);
      ctx.strokeStyle = color + this.alphaToHex(alpha);
      ctx.lineWidth = lineWidth + pass * 4;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.strokeStyle = color + this.alphaToHex(opacity);
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  private alphaToHex(alpha: number): string {
    const clamped = Math.max(0, Math.min(1, alpha));
    const hex = Math.round(clamped * 255).toString(16).padStart(2, '0');
    return hex;
  }

  private handleMouseDown(e: MouseEvent): void {
    if (this.state.isComplete) return;

    const pos = this.getCanvasPos(e);
    const anchor = this.findNearestAnchor(pos);

    if (anchor) {
      this.state.drawState = {
        isDrawing: true,
        startAnchorId: anchor.id,
        currentPos: pos,
        points: [],
        lastSampleTime: performance.now()
      };
    }
  }

  private handleMouseMove(e: MouseEvent): void {
    const pos = this.getCanvasPos(e);

    if (this.state.drawState.isDrawing) {
      const now = performance.now();
      if (now - this.state.drawState.lastSampleTime >= SAMPLE_INTERVAL) {
        this.state.drawState.points.push({ x: pos.x, y: pos.y });
        this.state.drawState.lastSampleTime = now;
      }
      this.state.drawState.currentPos = pos;

      const endAnchor = this.findNearestAnchor(pos);
      this.state.snapTargetId = (endAnchor && endAnchor.id !== this.state.drawState.startAnchorId)
        ? endAnchor.id
        : null;
    } else {
      const anchor = this.findNearestAnchor(pos);
      this.state.snapTargetId = anchor ? anchor.id : null;
    }
  }

  private async handleMouseUp(): Promise<void> {
    if (!this.state.drawState.isDrawing || !this.state.levelData) {
      this.state.drawState = this.createEmptyDrawState();
      return;
    }

    const ds = this.state.drawState;
    const startId = ds.startAnchorId!;
    let endPos = ds.currentPos;

    if (ds.points.length > 0 && endPos) {
      endPos = this.state.snapTargetId
        ? this.renderer.getAnchorScreenPos(
            this.state.levelData.anchorPoints.find(a => a.id === this.state.snapTargetId)!,
            this.state.rotationOffset
          )
        : ds.points[ds.points.length - 1];
    }

    const endAnchor = this.findNearestAnchor(endPos ?? { x: 0, y: 0 });
    const endId = endAnchor?.id;

    if (startId && endId && startId !== endId) {
      const edgeKey = [startId, endId].sort().join('-');
      const alreadyConnected = this.state.completedEdges.has(edgeKey);

      if (!alreadyConnected) {
        const startAnchor = this.state.levelData.anchorPoints.find(a => a.id === startId)!;
        const startPos = this.renderer.getAnchorScreenPos(startAnchor, this.state.rotationOffset);

        let curvePoints: CurvePoint[] = [{ x: startPos.x, y: startPos.y }, ...ds.points];
        if (endPos) curvePoints.push(endPos);

        curvePoints = simplifyPath(curvePoints, 5);
        curvePoints = smoothPath(curvePoints, 0.5);

        const result = await verifyEdge(this.state.currentLevel, startId, endId);

        const connection: Connection = {
          from: startId,
          to: endId,
          curve: curvePoints,
          valid: result.valid,
          opacity: 0,
          glowIntensity: 0
        };

        this.state.connections.push(connection);
        this.animateConnection(connection);

        if (result.valid) {
          this.state.completedEdges.add(edgeKey);
          this.checkCompletion();
        } else {
          setTimeout(() => {
            this.removeConnection(startId, endId);
          }, 1500);
        }
      }
    }

    this.state.drawState = this.createEmptyDrawState();
    this.state.snapTargetId = null;
  }

  private animateConnection(conn: Connection): void {
    const duration = 600;
    const startTime = performance.now();

    const animate = () => {
      const elapsed = performance.now() - startTime;
      const t = clamp(elapsed / duration, 0, 1);
      const eased = 1 - Math.pow(1 - t, 3);

      conn.opacity = eased;
      conn.glowIntensity = eased;

      if (t < 1) {
        requestAnimationFrame(animate);
      }
    };
    animate();
  }

  private removeConnection(from: string, to: string): void {
    const idx = this.state.connections.findIndex(
      c => c.from === from && c.to === to
    );
    if (idx >= 0) {
      const conn = this.state.connections[idx];
      const duration = 400;
      const startOpacity = conn.opacity;
      const startTime = performance.now();

      const fadeOut = () => {
        const elapsed = performance.now() - startTime;
        const t = clamp(elapsed / duration, 0, 1);
        conn.opacity = startOpacity * (1 - t);

        if (t < 1) {
          requestAnimationFrame(fadeOut);
        } else {
          this.state.connections.splice(idx, 1);
        }
      };
      fadeOut();
    }
  }

  private checkCompletion(): void {
    if (!this.state.levelData) return;

    const total = this.state.levelData.edges.length;
    const current = this.state.completedEdges.size;

    this.onProgressChange?.(current, total);

    if (current >= total && !this.state.isComplete) {
      this.state.isComplete = true;
      if (this.completionTimeoutId) {
        clearTimeout(this.completionTimeoutId);
      }
      this.completionTimeoutId = setTimeout(() => {
        this.onComplete?.(this.state.levelData!.creatureDescription);
        this.completionTimeoutId = null;
      }, 1500);
    }
  }

  undoLastConnection(): void {
    if (this.state.connections.length === 0 || this.state.isComplete) return;

    const idx = this.state.connections.length - 1;
    const conn = this.state.connections[idx];

    if (conn.valid) {
      const edgeKey = [conn.from, conn.to].sort().join('-');
      this.state.completedEdges.delete(edgeKey);
      this.onProgressChange?.(this.state.completedEdges.size, this.state.levelData?.edges.length ?? 0);
    }

    const duration = 300;
    const startOpacity = conn.opacity;
    const startTime = performance.now();

    const fadeOut = () => {
      const elapsed = performance.now() - startTime;
      const t = clamp(elapsed / duration, 0, 1);
      conn.opacity = startOpacity * (1 - t);

      if (t < 1) {
        requestAnimationFrame(fadeOut);
      } else {
        this.state.connections.splice(idx, 1);
      }
    };
    fadeOut();
  }

  resetLevel(): void {
    if (this.completionTimeoutId) {
      clearTimeout(this.completionTimeoutId);
      this.completionTimeoutId = null;
    }

    this.state.connections = [];
    this.state.completedEdges = new Set();
    this.state.isComplete = false;
    this.state.drawState = this.createEmptyDrawState();
    this.state.snapTargetId = null;
    this.onProgressChange?.(0, this.state.levelData?.edges.length ?? 0);
  }

  toggleFrequencies(): boolean {
    this.state.showFrequencies = !this.state.showFrequencies;
    return this.state.showFrequencies;
  }

  async loadLevel(levelId: number): Promise<boolean> {
    if (this.completionTimeoutId) {
      clearTimeout(this.completionTimeoutId);
      this.completionTimeoutId = null;
    }

    const data = await getLevel(levelId);
    if (!data) return false;

    this.state.currentLevel = levelId;
    this.state.levelData = data;
    this.state.connections = [];
    this.state.completedEdges = new Set();
    this.state.isComplete = false;
    this.state.rotationOffset = 0;
    this.state.drawState = this.createEmptyDrawState();
    this.state.snapTargetId = null;
    this.state.showFrequencies = false;

    this.onLevelChange?.(data);
    this.onProgressChange?.(0, data.edges.length);

    return true;
  }

  getCurrentLevel(): number {
    return this.state.currentLevel;
  }

  start(): void {
    this.lastTime = performance.now();
    this.loop();
  }

  stop(): void {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }
  }

  private loop(): void {
    const now = performance.now();
    const delta = (now - this.lastTime) / 1000;
    this.lastTime = now;

    try {
      this.update(delta);
      this.render();
    } catch (err) {
      console.error('Game loop error:', err);
    }

    this.animationFrameId = requestAnimationFrame(() => this.loop());
  }

  private update(delta: number): void {
    this.state.time += delta;

    if (this.state.levelData) {
      this.state.rotationOffset += this.state.levelData.rotationSpeed * delta * 60;
    }

    this.state.connections.forEach(c => {
      c.opacity = Math.min(c.opacity, 1);
    });
  }

  private render(): void {
    this.renderer.beginFrame();

    if (this.state.levelData) {
      this.renderer.drawBackgroundStars(
        this.backgroundStars,
        this.state.rotationOffset,
        this.state.time
      );

      this.renderer.drawLightPollution(this.state.time, this.state.levelData.lightPollution);

      this.renderer.drawCreatureOutline(
        this.state.levelData.anchorPoints,
        this.state.levelData.edges,
        this.state.connections,
        this.state.rotationOffset,
        this.getProgress()
      );

      this.renderer.drawConnections(this.state.connections, this.state.time);

      if (this.state.drawState.isDrawing && this.state.drawState.startAnchorId) {
        const startAnchor = this.state.levelData.anchorPoints.find(
          a => a.id === this.state.drawState.startAnchorId
        );
        if (startAnchor && this.state.drawState.currentPos) {
          this.renderer.drawCurrentPath(
            this.state.drawState.points,
            startAnchor,
            this.state.drawState.currentPos,
            this.state.time,
            this.state.rotationOffset
          );
        }
      }

      const connectedIds = new Set<string>();
      this.state.connections.filter(c => c.valid).forEach(c => {
        connectedIds.add(c.from);
        connectedIds.add(c.to);
      });

      this.renderer.drawAnchorPoints(
        this.state.levelData.anchorPoints,
        this.state.rotationOffset,
        this.state.time,
        this.state.showFrequencies,
        this.state.snapTargetId ?? this.state.drawState.startAnchorId,
        connectedIds
      );

      this.renderer.drawCompletionEffect(this.state.time, this.getProgress());
    }

    this.drawTouchAssist();
  }

  private getProgress(): number {
    if (!this.state.levelData) return 0;
    const total = this.state.levelData.edges.length;
    if (total === 0) return 0;
    return this.state.completedEdges.size / total;
  }

  destroy(): void {
    this.stop();
    if (this.completionTimeoutId) {
      clearTimeout(this.completionTimeoutId);
      this.completionTimeoutId = null;
    }
    this.listeners.forEach(fn => fn());
  }
}
