# source rec.sh — drive the phone and screen-record one clip, logging every touch.
# Touch log lines: "<seconds since record start> tap x y" / "swipe x1 y1 x2 y2 ms"
# so the composition can draw finger ripples exactly where and when they happened.
export MSYS_NO_PATHCONV=1
HERE="$(cygpath -m "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)")"
OUT="$HERE/../assets/raw/clips"; mkdir -p "$OUT"

now() { date +%s.%N; }
t() { awk -v a="$(now)" -v b="$T0" 'BEGIN{printf "%.2f", a-b}'; }

rec_start() { # name seconds
  CLIP=$1; LOG="$OUT/$CLIP.touches"; : > "$LOG"
  adb shell rm -f /sdcard/hp_$CLIP.mp4
  adb shell screenrecord --bit-rate 20000000 --time-limit "$2" /sdcard/hp_$CLIP.mp4 &
  REC_PID=$!; T0=$(now); sleep 1.2
}
rec_stop() {
  adb shell pkill -INT screenrecord 2>/dev/null; wait $REC_PID 2>/dev/null; sleep 1
  adb pull /sdcard/hp_$CLIP.mp4 "$OUT/$CLIP.mp4" >/dev/null && echo "saved $CLIP ($(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT/$CLIP.mp4")s)"
}
tap()   { echo "$(t) tap $1 $2" >> "$LOG"; adb shell input tap "$1" "$2"; }
swipe() { echo "$(t) swipe $1 $2 $3 $4 $5" >> "$LOG"; adb shell input swipe "$1" "$2" "$3" "$4" "$5"; }
key()   { adb shell input keyevent "$1"; }
type_slow() { # text typed a character at a time, like a person
  local s=$1 i
  for ((i = 0; i < ${#s}; i++)); do adb shell input text "${s:i:1}"; sleep 0.05; done
}
at() { node "$HERE/ui.mjs" find "$@"; } # -> "x y"
tapt() { local p; p=$(at "$@") || return 1; tap $p; }
shot() { adb exec-out screencap -p > "$HERE/../assets/raw/$1.png"; }
SCR="C:/Users/Aanand/AppData/Local/Temp/claude/D--company/e66a38a6-c6bf-451b-9b3e-7292348fa360/scratchpad"
sheet() { # clip [frames] -> contact sheet in scratchpad/sheet.png
  local n=${2:-10} d; d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT/$1.mp4")
  ffmpeg -v error -y -i "$OUT/$1.mp4" -vf "fps=$n/$d,scale=180:-1,tile=${n}x1" -frames:v 1 "$SCR/sheet.png"
}
dtap() { echo "$(t) tap $1 $2" >> "$LOG"; adb shell "input tap $1 $2 & sleep 0.12; input tap $1 $2"; echo "$(t) tap $1 $2" >> "$LOG"; }
zoomto() { # zoom one level towards a named marker (taps just below it so the marker isn't selected)
  local p; p=$(at "$1") || return 1; set -- $p; dtap $1 $(( $2 + ${ZOFF:-45} ));
}
KTM="Alsus|Leeway|Education Light|Sarthak|Aadarsh|Jyatha|Kupondole|Lazimpat|Panipokhari|Pathshala|Chaksibari|Saathi|Aangan|Thapagaun|Himal Chhaya|Dream home|Prasanga|Tusal|Boudha"
zoomktm() { local p; p=$(node "$HERE/ui.mjs" centroid "$KTM") || return 1; set -- $p; dtap $1 $(( $2 + ${ZOFF:-30} )); }
# one zoom step: drag the Kathmandu cluster to centre, then double-tap a free spot beside it
zstep() {
  local c; c=$(node "$HERE/ui.mjs" centroid "$KTM") || return 1; set -- $c
  swipe $1 $2 360 ${CY:-760} 450; sleep 0.9
  local e; e=$(node "$HERE/ui.mjs" empty "360,${CY:-760}"); dtap $e
}
# zoom until the Kathmandu hostels spread over $1 px vertically (max 10 steps)
zoomin() { local i s; for i in 1 2 3 4 5 6 7 8 9 10; do s=$(node "$HERE/ui.mjs" spread "$KTM"); [ "$s" -ge "$1" ] && return; zstep; sleep 1.2; done; }
