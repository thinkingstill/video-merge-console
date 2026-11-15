#!/bin/bash
#
# merge.sh —— 递归扫描目录（含任意层级子目录）内的视频，统一成 1080x1920 竖屏
#             （等比缩放 + 黑边填充），再按相对路径自然顺序拼接为一个 MP4。
#
# 画面规则：
#   - 输出 9:16 竖屏（1080x1920）或 16:9 横屏（1920x1080）
#   - 竖屏视频保持原始比例，居中显示；横屏同理
#   - 方向不符的视频缩到画布内，居中，四周补黑边
#   - 不裁剪任何画面内容
#
# 输出方向：ORIENT=auto 时扫描全部视频，按横屏/竖屏数量占比自动选画布；
#   也可用 ORIENT=portrait / ORIENT=landscape 强制指定。
#   判定会读取 rotation 元数据——手机竖拍常是「宽>高 + rotation=90」，只看宽高会判反。
#
# 合并顺序：按文件名自然排序 —— 取文件名的数字段按数值比较（1 < 2 < 10），
#   与所在子目录无关。文件名相同的，按所在路径次序稳定排列。
#   例：clip_1.mp4 → clip_9.mp4 → clip_10.mp4；第2集.mp4 → 第10集.mp4
#   隐藏目录（. 开头）与 __MACOSX 会被跳过。
#
# 用法：
#   ./merge.sh <输入目录> <输出文件.mp4>
#
# 示例：
#   ./merge.sh ./input ./output/final.mp4
#   ./merge.sh ~/Movies/clips ~/Desktop/merged.mp4
#
# 可选环境变量：
#   ORIENT=auto    输出方向：auto（按占比推荐）/ portrait / landscape，默认 auto
#   FPS=30         统一帧率，默认 30
#   CRF=20         画质（18~23，数值越小越好、文件越大），默认 20
#   PRESET=medium  x264 速度档位（ultrafast..veryslow），默认 medium
#   KEEP_TEMP=1    保留中间文件便于排查，默认处理完自动删除
#
set -eo pipefail

ORIENT="${ORIENT:-auto}"
WIDTH=1080
HEIGHT=1920
FPS="${FPS:-30}"
CRF="${CRF:-20}"
PRESET="${PRESET:-medium}"
KEEP_TEMP="${KEEP_TEMP:-0}"

usage() {
  cat <<'EOF'
用法：./merge.sh <输入目录> <输出文件.mp4>

  <输入目录>      待合并视频所在目录。会递归进入所有层级子目录；
                  合并顺序 = 按文件名自然排序（文件名里的数字按数值比较，
                  1 < 2 < 10），与所在子目录无关，例如 clip_1 → clip_9 → clip_10。
                  文件名相同的，按所在路径次序排列。
                  隐藏目录（. 开头）与 __MACOSX 自动跳过。
  <输出文件.mp4>  合并后的成品路径，父目录不存在会自动创建

输出方向由环境变量 ORIENT 控制：
  自动（默认）   统计目录内横屏/竖屏数量，取占比多的一侧
  强制竖屏       ORIENT=portrait   → 1080x1920
  强制横屏       ORIENT=landscape  → 1920x1080

示例：
  ./merge.sh ./input ./output/final.mp4
  ORIENT=landscape ./merge.sh ./input ./output/final.mp4
  ORIENT=portrait FPS=25 CRF=18 ./merge.sh ./input ./output/final.mp4
EOF
}

if [ "$#" -ne 2 ]; then
  usage
  exit 1
fi

INPUT_DIR="$1"
OUTPUT_FILE="$2"

# ---------- 参数校验 ----------
if [ ! -d "$INPUT_DIR" ]; then
  echo "错误：输入目录不存在 -> $INPUT_DIR" >&2
  exit 1
fi
INPUT_DIR="$(cd "$INPUT_DIR" && pwd)"

if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
  echo "错误：未找到 ffmpeg / ffprobe，请先执行 brew install ffmpeg" >&2
  exit 1
fi

# 输出统一为 mp4
case "$OUTPUT_FILE" in
  *.mp4|*.MP4) ;;
  *) OUTPUT_FILE="${OUTPUT_FILE}.mp4" ;;
esac

OUT_PARENT="$(dirname "$OUTPUT_FILE")"
mkdir -p "$OUT_PARENT"
OUT_PARENT="$(cd "$OUT_PARENT" && pwd)"
OUTPUT_FILE="$OUT_PARENT/$(basename "$OUTPUT_FILE")"

# ---------- 递归收集输入文件 ----------
# 顺序 = 按文件名（basename）自然排序：文件名里的数字段按数值比较（1 < 2 < 10），
# 与目录层级无关；文件名相同时再按完整路径比较，保证结果稳定可复现。
files=()
while IFS= read -r f; do
  files+=("$f")
done < <(
  find "$INPUT_DIR" \
    \( -type d \( -name '.*' -o -name '__MACOSX' \) -prune \) -o \
    \( -type f ! -name '.*' \
       \( -iname '*.mp4' -o -iname '*.mov' -o -iname '*.m4v' -o -iname '*.mkv' \
          -o -iname '*.avi' -o -iname '*.flv' -o -iname '*.webm' -o -iname '*.wmv' \
          -o -iname '*.ts' -o -iname '*.m2ts' -o -iname '*.mpg' -o -iname '*.mpeg' \
          -o -iname '*.3gp' \) -print \) 2>/dev/null \
    | while IFS= read -r p; do printf '%s\t%s\n' "$(basename "$p")" "$p"; done \
    | sort -t $'\t' -k1,1V -k2,2 \
    | cut -f2-
)

if [ "${#files[@]}" -eq 0 ]; then
  echo "错误：目录（含所有子目录）中没有找到支持的视频文件 -> $INPUT_DIR" >&2
  exit 1
fi

# ---------- 判定输出方向 ----------
# 部分视频带 Display Matrix（手机竖拍常见）：文件本身宽>高，靠 rotation 告诉播放器转正。
# 只看宽高会把它们判成横屏，因此先应用旋转再比宽高比。
# 另：ffprobe 的 csv 输出在这类文件上会多一列（尾随逗号），故逐字段做数字校验。
probe_kind() {
  local f="$1" dims w h rot abs t
  dims="$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height \
    -of csv=p=0 "$f" 2>/dev/null || true)"
  dims="${dims%%$'\n'*}"
  w="${dims%%,*}"
  h="${dims#*,}"; h="${h%%,*}"
  case "$w" in ''|*[!0-9]*) printf 'square'; return ;; esac
  case "$h" in ''|*[!0-9]*) printf 'square'; return ;; esac

  rot="$(ffprobe -v error -select_streams v:0 -show_entries stream_side_data=rotation \
    -of csv=p=0 "$f" 2>/dev/null || true)"
  rot="${rot%%$'\n'*}"; rot="${rot%%,*}"
  case "$rot" in ''|N/A|*[!0-9-]*) rot=0 ;; esac
  abs="${rot#-}"

  if [ $(( abs % 180 )) -eq 90 ]; then t="$w"; w="$h"; h="$t"; fi

  if [ $(( w * 100 )) -ge $(( h * 105 )) ]; then
    printf 'landscape'
  elif [ $(( w * 100 )) -le $(( h * 95 )) ]; then
    printf 'portrait'
  else
    printf 'square'
  fi
}

case "$ORIENT" in
  auto|portrait|landscape) ;;
  *)
    echo "错误：ORIENT 只能是 auto / portrait / landscape，当前为 '$ORIENT'" >&2
    exit 1 ;;
esac

orientation_note=""
if [ "$ORIENT" = "auto" ]; then
  echo "正在统计横竖屏分布（${#files[@]} 个文件）..."
  n_land=0; n_port=0; n_sq=0
  for f in "${files[@]}"; do
    case "$(probe_kind "$f")" in
      landscape) n_land=$(( n_land + 1 )) ;;
      portrait)  n_port=$(( n_port + 1 )) ;;
      *)         n_sq=$(( n_sq + 1 )) ;;
    esac
  done
  echo "分布：横屏 ${n_land} · 竖屏 ${n_port} · 方形 ${n_sq}"
  if [ "$n_land" -gt "$n_port" ]; then
    ORIENT=landscape
  else
    ORIENT=portrait
  fi
  orientation_note="（自动判定 横屏 ${n_land} / 竖屏 ${n_port}）"
fi

if [ "$ORIENT" = "landscape" ]; then
  WIDTH=1920; HEIGHT=1080
  ORIENT_NAME="横屏 16:9"
else
  WIDTH=1080; HEIGHT=1920
  ORIENT_NAME="竖屏 9:16"
fi

echo "================================================"
echo "输入目录：${INPUT_DIR}（递归）"
echo "输出文件：$OUTPUT_FILE"
echo "目标规格：${WIDTH}x${HEIGHT}  ${ORIENT_NAME}  fps=${FPS}  crf=${CRF}  preset=${PRESET} ${orientation_note}"
echo "待处理视频：${#files[@]} 个（含子目录）"
echo "================================================"
echo "合并顺序（按文件名自然排序）："
shown=0
total=${#files[@]}
for f in "${files[@]}"; do
  shown=$((shown + 1))
  if [ "$total" -le 20 ] || [ "$shown" -le 10 ] || [ "$shown" -gt $((total - 5)) ]; then
    printf "  %3d. %s\n" "$shown" "${f#"$INPUT_DIR"/}"
  elif [ "$shown" -eq 11 ]; then
    echo "        ... 中间 $((total - 15)) 个略 ..."
  fi
done
echo "================================================"

# ---------- 临时工作目录 ----------
WORK_DIR="${TMPDIR:-/tmp}/video_merge.$$"
rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"

cleanup() {
  if [ "$KEEP_TEMP" = "1" ]; then
    echo "中间文件已保留：$WORK_DIR"
  else
    rm -rf "$WORK_DIR"
  fi
}
trap cleanup EXIT

# ---------- 阶段一：逐个归一化 ----------
VF="scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease:force_divisible_by=2,\
pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2:black,\
fps=${FPS},setsar=1,format=yuv420p"

index=0
for f in "${files[@]}"; do
  rel="${f#"$INPUT_DIR"/}"

  # 跳过输出文件自身（避免重复处理上一轮成品）
  if [ "$f" = "$OUTPUT_FILE" ]; then
    echo "跳过输出文件自身：$rel"
    continue
  fi

  # 必须有视频流
  if ! ffprobe -v error -select_streams v:0 -show_entries stream=codec_type \
       -of csv=p=0 "$f" 2>/dev/null | grep -q video; then
    echo "跳过（无视频流）：$rel"
    continue
  fi

  index=$((index + 1))
  out="$(printf '%s/%04d.mp4' "$WORK_DIR" "$index")"
  echo ""
  echo "[$index/${#files[@]}] 归一化：$rel"

  if ffprobe -v error -select_streams a:0 -show_entries stream=codec_type \
       -of csv=p=0 "$f" 2>/dev/null | grep -q audio; then
    # 有音轨：保留原音轨
    ffmpeg -nostdin -y -hide_banner -loglevel warning -stats -i "$f" \
      -map 0:v:0 -map 0:a:0 \
      -vf "$VF" \
      -c:v libx264 -crf "$CRF" -preset "$PRESET" -profile:v high -level 4.0 -pix_fmt yuv420p \
      -g $((FPS * 2)) -keyint_min $((FPS * 2)) -sc_threshold 0 \
      -c:a aac -b:a 192k -ar 48000 -ac 2 \
      -video_track_timescale 90000 \
      "$out"
  else
    # 无音轨：补一条静音轨，保证 concat 时所有分段流结构一致
    echo "         （该文件无音轨，自动补静音）"
    ffmpeg -nostdin -y -hide_banner -loglevel warning -stats -i "$f" \
      -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=48000 \
      -map 0:v:0 -map 1:a:0 \
      -vf "$VF" \
      -c:v libx264 -crf "$CRF" -preset "$PRESET" -profile:v high -level 4.0 -pix_fmt yuv420p \
      -g $((FPS * 2)) -keyint_min $((FPS * 2)) -sc_threshold 0 \
      -c:a aac -b:a 192k -ar 48000 -ac 2 \
      -video_track_timescale 90000 \
      -shortest \
      "$out"
  fi
done

if [ "$index" -eq 0 ]; then
  echo "错误：没有可处理的有效视频文件" >&2
  exit 1
fi

# ---------- 阶段二：拼接 ----------
# 关键点：给每个分段写明 duration（取视频流时长，而非容器时长）。
# 容器时长取音频/视频中较长者，AAC 编码会让音频比视频长 10~20ms；
# 若按容器时长累加，段间会出现间隔，成品帧率被推断成 60fps 且音画缓慢偏移。
# 用视频流时长做 offset，成品就是精确的恒定帧率。
#
# concat demuxer 只接受纯数字（形如 173.033333），多一个逗号、CR 或空行都会
# 报 "invalid duration"。ffprobe 的文本输出可能带 CSV 分隔符、多行或 CRLF，
# 因此统一走 sanitize_duration 清洗 + 校验，拿不到合法值就跳过该行（降级为
# 按容器自身时长拼接），绝不让整次合并中断。
sanitize_duration() {
  local raw="${1-}"
  raw="${raw//$'\r'/}"      # 去掉 CR（Windows 换行残留）
  raw="${raw%%$'\n'*}"      # 只保留第一行
  raw="${raw%%,*}"          # 去掉逗号及其后（CSV 多列残留）
  raw="${raw// /}"          # 去掉空格
  raw="${raw//$'\t'/}"      # 去掉制表符
  case "$raw" in
    ''|N/A) return 0 ;;                       # 无值
    *[!0-9.]*) return 0 ;;                    # 含非数字字符
    *.*.*) return 0 ;;                        # 多个小数点
    .*|*.) return 0 ;;                        # 缺整数位或小数位
  esac
  printf '%s' "$raw"
}

LIST="$WORK_DIR/filelist.txt"
: > "$LIST"
count=0
missing_dur=0
for out in "$WORK_DIR"/[0-9][0-9][0-9][0-9].mp4; do
  if [ -f "$out" ]; then
    count=$((count + 1))

    raw="$(ffprobe -v error -select_streams v:0 -show_entries stream=duration \
      -of default=noprint_wrappers=1:nokey=1 "$out" 2>/dev/null || true)"
    seg_dur="$(sanitize_duration "$raw")"

    if [ -z "$seg_dur" ]; then
      raw="$(ffprobe -v error -show_entries format=duration \
        -of default=noprint_wrappers=1:nokey=1 "$out" 2>/dev/null || true)"
      seg_dur="$(sanitize_duration "$raw")"
    fi

    printf "file '%s'\n" "$(basename "$out")" >> "$LIST"
    if [ -n "$seg_dur" ]; then
      printf "duration %s\n" "$seg_dur" >> "$LIST"
    else
      missing_dur=$((missing_dur + 1))
      echo "警告：无法解析 $(basename "$out") 的时长，该段按容器自身时长拼接" >&2
    fi
  fi
done

if [ "$missing_dur" -gt 0 ]; then
  echo "提示：${missing_dur} 个分段缺少精确时长，成品帧率可能不严格恒定（不影响可播放性）" >&2
fi

if [ "$KEEP_TEMP" = "1" ]; then
  echo "--- filelist.txt ---"
  cat "$LIST"
  echo "--------------------"
fi

echo ""
echo "开始合并 ${count} 个分段..."

# 视频流直接 copy（不二次编码，无画质损失）；音频重编码一次以便重新生成
# 连续时间戳，消除段边界的时间戳回退告警。
(
  cd "$WORK_DIR"
  ffmpeg -nostdin -y -hide_banner -loglevel warning -stats \
    -f concat -safe 0 -i filelist.txt \
    -map 0:v:0 -map 0:a:0 \
    -c:v copy \
    -c:a aac -b:a 192k -ar 48000 -ac 2 \
    -af "aresample=async=1:first_pts=0" \
    -movflags +faststart \
    "$OUTPUT_FILE"
)

# ---------- 结果校验 ----------
echo ""
echo "================================================"
if [ ! -f "$OUTPUT_FILE" ]; then
  echo "错误：合并失败，未生成输出文件" >&2
  exit 1
fi

echo "合并完成：$OUTPUT_FILE"
ffprobe -v error -show_entries format=duration,size \
  -show_entries stream=codec_type,codec_name,width,height,r_frame_rate \
  -of default=noprint_wrappers=1 "$OUTPUT_FILE"
echo "================================================"
echo "共处理视频：$index 个"
