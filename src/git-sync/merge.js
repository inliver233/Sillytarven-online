import fs from 'node:fs';
import git from 'isomorphic-git';
import { describePath } from './tracking.js';
import { writeTreesFromFlat } from './repo.js';

/**
 * File-level three-way merge.
 *
 * Tavern data is mostly JSON, JSONL and PNG cards, where git's line merge would leave conflict
 * markers in live files or corrupt images. Here a file changed on one side takes that side; a
 * file changed differently on both sides is a conflict the user settles by picking a side.
 */

/**
 * @typedef {object} MergePlan
 * @property {'up-to-date'|'fast-forward'|'merge'} type
 * @property {string} ours
 * @property {string} theirs
 * @property {string|null} base
 * @property {Array<{ path: string, category: string, categoryLabel: string, item: string, ours: 'modified'|'deleted'|'added', theirs: 'modified'|'deleted'|'added' }>} conflicts
 * @property {number} theirsChanges Files the other side changed
 */

/**
 * Reads every file of a commit as path → { oid, mode }.
 * @param {import('./repo.js').RepoContext} ctx
 * @param {string|null} oid
 */
async function readFlatTree(ctx, oid) {
    /** @type {Map<string, { oid: string, mode: string }>} */
    const flat = new Map();
    if (!oid) return flat;
    await git.walk({
        fs, gitdir: ctx.gitdir, cache: ctx.cache, trees: [git.TREE({ ref: oid })],
        map: async (filepath, [entry]) => {
            if (!entry || filepath === '.') return true;
            if ((await entry.type()) === 'blob') {
                flat.set(filepath, { oid: await entry.oid(), mode: (await entry.mode()).toString(8) });
            }
            return true;
        },
    });
    return flat;
}

/**
 * Works out what merging `theirs` into `ours` involves, without changing anything.
 * @param {import('./repo.js').RepoContext} ctx
 * @param {string} ours
 * @param {string} theirs
 * @returns {Promise<MergePlan>}
 */
export async function planMerge(ctx, ours, theirs) {
    if (ours === theirs || await git.isDescendent({ fs, gitdir: ctx.gitdir, oid: ours, ancestor: theirs, depth: -1, cache: ctx.cache })) {
        return { type: 'up-to-date', ours, theirs, base: theirs, conflicts: [], theirsChanges: 0 };
    }
    if (await git.isDescendent({ fs, gitdir: ctx.gitdir, oid: theirs, ancestor: ours, depth: -1, cache: ctx.cache })) {
        return { type: 'fast-forward', ours, theirs, base: ours, conflicts: [], theirsChanges: 0 };
    }
    const [base = null] = await git.findMergeBase({ fs, gitdir: ctx.gitdir, oids: [ours, theirs], cache: ctx.cache });
    const [baseTree, ourTree, theirTree] = await Promise.all([readFlatTree(ctx, base), readFlatTree(ctx, ours), readFlatTree(ctx, theirs)]);
    const conflicts = [];
    let theirsChanges = 0;
    for (const filepath of new Set([...baseTree.keys(), ...ourTree.keys(), ...theirTree.keys()])) {
        const b = baseTree.get(filepath)?.oid;
        const o = ourTree.get(filepath)?.oid;
        const t = theirTree.get(filepath)?.oid;
        if (t !== b) theirsChanges++;
        if (o === t || o === b || t === b) continue;
        const side = (value) => (!value ? 'deleted' : !b ? 'added' : 'modified');
        conflicts.push({ path: filepath, ...describePath(filepath), ours: side(o), theirs: side(t) });
    }
    return { type: 'merge', ours, theirs, base, conflicts, theirsChanges };
}

/**
 * Writes the merge commit for a plan. Every conflict needs a choice.
 * @param {import('./repo.js').RepoContext} ctx
 * @param {MergePlan} plan
 * @param {Record<string, 'ours'|'theirs'>} choices Conflict path → side to keep
 * @param {{ message: string, author: { name: string, email: string } }} options
 * @returns {Promise<string>} The merge commit
 */
export async function writeMergeCommit(ctx, plan, choices, { message, author }) {
    const missing = plan.conflicts.filter(conflict => choices[conflict.path] !== 'ours' && choices[conflict.path] !== 'theirs');
    if (missing.length) {
        const message = `还有 ${missing.length} 个冲突没有选择保留哪一边`;
        throw Object.assign(new Error(message), { code: 'UnresolvedConflicts', status: 409, userMessage: message, details: missing });
    }
    const [baseTree, ourTree, theirTree] = await Promise.all([readFlatTree(ctx, plan.base), readFlatTree(ctx, plan.ours), readFlatTree(ctx, plan.theirs)]);
    /** @type {Map<string, { oid: string, mode: string }>} */
    const merged = new Map();
    for (const filepath of new Set([...baseTree.keys(), ...ourTree.keys(), ...theirTree.keys()])) {
        const b = baseTree.get(filepath);
        const o = ourTree.get(filepath);
        const t = theirTree.get(filepath);
        let pick;
        if (o?.oid === t?.oid) pick = o;
        else if (o?.oid === b?.oid) pick = t;
        else if (t?.oid === b?.oid) pick = o;
        else pick = choices[filepath] === 'theirs' ? t : o;
        if (pick) merged.set(filepath, pick);
    }
    const tree = await git.writeTree({ fs, gitdir: ctx.gitdir, tree: await writeTreesFromFlat(ctx, merged) });
    return git.commit({ fs, gitdir: ctx.gitdir, cache: ctx.cache, author, message, tree, parent: [plan.ours, plan.theirs], noUpdateBranch: true });
}
