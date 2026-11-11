import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mimeOf } from '../../src/renderer/live-stream';
import { FFMPEG, makeFixtures } from '../fixtures';

const fragmented = (name: string, audio: boolean) => new Uint8Array(execFileSync(FFMPEG, [
  '-v', 'error', '-i', join(makeFixtures([name]), name), '-map', '0:v:0', ...(audio ? ['-map', '0:a:0'] : []),
  '-c:v', 'copy', '-c:a', 'aac', '-movflags', 'empty_moov+default_base_moof', '-f', 'mp4', '-',
], { maxBuffer: 1 << 26 }));

describe('mimeOf', () => {
  it('lit profil et niveau H.264 et la présence du son', () => {
    expect(mimeOf(fragmented('cam.mts', true))).toMatch(/^video\/mp4; codecs="avc1\.[0-9a-f]{6},mp4a\.40\.2"$/);
    expect(mimeOf(fragmented('clip.mp4', false))).toMatch(/^video\/mp4; codecs="avc1\.[0-9a-f]{6}"$/);
  });

  it('attend que « moov » soit complet', () => {
    const bytes = fragmented('cam.mts', true);
    expect(mimeOf(bytes.subarray(0, 40))).toBeNull();
  });

  it('ignore ce qui n’est pas un MP4', () => {
    expect(mimeOf(new Uint8Array(readFileSync(join(makeFixtures(['b.png']), 'b.png'))))).toBeNull();
  });
});
