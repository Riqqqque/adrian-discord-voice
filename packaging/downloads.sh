# shellcheck shell=bash
# Pinned downloads shared by install.sh (native) and the Docker image build.
# Sourced, not run. Every file is checked against its SHA-256 before use.
# Set ADRIAN_DOWNLOAD_CACHE=/dir to reuse files already downloaded there.
# Mirrors: ADRIAN_DOWNLOAD_MIRRORS="https://a/dir https://b/dir" (or one https
# URL per line in /opt/adrian/download-mirrors, for the hourly update), tried in
# order after the original site, as <mirror>/<file name>. A mirror is only a
# place to fetch from: its files must still match a checksum listed here.

NODE_VERSION=22.23.4
NODE_SHA256=1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"
SHERPA=https://github.com/k2-fsa/sherpa-onnx/releases/download
# sha256: one checksum, or several separated by commas: every upload of that file
# this version knows to be good (upstream sometimes replaces a file in place). A
# model already installed from any of them is kept, and the marker records which.
# name|url|sha256|kind (file; bin = executable file; or tar.bz2 that unpacks to a directory of the same name)|files to drop after unpacking|disk
# disk, in MB: ARCHIVE:PEAK:KEPT = the download (staged under /opt), what it unpacks to at its
# largest, and what is left once the dropped files are gone. Bumping a model? Update these too.
MODELS=(
  "silero_vad.onnx|$SHERPA/asr-models/silero_vad.onnx|9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6|file||1:1:1"
  # Multilingual (25 European languages) always-on recognizer; replaced v2 in 0.7.0.
  # Upstream re-exported it in place on 2026-11-07 (same checkpoint and tokens, newer
  # export tools, plus a model card): 1495e91b... is that upload, 5793d0fd... the 2025 one.
  "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8|$SHERPA/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2|1495e91b59d7fc53ddca91f3431758ec99f8fa253fdb0e1e851be0f72b14b0f9,5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf|tar.bz2||465:645:645"
  # Second pass for non-English questions (Chinese, Japanese, Vietnamese, ...). Only int8 files are used.
  "sherpa-onnx-whisper-small|$SHERPA/asr-models/sherpa-onnx-whisper-small.tar.bz2|486a46afbb7ba798507190ffe02fea2dd726049af212e774537efac6afb210a6|tar.bz2|small-encoder.onnx small-decoder.onnx test_wavs|610:1285:360"
  # Vietnamese voice (Kokoro has none).
  "vits-piper-vi_VN-vais1000-medium|$SHERPA/tts-models/vits-piper-vi_VN-vais1000-medium.tar.bz2|fa1367710767d36ed5cf13b4a449e20c35ffd12791c2e47c2e64142bfa55551a|tar.bz2||65:80:80"
  # Re-packed upstream on 2026-10-26 (60703707...): the same 377 files, byte for byte.
  "kokoro-multi-lang-v1_0|$SHERPA/tts-models/kokoro-multi-lang-v1_0.tar.bz2|60703707bc05ccd48d60e1eb723f38b07d6e474795a0b6a588d7220400e0f7a4,c5f7e2d2caf082bc1d20fb70334a61d99d20b484500aad32e7cf84c128ea3298|tar.bz2||334:385:385"
  # PC rooms: does a pause sound mid-sentence? (Smart Turn v3.2, pipecat-ai, BSD-2-Clause; 0.14.7)
  "smart-turn-v3.2-cpu.onnx|https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/f766f81d3cfdf7737ac64aad813d91bbfd56bf93/smart-turn-v3.2-cpu.onnx|2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f|file||9:9:9"
  # Music from YouTube (0.10.0). YouTube changes break it every few weeks: bump the
  # version and checksum (from the release's SHA2-256SUMS) and ship a new release.
  # Play a real song through ffmpeg first: 2026.10.26's default TV client looks up
  # fine, then its stream URL answers ffmpeg with 403.
  "yt-dlp_linux|https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp_linux|58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a|bin||39:39:39"
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

ISSUES=https://github.com/Riqqqque/adrian-discord-voice/issues

# known_sha SHA LIST: is SHA one of the comma-separated checksums in LIST?
known_sha() {
  local s
  [ -n "$1" ] || return 1
  for s in ${2//,/ }; do [ "$s" = "$1" ] && return 0; done
  return 1
}
# matching_sha FILE LIST: prints FILE's checksum if it is one of LIST's.
matching_sha() {
  local got
  [ -f "$1" ] || return 1
  got=$(sha256sum "$1" 2>/dev/null | cut -d' ' -f1) || return 1
  known_sha "$got" "$2" && echo "$got"
}
# model_installed DIR NAME LIST: unpacked, from a file whose checksum is one of LIST's.
model_installed() {
  [ -e "$1/$2" ] && known_sha "$(cat "$1/.$2.sha256" 2>/dev/null)" "$3"
}
# The mirrors to try after the original site, one per line (https only).
download_mirrors() {
  local list=${ADRIAN_DOWNLOAD_MIRRORS:-} f=${ADRIAN_MIRRORS_FILE:-/opt/adrian/download-mirrors} m
  if [ -z "$list" ] && [ -f "$f" ] && [ ! -L "$f" ]; then list=$(grep -v '^[[:space:]]*#' "$f" 2>/dev/null || true); fi
  for m in ${list//,/ }; do
    case $m in
      https://*) printf '%s\n' "${m%/}" ;;
      *) printf 'warning: ignoring download mirror %s: only https:// mirrors are used\n' "$m" >&2 ;;
    esac
  done
}
mb() { awk -v b="$1" 'BEGIN{printf "%.0f", b/1048576}'; }

# fetch url sha256[,sha256...] dest [MB expected]: the file from the cache, the
# original site or a mirror, whichever first gives one with a known checksum.
# FETCHED_SHA is then the one it matched.
fetch() {
  local url=$1 shas=$2 dest=$3 want=${4:-} name src got size rc=0 tried=() bad=() host
  name=$(basename "$url")
  FETCHED_SHA=
  if [ -n "${ADRIAN_DOWNLOAD_CACHE:-}" ] && [ -f "$ADRIAN_DOWNLOAD_CACHE/$name" ]; then
    if got=$(matching_sha "$ADRIAN_DOWNLOAD_CACHE/$name" "$shas"); then
      cp "$ADRIAN_DOWNLOAD_CACHE/$name" "$dest"
      FETCHED_SHA=$got
      return
    fi
    say "cached $name has the wrong checksum; downloading again"
  fi
  while read -r src; do
    [ -n "$src" ] || continue
    host=${src#https://}; host=${host%%/*}
    tried+=("$host")
    if [ "$src" = "$url" ]; then say "Downloading $name"; else say "Downloading $name from the mirror $host"; fi
    rm -f "$dest"
    # Limits on a stall, not on total time: a big model on a slow line is fine.
    curl -fL --retry 3 --connect-timeout 30 --speed-time 60 --speed-limit 1024 --proto '=https' --tlsv1.2 -o "$dest" "$src" || {
      rc=$? # curl's own code stays the exit code
      printf 'error: downloading %s from %s stopped (curl error %s: the connection dropped, the site is down or blocked, or it has no such file).\n' "$name" "$host" "$rc" >&2
      continue
    }
    if got=$(matching_sha "$dest" "$shas"); then
      FETCHED_SHA=$got
      return 0
    fi
    got=$(sha256sum "$dest" 2>/dev/null | cut -d' ' -f1) || got=unreadable
    size=$(stat -c %s "$dest" 2>/dev/null || wc -c <"$dest" 2>/dev/null || echo 0)
    bad+=("$host gave $(mb "$size") MB with SHA-256 $got")
  done < <(printf '%s\n' "$url"; download_mirrors | while read -r m; do printf '%s/%s\n' "$m" "$name"; done)
  rm -f "$dest"
  if [ ${#bad[@]} -eq 0 ]; then
    printf 'error: %s could not be downloaded (tried: %s). Check the internet connection, then run the same command again: everything that already finished is kept.\n' "$name" "${tried[*]}" >&2
    return "$rc"
  fi
  # A file that arrived in full but isn't one this version knows: the site has
  # a different file now. Retrying fetches the same one, so say what helps.
  local changed="the file on the download site is not one this version of A.D.R.I.A.N. knows (most likely it was replaced by a new upload), so this version won't use it. Nothing was installed from it. Running the command again won't change that. What to do: install the newest A.D.R.I.A.N. release, which may know the new file; or put a mirror you trust that still has a known copy in ADRIAN_DOWNLOAD_MIRRORS; or report it at $ISSUES with this message. Don't skip the check: it is what tells a changed file from a tampered one."
  local short="Running the same command again fixes a download that was cut short or changed on the way (a proxy or a captive Wi-Fi page can do that); everything that already finished is kept. If it fails the same way twice, $changed"
  if [ -n "$want" ] && [ "$(mb "$size")" -lt $((want * 9 / 10)) ]; then
    die "$name doesn't match its checksum, and it's smaller than it should be ($(mb "$size") MB of about $want MB). $short (${bad[*]}.)"
  elif [ -n "$want" ]; then
    die "$name downloaded at full size but doesn't match any checksum this version knows: $changed (${bad[*]}.)"
  fi
  die "$name doesn't match its checksum. $short (${bad[*]}.)"
}

install_node() { # install_node <opt dir> <scratch dir>
  local opt=$1 tmp=$2 dir=node-v$NODE_VERSION old d
  if [ ! -x "$opt/$dir/bin/node" ]; then
    fetch "$NODE_URL" "$NODE_SHA256" "$tmp/node.tar.xz"
    rm -rf "${opt:?}/$dir.new"
    mkdir -p "$opt/$dir.new"
    tar -xJf - -C "$opt/$dir.new" --strip-components=1 --no-same-owner <"$tmp/node.tar.xz"
    "$opt/$dir.new/bin/node" --version >/dev/null || { rm -rf "${opt:?}/$dir.new"; die "Node $NODE_VERSION does not run on this system"; }
    rm -rf "${opt:?}/$dir"
    mv -T "$opt/$dir.new" "$opt/$dir"
    rm -f "$tmp/node.tar.xz"
  fi
  # Anything above can fail with the running Node untouched, and this can't stop halfway.
  old=$(readlink "$opt/node" 2>/dev/null || true)
  ln -sfn "$dir" "$opt/node.new" && mv -Tf "$opt/node.new" "$opt/node"
  for d in "$opt"/node-v*; do
    case ${d##*/} in "$dir"|"$old") ;; *) rm -rf "$d" ;; esac
  done
}

install_models() { # install_models <models dir> <scratch dir>
  local dir=$1 tmp=$2 m name url sha kind drop disk marker file want
  refuse_symlinks "$dir"
  for m in "${MODELS[@]}"; do
    IFS='|' read -r name url sha kind drop disk <<<"$m"
    marker="$dir/.$name.sha256"
    refuse_symlinks "$marker" "$dir/$name"
    if model_installed "$dir" "$name" "$sha"; then continue; fi
    file="$tmp/$(basename "$url")"
    # Its size, to tell a download cut short from a changed file (big ones only).
    want=${disk%%:*}; [[ $want =~ ^[0-9]+$ ]] && [ "$want" -ge 20 ] || want=
    fetch "$url" "$sha" "$file" "$want"
    rm -rf "${dir:?}/$name"
    if [ "$kind" = file ]; then
      install -m 0644 "$file" "$dir/$name"
    elif [ "$kind" = bin ]; then
      install -m 0755 "$file" "$dir/$name"
    else
      say "Unpacking $name"
      tar -xjf - -C "$dir" --no-same-owner <"$file"
      [ -d "$dir/$name" ] || die "$name archive did not contain $name/"
      for f in $drop; do rm -rf "${dir:?}/$name/$f"; done
    fi
    rm -f "$file"
    # mv replaces a link instead of writing through it.
    # The checksum of the file it came from: one of the known ones.
    echo "$FETCHED_SHA" >"$tmp/marker" && mv -fT "$tmp/marker" "$marker"
  done
}

disk_needed() { # disk_needed <opt dir> <models dir> → "STAGING_MB MODELS_MB" the downloads still to do take
  local opt=$1 dir=$2 m name url sha kind disk a p k stage=0 kept=0 extra=0
  for m in "${MODELS[@]}"; do
    IFS='|' read -r name url sha kind _ disk <<<"$m"
    if model_installed "$dir" "$name" "$sha"; then continue; fi
    IFS=: read -r a p k <<<"${disk:-0:0:0}"
    [[ $a =~ ^[0-9]+$ && $p =~ ^[0-9]+$ && $k =~ ^[0-9]+$ ]] || { a=0 p=0 k=0; }
    # Archives are staged one at a time (a cached one is copied in too). Unpacked
    # models add up, and the biggest briefly holds the files it then drops.
    [ "$a" -le "$stage" ] || stage=$a
    kept=$((kept + k))
    [ $((p - k)) -le "$extra" ] || extra=$((p - k))
  done
  # A new Node: its archive and the unpacked runtime.
  [ -x "$opt/node-v$NODE_VERSION/bin/node" ] || stage=$((stage + 250))
  echo "$stage $((kept + extra))"
}

# disk_short <opt dir> <models dir> [margin MB]: says what's short for the
# downloads still to do; says nothing when there's room (or df can't tell).
disk_short() {
  local opt=$1 dir=$2 margin=${3:-100} need_o need_m o m fo fm
  read -r need_o need_m <<<"$(disk_needed "$opt" "$dir")"
  o=$opt; while [ ! -e "$o" ]; do o=$(dirname "$o"); done
  m=$dir; while [ ! -e "$m" ]; do m=$(dirname "$m"); done
  fo=$(df -Pk "$o" 2>/dev/null | awk 'NR==2{print int($4/1024)}') || true
  fm=$(df -Pk "$m" 2>/dev/null | awk 'NR==2{print int($4/1024)}') || true
  [[ $fo =~ ^[0-9]+$ && $fm =~ ^[0-9]+$ ]] || return 0
  if [ "$(df -Pk "$o" 2>/dev/null | awk 'NR==2{print $6}')" = "$(df -Pk "$m" 2>/dev/null | awk 'NR==2{print $6}')" ]; then
    [ "$fo" -ge $((need_o + need_m + margin)) ] ||
      echo "only $fo MB free on the disk that holds $opt and $dir, and the downloads still to do need about $((need_o + need_m + margin)) MB"
  else
    [ "$fo" -ge $((need_o + margin)) ] || echo "only $fo MB free under $opt, where the downloads are staged, and they need about $((need_o + margin)) MB"
    [ "$fm" -ge $((need_m + margin)) ] || echo "only $fm MB free under $dir, and the speech models still to fetch need about $((need_m + margin)) MB"
  fi
  return 0
}
