import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const apiPath = resolve(__dirname, '..', '..', 'chat5-compat', 'tts_engine', 'selina_tts_api.py');

function readMinimumDuration(expectedDuration: number, expectedChars: number) {
  const script = String.raw`
import ast, json, sys

source_path = sys.argv[1]
tree = ast.parse(open(source_path, 'r', encoding='utf-8').read(), filename=source_path)
function_node = next(
    (node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'minimum_acceptable_duration'),
    None,
)
if function_node is None:
    print(json.dumps({'found': False, 'value': None}))
else:
    namespace = {}
    ast.fix_missing_locations(function_node)
    exec(compile(ast.Module(body=[function_node], type_ignores=[]), source_path, 'exec'), namespace)
    value = namespace['minimum_acceptable_duration'](float(sys.argv[2]), int(sys.argv[3]))
    print(json.dumps({'found': True, 'value': value}))
`;
  const result = spawnSync('python', [
    '-c',
    script,
    apiPath,
    String(expectedDuration),
    String(expectedChars),
  ], { encoding: 'utf8', windowsHide: true });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim()) as { found: boolean; value: number | null };
}

function readQualityRetryFallback(reason: string, sampleCount: number, sampleRate: number) {
  const script = String.raw`
import ast, json, sys

source_path = sys.argv[1]
tree = ast.parse(open(source_path, 'r', encoding='utf-8').read(), filename=source_path)
function_node = next(
    (node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'should_keep_quality_retry_audio'),
    None,
)
if function_node is None:
    print(json.dumps({'found': False, 'value': None}))
else:
    namespace = {}
    ast.fix_missing_locations(function_node)
    exec(compile(ast.Module(body=[function_node], type_ignores=[]), source_path, 'exec'), namespace)
    value = namespace['should_keep_quality_retry_audio'](sys.argv[2], int(sys.argv[3]), int(sys.argv[4]))
    print(json.dumps({'found': True, 'value': value}))
`;
  const result = spawnSync('python', [
    '-c',
    script,
    apiPath.replace('selina_tts_api.py', 'selina_tts_engine.py'),
    reason,
    String(sampleCount),
    String(sampleRate),
  ], { encoding: 'utf8', windowsHide: true });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim()) as { found: boolean; value: boolean | null };
}

describe('TTS duration quality policy', () => {
  test('does not reject a valid 0.54 second two-character reply', () => {
    const result = readMinimumDuration(1, 2);

    expect(result.found).toBe(true);
    expect(result.value).toBeLessThanOrEqual(0.54);
  });

  test('keeps the 60 percent completeness gate for longer replies', () => {
    const result = readMinimumDuration(4, 8);

    expect(result.found).toBe(true);
    expect(result.value).toBeCloseTo(2.4, 6);
  });

  test('keeps a non-silent short segment after the final retry instead of dropping a sentence', () => {
    const result = readQualityRetryFallback('提前终止(0.81s)', 25800, 32000);

    expect(result.found).toBe(true);
    expect(result.value).toBe(true);
  });

  test('still rejects empty, silent, and white-noise retry output', () => {
    expect(readQualityRetryFallback('空音频', 0, 32000).value).toBe(false);
    expect(readQualityRetryFallback('全静音(RMS=0.001)', 25800, 32000).value).toBe(false);
    expect(readQualityRetryFallback('白噪音(高频比=0.81)', 25800, 32000).value).toBe(false);
  });
});
