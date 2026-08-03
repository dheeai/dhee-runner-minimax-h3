/**
 * Thin ffmpeg/ffprobe helpers. The only pixel/PCM work this runner does is the
 * head/tail pad (held frame + silence) around a rendered H3 clip — everything
 * else happens inside the ComfyUI graph.
 */
import { spawn } from 'node:child_process';

const FFMPEG = process.env['DHEE_FFMPEG'] || 'ffmpeg';
const FFPROBE = process.env['DHEE_FFPROBE'] || 'ffprobe';

export function ff(args: string[], signal?: AbortSignal): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((done) => {
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'], signal });
    let se = '';
    p.stderr?.on('data', (d) => { se += d.toString(); });
    p.on('close', (c) => done({ ok: c === 0, stderr: se }));
    p.on('error', (e) => done({ ok: false, stderr: `spawn failed: ${e.message}` }));
  });
}

/** Pixel dimensions of an image/video via ffprobe, or null when unreadable. */
export function probeSize(path: string, signal?: AbortSignal): Promise<{ w: number; h: number } | null> {
  return new Promise((done) => {
    const p = spawn(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', path], { stdio: ['ignore', 'pipe', 'ignore'], signal });
    let so = '';
    p.stdout?.on('data', (d) => { so += d.toString(); });
    p.on('close', () => {
      const m = /^(\d+)x(\d+)/.exec(so.trim());
      done(m ? { w: Number(m[1]), h: Number(m[2]) } : null);
    });
    p.on('error', () => done(null));
  });
}

/** Media duration (seconds) via ffprobe, or null when unreadable. */
export function probeDuration(path: string, signal?: AbortSignal): Promise<number | null> {
  return new Promise((done) => {
    const p = spawn(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nk=1:nw=1', path], { stdio: ['ignore', 'pipe', 'ignore'], signal });
    let so = '';
    p.stdout?.on('data', (d) => { so += d.toString(); });
    p.on('close', () => { const n = parseFloat(so.trim()); done(Number.isFinite(n) && n > 0 ? n : null); });
    p.on('error', () => done(null));
  });
}
