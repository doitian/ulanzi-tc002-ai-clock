import assert from 'node:assert/strict';
import test from 'node:test';
import { MATRIX_H, MATRIX_W, renderScene } from '../src/scene.ts';

const palette = ['#000000', '#ffb92f', '#22bbdd'];

function scene(base, frames = [[]]) {
  return { palette, base, frames, delayMs: 400 };
}

const wideScene = scene([
  { kind: 'rect', x: 0, y: 14, w: 52, h: 2, color: 2 },
  { kind: 'ellipse', x: 16, y: 2, w: 19, h: 12, color: 1 },
  { kind: 'ellipse', x: 2, y: 5, w: 9, h: 8, color: 2 },
  { kind: 'sprite', x: 43, y: 3, rows: ['01110', '12221', '01110'] },
]);

test('fills a 52x16 frame with shaped pixel art', () => {
  const art = renderScene(wideScene);
  assert.equal(art.frames.length, 1);
  assert.equal(art.frames[0].length, MATRIX_W * MATRIX_H);
  assert.equal(art.frames[0][14 * MATRIX_W], 2);
  assert.equal(art.frames[0][6 * MATRIX_W + 22], 1);
  assert.equal(art.frames[0][3 * MATRIX_W + 44], 1);
});

test('event time is readable-color and identical across animated frames', () => {
  const event = scene([
    { kind: 'rect', x: 0, y: 15, w: 31, h: 1, color: 2 },
    { kind: 'ellipse', x: 7, y: 1, w: 17, h: 13, color: 1 },
    { kind: 'rect', x: 0, y: 3, w: 5, h: 8, color: 2 },
  ], [[], [{ kind: 'rect', x: 10, y: 5, w: 3, h: 3, color: 2 }]]);
  const art = renderScene(event, '07:25');
  assert.equal(art.frames.length, 2);
  assert.equal(art.palette.at(-1), '#ffffff');
  const rightSide = (frame) => Array.from(frame).filter((_, i) => i % MATRIX_W >= 31);
  assert.deepEqual(rightSide(art.frames[0]), rightSide(art.frames[1]));
  assert.ok(rightSide(art.frames[0]).filter(Boolean).length > 35);
  assert.notDeepEqual(art.frames[0], art.frames[1]);
});

test('ignores a model-drawn fullscreen background and accepts type as a shape alias', () => {
  const art = renderScene(scene([
    { type: 'rect', x: 0, y: 0, w: 52, h: 16, color: 1 },
    ...wideScene.base,
  ]));
  assert.equal(art.frames[0][0], 0);
  assert.equal(art.frames[0][14 * MATRIX_W], 2);
});

test('rejects tiny or blank compositions rather than silently padding with black', () => {
  assert.throws(() => renderScene(scene([{ kind: 'rect', x: 23, y: 7, w: 3, h: 2, color: 1 }])), /underused canvas/);
});

test('rejects malformed sprite rows', () => {
  assert.throws(() => renderScene(scene([
    ...wideScene.base,
    { kind: 'sprite', x: 2, y: 2, rows: ['1100', '11'] },
  ])), /sprite.rows/);
});
