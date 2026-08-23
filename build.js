#!/usr/bin/env node
/**
 * Assembles the static site served by Caddy into `dist/`.
 *
 * The output mirrors the public URL layout one-to-one, so the URLs used by
 * embedding pages are unchanged:
 *
 *   dist/
 *   ├── index.html, demo.html, join.html, control.html
 *   ├── client/         bundled ES modules (moving "latest" alias)
 *   ├── client/<ver>/   the same bundles, immutable and safe to pin
 *   ├── styles/         stylesheets of the join/control pages
 *   └── katex/          vendored KaTeX distribution
 *
 * Bundling is required because the browser cannot resolve the bare specifier
 * `@lecturedoc2/libcrypto`; esbuild inlines it into each entry point.
 *
 * ## Why the output is published twice
 *
 * `/component/ld-quiz.js` cannot be cached and cannot be pinned with Subresource
 * Integrity: its contents change under a stable URL, so a correct SRI hash today
 * is a broken page tomorrow. That is fine for the demo pages, which are served
 * from the same deployment, and wrong for an external embedder -- a LectureDoc2
 * deck or a Moodle course -- that wants a URL which will still mean the same
 * thing next term.
 *
 * So both exist: `/component/<version>/ld-quiz.js` never changes and may be cached
 * forever and hashed; `/component/ld-quiz.js` always tracks the deployment. Which
 * one an integrator picks is a decision about coupling, and it should be theirs.
 *
 * Usage: node build.js [--watch] [--minify]
 */

import * as esbuild from "esbuild";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = join(ROOT, "dist");

const WATCH = process.argv.includes("--watch");
const MINIFY =
    process.argv.includes("--minify") || process.env.NODE_ENV === "production";

/** The component's version is what embedders pin, so it names the directory. */
const { version: CLIENT_VERSION } = JSON.parse(
    await readFile(join(ROOT, "packages/ld-quiz/package.json"), "utf8"),
);

/*
 * Two output trees, because two different people deploy them.
 *
 *   dist/component/  the embeddable component, and nothing else. This is what
 *                    a slide deck on another site loads, and the only part an
 *                    external integrator ever has to think about.
 *   dist/app/        the Quizzy web application: the join, control, demo and
 *                    index pages with their styles and KaTeX. Served at the
 *                    root of the Quizzy server.
 */
const COMPONENT_DIR = join(DIST, "component");
const VERSIONED_DIR = join(COMPONENT_DIR, CLIENT_VERSION);
const APP_DIR = join(DIST, "app");

/**
 * Watch mode publishes only the moving alias.
 *
 * The versioned directory is meant to be immutable; rewriting it on every
 * keystroke would teach exactly the wrong lesson about what that URL promises,
 * and the pages used during development track the alias anyway.
 */
const OUTPUT_DIR = WATCH ? COMPONENT_DIR : VERSIONED_DIR;

/** ES module entry points, the component tree and the application tree. */
/** The component. Its own tree, its own versioned URL. */
const COMPONENT_ENTRY = [
    { in: join(ROOT, "packages/ld-quiz/src/ld-quiz.js"), out: "ld-quiz" },
];

/** The application's own page scripts, which no embedder ever loads. */
const APP_ENTRIES = [
    ["packages/server/web/js/quiz-client.js", "js/quiz-client"],
    ["packages/server/web/js/quiz-control.js", "js/quiz-control"],
].map(([from, out]) => ({ in: join(ROOT, from), out }));

/** Files and directories copied verbatim: [source, destination]. */
const COPIES = [
    ["packages/server/web/index.html", "app/index.html"],
    ["packages/server/web/demo.html", "app/demo.html"],
    ["packages/server/web/join.html", "app/join.html"],
    ["packages/server/web/control.html", "app/control.html"],
    ["packages/server/web/styles", "app/styles"],
    ["packages/server/web/katex", "app/katex"],
];

async function copyStaticFiles() {
    for (const [from, to] of COPIES) {
        await cp(join(ROOT, from), join(DIST, to), { recursive: true });
    }
}

/**
 * Mirror the versioned build up to the moving `/component/` alias.
 *
 * Built once and copied, rather than bundled twice: the two URLs are supposed to
 * serve identical bytes, and a second esbuild pass would only create
 * opportunities for them to drift. Entries are copied one at a time because
 * `fs.cp` refuses a directory copy that would descend into itself, which a
 * straight `client/<version>` -> `client` copy otherwise looks like.
 *
 * Source maps are referenced by bare filename, so they resolve at either depth.
 */
async function publishMovingAlias() {
    for (const entry of await readdir(VERSIONED_DIR)) {
        await cp(join(VERSIONED_DIR, entry), join(COMPONENT_DIR, entry), {
            recursive: true,
        });
    }
    await writeFile(
        join(COMPONENT_DIR, "version.json"),
        JSON.stringify({ version: CLIENT_VERSION }, null, 2) + "\n",
        "utf8",
    );
}

const componentOptions = {
    entryPoints: COMPONENT_ENTRY,
    outdir: OUTPUT_DIR,
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

const appOptions = { ...componentOptions, entryPoints: APP_ENTRIES, outdir: APP_DIR };

if (WATCH) {
    const ctx = await esbuild.context(componentOptions);
    await ctx.watch();
    const appCtx = await esbuild.context(appOptions);
    await appCtx.watch();
    await copyStaticFiles();
    console.log("Watching for changes in the client sources ...");
    console.log("(HTML, CSS and KaTeX are copied once; re-run to refresh them.)");
    console.log("(The versioned /component/<version>/ copy is not written in watch mode.)");
} else {
    await esbuild.build(componentOptions);
    await esbuild.build(appOptions);
    await copyStaticFiles();
    await publishMovingAlias();
    console.log(`Build complete: ${DIST}`);
    console.log(`  component, immutable: /component/${CLIENT_VERSION}/ld-quiz.js`);
    console.log(`  component, moving:    /component/ld-quiz.js`);
    console.log(`  application:          / (index, demo, join, control)`);
}
