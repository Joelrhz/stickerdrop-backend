const express = require('express');
const cors = require('cors');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const { v4: uuidv4 } = require('uuid');
const { execSync, exec } = require('child_process');
const path = require('path');
const fs = require('fs');

// Set ffmpeg path
ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
const PORT = 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use('/files', express.static(path.join(__dirname, 'tmp')));

// Ensure tmp directory exists
const TMP_DIR = path.join(__dirname, 'tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// Multer for file uploads
const upload = multer({ dest: TMP_DIR });

// Cleanup old files (older than 1 hour)
function cleanupOldFiles() {
  const files = fs.readdirSync(TMP_DIR);
  const now = Date.now();
  files.forEach(file => {
    const filePath = path.join(TMP_DIR, file);
    const stat = fs.statSync(filePath);
    if (now - stat.mtimeMs > 3600000) {
      fs.unlinkSync(filePath);
    }
  });
}
setInterval(cleanupOldFiles, 600000); // Every 10 minutes

// Check if yt-dlp is available
function checkYtDlp() {
  try {
    execSync('yt-dlp --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────
// POST /download — Download TikTok video
// ─────────────────────────────────────────────
app.post('/download', async (req, res) => {
  const { url } = req.body;

  if (!url || !url.includes('tiktok.com')) {
    return res.status(400).json({ error: 'Invalid TikTok URL' });
  }

  if (!checkYtDlp()) {
    return res.status(500).json({
      error: 'yt-dlp is not installed. Please install it: pip install yt-dlp'
    });
  }

  const fileId = uuidv4();
  const outputPath = path.join(TMP_DIR, `${fileId}.mp4`);

  try {
    // Download with yt-dlp (no watermark, best quality under 720p)
    execSync(
      `yt-dlp -f "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best[height<=720]" --merge-output-format mp4 -o "${outputPath}" "${url}"`,
      { stdio: 'pipe', timeout: 60000 }
    );

    if (!fs.existsSync(outputPath)) {
      throw new Error('Download failed — file not created');
    }

    // Get video duration using ffprobe
    const durationCmd = `"${ffmpegStatic.replace('ffmpeg', 'ffprobe') || 'ffprobe'}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${outputPath}"`;
    let duration = 10;
    try {
      const result = execSync(durationCmd, { stdio: 'pipe' }).toString().trim();
      duration = parseFloat(result) || 10;
    } catch {
      // Use ffmpeg to get duration as fallback
      duration = await new Promise((resolve) => {
        ffmpeg.ffprobe(outputPath, (err, metadata) => {
          resolve(err ? 10 : (metadata?.format?.duration || 10));
        });
      });
    }

    res.json({
      success: true,
      fileId,
      videoUrl: `http://localhost:${PORT}/files/${fileId}.mp4`,
      duration: Math.round(duration * 10) / 10
    });
  } catch (err) {
    console.error('Download error:', err.message);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

    if (err.message.includes('Private') || err.message.includes('private')) {
      return res.status(400).json({ error: 'This video is private or unavailable.' });
    }
    res.status(500).json({ error: 'Could not download the video. Make sure the link is public.' });
  }
});

// ─────────────────────────────────────────────
// POST /process — Convert to animated WebP sticker
// ─────────────────────────────────────────────
app.post('/process', async (req, res) => {
  const { fileId, startTime, duration, crop } = req.body;

  // Validate inputs
  if (!fileId || startTime === undefined || !duration || !crop) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  const inputPath = path.join(TMP_DIR, `${fileId}.mp4`);
  if (!fs.existsSync(inputPath)) {
    return res.status(404).json({ error: 'Video file not found. Please download again.' });
  }

  const outputId = uuidv4();
  const outputPath = path.join(TMP_DIR, `${outputId}.webp`);

  // Clamp duration to 4s max
  const clampedDuration = Math.min(parseFloat(duration), 4);
  const clampedStart = Math.max(0, parseFloat(startTime));

  // Crop values from frontend (pixel coordinates on the displayed video)
  const { x, y, width, height, videoWidth, videoHeight } = crop;

  try {
    await new Promise((resolve, reject) => {
      // Build crop filter: crop=w:h:x:y
      // Scale crop coords to actual video dimensions
      const scaleX = videoWidth > 0 ? videoWidth : 1;
      const scaleY = videoHeight > 0 ? videoHeight : 1;

      const cropX = Math.max(0, Math.round(x));
      const cropY = Math.max(0, Math.round(y));
      const cropW = Math.max(64, Math.round(width));
      const cropH = Math.max(64, Math.round(height));

      const filterComplex = [
        `crop=${cropW}:${cropH}:${cropX}:${cropY}`,
        `scale=512:512:flags=lanczos`,
        `fps=15`
      ].join(',');

      ffmpeg(inputPath)
        .inputOptions([
          `-ss ${clampedStart}`,
          `-t ${clampedDuration}`
        ])
        .videoFilters(filterComplex)
        .noAudio()
        .outputOptions([
          '-vcodec libwebp',
          '-loop 0',          // Infinite loop
          '-preset default',
          '-an',              // No audio
          '-vsync 0',
          '-quality 75',
          '-compression_level 6',
        ])
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    // Check file size
    const stats = fs.statSync(outputPath);
    const sizeKB = stats.size / 1024;

    // If over 500KB, re-encode with lower quality
    if (sizeKB > 500) {
      const optimizedPath = path.join(TMP_DIR, `${outputId}_opt.webp`);
      await new Promise((resolve, reject) => {
        const cropX = Math.max(0, Math.round(crop.x));
        const cropY = Math.max(0, Math.round(crop.y));
        const cropW = Math.max(64, Math.round(crop.width));
        const cropH = Math.max(64, Math.round(crop.height));

        ffmpeg(inputPath)
          .inputOptions([`-ss ${clampedStart}`, `-t ${clampedDuration}`])
          .videoFilters([
            `crop=${cropW}:${cropH}:${cropX}:${cropY}`,
            `scale=512:512:flags=lanczos`,
            `fps=10`
          ].join(','))
          .noAudio()
          .outputOptions([
            '-vcodec libwebp', '-loop 0', '-an', '-vsync 0',
            '-quality 60', '-compression_level 6'
          ])
          .output(optimizedPath)
          .on('end', () => {
            fs.unlinkSync(outputPath);
            fs.renameSync(optimizedPath, outputPath);
            resolve();
          })
          .on('error', reject)
          .run();
      });
    }

    const finalStats = fs.statSync(outputPath);
    res.json({
      success: true,
      stickerUrl: `http://localhost:${PORT}/files/${outputId}.webp`,
      sizeKB: Math.round(finalStats.size / 1024)
    });
  } catch (err) {
    console.error('Processing error:', err.message);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    res.status(500).json({ error: 'Failed to process video. Please try again.' });
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 TikTok Sticker Backend running on http://localhost:${PORT}`);
  console.log(`📁 Temp files: ${TMP_DIR}`);
  console.log(`✅ yt-dlp available: ${checkYtDlp()}`);
});
