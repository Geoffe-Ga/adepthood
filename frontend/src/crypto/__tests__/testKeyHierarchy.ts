import { keyHierarchyWithFloor } from '../wrapCore';

import { TEST_ONLY_KDF_PARAMS } from './testKdfParams';

/**
 * TEST-ONLY key hierarchy whose KDF floor is TEST_ONLY_KDF_PARAMS, so suites
 * can wrap and unwrap in milliseconds. It is the only route to a floor below
 * production: the exported keyHierarchy.ts API is pinned to
 * PRODUCTION_KDF_PARAMS, and cryptoUnreachable.test.ts allows `wrapCore` to be
 * imported only by keyHierarchy.ts and files under src/crypto/__tests__/.
 * Every wrap through it still passes `kdfParams: TEST_ONLY_KDF_PARAMS`
 * explicitly; its default stays the production set.
 */
export const testOnlyKeyHierarchy = keyHierarchyWithFloor(TEST_ONLY_KDF_PARAMS);
