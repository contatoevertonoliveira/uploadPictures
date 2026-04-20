const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const archiver = require('archiver');
const express = require('express');
const multer = require('multer');
const nodemailer = require('nodemailer');

const PORT = Number(process.env.PORT || 3000);
const AUTO_SEND_ENABLED = String(process.env.AUTO_SEND_ENABLED || 'false').toLowerCase() === 'true';
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
app.use(express.json({ limit: '1mb' }));

function requireAdminAuth(req, res, next) {
  const user = process.env.ADMIN_USER;
  const pass = process.env.ADMIN_PASS;
  if (!user || !pass) {
    res.status(403).send('Admin não configurado. Defina ADMIN_USER e ADMIN_PASS.');
    return;
  }

  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin"');
    res.status(401).send('Auth requerida.');
    return;
  }

  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  const reqUser = sep >= 0 ? decoded.slice(0, sep) : '';
  const reqPass = sep >= 0 ? decoded.slice(sep + 1) : '';

  if (reqUser !== user || reqPass !== pass) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin"');
    res.status(401).send('Credenciais inválidas.');
    return;
  }

  next();
}

function ensureConfigFile() {
  const configDir = path.dirname(CONFIG_PATH);
  fs.mkdirSync(configDir, { recursive: true });

  if (!fs.existsSync(CONFIG_PATH)) {
    const defaultConfig = {
      batchSize: 10,
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
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!user || !pass) {
    throw new Error(
      'SMTP não configurado. Defina SMTP_USER e SMTP_PASS (para Gmail, use senha de app).'
    );
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

function listAllPhotos() {
  const items = [];

  const pending = listPendingPhotos().map((x) => ({
    relPath: `pending/${x.fileName}`,
    fileName: x.fileName,
    fullPath: x.fullPath,
    mtime: x.mtime,
    bucket: 'pending',
  }));
  items.push(...pending);

  if (fs.existsSync(SENT_DIR)) {
    const dayDirs = fs.readdirSync(SENT_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
    dayDirs.forEach((d) => {
      const dirPath = path.join(SENT_DIR, d.name);
      const files = fs.readdirSync(dirPath, { withFileTypes: true }).filter((f) => f.isFile());
      files.forEach((f) => {
        const full = path.join(dirPath, f.name);
        const st = fs.statSync(full);
        items.push({
          relPath: `sent/${d.name}/${f.name}`,
          fileName: f.name,
          fullPath: full,
          mtime: st.mtimeMs,
          bucket: 'sent',
        });
      });
    });
  }

  items.sort((a, b) => b.mtime - a.mtime);
  return items;
}

function parseEmailList(value) {
  return String(value || '')
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function resolveStorageFile_(relPath) {
  const safeRel = String(relPath || '').replace(/^\/+/, '');
  if (!safeRel) {
    throw new Error('Caminho inválido.');
  }

  const full = path.join(STORAGE_DIR, safeRel);
  const normalized = path.normalize(full);
  if (!normalized.startsWith(path.normalize(STORAGE_DIR + path.sep))) {
    throw new Error('Caminho inválido.');
  }
  if (!fs.existsSync(normalized)) {
    throw new Error(`Arquivo não encontrado: ${safeRel}`);
  }
  const st = fs.statSync(normalized);
  if (!st.isFile()) {
    throw new Error(`Não é arquivo: ${safeRel}`);
  }

  return { safeRel, fullPath: normalized, stat: st };
}

async function sendManualSelection({ relPaths, overrideEmails }) {
  const config = readRecipientsConfig();
  const emails = overrideEmails && overrideEmails.length ? overrideEmails : config.emails;
  if (!emails.length) {
    throw new Error('Nenhum e-mail configurado.');
  }

  const unique = Array.from(new Set(relPaths.map((x) => String(x || '').trim()).filter(Boolean)));
  if (unique.length === 0) {
    throw new Error('Nenhuma foto selecionada.');
  }
  if (unique.length > 200) {
    throw new Error('Selecione no máximo 200 arquivos por envio.');
  }

  const files = [];
  let totalBytes = 0;
  unique.forEach((rel) => {
    const resolved = resolveStorageFile_(rel);
    totalBytes += resolved.stat.size;
    files.push({
      relPath: resolved.safeRel,
      fileName: path.basename(resolved.safeRel),
      fullPath: resolved.fullPath,
    });
  });

  if (totalBytes > 220 * 1024 * 1024) {
    throw new Error('Seleção muito grande para e-mail. Reduza a quantidade de arquivos.');
  }

  const zipName = `manual_${fileDateToken()}_${files.length}fotos.zip`;
  const zipPath = path.join(ZIP_DIR, zipName);
  await createZipFromFiles(files, zipPath);

  const cfgToSend = { ...config, emails };
  await sendBatchEmail(zipPath, cfgToSend, files.length);

  const sentBucket = path.join(SENT_DIR, new Date().toISOString().slice(0, 10));
  fs.mkdirSync(sentBucket, { recursive: true });
  files.forEach((f) => {
    if (f.relPath.startsWith('pending/')) {
      moveFileSafe(f.fullPath, path.join(sentBucket, f.fileName));
    }
  });

  return { zipName, count: files.length, emails };
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
    autoSendEnabled: AUTO_SEND_ENABLED,
    pending: listPendingPhotos().length,
    batchSize: cfg.batchSize,
    recipients: cfg.emails.length,
  });
});

app.get('/admin', requireAdminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/galeria', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'gallery.html'));
});

app.get('/api/admin/list', requireAdminAuth, (req, res) => {
  const all = listAllPhotos().map((x) => ({
    relPath: x.relPath,
    url: `/files/${encodeURI(x.relPath)}`,
    name: x.fileName,
    bucket: x.bucket,
    mtime: x.mtime,
  }));
  res.json({ items: all });
});

app.get('/api/gallery/list', (req, res) => {
  const all = listAllPhotos().map((x) => ({
    url: `/files/${encodeURI(x.relPath)}`,
    name: x.fileName,
    bucket: x.bucket,
    mtime: x.mtime,
  }));
  res.json({ items: all });
});

app.post('/api/admin/send', requireAdminAuth, async (req, res) => {
  try {
    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    const overrideEmails = Array.isArray(req.body?.emails)
      ? req.body.emails
      : parseEmailList(req.body?.emails);
    const result = await sendManualSelection({ relPaths: files, overrideEmails });
    res.json({ ok: true, ...result });
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    res.status(400).json({ ok: false, error: msg });
  }
});

app.post('/api/admin/delete', requireAdminAuth, (req, res) => {
  try {
    const rel = String(req.body?.file || '').trim();
    const resolved = resolveStorageFile_(rel);
    fs.unlinkSync(resolved.fullPath);
    res.json({ ok: true, file: resolved.safeRel });
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    res.status(400).json({ ok: false, error: msg });
  }
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

    if (AUTO_SEND_ENABLED) {
      processBatchesIfNeeded().catch(() => {});
    }

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
