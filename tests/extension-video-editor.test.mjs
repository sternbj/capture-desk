import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeVideoEdit } from '../chrome-extension/video-editor.js';

test('video edits reject reversed or empty trims before recording an export', () => {
  assert.throws(() => normalizeVideoEdit({ start: 3, end: 2 }, 4), /Ausschnitt/);
  assert.throws(() => normalizeVideoEdit({ start: 1, end: 1.01 }, 4), /Ausschnitt/);
  assert.throws(() => normalizeVideoEdit({ start: 0, end: 2 }, Infinity), /Videodauer/);
});
test('caption and privacy intervals stay inside the trimmed output timeline', () => {
  const edit = normalizeVideoEdit({ start: .5, end: 2.5, caption: { text: 'Caption', start: -.5, end: 10 }, shapes: [{ type: 'redact', start: .3, end: 10, x: -2, y: 105, width: 130, height: 20 }] }, 4);
  assert.equal(edit.duration, 2); assert.equal(edit.caption.start, 0); assert.equal(edit.caption.end, 2);
  assert.equal(edit.shapes[0].start, .3); assert.equal(edit.shapes[0].end, 2); assert.equal(edit.shapes[0].x, 0); assert.equal(edit.shapes[0].y, 99); assert.equal(edit.shapes[0].width, 100);
  assert.throws(() => normalizeVideoEdit({ start: 0, end: 2, shapes: [{ type: 'redact', start: 1.9, end: .2 }] }, 4), /Endzeit/);
});
