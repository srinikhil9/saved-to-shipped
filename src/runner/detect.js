import fs from "node:fs";
import path from "node:path";

function detectLanguage(dir) {
  const names = new Set(fs.readdirSync(dir));
  const has = (name) => names.has(name);
  const python = has('pyproject.toml') || has('requirements.txt') || has('setup.py') || has('Pipfile') || has('setup.cfg');
  const javascript = has('package.json');
  if (python && javascript) {
    return countExt(dir, '.py') >= countExt(dir, '.js') + countExt(dir, '.ts') ? 'python' : 'javascript';
  }
  if (python) return 'python';
  if (javascript) return 'javascript';
  if (has('go.mod')) return 'go';
  if (has('Cargo.toml')) return 'rust';
  const py = countExt(dir, '.py');
  const js = countExt(dir, '.js') + countExt(dir, '.ts');
  if (py === 0 && js === 0) return 'unknown';
  return py >= js ? 'python' : 'javascript';
}

function countExt(dir, ext) {
  let n = 0;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.isFile() && name.endsWith(ext)) n += 1;
  }
  return n;
}

function readOptionalDeps(dir) {
  const file = path.join(dir, 'pyproject.toml');
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  const section = text.split('[project.optional-dependencies]')[1];
  if (!section) return [];
  const body = section.split(/\n\[/)[0];
  const names = [];
  for (const match of body.matchAll(/^([A-Za-z0-9_-]+)\s*=/gm)) {
    names.push(match[1]);
  }
  return names;
}

export { detectLanguage, readOptionalDeps };
