set -e
cd "$(dirname "$0")/.."

# Times are measured during capture, relative to the first screencast frame.
read -r reminder_start reminder_end meeting_start meeting_end <<EOF
$(node -e "const t = require('./docs/images/demo-timing.json'); console.log(t.reminderStart, t.reminderEnd, t.meetingEndStart, t.meetingEndEnd)")
EOF
ffmpeg -y -loglevel error -i docs/images/demo-raw.mp4 -loop 1 -i docs/images/demo-reminder.png -loop 1 -i docs/images/demo-meeting-end.png -loop 1 -i scripts/demo-assets/caption.png -filter_complex "[0:v]pad=1280:880:0:0:color=0x18251f[base];[1:v]scale=600:-1[p1];[2:v]scale=600:-1[p2];[base][p1]overlay=650:32:enable='between(t,$reminder_start,$reminder_end)'[a];[a][p2]overlay=650:32:enable='between(t,$meeting_start,$meeting_end)'[b];[b][3:v]overlay=0:800:shortest=1,format=yuv420p[v]" -map '[v]' -c:v libx264 -crf 20 -movflags +faststart -t "$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 docs/images/demo-raw.mp4)" docs/images/demo.mp4
ffmpeg -y -loglevel error -ss 28 -i docs/images/demo.mp4 -frames:v 1 docs/images/demo-poster.png
ffmpeg -y -loglevel error -i docs/images/demo.mp4 -vf 'fps=5,scale=800:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4' -loop 0 docs/images/demo-preview.gif
