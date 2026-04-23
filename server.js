const express = require('express');
const cors = require('cors');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const { v4: uuidv4 } = require('uuid');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

try {
  const sys = execSync('which ffmpeg').toString().trim();
  ffmpeg.setFfmpegPath(sys || ffmpegStatic);
} catch { ffmpeg.setFfmpegPath(ffmpegStatic); }

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
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

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    proto.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.tiktok.com/'
      }
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        downloadFile(res.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', err => { fs.unlink(dest, () => {}); reject(err); });
  });
}

async function getTikTokVideo(url) {
  return new Promise((resolve, reject) => {
    const postData = `url=${encodeURIComponent(url)}&hd=1`;
    const options = {
      hostname: 'www.tikwm.com', path: '/api/', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData), 'User-Agent': 'Mozilla/5.0' }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.code === 0 && json.data?.play) resolve(json.data);
          else reject(new Error(json.msg || 'Could not get video'));
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

app.get('/', (req, res) => res.json({ status: 'ok' }));

app.post('/download', async (req, res) => {
  const { url } = req.body;
  if (!url || !/tiktok\.com/i.test(url)) return res.status(400).json({ error: 'Invalid TikTok URL' });

  const fileId = uuidv4();
  const outputPath = path.join(TMP_DIR, `${fileId}.mp4`);
  try {
    const data = await getTikTokVideo(url);
    const videoUrl = data.hdplay || data.play;
    await downloadFile(videoUrl, outputPath);
    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1000) throw new Error('Download failed');
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    res.json({ success: true, fileId, videoUrl: `${proto}://${host}/files/${fileId}.mp4`, duration: parseFloat(data.duration || 10) });
  } catch (err) {
    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
    console.error('Download error:', err.message);
    res.status(500).json({ error: 'Could not download. Make sure the link is public.' });
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
    const sizeKB = Math.round(fs.statSync(outputPath).size / 1024);
    const base64 = fs.readFileSync(outputPath).toString('base64');
    res.json({ success: true, base64, sizeKB });
  } catch (err) {
    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
    console.error('Process error:', err.message);
    res.status(500).json({ error: 'Processing failed. Please try again.' });
  }
});

app.listen(PORT, () => console.log(`\n🚀 StickerDrop on port ${PORT}`));
