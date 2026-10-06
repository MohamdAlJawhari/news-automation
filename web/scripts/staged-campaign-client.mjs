// Node 24 validation-only resolver. No application imports or database writes.
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/[/\\]generated[/\\]prisma[/\\]client(?:\.ts)?$/.test(specifier)) {
      return nextResolve(new URL("../.campaign-settings-validation/client/client.ts", import.meta.url).href, context);
    }
    return nextResolve(specifier, context);
  },
});
