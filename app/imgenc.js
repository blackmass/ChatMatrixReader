// Pixels of the screen (what the exe gives: BGRA, top row first) as a picture file for a plugin: PNG (nothing lost) or JPEG, made `scale` times as large when asked (the smoothing of the page makes it smooth:
// small letters are easier to read larger). Needs a canvas, so it is for the pages of the program (the hub), not for the core.
export function encodeBGRA(pic, { scale = 1, format = 'png' } = {}) {
  const { px, width: w, height: h } = pic;
  const src = new ImageData(w, h), d = src.data;
  for (let i = 0, n = w * h * 4; i < n; i += 4) { d[i] = px[i + 2]; d[i + 1] = px[i + 1]; d[i + 2] = px[i]; d[i + 3] = 255; }          // (B G R A -> R G B, whole)
  const a = document.createElement('canvas'); a.width = w; a.height = h; a.getContext('2d').putImageData(src, 0, 0);
  let out = a;
  if (scale > 1) {
    out = document.createElement('canvas'); out.width = w * scale; out.height = h * scale;
    const g = out.getContext('2d'); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; g.drawImage(a, 0, 0, out.width, out.height);
  }
  const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
  const url = out.toDataURL(mime, 0.92);
  return { width: out.width, height: out.height, mime, base64: url.slice(url.indexOf(',') + 1) };
}
