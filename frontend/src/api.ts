import type { LevelData, VerifyResult } from './types';

const API_BASE = '/api';

export async function getLevelList(): Promise<{ id: number; name: string; creatureName: string }[]> {
  try {
    const res = await fetch(`${API_BASE}/levels`);
    const data = await res.json();
    if (data.success) {
      return data.levels;
    }
    return [];
  } catch {
    return [];
  }
}

export async function getLevel(id: number): Promise<LevelData | null> {
  try {
    const res = await fetch(`${API_BASE}/levels/${id}`);
    const data = await res.json();
    if (data.success) {
      return data.level as LevelData;
    }
    return null;
  } catch {
    return null;
  }
}

export async function verifyEdge(levelId: number, from: string, to: string): Promise<VerifyResult> {
  try {
    const res = await fetch(`${API_BASE}/levels/${levelId}/verify?edge=${from}-${to}`);
    return await res.json() as VerifyResult;
  } catch {
    return {
      success: false,
      valid: false,
      isHarmonic: false,
      isDefinedEdge: false
    };
  }
}

export async function healthCheck(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/health`);
    const data = await res.json();
    return data.success && data.status === 'running';
  } catch {
    return false;
  }
}
