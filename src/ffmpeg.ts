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
