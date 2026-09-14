import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { parseVmd } from '@yohawing/three-mmd-loader/parser';

const projectRoot = resolve(import.meta.dirname, '../..');
const scriptPath = resolve(projectRoot, 'scripts/trim-vmd-leading-frames.mjs');

function fixedName(name: string, length: number): Uint8Array {
  const result = new Uint8Array(length);
  result.set(new TextEncoder().encode(name).slice(0, length));
  return result;
}

function writeU32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function boneFrame(name: string, frame: number, translationX: number): Uint8Array {
  const bytes = new Uint8Array(111);
  bytes.set(fixedName(name, 15), 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(15, frame, true);
  view.setFloat32(19, translationX, true);
  view.setFloat32(46, 1, true);
  return bytes;
}

function morphFrame(name: string, frame: number, weight: number): Uint8Array {
  const bytes = new Uint8Array(23);
  bytes.set(fixedName(name, 15), 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(15, frame, true);
  view.setFloat32(19, weight, true);
  return bytes;
}

function buildVmd(): Uint8Array {
  const header = new Uint8Array(50);
  header.set(fixedName('Vocaloid Motion Data 0002', 30), 0);
  const bones = [
    boneFrame('Moving', 0, 1),
    boneFrame('Moving', 15, 2),
    boneFrame('Moving', 25, 3),
    boneFrame('Static', 0, 4)
  ];
  const morphs = [
    morphFrame('Face', 0, 0.1),
    morphFrame('Face', 15, 0.8),
    morphFrame('Face', 25, 0.4)
  ];
  const parts: Uint8Array[] = [header, writeU32(bones.length), ...bones, writeU32(morphs.length), ...morphs];
  for (let index = 0; index < 5; index += 1) parts.push(writeU32(0));
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

describe('trim-vmd-leading-frames script', () => {
  it('shifts the authored pose to frame zero while preserving static tracks', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'chatx2-vmd-trim-'));
    const input = resolve(directory, 'input.vmd');
    const output = resolve(directory, 'output.vmd');
    writeFileSync(input, buildVmd());

    execFileSync(process.execPath, [scriptPath, input, output, '15'], { cwd: projectRoot });

    const bytes = readFileSync(output);
    const parsed = parseVmd(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    expect(Array.from(parsed.boneTracks.Moving.frames)).toEqual([0, 10]);
    expect(Array.from(parsed.boneTracks.Moving.translations).filter((_, index) => index % 3 === 0))
      .toEqual([2, 3]);
    expect(Array.from(parsed.boneTracks.Static.frames)).toEqual([0]);
    expect(parsed.boneTracks.Static.translations[0]).toBeCloseTo(4, 5);
    expect(Array.from(parsed.morphTracks.Face.frames)).toEqual([0, 10]);
    expect(parsed.morphTracks.Face.weights[0]).toBeCloseTo(0.8, 5);
    expect(parsed.morphTracks.Face.weights[1]).toBeCloseTo(0.4, 5);
    expect(parsed.metadata.maxFrame).toBe(10);
  });
});
