const express = require('express');
const cors = require('cors');
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
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.tiktok.com/' }
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

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/download', async (req, res) => {
  const { url } = req.body;
  if (!url || !/tiktok\.com/i.test(url)) return res.status(400).json({ error: 'Invalid TikTok URL' });

  const fileId = uuidv4();
  const outputPath = path.join(TMP_DIR, `${fileId}.mp4`);
  try {
    const data = await getTikTokVideo(url);
    await downloadFile(data.hdplay || data.play, outputPath);
    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1000) throw new Error('Download failed');
    res.json({ success: true, fileId, duration: parseFloat(data.duration || 10) });
  } catch (err) {
    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
    res.status(500).json({ error: 'No se pudo descargar. Verifica que el link sea público.' });
  }
});

app.post('/process', async (req, res) => {
  const { fileId, startTime, duration, crop } = req.body;
  if (!fileId || startTime === undefined || !duration || !crop) return res.status(400).json({ error: 'Missing parameters' });

  const inputPath = path.join(TMP_DIR, `${fileId}.mp4`);
  if (!fs.existsSync(inputPath)) return res.status(404).json({ error: 'Video no encontrado. Descarga de nuevo.' });

  const outputId = uuidv4();
  const gifPath = path.join(TMP_DIR, `${outputId}.gif`);
  const dur = Math.min(parseFloat(duration), 4);
  const start = Math.max(0, parseFloat(startTime));
  const cx = Math.max(0, Math.round(crop.x));
  const cy = Math.max(0, Math.round(crop.y));
  const cw = Math.max(64, Math.round(crop.width));
  const ch = Math.max(64, Math.round(crop.height));

  try {
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .inputOptions([`-ss ${start}`, `-t ${dur}`])
        .videoFilters([
          `crop=${cw}:${ch}:${cx}:${cy}`,
          `scale=512:512:flags=lanczos`,
          `fps=12`,
          `split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer`
        ].join(','))
        .noAudio()
        .output(gifPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    const sizeKB = Math.round(fs.statSync(gifPath).size / 1024);
    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Content-Disposition', 'attachment; filename="sticker.gif"');
    res.setHeader('X-Sticker-Size', sizeKB);
    res.sendFile(path.resolve(gifPath));
  } catch (err) {
    try { if (fs.existsSync(gifPath)) fs.unlinkSync(gifPath); } catch {}
    console.error('Process error:', err.message);
    res.status(500).json({ error: 'Error procesando. Intenta de nuevo.' });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => console.log(`\n🚀 StickerDrop on port ${PORT}`));
