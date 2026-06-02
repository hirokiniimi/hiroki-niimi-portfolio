require('dotenv').config();
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first'); // IPv4を優先（Railway対応）
const express    = require('express');
const multer     = require('multer');
const fs         = require('fs');
const path       = require('path');
const crypto     = require('crypto');
const { Resend } = require('resend');
const rateLimit  = require('express-rate-limit');

const app  = express();
const PORT = process.env.PORT || 3000;

// Railway では DATA_DIR にボリュームをマウントする
const DATA_DIR   = process.env.DATA_DIR || __dirname;
const IMAGES_DIR = path.join(DATA_DIR, 'images');
const CONTENT_FILE = path.join(DATA_DIR, 'content.json');

const CONTACT_TO = 'niimi12hiroki10@gmail.com';

// ── Mailer ──
const resend = new Resend(process.env.RESEND_API_KEY);

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';

const SECRET = crypto.randomBytes(32).toString('hex');

// ── Rate Limiters ──
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15分
  max: 10,                   // 10回まで
  message: { error: 'ログイン試行回数が多すぎます。15分後に再試行してください。' }
});

const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1時間
  max: 5,                    // 5件まで
  message: { error: '送信回数が上限に達しました。しばらく時間をおいてください。' }
});

// ── Middleware ──
app.set('trust proxy', 1); // Railwayのリバースプロキシ対応
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname), { extensions: ['html'] }));

// images ディレクトリを確保
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

// ── Auth helpers ──
function getToken(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/admin_token=([^;]+)/);
  return m ? m[1] : null;
}

function requireAuth(req, res, next) {
  if (getToken(req) === SECRET) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ── Image upload ──
const upload = multer({
  storage: multer.diskStorage({
    destination: IMAGES_DIR,
    filename: (req, file, cb) =>
      cb(null, `${Date.now()}${path.extname(file.originalname)}`)
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('画像またはPDFファイルのみ対応しています'));
  }
});

// ── Public API ──
app.get('/api/content', (req, res) => {
  try {
    res.json(JSON.parse(fs.readFileSync(CONTENT_FILE, 'utf8')));
  } catch {
    res.json({ works: [], about: { ja: '', en: '', image: '' }, news: [] });
  }
});

// ── Auth API ──
app.post('/api/login', loginLimiter, (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    res.setHeader('Set-Cookie',
      `admin_token=${SECRET}; Path=/; HttpOnly; SameSite=Lax`);
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'パスワードが違います' });
  }
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie',
    'admin_token=; Path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT');
  res.json({ ok: true });
});

app.get('/api/auth', requireAuth, (req, res) => res.json({ ok: true }));

// ── Protected API ──
app.put('/api/content', requireAuth, (req, res) => {
  try {
    fs.writeFileSync(CONTENT_FILE, JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/upload', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'ファイルがありません' });
  res.json({ path: `images/${req.file.filename}` });
});

// ── Contact ──
app.post('/api/contact', contactLimiter, async (req, res) => {
  const { name, email, subject, message } = req.body;
  if (!name || !email || !message) {
    return res.status(400).json({ error: '必須項目を入力してください' });
  }
  if (!process.env.RESEND_API_KEY) {
    return res.status(500).json({ error: 'メール設定が未完了です' });
  }
  try {
    await resend.emails.send({
      from: 'onboarding@resend.dev',
      replyTo: `${name} <${email}>`,
      to: CONTACT_TO,
      subject: subject ? `[お問い合わせ] ${subject}` : `[お問い合わせ] ${name} 様より`,
      text: [
        `お名前: ${name}`,
        `メール: ${email}`,
        `件名: ${subject || '（なし）'}`,
        '',
        `メッセージ:`,
        message
      ].join('\n')
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('Mail error:', e.message);
    res.status(500).json({ error: '送信に失敗しました。時間をおいて再度お試しください。' });
  }
});

// ── Start ──
app.listen(PORT, () => {
  console.log(`\n  サイト:  http://localhost:${PORT}`);
  console.log(`  管理画面: http://localhost:${PORT}/admin.html\n`);
});
