const express = require('express');
const cors = require('cors');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const { v4: uuidv4 } = require('uuid');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

try {
  const sys = execSync('which ffmpeg').toString().trim();
  ffmpeg.setFfmpegPath(sys || ffmpegStatic);
} catch { ffmpeg.setFfmpegPath(ffmpegStatic); }

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use('/files', express.static(path.join(__dirname, 'tmp')));

const TMP_DIR = path.join(__dirname, 'tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
const upload = multer({ dest: TMP_DIR });

setInterval(() => {
  try {
    fs.readdirSync(TMP_DIR).forEach(f => {
      const p = path.join(TMP_DIR, f);
      if (Date.now() - fs.statSync(p).mtimeMs > 3600000) fs.unlinkSync(p);
    });
  } catch {}
}, 600000);

// Busca yt-dlp en el sistema o en la carpeta local
function getYtDlp() {
  try { execSync('yt-dlp --version', { stdio: 'pipe' }); return 'yt-dlp'; } catch {}
  try { execSync('./yt-dlp --version', { stdio: 'pipe' }); return './yt-dlp'; } catch {}
  return null;
}

app.get('/', (req, res) => res.json({ status: 'ok', ytdlp: !!getYtDlp(), path: getYtDlp() }));

app.post('/download', async (req, res) => {
  const { url } = req.body;
  if (!url || !/tiktok\.com/i.test(url)) return res.status(400).json({ error: 'Invalid TikTok URL' });
  
  const ytdlp = getYtDlp();
  if (!ytdlp) return res.status(500).json({ error: 'yt-dlp not available' });

  const fileId = uuidv4();
  const outputPath = path.join(TMP_DIR, `${fileId}.mp4`);
  try {
    execSync(`${ytdlp} -f "best[height<=720][ext=mp4]/best[height<=720]" --merge-output-format mp4 -o "${outputPath}" "${url}"`, { stdio: 'pipe', timeout: 90000 });
    if (!fs.existsSync(outputPath)) throw new Error('Download failed');

    let duration = 10;
    try { duration = await new Promise(r => ffmpeg.ffprobe(outputPath, (e, m) => r(e ? 10 : m?.format?.duration || 10))); } catch {}

    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    res.json({ success: true, fileId, videoUrl: `${proto}://${host}/files/${fileId}.mp4`, duration: Math.round(duration * 10) / 10 });
  } catch (err) {
    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
    res.status(500).json({ error: err.message.includes('private') ? 'Video is private.' : 'Could not download. Make sure the link is public.' });
  }
});

app.post('/process', async (req, res) => {
  const { fileId, startTime, duration, crop } = req.body;
  if (!fileId || startTime === undefined || !duration || !crop) return res.status(400).json({ error: 'Missing parameters' });

  const inputPath = path.join(TMP_DIR, `${fileId}.mp4`);
  if (!fs.existsSync(inputPath)) return res.status(404).json({ error: 'Video not found. Please download again.' });

  const outputId = uuidv4();
  const outputPath = path.join(TMP_DIR, `${outputId}.webp`);
  const dur = Math.min(parseFloat(duration), 4);
  const start = Math.max(0, parseFloat(startTime));
  const cx = Math.max(0, Math.round(crop.x)), cy = Math.max(0, Math.round(crop.y));
  const cw = Math.max(64, Math.round(crop.width)), ch = Math.max(64, Math.round(crop.height));

  const encode = (input, out, fps, quality) => new Promise((resolve, reject) => {
    ffmpeg(input)
      .inputOptions([`-ss ${start}`, `-t ${dur}`])
      .videoFilters([`crop=${cw}:${ch}:${cx}:${cy}`, `scale=512:512:flags=lanczos`, `fps=${fps}`].join(','))
      .noAudio()
      .outputOptions(['-vcodec libwebp', '-loop 0', '-an', '-vsync 0', `-quality ${quality}`, '-compression_level 6'])
      .output(out).on('end', resolve).on('error', reject).run();
  });

  try {
    await encode(inputPath, outputPath, 15, 75);
    if (fs.statSync(outputPath).size / 1024 > 500) {
      const opt = outputPath + '_opt.webp';
      await encode(inputPath, opt, 10, 55);
      fs.unlinkSync(outputPath); fs.renameSync(opt, outputPath);
    }
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    res.json({ success: true, stickerUrl: `${proto}://${host}/files/${outputId}.webp`, sizeKB: Math.round(fs.statSync(outputPath).size / 1024) });
  } catch (err) {
    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
    res.status(500).json({ error: 'Processing failed. Please try again.' });
  }
});

app.listen(PORT, () => console.log(`\n🚀 StickerDrop on port ${PORT} | yt-dlp: ${getYtDlp()}`));
