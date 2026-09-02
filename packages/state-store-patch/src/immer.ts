import {enablePatches} from 'immer';

/**
 * Patches are an opt-in immer plugin, so they are enabled ONCE, here, and the
 * rest of the package imports immer through this module.
 *
 * The same arrangement the retired free-form processor path used, for
 * the same reason: `produceWithPatches` throws if the plugin was never enabled,
 * and a call site that forgets is a runtime failure on the reorg path -- the one
 * path that is exercised least and matters most.
 */
enablePatches();

export * from 'immer';
