// Rough count of the characters sent to the official Google Cloud Translation API, per calendar month. An estimate only (other
// programs / other PCs using the same key are not counted; Google's month boundary may differ by a few hours).
// Stored in usage.json in the program folder. Port of usage.py.
import { log } from './log.js';

export const FREE_LIMIT = 500_000;       // characters per month that Google lists as free (check the pricing page)
export const STEP = 100_000;             // tell the user every time the total passes a multiple of this
const PATH = 'usage.json';

export const currentMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };

export class Usage {
  constructor(files, { month = currentMonth } = {}) { this.files = files; this.month = month; this.state = null; }

  async load() {
    if (!this.state) {
      try {
        const d = JSON.parse(await this.files.read(PATH));
        this.state = { month: String(d.month ?? ''), chars: parseInt(d.chars ?? 0, 10) || 0, notified: parseInt(d.notified ?? 0, 10) || 0 };
      } catch { this.state = { month: this.month(), chars: 0, notified: 0 }; }
    }
    if (this.state.month !== this.month()) this.state = { month: this.month(), chars: 0, notified: 0 };      // a new month starts again
    return this.state;
  }

  async total() { return (await this.load()).chars; }

  // count n more characters; returns the new total if it passed a multiple of STEP since the last notice, else null
  async add(n) {
    const st = await this.load();
    st.chars += Math.max(0, Math.trunc(n));
    const level = Math.floor(st.chars / STEP);
    let hit = null;
    if (level > st.notified) { st.notified = level; hit = st.chars; }
    try { await this.files.write(PATH, JSON.stringify(st)); } catch (e) { log.warn(`사용량 저장 실패: ${e?.message || e}`); }
    return hit;
  }
}
