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

const TMP = path.join(__dirname, 'tmp');
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });
app.use('/files', express.static(TMP));

setInterval(() => {
  try {
    fs.readdirSync(TMP).forEach(f => {
      const p = path.join(TMP, f);
      if (Date.now() - fs.statSync(p).mtimeMs > 3600000) fs.unlinkSync(p);
    });
  } catch {}
}, 600000);

function dlFile(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    proto.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.tiktok.com/' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) { file.close(); dlFile(res.headers.location, dest).then(resolve).catch(reject); return; }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', err => { fs.unlink(dest, () => {}); reject(err); });
  });
}

async function getTT(url) {
  return new Promise((resolve, reject) => {
    const postData = `url=${encodeURIComponent(url)}&hd=1`;
    const opts = { hostname: 'www.tikwm.com', path: '/api/', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData), 'User-Agent': 'Mozilla/5.0' } };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { const j = JSON.parse(data); if (j.code === 0 && j.data?.play) resolve(j.data); else reject(new Error(j.msg || 'Error')); } catch(e) { reject(e); }
      });
    });
    req.on('error', reject); req.write(postData); req.end();
  });
}

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/download', async (req, res) => {
  const { url } = req.body;
  if (!url || !/tiktok\.com/i.test(url)) return res.status(400).json({ error: 'Invalid URL' });
  const fileId = uuidv4();
  const out = path.join(TMP, `${fileId}.mp4`);
  try {
    const data = await getTT(url);
    await dlFile(data.hdplay || data.play, out);
    if (!fs.existsSync(out) || fs.statSync(out).size < 1000) throw new Error('Download failed');
    res.json({ success: true, fileId, duration: parseFloat(data.duration || 10) });
  } catch (err) {
    try { if (fs.existsSync(out)) fs.unlinkSync(out); } catch {}
    res.status(500).json({ error: 'No se pudo descargar. Verifica que el link sea público.' });
  }
});

// Generate thumbnails with FFmpeg - fast, server-side
app.post('/thumbs', async (req, res) => {
  const { fileId, count } = req.body;
  if (!fileId) return res.status(400).json({ error: 'Missing fileId' });
  const inp = path.join(TMP, `${fileId}.mp4`);
  if (!fs.existsSync(inp)) return res.status(404).json({ error: 'Video not found' });

  try {
    // Get duration
    const dur = await new Promise(r => ffmpeg.ffprobe(inp, (e, m) => r(e ? 10 : m?.format?.duration || 10)));
    const n = count || 10;
    const thumbs = [];
    const promises = [];

    for (let i = 0; i < n; i++) {
      const t = (i / n) * dur;
      const thumbPath = path.join(TMP, `${fileId}_t${i}.jpg`);
      promises.push(new Promise((resolve) => {
        ffmpeg(inp)
          .seekInput(t)
          .frames(1)
          .size('60x60')
          .outputOptions(['-vf', 'scale=60:60:force_original_aspect_ratio=increase,crop=60:60'])
          .output(thumbPath)
          .on('end', () => {
            try {
              const data = fs.readFileSync(thumbPath);
              thumbs[i] = `data:image/jpeg;base64,${data.toString('base64')}`;
              fs.unlinkSync(thumbPath);
            } catch {}
            resolve();
          })
          .on('error', () => resolve())
          .run();
      }));
    }

    await Promise.all(promises);
    res.json({ thumbs });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate thumbnails' });
  }
});

app.post('/process', async (req, res) => {
  const { fileId, startTime, duration, crop } = req.body;
  if (!fileId || startTime === undefined || !duration || !crop) return res.status(400).json({ error: 'Missing params' });
  const inp = path.join(TMP, `${fileId}.mp4`);
  if (!fs.existsSync(inp)) return res.status(404).json({ error: 'Video not found' });

  const outId = uuidv4();
  const out = path.join(TMP, `${outId}.gif`);
  const dur = Math.min(parseFloat(duration), 10);
  const start = Math.max(0, parseFloat(startTime));
  const cx = Math.max(0, Math.round(crop.x)), cy = Math.max(0, Math.round(crop.y));
  const cw = Math.max(64, Math.round(crop.width)), ch = Math.max(64, Math.round(crop.height));

  try {
    await new Promise((resolve, reject) => {
      ffmpeg(inp)
        .inputOptions([`-ss ${start}`, `-t ${dur}`])
        .videoFilters([`crop=${cw}:${ch}:${cx}:${cy}`, `scale=512:512:flags=lanczos`, `fps=12`, `split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer`].join(','))
        .noAudio()
        .output(out)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Content-Disposition', 'attachment; filename="sticker.gif"');
    res.sendFile(path.resolve(out));
  } catch (err) {
    try { if (fs.existsSync(out)) fs.unlinkSync(out); } catch {}
    res.status(500).json({ error: 'Processing failed' });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => console.log(`🚀 StickerDrop on port ${PORT}`));
