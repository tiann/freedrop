// Minimal QR code encoder for the share link (ISO/IEC 18004): byte mode,
// error correction level M, versions 1–10 — up to 213 bytes, a freedrop
// link needs ~70. Zero deps, like signal.mjs; the CLI keeps using
// qrcode-terminal, which test/qr.test.mjs checks this against.

// level M: [EC codewords per block, [blocks, data codewords per block]…]
const BLOCKS = [
    null,
    [10, [1, 16]],
    [16, [1, 28]],
    [26, [1, 44]],
    [18, [2, 32]],
    [24, [2, 43]],
    [16, [4, 27]],
    [18, [4, 31]],
    [22, [2, 38], [2, 39]],
    [22, [3, 36], [2, 37]],
    [26, [4, 43], [1, 44]],
];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
export const MAX_VERSION = BLOCKS.length - 1;

// GF(256) over x^8 + x^4 + x^3 + x^2 + 1, for the Reed-Solomon codewords
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x = (x << 1) ^ (x & 0x80 ? 0x11d : 0);
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

const rsRemainder = (data, n) => {
    let g = [1]; // generator ∏(x + α^i), highest degree first
    for (let i = 0; i < n; i++) {
        const next = new Array(g.length + 1).fill(0);
        for (let j = 0; j < g.length; j++) {
            next[j] ^= g[j];
            next[j + 1] ^= mul(g[j], EXP[i]);
        }
        g = next;
    }
    const r = new Array(n).fill(0);
    for (const d of data) {
        const f = d ^ r.shift();
        r.push(0);
        for (let j = 0; j < n; j++) r[j] ^= mul(g[j + 1], f);
    }
    return r;
};

const dataCodewords = (v) => BLOCKS[v].slice(1).reduce((n, [c, d]) => n + c * d, 0);
const countBits = (v) => (v < 10 ? 8 : 16);

// mode + count + payload, terminated and padded, then split into blocks
// and interleaved with their error correction codewords
const codewords = (bytes, v) => {
    const bits = [];
    const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    const cap = dataCodewords(v) * 8;
    put(0b0100, 4);
    put(bytes.length, countBits(v));
    for (const b of bytes) put(b, 8);
    put(0, Math.min(4, cap - bits.length));
    put(0, (8 - (bits.length % 8)) % 8);
    for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((n, b) => (n << 1) | b, 0));

    const [ec, ...groups] = BLOCKS[v];
    const blocks = [];
    let k = 0;
    for (const [count, len] of groups) {
        for (let b = 0; b < count; b++, k += len) blocks.push(data.slice(k, k + len));
    }
    const ecc = blocks.map((b) => rsRemainder(b, ec));
    const out = [];
    for (let i = 0; i < Math.max(...blocks.map((b) => b.length)); i++) {
        for (const b of blocks) if (i < b.length) out.push(b[i]);
    }
    for (let i = 0; i < ec; i++) for (const e of ecc) out.push(e[i]);
    return out;
};

const MASKS = [
    (y, x) => (y + x) % 2 === 0,
    (y) => y % 2 === 0,
    (y, x) => x % 3 === 0,
    (y, x) => (y + x) % 3 === 0,
    (y, x) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
    (y, x) => ((y * x) % 2) + ((y * x) % 3) === 0,
    (y, x) => (((y * x) % 2) + ((y * x) % 3)) % 2 === 0,
    (y, x) => (((y + x) % 2) + ((y * x) % 3)) % 2 === 0,
];

const build = (v, words, mask) => {
    const size = 17 + 4 * v;
    const dark = Array.from({ length: size }, () => new Array(size).fill(false));
    const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (x, y, on) => {
        dark[y][x] = on;
        fixed[y][x] = true;
    };

    // finders with their separators, timing lines, alignment patterns
    for (const [fx, fy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
        for (let dy = -4; dy <= 4; dy++) {
            for (let dx = -4; dx <= 4; dx++) {
                const x = fx + dx;
                const y = fy + dy;
                const d = Math.max(Math.abs(dx), Math.abs(dy));
                if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
            }
        }
    }
    for (let i = 8; i < size - 8; i++) {
        set(6, i, i % 2 === 0);
        set(i, 6, i % 2 === 0);
    }
    const al = ALIGN[v];
    const last = al.length - 1;
    for (const [i, ay] of al.entries()) {
        for (const [j, ax] of al.entries()) {
            // not on the three finder corners — but the ones crossing a
            // timing line (version 7+) do belong there
            if ((i === 0 && (j === 0 || j === last)) || (i === last && j === 0)) continue;
            for (let dy = -2; dy <= 2; dy++) {
                for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
            }
        }
    }

    // format info: level M (00) + mask, BCH(15,5), fixed XOR pattern
    let rem = mask;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const fmt = ((mask << 10) | rem) ^ 0x5412;
    const bit = (n, i) => ((n >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(fmt, i));
    set(8, 7, bit(fmt, 6));
    set(8, 8, bit(fmt, 7));
    set(7, 8, bit(fmt, 8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(fmt, i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(fmt, i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(fmt, i));
    set(8, size - 8, true);

    // version info (7+): BCH(18,6), mirrored next to two finders
    if (v >= 7) {
        rem = v;
        for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
        const ver = (v << 12) | rem;
        for (let i = 0; i < 18; i++) {
            const a = size - 11 + (i % 3);
            const b = Math.floor(i / 3);
            set(a, b, bit(ver, i));
            set(b, a, bit(ver, i));
        }
    }

    // codewords zigzag up and down two-column strips from the bottom
    // right, skipping the vertical timing line; leftovers stay light
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        const up = ((right + 1) & 2) === 0;
        for (let vert = 0; vert < size; vert++) {
            for (let j = 0; j < 2; j++) {
                const x = right - j;
                const y = up ? size - 1 - vert : vert;
                if (fixed[y][x]) continue;
                const on = i < words.length * 8 && ((words[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
                dark[y][x] = on !== MASKS[mask](y, x);
                i++;
            }
        }
    }
    return dark;
};

// the spec's four penalty rules: long runs, 2×2 blocks, finder
// look-alikes, dark/light imbalance — the lowest score scans best
const penalty = (m) => {
    const n = m.length;
    let score = 0;
    const lines = [...m, ...m.map((_, x) => m.map((row) => row[x]))];
    for (const line of lines) {
        let run = 1;
        for (let i = 1; i <= n; i++) {
            if (i < n && line[i] === line[i - 1]) run++;
            else {
                if (run >= 5) score += run - 2;
                run = 1;
            }
        }
        const s = `0000${line.map(Number).join("")}0000`; // the quiet zone is light
        for (let i = s.indexOf("1011101"); i !== -1; i = s.indexOf("1011101", i + 1)) {
            if (s.slice(i - 4, i) === "0000") score += 40;
            if (s.slice(i + 7, i + 11) === "0000") score += 40;
        }
    }
    let dark = 0;
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            dark += m[y][x];
            if (y && x && m[y][x] === m[y - 1][x] && m[y][x] === m[y][x - 1] && m[y][x] === m[y - 1][x - 1]) score += 3;
        }
    }
    return score + 10 * Math.floor(Math.abs(dark * 20 - n * n * 10) / (n * n));
};

// text → square matrix of booleans (true = dark), or null when it does
// not fit; `mask` pins the mask pattern (tests), else the best is chosen
export function qrMatrix(text, mask) {
    const bytes = new TextEncoder().encode(text);
    let v = 1;
    while (v <= MAX_VERSION && dataCodewords(v) * 8 < 4 + countBits(v) + bytes.length * 8) v++;
    if (v > MAX_VERSION) return null;
    const words = codewords(bytes, v);
    if (mask !== undefined) return build(v, words, mask);
    let best = null;
    let bestScore = Infinity;
    for (let k = 0; k < MASKS.length; k++) {
        const m = build(v, words, k);
        const s = penalty(m);
        if (s < bestScore) [best, bestScore] = [m, s];
    }
    return best;
}

// an SVG with a 4-module quiet zone, dark on light whatever the theme —
// scanners want it that way round
export function qrSvg(text) {
    const m = qrMatrix(text);
    if (!m) return null;
    const q = 4;
    const n = m.length + 2 * q;
    let d = "";
    for (let y = 0; y < m.length; y++) {
        for (let x = 0; x < m.length; x++) {
            if (!m[y][x] || (x && m[y][x - 1])) continue;
            let w = 1;
            while (x + w < m.length && m[y][x + w]) w++;
            d += `M${x + q} ${y + q}h${w}v1h${-w}z`;
        }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges">`
        + `<rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
