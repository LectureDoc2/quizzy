#!/usr/bin/env node
/**
 * Assembles the static site served by Caddy into `dist/`.
 *
 * The output mirrors the public URL layout one-to-one, so the URLs used by
 * embedding pages (e.g. `<script src="https://quiz.example.com/client/ld-quiz.js">`)
 * are unchanged:
 *
 *   dist/
 *   ├── index.html, demo.html, join.html, control.html
 *   ├── client/   bundled ES modules + the web component's stylesheet
 *   ├── styles/   stylesheets of the join/control pages
 *   └── katex/    vendored KaTeX distribution
 *
 * Bundling is required because the browser cannot resolve the bare specifier
 * `@lecturedoc2/libcrypto`; esbuild inlines it into each entry point.
 *
 * Usage: node build.js [--watch] [--minify]
 */

import * as esbuild from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = join(ROOT, "dist");

const WATCH = process.argv.includes("--watch");
const MINIFY =
    process.argv.includes("--minify") || process.env.NODE_ENV === "production";

/** ES module entry points, all served from `/client/`. */
const ENTRY_POINTS = [
    ["packages/ld-quiz/src/ld-quiz.js", "ld-quiz"],
    ["packages/server/web/js/quiz-client.js", "quiz-client"],
    ["packages/server/web/js/quiz-control.js", "quiz-control"],
].map(([from, out]) => ({ in: join(ROOT, from), out }));

/** Files and directories copied verbatim: [source, destination]. */
const COPIES = [
    ["packages/ld-quiz/src/quiz-styles.css", "client/quiz-styles.css"],
    ["packages/server/web/index.html", "index.html"],
    ["packages/server/web/demo.html", "demo.html"],
    ["packages/server/web/join.html", "join.html"],
    ["packages/server/web/control.html", "control.html"],
    ["packages/server/web/styles", "styles"],
    ["packages/server/web/katex", "katex"],
];

async function copyStaticFiles() {
    for (const [from, to] of COPIES) {
        await cp(join(ROOT, from), join(DIST, to), { recursive: true });
    }
}

const buildOptions = {
    entryPoints: ENTRY_POINTS,
    outdir: join(DIST, "client"),
    bundle: true,
    format: "esm",
    platform: "browser",
    // Matches the "modern browsers" support statement in the README.
    target: ["chrome120", "firefox120", "safari17", "edge120"],
    sourcemap: true,
    minify: MINIFY,
    logLevel: "info",
};

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });

if (WATCH) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    await copyStaticFiles();
    console.log("Watching for changes in the client sources ...");
    console.log("(HTML, CSS and KaTeX are copied once; re-run to refresh them.)");
} else {
    await esbuild.build(buildOptions);
    await copyStaticFiles();
    console.log(`Build complete: ${DIST}`);
}
