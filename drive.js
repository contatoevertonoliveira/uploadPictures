const fs = require('node:fs');
const { google } = require('googleapis');

function loadServiceAccountCredentials() {
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const path = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH || process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (json) {
    return JSON.parse(json);
  }
  if (path) {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  }

  throw new Error(
    'Credenciais do Google não configuradas. Defina GOOGLE_SERVICE_ACCOUNT_JSON (conteúdo JSON) ou GOOGLE_SERVICE_ACCOUNT_JSON_PATH/GOOGLE_APPLICATION_CREDENTIALS (caminho para o JSON).'
  );
}

function createDriveClient() {
  const credentials = loadServiceAccountCredentials();
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });

  return google.drive({ version: 'v3', auth });
}

async function uploadFileToFolder({ filePath, fileName, mimeType, folderId }) {
  const drive = createDriveClient();

  const res = await drive.files.create({
    supportsAllDrives: true,
    requestBody: {
      name: fileName,
      parents: [folderId],
    },
    media: {
      mimeType,
      body: fs.createReadStream(filePath),
    },
    fields: 'id,name,webViewLink',
  });

  return res.data;
}

module.exports = { uploadFileToFolder };

