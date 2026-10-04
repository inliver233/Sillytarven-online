import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { findRelativeImports, getExtensionModuleGraph } from '../src/extension-module-graph.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-extension-graph-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

function write(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
}

test('static relative imports are found, dynamic and bare ones are not', () => {
    assert.deepEqual(findRelativeImports(`
import { a } from './a.js';
import * as b from "../b.js";
import './side-effect.js';
export { c } from './c.js';
const lazy = await import('./lazy.js');
import { eventSource } from '../../../script.js';
import x from 'library';
`), ['./a.js', '../b.js', './side-effect.js', './c.js', '../../../script.js']);
    assert.deepEqual(findRelativeImports('import{a as b}from"./min.js";export*from"./more.js"'), ['./min.js', './more.js']);
});

test('third-party extensions resolve files like the static route: user folder first, then global', async () => {
    const userExtensions = path.join(root, 'user-extensions');
    write(path.join(userExtensions, 'demo', 'manifest.json'), JSON.stringify({ js: 'index.js' }));
    write(path.join(userExtensions, 'demo', 'index.js'), 'import \'./src/a.js\';\nimport { s } from \'../../../script.js\';');
    write(path.join(userExtensions, 'demo', 'src', 'a.js'), 'import { b } from \'./nested/b.js\';\nimport(\'./lazy.js\');');
    write(path.join(userExtensions, 'demo', 'src', 'nested', 'b.js'), 'import \'./missing.js\';\nimport { a } from \'../a.js\';');

    const graph = await getExtensionModuleGraph(['third-party/demo', 'third-party/..', 'unknown-extension'], userExtensions);
    assert.deepEqual(graph, { 'third-party/demo': ['src/a.js', 'src/nested/b.js'] });
});
