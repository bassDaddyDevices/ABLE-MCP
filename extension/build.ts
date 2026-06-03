import * as esbuild from "esbuild";
import * as fs from "node:fs";

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const production = process.argv.includes("--production");

await esbuild.build({
    entryPoints: ["src/extension.ts"],
    outfile: manifest.entry,
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node22",
    sourcesContent: false,
    logLevel: "info",
    minify: production,
    sourcemap: !production,
    // ws is bundled — the Extension Host gives us a node-like runtime but
    // does not provide a node_modules resolver at runtime.
    external: [],
});
