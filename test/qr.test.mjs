// The web page's QR encoder (qr.mjs) against the one the CLI already
// ships (qrcode-terminal's port of Kazuhiko Arase's encoder): same text,
// same mask → the same modules, for every version and mask it supports.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { qrMatrix, qrSvg, MAX_VERSION } from "../qr.mjs";

const require = createRequire(import.meta.url);
const QRCode = require("qrcode-terminal/vendor/QRCode");
const { M } = require("qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel");

const reference = (text, mask) => {
    const qr = new QRCode(-1, M);
    qr.addData(text);
    qr.make();
    qr.makeImpl(false, mask);
    return qr.modules;
};

// level M byte capacity per version: both sides of every boundary
const CAPACITY = [0, 14, 26, 42, 62, 84, 106, 122, 152, 180, 213];
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const text = (n, seed) => Array.from({ length: n }, (_, i) => ALPHABET[(i * 7 + seed * 13) % 64]).join("");

test("matches the reference encoder module for module", () => {
    const lengths = [1, ...CAPACITY.slice(1).flatMap((c) => [c, c + 1])].filter((n) => n <= CAPACITY[MAX_VERSION]);
    for (const [k, n] of lengths.entries()) {
        const s = text(n, k);
        for (let mask = 0; mask < 8; mask++) {
            assert.deepEqual(qrMatrix(s, mask), reference(s, mask), `length ${n}, mask ${mask}`);
        }
    }
});

test("a freedrop link fits, picks one of the eight masks, and renders", () => {
    const link = `https://freedrop.dev/#${text(43, 1)}`;
    const m = qrMatrix(link);
    assert.equal(m.length, 37, "a 65-byte link is version 5");
    assert.ok([...Array(8).keys()].some((mask) => JSON.stringify(reference(link, mask)) === JSON.stringify(m)));
    const svg = qrSvg(link);
    assert.match(svg, /^<svg [^>]*viewBox="0 0 45 45"/);
    assert.equal(qrMatrix(text(CAPACITY[MAX_VERSION] + 1, 0)), null, "too long for version 10");
    assert.equal(qrSvg(text(CAPACITY[MAX_VERSION] + 1, 0)), null);
});
