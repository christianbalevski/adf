# Bundled coreutils WASM

`coreutils.wasm` is [uutils coreutils](https://github.com/uutils/coreutils), the
Rust implementation of coreutils, compiled for `wasm32-wasip1` (WASI Preview 1).
ADF exposes its `sort`, `uniq`, `wc`, `cut` and `tr` applets through
`src/main/tools/shell/commands/wasi-applet-adapter.ts`. The module contains the
larger upstream `feat_wasm` utility set. Its MIT license is in
[`coreutils.LICENSE`](coreutils.LICENSE).

## Verified binary source

The binary was introduced in ADF commit
`71ef4258b11ab2f541d8a5816f99488fd331fba5`. On 12 November 2026, downloading and
extracting the upstream [0.9.0 WASI release archive](https://github.com/uutils/coreutils/releases/download/0.9.0/coreutils-0.9.0-wasm32-wasip1.tar.gz)
and comparing it with `cmp` confirmed that its `coreutils.wasm` is byte-for-byte
identical to the checked-in file. No ADF binary modification separates these
two files. This is a verified upstream **binary match**, not a source rebuild.

| Input | Pinned value |
| --- | --- |
| Upstream repository | `https://github.com/uutils/coreutils.git` |
| Release | `0.9.0` |
| Peeled release-tag commit | `840c36d3964833e1dc107fcb9ade9c0ad63076c0` |
| Archive | `coreutils-0.9.0-wasm32-wasip1.tar.gz` |
| Archive SHA-256 | `e5efa8a1c10bd0ac09eb780d46aff6d8a4ea0be07d41f4dd9a102b266c6eb69f` |
| WASM SHA-256 | `96a64fc1d59e6cfbbce13c1e9d6bd6a0155ab0ac5194731ebd095fa1f88b2556` |
| WASM size | `9648183` bytes |
| Rust toolchain | `1.88.0` (upstream release workflow's `RUST_MIN_SRV`) |
| Cargo dependency lock | `Cargo.lock` at the pinned source commit |
| `Cargo.lock` SHA-256 | `c9b6ad944f1b9eaca859413e665faa0f4955794bf3d8ab628537416cec959e4a` |
| Target/features | `wasm32-wasip1`, `--no-default-features --features feat_wasm` |
| Profile | `release`, `strip=true`; upstream sets fat LTO, `panic=abort`, `codegen-units=1` |

To check the upstream binary independently, run from the ADF repository root
with Bash, `curl`, `tar`, `shasum` and `cmp`:

```bash
adf_root="$PWD"
download_dir="$(mktemp -d)"
(
  set -eu
  cd "$download_dir"
  curl --fail --location --output coreutils-0.9.0-wasm32-wasip1.tar.gz \
    https://github.com/uutils/coreutils/releases/download/0.9.0/coreutils-0.9.0-wasm32-wasip1.tar.gz
  printf '%s  %s\n' \
    e5efa8a1c10bd0ac09eb780d46aff6d8a4ea0be07d41f4dd9a102b266c6eb69f \
    coreutils-0.9.0-wasm32-wasip1.tar.gz | shasum -a 256 -c -
  tar -xzf coreutils-0.9.0-wasm32-wasip1.tar.gz
  printf '%s  %s\n' \
    96a64fc1d59e6cfbbce13c1e9d6bd6a0155ab0ac5194731ebd095fa1f88b2556 \
    coreutils-0.9.0-wasm32-wasip1/coreutils.wasm | shasum -a 256 -c -
  cmp "$adf_root/resources/wasm/coreutils.wasm" \
    coreutils-0.9.0-wasm32-wasip1/coreutils.wasm
)
```

## Source build recipe (not yet reproduced)

The recipe below is derived from upstream's pinned
[`CICD.yml`](https://github.com/uutils/coreutils/blob/840c36d3964833e1dc107fcb9ade9c0ad63076c0/.github/workflows/CICD.yml)
WASI release job and
[`Cargo.toml`](https://github.com/uutils/coreutils/blob/840c36d3964833e1dc107fcb9ade9c0ad63076c0/Cargo.toml).
Use a clean Linux environment with Git, a host C compiler/linker and `rustup`
installed. Upstream used `ubuntu-latest`; its exact runner image and host
packages have not been reconstructed here. No separate WASI SDK, `wasm-opt`
pass or local source patch is specified by that release job.

```bash
# Run in a new scratch directory, with Bash. This does not replace ADF's binary.
set -eu
git clone https://github.com/uutils/coreutils.git coreutils-source
cd coreutils-source
git checkout --detach 840c36d3964833e1dc107fcb9ade9c0ad63076c0
printf '%s  %s\n' \
  c9b6ad944f1b9eaca859413e665faa0f4955794bf3d8ab628537416cec959e4a \
  Cargo.lock | shasum -a 256 -c -
rustup toolchain install 1.88.0 --profile minimal --target wasm32-wasip1
rustc +1.88.0 --version --verbose
cargo +1.88.0 --version
CARGO_INCREMENTAL=0 cargo +1.88.0 build --locked --release \
  --config=profile.release.strip=true --target=wasm32-wasip1 \
  --features=feat_wasm --no-default-features
shasum -a 256 target/wasm32-wasip1/release/coreutils.wasm
# Test whether this build matches the bundled/upstream binary:
printf '%s  %s\n' \
  96a64fc1d59e6cfbbce13c1e9d6bd6a0155ab0ac5194731ebd095fa1f88b2556 \
  target/wasm32-wasip1/release/coreutils.wasm | shasum -a 256 -c -
```

`--locked` is added to the upstream build command to prohibit dependency
re-resolution. Preserve the pinned checkout's Cargo configuration and release
profile; do not run `cargo update`. A different toolchain, dependency graph,
host environment or embedded build path may change the bytes. The existing
binary embeds Rust compiler commit
`6b00bc3880198600130e1cf62b8f8a93494488cc`, consistent with Rust 1.88.0.

**The source build above has not been executed for this documentation, and
bit-for-bit reproducibility is unverified.** The recorded archive checksum and
binary comparison establish where identical prebuilt bytes can be obtained;
they do not prove those bytes were built from the tagged source. Before
replacing the module, record the actual build environment and output digest,
compare with the pinned binary, and run ADF's applet regression tests:

```bash
# From the ADF checkout, with its npm dependencies installed:
npx vitest run tests/unit/tools/shell-text-wasm.test.ts
```

ADF's Studio and npm packaging currently copy this checked-in module; they do
not rebuild it from Rust. Installer provenance therefore covers packaging
these bytes into a release, not an independent attestation of the WASM's
upstream compilation.
