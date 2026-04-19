const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const express = require('express');
const multer = require('multer');

const { uploadFileToFolder } = require('./drive');

const PORT = Number(process.env.PORT || 3000);
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID || '';

if (!DRIVE_FOLDER_ID) {
  throw new Error('Defina a variável de ambiente DRIVE_FOLDER_ID com o ID da pasta do Google Drive.');
}

const tmpDir = path.join(os.tmpdir(), 'roma-shared-pictures');
fs.mkdirSync(tmpDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, tmpDir),
    filename: (req, file, cb) => {
      const safeBase = (file.originalname || 'foto')
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      cb(null, `${ts}_${safeBase}`);
    },
  }),
  limits: {
    fileSize: 25 * 1024 * 1024,
  },
});

const app = express();

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self)');
  next();
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
  const file = req.file;
  const source = String(req.body?.source || 'upload').toLowerCase();

  if (!file) {
    res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    return;
  }

  try {
    const driveName = `${new Date().toISOString().replace(/[:.]/g, '-')}_${source}_${file.originalname || 'foto'}`;
    const uploaded = await uploadFileToFolder({
      filePath: file.path,
      fileName: driveName,
      mimeType: file.mimetype || 'application/octet-stream',
      folderId: DRIVE_FOLDER_ID,
    });

    res.json({
      id: uploaded.id,
      name: uploaded.name,
      url: uploaded.webViewLink,
    });
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    res.status(500).json({ error: msg });
  } finally {
    fs.promises.unlink(file.path).catch(() => {});
  }
});

const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir, { extensions: ['html'] }));
app.use('/assets', express.static(path.join(__dirname, '..', 'apps-script')));

app.listen(PORT, () => {
  process.stdout.write(`Server running on http://localhost:${PORT}\n`);
});

