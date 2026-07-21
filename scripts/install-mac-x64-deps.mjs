// The universal macOS build packages the app for arm64 AND x64, but npm only
// installs the platform binary package matching the host arch. These deps ship
// prebuilt single-arch binaries (no compile step) and resolve the right package
// at runtime via process.arch — so the Intel variants must be present in
// node_modules before electron-builder packs, or the x64 slice of the
// universal dmg crashes on load. Run on the macOS release runner after
// `npm ci` (see .github/workflows/release.yml).
//
// node-pty and tree-sitter-bash need no entry here: they bundle prebuilds for
// both darwin arches inside the package itself.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const PAIRS = [
  ["sqlite-vec", "sqlite-vec-darwin-x64"],
  ["esbuild", "@esbuild/darwin-x64"],
  ["@lydell/node-pty", "@lydell/node-pty-darwin-x64"],
];

// Pin each install to the exact version the parent package declares so the
// binary can never drift from the JS wrapper that loads it.
const specs = PAIRS.map(([parent, pkg]) => {
  const manifest = JSON.parse(
    readFileSync(`node_modules/${parent}/package.json`, "utf8"),
  );
  const version = manifest.optionalDependencies?.[pkg];
  if (!version) {
    throw new Error(`${parent} does not declare ${pkg} in optionalDependencies`);
  }
  return `${pkg}@${version}`;
});

console.log(`Installing Intel (x64) binary packages: ${specs.join(", ")}`);
// --force overrides npm's cpu-field check on an arm64 host; --no-save keeps
// package.json / package-lock.json untouched.
execFileSync("npm", ["install", "--no-save", "--force", ...specs], {
  stdio: "inherit",
});
