const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const archiver = require('archiver');
const express = require('express');
const multer = require('multer');
const nodemailer = require('nodemailer');

const PORT = Number(process.env.PORT || 3000);
const ROOT_DIR = __dirname;
const STORAGE_DIR = path.join(ROOT_DIR, 'storage');
const INBOX_DIR = path.join(STORAGE_DIR, 'pending');
const SENT_DIR = path.join(STORAGE_DIR, 'sent');
const ZIP_DIR = path.join(STORAGE_DIR, 'zips');
const CONFIG_PATH = path.join(ROOT_DIR, 'config', 'recipients.json');

fs.mkdirSync(INBOX_DIR, { recursive: true });
fs.mkdirSync(SENT_DIR, { recursive: true });
fs.mkdirSync(ZIP_DIR, { recursive: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024,
  },
});

const app = express();
let processingBatch = false;

function ensureConfigFile() {
  const configDir = path.dirname(CONFIG_PATH);
  fs.mkdirSync(configDir, { recursive: true });

  if (!fs.existsSync(CONFIG_PATH)) {
    const defaultConfig = {
      batchSize: 50,
      emails: ['voce@exemplo.com'],
      subject: 'Lote de fotos - Casorio',
      body: 'Segue em anexo o lote de fotos.',
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2), 'utf8');
  }
}

function readRecipientsConfig() {
  ensureConfigFile();
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const cfg = JSON.parse(raw);
  const emails = Array.isArray(cfg.emails)
    ? cfg.emails
        .map((x) => String(x || '').trim())
        .filter(Boolean)
    : [];
  return {
    batchSize: Number(cfg.batchSize) > 0 ? Number(cfg.batchSize) : 50,
    emails,
    subject: String(cfg.subject || 'Lote de fotos - Casorio'),
    body: String(cfg.body || 'Segue em anexo o lote de fotos.'),
  };
}

function sanitizeFileName(name) {
  return String(name || 'foto')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90);
}

function fileDateToken() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function moveFileSafe(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
}

function createTransport() {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) {
    throw new Error('SMTP não configurado. Defina SMTP_HOST, SMTP_USER e SMTP_PASS.');
  }

  const port = Number(process.env.SMTP_PORT || 587);
  const secure = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || port === 465;
  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });
}

async function createZipFromFiles(files, outputZipPath) {
  await fs.promises.mkdir(path.dirname(outputZipPath), { recursive: true });

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputZipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => resolve());
    output.on('error', reject);
    archive.on('error', reject);

    archive.pipe(output);
    files.forEach((f) => archive.file(f.fullPath, { name: f.fileName }));
    archive.finalize();
  });
}

async function sendBatchEmail(zipPath, config, count) {
  const transport = createTransport();
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const to = config.emails.join(', ');
  const subject = `${config.subject} (${count} fotos)`;

  await transport.sendMail({
    from,
    to,
    subject,
    text: config.body,
    attachments: [
      {
        filename: path.basename(zipPath),
        path: zipPath,
      },
    ],
  });
}

function listPendingPhotos() {
  const entries = fs.readdirSync(INBOX_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => {
      const fullPath = path.join(INBOX_DIR, e.name);
      const st = fs.statSync(fullPath);
      return { fileName: e.name, fullPath, mtime: st.mtimeMs };
    })
    .sort((a, b) => a.mtime - b.mtime);
}

async function processBatchesIfNeeded() {
  if (processingBatch) return;
  processingBatch = true;

  try {
    const config = readRecipientsConfig();
    if (config.emails.length === 0) {
      process.stdout.write('Nenhum e-mail configurado em config/recipients.json.\n');
      return;
    }

    let pending = listPendingPhotos();
    while (pending.length >= config.batchSize) {
      const chunk = pending.slice(0, config.batchSize);
      const zipName = `lote_${fileDateToken()}_${chunk.length}fotos.zip`;
      const zipPath = path.join(ZIP_DIR, zipName);

      await createZipFromFiles(chunk, zipPath);
      await sendBatchEmail(zipPath, config, chunk.length);

      const sentBucket = path.join(SENT_DIR, new Date().toISOString().slice(0, 10));
      fs.mkdirSync(sentBucket, { recursive: true });
      chunk.forEach((item) => moveFileSafe(item.fullPath, path.join(sentBucket, item.fileName)));

      process.stdout.write(`Lote enviado por email: ${zipName}\n`);
      pending = listPendingPhotos();
    }
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    process.stderr.write(`Falha ao processar lotes: ${msg}\n`);
  } finally {
    processingBatch = false;
  }
}

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self)');
  next();
});

app.get('/health', (req, res) => {
  const cfg = readRecipientsConfig();
  res.json({
    ok: true,
    pending: listPendingPhotos().length,
    batchSize: cfg.batchSize,
    recipients: cfg.emails.length,
  });
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
  const file = req.file;
  const source = String(req.body?.source || 'upload').toLowerCase();

  if (!file) {
    res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    return;
  }

  try {
    const finalName = `${fileDateToken()}_${source}_${sanitizeFileName(file.originalname)}`;
    const finalPath = path.join(INBOX_DIR, finalName);

    await pipeline(
      Readable.from(file.buffer),
      fs.createWriteStream(finalPath)
    );

    processBatchesIfNeeded().catch(() => {});

    res.json({
      id: finalName,
      name: finalName,
      url: `/files/pending/${encodeURIComponent(finalName)}`,
    });
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    res.status(500).json({ error: msg });
  }
});

const publicDir = path.join(__dirname, 'public');
const assetDirPrimary = path.join(__dirname, 'app-script');
const assetDirFallback = path.join(__dirname, '..', 'apps-script');
app.use(express.static(publicDir, { extensions: ['html'] }));
app.use('/assets', express.static(assetDirPrimary));
app.use('/assets', express.static(assetDirFallback));
app.use('/files', express.static(STORAGE_DIR));

ensureConfigFile();

app.listen(PORT, () => {
  process.stdout.write(`Server running on http://localhost:${PORT}\n`);
});
