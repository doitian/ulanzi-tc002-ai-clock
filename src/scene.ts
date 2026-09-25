export const MATRIX_W = 52;
export const MATRIX_H = 16;

export interface RenderedScene {
  palette: string[];
  frames: Uint8Array[];
  delayMs: number;
}

type Shape = Record<string, unknown>;

const DIGITS: Record<string, string[]> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  ':': ['0', '1', '0', '1', '0'],
};

function integer(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function put(pixels: Uint8Array, x: number, y: number, color: number, maxX: number): void {
  if (x >= 0 && x < maxX && y >= 0 && y < MATRIX_H) pixels[y * MATRIX_W + x] = color;
}

function drawShape(pixels: Uint8Array, shape: Shape, paletteSize: number, maxX: number): void {
  const kind = shape.kind ?? shape.type;
  if (kind === 'rect' && shape.fill !== false && shape.x === 0 && shape.y === 0 &&
    shape.w === maxX && shape.h === MATRIX_H) return;
  if (kind === 'sprite') {
    const x = integer(shape.x, 'sprite.x', -52, 51);
    const y = integer(shape.y, 'sprite.y', -16, 15);
    const rows = shape.rows;
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 16 ||
      !rows.every((row) => typeof row === 'string' && /^[0-9a-f]+$/i.test(row) && row.length === rows[0].length) ||
      rows[0].length > 52) {
      throw new Error('sprite.rows must be 1–16 equal-length hex-index strings (at most 52 pixels wide)');
    }
    for (let dy = 0; dy < rows.length; dy++) {
      for (let dx = 0; dx < rows[dy].length; dx++) {
        const color = parseInt(rows[dy][dx], 16);
        if (color >= paletteSize) throw new Error('sprite uses a palette index that does not exist');
        if (color !== 0) put(pixels, x + dx, y + dy, color, maxX);
      }
    }
    return;
  }

  if (kind !== 'rect' && kind !== 'ellipse' && kind !== 'line') {
    throw new Error(`unknown shape kind: ${String(kind)}`);
  }
  const color = integer(shape.color, 'shape.color', 0, paletteSize - 1);
  const x = integer(shape.x, 'shape.x', -52, 51);
  const y = integer(shape.y, 'shape.y', -16, 15);
  if (kind === 'line') {
    const x2 = integer(shape.x2, 'line.x2', -52, 103);
    const y2 = integer(shape.y2, 'line.y2', -16, 31);
    let dx = Math.abs(x2 - x);
    let dy = -Math.abs(y2 - y);
    const sx = x < x2 ? 1 : -1;
    const sy = y < y2 ? 1 : -1;
    let err = dx + dy;
    let px = x;
    let py = y;
    for (;;) {
      put(pixels, px, py, color, maxX);
      if (px === x2 && py === y2) break;
      const e = 2 * err;
      if (e >= dy) { err += dy; px += sx; }
      if (e <= dx) { err += dx; py += sy; }
    }
    return;
  }

  const w = integer(shape.w, `${kind}.w`, 1, 52);
  const h = integer(shape.h, `${kind}.h`, 1, 16);
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      if (kind === 'rect') {
        if (shape.fill === false && dx !== 0 && dx !== w - 1 && dy !== 0 && dy !== h - 1) continue;
      } else {
        const nx = (2 * dx + 1 - w) / w;
        const ny = (2 * dy + 1 - h) / h;
        if (nx * nx + ny * ny > 1) continue;
        if (shape.fill === false) {
          const ix = (2 * dx + 1 - w) / Math.max(w - 2, 1);
          const iy = (2 * dy + 1 - h) / Math.max(h - 2, 1);
          if (ix * ix + iy * iy < 1) continue;
        }
      }
      put(pixels, x + dx, y + dy, color, maxX);
    }
  }
}

function drawShapes(pixels: Uint8Array, shapes: unknown, paletteSize: number, maxX: number, limit: number): void {
  if (!Array.isArray(shapes) || shapes.length > limit) throw new Error(`expected at most ${limit} shapes`);
  for (const shape of shapes) {
    if (!shape || typeof shape !== 'object' || Array.isArray(shape)) throw new Error('invalid shape');
    drawShape(pixels, shape as Shape, paletteSize, maxX);
  }
}

function checkCoverage(pixels: Uint8Array, isEvent: boolean): void {
  let count = 0;
  let minX = MATRIX_W;
  let maxX = -1;
  let minY = MATRIX_H;
  let maxY = -1;
  const segments = [0, 0, 0];
  const width = isEvent ? 31 : MATRIX_W;
  for (let y = 0; y < MATRIX_H; y++) {
    for (let x = 0; x < width; x++) {
      if (!pixels[y * MATRIX_W + x]) continue;
      count++;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      segments[Math.min(2, Math.floor(x * 3 / width))]++;
    }
  }
  const needed = isEvent ? 35 : 75;
  const maximum = isEvent ? 260 : 420;
  const span = isEvent ? 23 : 40;
  if (count < needed || count > maximum || maxX - minX + 1 < span ||
    maxY - minY + 1 < 9 || segments.some((n) => n < (isEvent ? 5 : 8))) {
    const problem = count > maximum ? 'too many LEDs lit' : 'underused canvas';
    throw new Error(`${problem}: ${count} lit pixels, ${Math.max(0, maxX - minX + 1)}-pixel horizontal span, ${Math.max(0, maxY - minY + 1)}-pixel height, sections ${segments.join('/')}. Use bold shapes and details across the ${width}x16 drawing area (${needed}–${maximum} lit pixels and at least ${span} columns wide).`);
  }
}

function addTime(pixels: Uint8Array, time: string, color: number): void {
  let x = 34;
  for (const char of time) {
    const glyph = DIGITS[char];
    for (let dy = 0; dy < glyph.length; dy++) {
      for (let dx = 0; dx < glyph[dy].length; dx++) {
        if (glyph[dy][dx] === '1') put(pixels, x + dx, 5 + dy, color, MATRIX_W);
      }
    }
    x += glyph[0].length + 1;
  }
  for (let y = 3; y <= 11; y++) put(pixels, 31, y, color, MATRIX_W);
}

export function renderScene(raw: unknown, timeLabel?: string): RenderedScene {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('scene must be a JSON object');
  const scene = raw as Record<string, unknown>;
  if (!Array.isArray(scene.palette) || scene.palette.length < 2 || scene.palette.length > 16 ||
    !scene.palette.every((c) => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c))) {
    throw new Error('palette must contain 2–16 #RRGGBB colors');
  }
  const palette = (scene.palette as string[]).map((c) => c.toLowerCase());
  palette[0] = '#000000';
  if (!palette.slice(1).some((c) => Math.max(...[1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16))) >= 140)) {
    throw new Error('palette needs a bright foreground color');
  }
  if (!Array.isArray(scene.base) || scene.base.length === 0) throw new Error('base must contain shapes');
  const event = !!timeLabel;
  if (event && !/^\d{2}:\d{2}$/.test(timeLabel)) throw new Error('event time must be HH:MM');
  const maxX = event ? 31 : MATRIX_W;
  const base = new Uint8Array(MATRIX_W * MATRIX_H);
  drawShapes(base, scene.base, palette.length, maxX, 60);

  const overlays = scene.frames === undefined ? [[]] : scene.frames;
  if (!Array.isArray(overlays) || overlays.length < 1 || overlays.length > 6) {
    throw new Error('frames must contain 1–6 arrays of animated overlay shapes');
  }
  const frames = overlays.map((shapes) => {
    const frame = base.slice();
    drawShapes(frame, shapes, palette.length, maxX, 30);
    checkCoverage(frame, event);
    return frame;
  });
  if (event) {
    let color: number;
    if (palette.length < 16) {
      palette.push('#ffffff');
      color = palette.length - 1;
    } else {
      const brightness = (hex: string) =>
        0.2126 * parseInt(hex.slice(1, 3), 16) +
        0.7152 * parseInt(hex.slice(3, 5), 16) +
        0.0722 * parseInt(hex.slice(5, 7), 16);
      color = palette.reduce((best, c, i) => i && brightness(c) > brightness(palette[best]) ? i : best, 1);
    }
    for (const frame of frames) addTime(frame, timeLabel!, color);
  }
  const delayMs = typeof scene.delayMs === 'number' && Number.isFinite(scene.delayMs)
    ? Math.min(1000, Math.max(100, Math.round(scene.delayMs))) : 400;
  return { palette, frames, delayMs };
}
