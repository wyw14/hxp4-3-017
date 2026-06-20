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
  clamp
} from './utils';

const SNAP_DISTANCE = 35;
const SAMPLE_INTERVAL = 16;

export class Game {
  private canvas: HTMLCanvasElement;
  private renderer: Renderer;
  private state: GameState;
  private backgroundStars: BackgroundStar[] = [];
  private lastTime: number = 0;
  private animationFrameId: number = 0;
  private listeners: Array<() => void> = [];
  private completionTimeoutId: ReturnType<typeof setTimeout> | null = null;

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

    this.resize();
    this.bindEvents();
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
    this.renderer.resize(w, h);
    this.backgroundStars = generateBackgroundStars(400, w, h);
  }

  private bindEvents(): void {
    window.addEventListener('resize', () => this.resize());

    this.canvas.addEventListener('mousedown', (e) => this.handleMouseDown(e));
    this.canvas.addEventListener('mousemove', (e) => this.handleMouseMove(e));
    this.canvas.addEventListener('mouseup', () => this.handleMouseUp());
    this.canvas.addEventListener('mouseleave', () => this.handleMouseUp());

    this.canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const t = e.touches[0];
      this.handleMouseDown({ clientX: t.clientX, clientY: t.clientY } as MouseEvent);
    });
    this.canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      const t = e.touches[0];
      this.handleMouseMove({ clientX: t.clientX, clientY: t.clientY } as MouseEvent);
    });
    this.canvas.addEventListener('touchend', (e) => {
      e.preventDefault();
      this.handleMouseUp();
    });
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

    for (const anchor of this.state.levelData.anchorPoints) {
      const anchorPos = this.renderer.getAnchorScreenPos(anchor, this.state.rotationOffset);
      const d = distance(pos, anchorPos);

      if (d < SNAP_DISTANCE && d < nearestDist) {
        const isValidAnchor = anchor.id.startsWith('a') || anchor.id.startsWith('b') || anchor.id.startsWith('c');
        if (isValidAnchor) {
          nearest = anchor;
          nearestDist = d;
        }
      }
    }

    return nearest;
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
