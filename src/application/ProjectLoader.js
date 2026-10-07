import fs from 'node:fs';
import path from 'node:path';

/** Recursively finds every `.xml` file under `rootDir`. */
export function findXmlFiles(rootDir) {
  const results = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.xml')) {
        results.push(full);
      }
    }
  }
  return results;
}

/** Reads every mapper XML file under `rootDir` into `{ sourceFile, source }` pairs. */
export function loadMapperFiles(rootDir) {
  return findXmlFiles(rootDir).map((sourceFile) => ({
    sourceFile,
    source: fs.readFileSync(sourceFile, 'utf8'),
  }));
}
