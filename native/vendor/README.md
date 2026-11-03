# AEC source subset

Upstream files retain their original paths and notices:

| Package | Version | Source | SHA-256 |
| --- | --- | --- | --- |
| webrtc-audio-processing | 2.1 | [tarball](https://freedesktop.org/software/pulseaudio/webrtc-audio-processing/webrtc-audio-processing-2.1.tar.xz) | `ae9302824b2038d394f10213cab05312c564a038434269f11dbf68f511f9f9fe` |
| abseil-cpp | 20240722.0 | [tarball](https://github.com/abseil/abseil-cpp/releases/download/20240722.0/abseil-cpp-20240722.0.tar.gz) | `f50e5ac311a81382da7fa75b97310e4b9006474f9560ac46f54a9967f07d4ae3` |

`webrtc-audio-processing` is the freedesktop standalone APM extraction. Abseil's
version and checksum come from that release's `subprojects/abseil-cpp.wrap`.
WebRTC uses BSD-3-Clause plus its PATENTS grant; Abseil uses Apache-2.0.
Included third-party FFT, Ooura, SPL square root and RNNoise notices keep their
upstream paths. The app ships all the included LICENSE/COPYING/PATENTS/AUTHORS files.

Regenerate from the repository root (Node and the macOS `tar` are sufficient):

```sh
mkdir -p .codex-tmp
TMPDIR="$PWD/.codex-tmp" node scripts/vendor-aec.mjs
```

Both downloads are SHA-256 checked before copying. `scripts/aec-sources.json` is
the fixed source and file manifest, shared by the regeneration script and build.
The file lists include the transitive headers for both architectures and notices;
no tests, benchmarks, build generators or AVX2 implementations are included.
The source lists were reduced against APM's linked dependency closure: unused
common-audio utilities and Abseil components are omitted. APM 2.1 unconditionally
references AGC1/2, NS, AECM and their VAD/RNNoise dependencies in its implementation,
so those linked dependencies remain even though the wrapper disables them. Transient
suppression is disabled and needs no implementation in this release. No
stub DSP implementations are used. `scripts/aec-sse2.patch` guards seven files'
AVX2 dispatch sites with `WEBRTC_ENABLE_AVX2`, preserving the upstream SSE2/scalar
paths when AVX2 is excluded. Regeneration applies this patch after copying.

`scripts/build.mjs` uses only Xcode's clang++, libtool and swiftc, building C files
as C11 and C++ files as C++17. It selects NEON on arm64 and SSE2 on x86_64 (without
WEBRTC_ENABLE_AVX2). The archive is static and needs no third-party dylibs. Objects
are invalidated by source/header timestamps, target/SDK/compiler and flag hashes.

The wrapper defaults to full AEC3 suppression. `--linear` exports the linear
filter output for the double-talk measurements that will decide a future default.
The delay estimator uses eight overlapping matched filters: `(32 + 7 * 24) *
64 / 16000 = 0.800 s`, covering the 250 ms lookahead plus a 300 ms speaker delay.
At 16 kHz AEC3 delays linear output by 64 samples, full output by 128; the wrapper
removes startup padding and drains the tail so output indices and length match input.
