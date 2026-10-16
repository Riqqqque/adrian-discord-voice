# Pinned downloads shared by install.sh (native) and the Docker image build.
# Sourced, not run. Every file is checked against its SHA-256 before use.
# Set ADRIAN_DOWNLOAD_CACHE=/dir to reuse files already downloaded there.

NODE_VERSION=22.23.3
NODE_SHA256=df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"
SHERPA=https://github.com/k2-fsa/sherpa-onnx/releases/download
# name|url|sha256|kind (file; bin = executable file; or tar.bz2 that unpacks to a directory of the same name)|files to drop after unpacking
MODELS=(
  "silero_vad.onnx|$SHERPA/asr-models/silero_vad.onnx|9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6|file"
  # Multilingual (25 European languages) always-on recognizer; replaced v2 in 0.7.0.
  "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8|$SHERPA/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2|5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf|tar.bz2"
  # Second pass for non-English questions (Chinese, Japanese, Vietnamese, ...). Only int8 files are used.
  "sherpa-onnx-whisper-small|$SHERPA/asr-models/sherpa-onnx-whisper-small.tar.bz2|486a46afbb7ba798507190ffe02fea2dd726049af212e774537efac6afb210a6|tar.bz2|small-encoder.onnx small-decoder.onnx test_wavs"
  # Vietnamese voice (Kokoro has none).
  "vits-piper-vi_VN-vais1000-medium|$SHERPA/tts-models/vits-piper-vi_VN-vais1000-medium.tar.bz2|fa1367710767d36ed5cf13b4a449e20c35ffd12791c2e47c2e64142bfa55551a|tar.bz2"
  "kokoro-multi-lang-v1_0|$SHERPA/tts-models/kokoro-multi-lang-v1_0.tar.bz2|c5f7e2d2caf082bc1d20fb70334a61d99d20b484500aad32e7cf84c128ea3298|tar.bz2"
  # Music from YouTube (0.10.0). YouTube changes break it every few weeks: bump the
  # version and checksum (from the release's SHA2-256SUMS) and ship a new release.
  "yt-dlp_linux|https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp_linux|58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a|bin"
)

command -v say >/dev/null || say() { printf '==> %s\n' "$*"; }
command -v die >/dev/null || die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# /etc/adrian and /var/lib/adrian belong to the service account, which could
# plant a symbolic link there; root must never follow one (it could hand over
# or change system files).
refuse_symlinks() {
  local p
  for p in "$@"; do
    if [ -L "$p" ]; then die "$p is a symbolic link; refusing to continue (it must be a real file or directory)"; fi
  done
  return 0
}

fetch() { # fetch url sha256 dest
  local url=$1 sha=$2 dest=$3 name
  name=$(basename "$url")
  if [ -n "${ADRIAN_DOWNLOAD_CACHE:-}" ] && [ -f "$ADRIAN_DOWNLOAD_CACHE/$name" ]; then
    if echo "$sha  $ADRIAN_DOWNLOAD_CACHE/$name" | sha256sum -c --status; then
      cp "$ADRIAN_DOWNLOAD_CACHE/$name" "$dest"
      return
    fi
    say "cached $name has the wrong checksum; downloading again"
  fi
  say "Downloading $name"
  curl -fL --retry 3 --proto '=https' --tlsv1.2 -o "$dest" "$url"
  echo "$sha  $dest" | sha256sum -c --status || die "checksum mismatch for $name"
}

install_models() { # install_models <models dir> <scratch dir>
  local dir=$1 tmp=$2 m name url sha kind drop marker file
  refuse_symlinks "$dir"
  for m in "${MODELS[@]}"; do
    IFS='|' read -r name url sha kind drop <<<"$m"
    marker="$dir/.$name.sha256"
    if [ -e "$dir/$name" ] && [ "$(cat "$marker" 2>/dev/null)" = "$sha" ]; then continue; fi
    file="$tmp/$(basename "$url")"
    fetch "$url" "$sha" "$file"
    rm -rf "${dir:?}/$name"
    if [ "$kind" = file ]; then
      install -m 0644 "$file" "$dir/$name"
    elif [ "$kind" = bin ]; then
      install -m 0755 "$file" "$dir/$name"
    else
      say "Unpacking $name"
      tar -xjf "$file" -C "$dir" --no-same-owner
      [ -d "$dir/$name" ] || die "$name archive did not contain $name/"
      for f in $drop; do rm -rf "${dir:?}/$name/$f"; done
    fi
    rm -f "$file"
    echo "$sha" >"$marker"
  done
}
