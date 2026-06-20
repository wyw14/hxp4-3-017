export interface AnchorPoint {
  id: string;
  x: number;
  y: number;
  frequency: number;
  name?: string;
  baseBrightness?: number;
  size?: number;
}

export interface ConstellationEdge {
  from: string;
  to: string;
  frequencyRatio: [number, number];
}

export interface LevelData {
  id: number;
  name: string;
  creatureName: string;
  creatureDescription: string;
  anchorPoints: AnchorPoint[];
  edges: ConstellationEdge[];
  lightPollution: {
    baseIntensity: number;
    variability: number;
    speed: number;
  };
  rotationSpeed: number;
}

export interface LevelsData {
  levels: LevelData[];
}
