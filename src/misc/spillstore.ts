import {open, RootDatabase, Database} from "lmdb";
import {mkdirSync, rmSync} from "fs";
import {resolve} from "path";
import logger from "./logger";
import {options} from "../options";

/**
 * Disk-backed storage for the memory-heavy solver structures (enabled with --spill <dir>).
 *
 * The design keeps all *objects* (tokens, constraint variables) in the V8 heap — they are
 * comparatively few — and moves the *sets* (points-to sets, listener-processed sets), whose
 * total membership grows superlinearly with program size, out of the V8 heap into LMDB
 * (a memory-mapped B-tree). The OS page cache keeps hot pages in RAM and evicts cold ones,
 * so peak V8 heap stays bounded by the configurable front cache instead of growing with
 * the analyzed program.
 *
 * Sets are stored per id as a Uint32Array buffer in **insertion order** (so iteration order
 * matches the in-heap Set semantics of the stock implementation). A small in-heap LRU of
 * decoded sets serves the solver's hot loop; dirty entries are written back on eviction.
 */
export class SpillEnv {

    private static env: RootDatabase | undefined;

    private static dir: string | undefined;

    private static stores: Array<SpilledIntSetStore> = [];

    static isEnabled(): boolean {
        return !!options.spill;
    }

    private static root(): RootDatabase {
        if (!SpillEnv.env) {
            SpillEnv.dir = resolve(options.spill!, `jelly-spill-${process.pid}`);
            mkdirSync(SpillEnv.dir, {recursive: true});
            SpillEnv.env = open({
                path: SpillEnv.dir,
                noSync: true, // scratch data — durability is irrelevant, speed matters
                noMemInit: true,
                encoding: "binary",
            });
            logger.info(`Spill mode enabled, disk store at ${SpillEnv.dir}`);
            process.on("exit", () => SpillEnv.cleanup());
        }
        return SpillEnv.env;
    }

    static openStore(name: string): SpilledIntSetStore {
        const db = SpillEnv.root().openDB<Buffer, number>({name, encoding: "binary", keyEncoding: "uint32"});
        const s = new SpilledIntSetStore(db);
        SpillEnv.stores.push(s);
        return s;
    }

    static cleanup() {
        try {
            // Force-commit any queued async write-backs before closing the env.
            for (const s of SpillEnv.stores)
                s.drain();
        } catch {
            /* ignore */
        }
        try {
            SpillEnv.env?.close();
        } catch {
            /* ignore */
        }
        if (SpillEnv.dir)
            try {
                rmSync(SpillEnv.dir, {recursive: true, force: true});
            } catch {
                /* ignore */
            }
        SpillEnv.env = undefined;
        SpillEnv.dir = undefined;
    }

    /** Total members currently cached in the V8 heap across all stores. */
    static cachedMembers(): number {
        let c = 0;
        for (const s of SpillEnv.stores)
            c += s.cachedMembers;
        return c;
    }
}

/**
 * A collection of integer sets, keyed by a non-negative integer id, spilled to LMDB with an
 * in-heap LRU front cache. Single-threaded use only (matches the solver).
 *
 * Membership counts and the id universe are kept in the heap (one number per id — O(#ids),
 * not O(total members)), so size queries and enumeration of ids never touch the disk.
 */
export class SpilledIntSetStore {

    /** Decoded sets, iterated in LRU order via Map insertion order. */
    private readonly cache: Map<number, {set: Set<number>, dirty: boolean}> = new Map;

    /** Per-id membership counts (also the authoritative id universe). */
    private readonly counts: Map<number, number> = new Map;

    cachedMembers: number = 0;

    constructor(private readonly db: Database<Buffer, number>) {}

    /** Number of sets. */
    get size(): number {
        return this.counts.size;
    }

    /** Number of members of the set with the given id (0 if unknown id). */
    count(id: number): number {
        return this.counts.get(id) ?? 0;
    }

    has(id: number): boolean {
        return this.counts.has(id);
    }

    /** All ids that have a (non-deleted) set. */
    ids(): IterableIterator<number> {
        return this.counts.keys();
    }

    /** Loads (or creates) the decoded set for an id, moving it to MRU position. */
    private load(id: number): {set: Set<number>, dirty: boolean} {
        let e = this.cache.get(id);
        if (e) {
            // refresh LRU position
            this.cache.delete(id);
            this.cache.set(id, e);
            return e;
        }
        const set = new Set<number>();
        const buf = this.db.getBinary(id);
        if (buf) {
            // Bulk-decode via a Uint32Array view instead of an element-by-element DataView
            // loop. LMDB buffers are little-endian in our encoding; on (universally) LE hosts
            // the view maps directly. If the byteOffset is not 4-byte aligned (Uint32Array
            // requires alignment), fall back to a one-shot copy into an aligned buffer.
            const n = buf.byteLength >>> 2;
            const u32 = (buf.byteOffset & 3) === 0
                ? new Uint32Array(buf.buffer, buf.byteOffset, n)
                : new Uint32Array(Uint8Array.prototype.slice.call(buf, 0, n << 2).buffer);
            for (let i = 0; i < n; i++)
                set.add(u32[i]);
        }
        e = {set, dirty: false};
        this.cache.set(id, e);
        this.cachedMembers += set.size;
        this.maybeEvict();
        return e;
    }

    private maybeEvict() {
        const cap = options.spillCacheSize;
        if (this.cachedMembers <= cap)
            return;
        // evict from LRU end until at ~half capacity, writing back dirty entries.
        //
        // Dirty write-backs use LMDB's ASYNC put(): it enqueues into LMDB's internal batched
        // write transaction (auto-committed off the hot path) instead of forcing one full
        // write-txn commit per set as putSync did — the per-set commit was the dominant cost
        // under cache thrash. Correctness is preserved because lmdb-js gives read-your-writes:
        // a later load()/getBinary() for an evicted id sees the queued value even before it
        // reaches disk. We drain (drain()) at cleanup to guarantee everything is committed.
        // (Explicit transactionSync batching is intentionally avoided — it is unreliable in
        // some sandboxed/embedded environments; async put needs no explicit transaction.)
        const target = cap >>> 1;
        for (const [id, e] of this.cache) {
            if (this.cachedMembers <= target)
                break;
            if (e.dirty) {
                void this.db.put(id, SpilledIntSetStore.encode(e.set));
                this.pendingWrites = true;
            }
            this.cache.delete(id);
            this.cachedMembers -= e.set.size;
        }
    }

    /** True if async put()s have been queued but not yet force-committed via drain(). */
    private pendingWrites = false;

    /**
     * Forces all queued async writes to commit. A single putSync (of a throwaway sentinel key
     * that is immediately removed) flushes lmdb-js's pending async write batch synchronously.
     * Cheap and only needed once, at store teardown / before durability matters.
     */
    drain() {
        if (!this.pendingWrites)
            return;
        this.db.putSync(SpilledIntSetStore.DRAIN_KEY, SpilledIntSetStore.DRAIN_VALUE);
        this.db.removeSync(SpilledIntSetStore.DRAIN_KEY);
        this.pendingWrites = false;
    }

    private static readonly DRAIN_KEY = 0xffffffff;
    private static readonly DRAIN_VALUE = Buffer.from([0]);

    /** Serializes a set to an insertion-ordered little-endian Uint32 buffer (bulk). */
    private static encode(set: Set<number>): Buffer {
        const u32 = new Uint32Array(set.size);
        let i = 0;
        for (const x of set)
            u32[i++] = x;
        return Buffer.from(u32.buffer, u32.byteOffset, u32.byteLength);
    }

    /**
     * Adopts an existing decoded set as the set for the given id (used when a heap set
     * grows past the spill threshold and is migrated to the store). The store takes
     * ownership of the given set object.
     */
    adopt(id: number, set: Set<number>) {
        const old = this.cache.get(id);
        if (old) {
            this.cache.delete(id);
            this.cachedMembers -= old.set.size;
        }
        this.cache.set(id, {set, dirty: true});
        this.cachedMembers += set.size;
        this.counts.set(id, set.size);
        this.maybeEvict();
    }

    /**
     * Adds a member to the set with the given id.
     * @return true if newly added, false if already present
     */
    add(id: number, x: number): boolean {
        const e = this.load(id);
        if (e.set.has(x))
            return false;
        e.set.add(x);
        e.dirty = true;
        this.cachedMembers++;
        this.counts.set(id, (this.counts.get(id) ?? 0) + 1);
        return true;
    }

    /** Checks membership. */
    contains(id: number, x: number): boolean {
        if (!this.counts.has(id))
            return false;
        return this.load(id).set.has(x);
    }

    /**
     * Returns the live decoded set for the given id (empty set if the id is unknown).
     * The returned set must not be mutated by the caller. Mutations made through 'add'
     * during iteration are visible, matching in-heap Set semantics, as long as the entry
     * is not evicted mid-iteration (the solver's fixpoint loop tolerates that case:
     * concurrently added tokens are separately enqueued for propagation).
     */
    getSet(id: number): Set<number> {
        if (!this.counts.has(id))
            return SpilledIntSetStore.empty;
        return this.load(id).set;
    }

    private static empty: Set<number> = new Set;

    /** Deletes the set with the given id. */
    delete(id: number) {
        const e = this.cache.get(id);
        if (e) {
            this.cache.delete(id);
            this.cachedMembers -= e.set.size;
        }
        if (this.counts.delete(id))
            this.db.removeSync(id);
    }

    /** Largest set size (O(#ids), heap only). */
    largest(): number {
        let c = 0;
        for (const n of this.counts.values())
            if (n > c)
                c = n;
        return c;
    }
}
