#!/usr/bin/env node
/**
 * Postinstall script to patch package exports for @railgun-community/engine and snarkjs.
 * This runs after pnpm install and modifies the package.json exports in node_modules.
 *
 * Why: pnpm's strict exports mode doesn't properly handle wildcard patterns like "./dist/*"
 * and .pnpmfile.cjs hooks don't work reliably on Vercel.
 */

const fs = require('fs');
const path = require('path');

function patchPackage(packagePath, patchFn) {
  try {
    const pkgJsonPath = path.join(packagePath, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) {
      console.log(`[patch-exports] Skipping ${packagePath} - package.json not found`);
      return;
    }

    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    const patched = patchFn(pkg);

    if (patched) {
      fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2));
      console.log(`[patch-exports] Patched ${pkg.name}`);
    }
  } catch (error) {
    console.error(`[patch-exports] Failed to patch ${packagePath}:`, error.message);
  }
}

// Find the package in node_modules (handles pnpm's nested structure)
function findPackage(packageName) {
  const nodeModulesPath = path.join(__dirname, '..', 'node_modules');

  // Try direct path first
  const directPath = path.join(nodeModulesPath, packageName);
  if (fs.existsSync(directPath)) {
    return directPath;
  }

  // Try pnpm's .pnpm structure
  const pnpmPath = path.join(nodeModulesPath, '.pnpm');
  if (fs.existsSync(pnpmPath)) {
    const dirs = fs.readdirSync(pnpmPath);
    const safeName = packageName.replace('/', '+').replace('@', '');

    for (const dir of dirs) {
      if (dir.startsWith(safeName) || dir.includes(safeName)) {
        const fullPath = path.join(pnpmPath, dir, 'node_modules', packageName);
        if (fs.existsSync(fullPath)) {
          return fullPath;
        }
      }
    }
  }

  return null;
}

// Patch ALL @railgun-community/* packages — open subpath exports universally
// Search multiple locations: own node_modules, hoisted (parent), and cwd
const searchRoots = [
  path.join(__dirname, '..', 'node_modules'),          // SDK's own
  path.join(__dirname, '..', '..', '..', 'node_modules'), // hoisted when SDK is a dep
  path.join(process.cwd(), 'node_modules'),              // cwd
].filter(d => fs.existsSync(d));

for (const nmDir of searchRoots) {
  const railgunDir = path.join(nmDir, '@railgun-community');
if (fs.existsSync(railgunDir)) {
  for (const entry of fs.readdirSync(railgunDir)) {
    const pkgDir = path.join(railgunDir, entry);
    patchPackage(pkgDir, (pkg) => {
      if (!pkg.name?.startsWith('@railgun-community/')) return false;
      let mainExport = pkg.exports?.['.'] || pkg.main || './dist/index.js';
      if (typeof mainExport === 'string' && !mainExport.startsWith('./')) {
        mainExport = './' + mainExport;
      }
      pkg.exports = {
        '.': mainExport,
        './*': './*.js',
        './dist/*': './dist/*.js',
        './dist/**/*': './dist/**/*.js',
      };
      return true;
    });
  }
  // Also patch nested copies inside each railgun package
  for (const entry of fs.readdirSync(railgunDir)) {
    const nestedDir = path.join(railgunDir, entry, 'node_modules', '@railgun-community');
    if (fs.existsSync(nestedDir)) {
      for (const nested of fs.readdirSync(nestedDir)) {
        patchPackage(path.join(nestedDir, nested), (pkg) => {
          if (!pkg.name?.startsWith('@railgun-community/')) return false;
          let mainExport = pkg.exports?.['.'] || pkg.main || './dist/index.js';
          if (typeof mainExport === 'string' && !mainExport.startsWith('./')) {
            mainExport = './' + mainExport;
          }
          pkg.exports = {
            '.': mainExport,
            './*': './*.js',
            './dist/*': './dist/*.js',
            './dist/**/*': './dist/**/*.js',
          };
          return true;
        });
      }
    }
  }
  }
} // end searchRoots loop

// Patch snarkjs
const snarkjsPath = findPackage('snarkjs');
if (snarkjsPath) {
  patchPackage(snarkjsPath, (pkg) => {
    if (pkg.name === 'snarkjs') {
      pkg.exports = {
        '.': {
          browser: './build/browser.esm.js',
          import: './main.js',
          require: './build/main.cjs',
          default: './build/browser.esm.js'
        }
      };
      return true;
    }
    return false;
  });
} else {
  console.log('[patch-exports] snarkjs not found');
}

console.log('[patch-exports] Done');
