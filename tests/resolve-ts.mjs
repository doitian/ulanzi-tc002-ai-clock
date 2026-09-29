import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    // Match Wrangler's selection of gifenc's ESM entry instead of Node's CJS entry.
    if (specifier === 'gifenc') {
      return { ...nextResolve('gifenc/dist/gifenc.esm.js', context), format: 'module' };
    }
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[cm]?[jt]s$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});
