#!/usr/bin/env node
/**
 * Renders packages/server/web/favicon.svg into the raster icons next to it:
 *
 *   favicon.ico            16 and 32 px, for browsers that ask for /favicon.ico
 *   apple-touch-icon.png   180 px on white, for iOS home screens
 *
 * The SVG is the source; re-run this after changing it:
 *
 *   node tools/render-icons.js
 *
 * Uses Playwright's Chromium from the server package, which the browser tests
 * already install (pnpm --filter ld-quiz-server exec playwright install chromium).
 */
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WEB = join(ROOT, "packages/server/web");
const require = createRequire(join(ROOT, "packages/server/package.json"));
const { chromium } = require("playwright");

const svg = await readFile(join(WEB, "favicon.svg"), "utf8");

/*
 * At 16 px a tile is 7 px wide and the glyphs blur into noise, so that size
 * gets just the four tiles, aligned to whole pixels. The colours are taken
 * from favicon.svg so the two cannot drift apart.
 */
const colors = [...svg.matchAll(/<rect [^>]*fill="(#[0-9a-f]{6})"/g)].map((m) => m[1]);
const tiles16 =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">` +
    [
        [0, 0],
        [9, 0],
        [0, 9],
        [9, 9],
    ]
        .map(([x, y], i) => `<rect x="${x}" y="${y}" width="7" height="7" rx="1.5" fill="${colors[i]}"/>`)
        .join("") +
    `</svg>`;

async function render(page, size, { background = "transparent", padding = 0, svg: source = svg } = {}) {
    const inner = size - 2 * padding;
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
        `<style>html,body{margin:0;background:${background}}` +
            `svg{display:block;width:${inner}px;height:${inner}px;margin:${padding}px}</style>` +
            source,
    );
    return page.screenshot({ omitBackground: background === "transparent", type: "png" });
}

/** An ICO file may hold PNG images directly; every current browser reads that. */
function ico(images) {
    const header = Buffer.alloc(6 + 16 * images.length);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(images.length, 4);
    let offset = header.length;
    images.forEach(({ size, png }, i) => {
        const entry = 6 + 16 * i;
        header.writeUInt8(size % 256, entry);
        header.writeUInt8(size % 256, entry + 1);
        header.writeUInt16LE(1, entry + 4);
        header.writeUInt16LE(32, entry + 6);
        header.writeUInt32LE(png.length, entry + 8);
        header.writeUInt32LE(offset, entry + 12);
        offset += png.length;
    });
    return Buffer.concat([header, ...images.map(({ png }) => png)]);
}

const browser = await chromium.launch();
try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    await writeFile(
        join(WEB, "favicon.ico"),
        ico([
            { size: 16, png: await render(page, 16, { svg: tiles16 }) },
            { size: 32, png: await render(page, 32) },
        ]),
    );
    // iOS fills transparency with black and rounds the corners itself.
    await writeFile(
        join(WEB, "apple-touch-icon.png"),
        await render(page, 180, { background: "#fff", padding: 14 }),
    );
} finally {
    await browser.close();
}
console.log("Wrote favicon.ico and apple-touch-icon.png.");
