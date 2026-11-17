// Pictures are plain objects { px: Uint8Array (BGRA, row after row), width, height } - what the exe's capture command gives.

export function sub(img, x, y, w, h) {
  x = Math.max(0, x); y = Math.max(0, y);
  w = Math.max(0, Math.min(w, img.width - x)); h = Math.max(0, Math.min(h, img.height - y));
  const px = new Uint8Array(w * h * 4);
  for (let r = 0; r < h; r++) {
    const s = ((y + r) * img.width + x) * 4;
    px.set(img.px.subarray(s, s + w * 4), r * w * 4);
  }
  return { px, width: w, height: h };
}

export function transpose(img) {
  const { width: w, height: h } = img;
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = (y * w + x) * 4, d = (x * h + y) * 4;
    px[d] = img.px[s]; px[d + 1] = img.px[s + 1]; px[d + 2] = img.px[s + 2]; px[d + 3] = img.px[s + 3];
  }
  return { px, width: h, height: w };
}

// R, G, B of one pixel
export function rgb(img, x, y) {
  const i = (y * img.width + x) * 4;
  return [img.px[i + 2], img.px[i + 1], img.px[i]];
}
