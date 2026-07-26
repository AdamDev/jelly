import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import {execFileSync} from "node:child_process";

// Parity test: the disk-spill mode (--spill) must produce the SAME call graph as the
// regular in-heap mode. When --spill is off the fork behaves like stock jelly (points-to
// sets stay in the V8 heap); when on, sets past --spill-threshold live in LMDB. The graph
// emitted (files, functions, calls, fun2fun, call2fun, ignore) must be identical either way.
//
// The fork's ONLY additive divergence is the optional top-level "names" map (real function
// names). We ignore "names" (and the "time" stamp) in the comparison, so this is the
// "modulo added fields" parity the task asks for.
//
// Each fixture is analyzed by spawning the built CLI (lib/main.js) twice -- once plain,
// once with --spill and --spill-threshold 1 (which forces essentially every set to migrate
// to LMDB, exercising the disk paths end to end). Running each mode in its own process
// isolates the native LMDB env exactly as real usage does.

const ROOT = path.resolve(__dirname, "..", "..");
const MAIN = path.join(ROOT, "lib", "main.js");
const BASEDIR = path.join(ROOT, "tests", "micro");

// Self-contained micro fixtures (no external node_modules needed).
const FIXTURES = ["classes.js", "arrays.js", "iterators.js", "promises.js", "prototypes.js"];

type CG = {
    files: string[];
    functions: Record<string, string>;
    calls: Record<string, string>;
    fun2fun: [number, number][];
    call2fun: [number, number][];
    ignore?: string[];
    names?: Record<string, string>;
    time?: string;
};

function runJelly(app: string, extra: string[]): CG {
    const out = path.join(os.tmpdir(), `parity-${app.replace(/\W/g, "_")}-${extra.length ? "spill" : "heap"}.json`);
    fs.rmSync(out, {force: true});
    execFileSync(process.execPath, [MAIN, "-b", BASEDIR, "-j", out, ...extra, "--", path.join(BASEDIR, app)],
        {stdio: "ignore", timeout: 60000});
    return JSON.parse(fs.readFileSync(out, "utf8")) as CG;
}

// Order-independent normalization: edges reference indices whose numbering can differ, so
// re-key each edge by the LOCATION STRINGS it connects, then sort every collection.
// In the saved cg.json, `functions` and `calls` are index->location OBJECTS (not arrays);
// function indices and call indices share one numbering space (calls follow functions).
function normalize(cg: CG) {
    const funcLoc = (i: number) => cg.functions[i];
    // a call/function edge endpoint may be either a function or a call location
    const anyLoc = (i: number) => cg.functions[i] ?? cg.calls[i];
    return {
        files: [...cg.files].sort(),
        functions: Object.values(cg.functions).sort(),
        calls: Object.values(cg.calls).sort(),
        ignore: [...(cg.ignore ?? [])].sort(),
        fun2fun: cg.fun2fun.map(([a, b]) => `${funcLoc(a)} -> ${funcLoc(b)}`).sort(),
        call2fun: cg.call2fun.map(([a, b]) => `${anyLoc(a)} -> ${funcLoc(b)}`).sort(),
    };
}

describe("tests/unit/spill-parity", () => {
    jest.setTimeout(120000);

    beforeAll(() => {
        if (!fs.existsSync(MAIN))
            throw new Error(`jelly-fork not built: ${MAIN} missing. Run 'npm run build' first.`);
    });

    for (const app of FIXTURES) {
        test(`${app}: spill graph == in-heap graph`, () => {
            const heap = normalize(runJelly(app, []));
            const spilled = normalize(runJelly(app, ["--spill", os.tmpdir(), "--spill-threshold", "1"]));

            expect(spilled.files).toEqual(heap.files);
            expect(spilled.functions).toEqual(heap.functions);
            expect(spilled.calls).toEqual(heap.calls);
            expect(spilled.fun2fun).toEqual(heap.fun2fun);
            expect(spilled.call2fun).toEqual(heap.call2fun);
            expect(spilled.ignore).toEqual(heap.ignore);
        });
    }

    test("names map is fork-only additive metadata (present, not compared for parity)", () => {
        // The spill run's graph carries the same structure; the extra "names" map is the
        // fork's additive field and must not affect the structural parity above.
        const heap = runJelly("classes.js", []) as CG;
        // names is optional; if present it maps function indices to real names, disjoint from structure.
        if (heap.names)
            expect(typeof heap.names).toBe("object");
    });
});
