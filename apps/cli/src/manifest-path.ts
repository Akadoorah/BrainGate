/**
 * Re-exported from core, where the checkout-attachment invariant needs the same walk.
 *
 * Two copies of "find the manifest" is two answers to "which project is this", and that question is
 * the one this repository has already been wrong about once.
 */
export { DEFAULT_MANIFEST, findManifest } from "@braingate/core";
