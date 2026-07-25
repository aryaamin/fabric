// Zero-network local linker.
// Creates node_modules/@fabric/<pkg> symlinks pointing at packages/<pkg>,
// so `node --experimental-strip-types` can resolve "@fabric/*" specifiers
// against each package's `exports` map. This replaces `npm install` for the
// pure-TypeScript core, which has no external runtime dependencies.
import { readdirSync, mkdirSync, existsSync, rmSync, symlinkSync, statSync } from "node:fs";
import { join, resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scope = join(root, "node_modules", "@fabric");
mkdirSync(scope, { recursive: true });

const pkgDir = join(root, "packages");
let linked = 0;
for (const name of readdirSync(pkgDir)) {
  const target = join(pkgDir, name);
  if (!statSync(target).isDirectory()) continue;
  const link = join(scope, name);
  if (existsSync(link)) rmSync(link, { recursive: true, force: true });
  symlinkSync(relative(scope, target), link, "dir");
  linked++;
  console.log(`linked @fabric/${name} -> ${relative(root, target)}`);
}
console.log(`\n${linked} workspace package(s) linked. Run: npm run demo`);
