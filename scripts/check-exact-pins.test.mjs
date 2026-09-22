import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkManifest } from './check-exact-pins.mjs';

test('accepts exact pins and workspace links', () => assert.deepEqual(checkManifest({ dependencies: { a: '1.2.3', b: 'workspace:*' } }), []));
test('reports ranged dependencies by name', () => assert.match(checkManifest({ dependencies: { a: '^1.2.3' } }).join(), /a/));
test('reports ranged dev dependencies', () => assert.match(checkManifest({ devDependencies: { b: '~1.2.3' } }).join(), /b/));
test('accepts empty manifests', () => assert.deepEqual(checkManifest({}), []));
