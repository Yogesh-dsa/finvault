const express    = require('express');
const mongoose   = require('mongoose');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const cors       = require('cors');
const path       = require('path');
const nodemailer = require('nodemailer');
const crypto     = require('crypto');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB Atlas connected'))
  .catch(err => { console.error('❌ MongoDB:', err.message); process.exit(1); });

const JWT_SECRET = process.env.JWT_SECRET || 'finvault_secret_change_me';
const BASE_URL   = process.env.BASE_URL   || 'http://localhost:3000';

// ── EMAIL ─────────────────────────────────────────────────
function getMailer() {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

async function sendVerificationEmail(email, name, token) {
  const mailer = getMailer();
  if (!mailer) { console.log('⚠️  SMTP not configured — skipping email for', email); return; }
  const url = `${BASE_URL}/api/auth/verify-email?token=${token}`;
  await mailer.sendMail({
    from: `"FinVault" <${process.env.SMTP_USER}>`,
    to: email,
    subject: 'Verify your FinVault account',
    html: `
    <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:520px;margin:0 auto;background:#0a0a0f;border-radius:20px;overflow:hidden">
      <div style="background:linear-gradient(135deg,#0A84FF,#5E5CE6);padding:36px;text-align:center">
        <div style="font-size:28px;font-weight:800;color:#fff;letter-spacing:-0.5px">FinVault</div>
        <div style="color:rgba(255,255,255,0.7);font-size:13px;margin-top:4px">Personal Finance Ledger</div>
      </div>
      <div style="padding:36px;background:#111118">
        <h2 style="color:#fff;font-size:20px;font-weight:700;margin:0 0 12px">Welcome, ${name}!</h2>
        <p style="color:rgba(255,255,255,0.6);font-size:14px;line-height:1.7;margin:0 0 28px">
          Click the button below to verify your email and activate your FinVault account.
          This link expires in <strong style="color:#fff">24 hours</strong>.
        </p>
        <a href="${url}" style="display:inline-block;background:linear-gradient(135deg,#0A84FF,#5E5CE6);color:#fff;font-size:15px;font-weight:700;padding:14px 32px;border-radius:12px;text-decoration:none">
          Verify Email Address
        </a>
        <p style="color:rgba(255,255,255,0.3);font-size:12px;margin:24px 0 0;line-height:1.5">
          If you didn't create a FinVault account, ignore this email.
        </p>
      </div>
    </div>`,
  });
}

// ── SCHEMAS ───────────────────────────────────────────────
const UserSchema = new mongoose.Schema({
  username:      { type: String, required: true, unique: true, trim: true },
  password:      { type: String, required: true },
  name:          { type: String, required: true },
  role:          { type: String, enum: ['admin','user'], default: 'user' },
  verified:      { type: Boolean, default: false },
  verifyToken:   String,
  verifyExpires: Date,
}, { timestamps: true });

// ── FIX 4: All schemas now have userId field for data isolation ──
const TransactionSchema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type:        { type: String, enum: ['income','expense'], required: true },
  date:        { type: String, required: true },
  description: { type: String, required: true },
  amount:      { type: Number, required: true },
  category:    String, note: String, addedBy: String,
  source:      { type: String, default: 'manual' },
}, { timestamps: true });

const LoanGivenSchema = new mongoose.Schema({
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  friendName: { type: String, required: true },
  date:       { type: String, required: true },
  amount:     { type: Number, required: true },
  purpose:    String, note: String,
  returned:   { type: Boolean, default: false },
  returnedOn: { type: String, default: null },
  addedBy:    String,
}, { timestamps: true });

const BankLoanSchema = new mongoose.Schema({
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  bankName:     { type: String, required: true },
  startDate:    { type: String, required: true },
  principal:    { type: Number, required: true },
  interestRate: { type: Number, required: true },
  emi:          { type: Number, default: 0 },
  loanType:     String, note: String,
  active:       { type: Boolean, default: true },
  addedBy:      String,
}, { timestamps: true });

const InterestPaymentSchema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  loanId:      { type: mongoose.Schema.Types.ObjectId, ref: 'BankLoan' },
  date:        { type: String, required: true },
  amount:      { type: Number, required: true },
  paymentType: String, note: String, addedBy: String,
}, { timestamps: true });

const User            = mongoose.model('User',            UserSchema);
const Transaction     = mongoose.model('Transaction',     TransactionSchema);
const LoanGiven       = mongoose.model('LoanGiven',       LoanGivenSchema);
const BankLoan        = mongoose.model('BankLoan',        BankLoanSchema);
const InterestPayment = mongoose.model('InterestPayment', InterestPaymentSchema);

// ── SEED ADMIN + AUTO MIGRATE ORPHANS ────────────────────
mongoose.connection.once('open', async () => {
  const exists = await User.findOne({ username: 'yogeshguptag23@gmail.com' });
  if (!exists) {
    const hash = await bcrypt.hash('Hauser@0422', 10);
    await User.create({ username:'yogeshguptag23@gmail.com', password:hash, name:'Yogesh Gupta', role:'admin', verified:true });
    console.log('✅ Admin seeded');
  }
  // Assign any records without userId to admin (handles pre-v3 data)
  const admin = await User.findOne({ role:'admin' });
  if (admin) {
    const f = { userId:{ $exists:false } };
    const [t,l,b,i] = await Promise.all([
      Transaction.updateMany(f,     { $set:{ userId:admin._id } }),
      LoanGiven.updateMany(f,       { $set:{ userId:admin._id } }),
      BankLoan.updateMany(f,        { $set:{ userId:admin._id } }),
      InterestPayment.updateMany(f, { $set:{ userId:admin._id } }),
    ]);
    const n = t.modifiedCount+l.modifiedCount+b.modifiedCount+i.modifiedCount;
    if (n > 0) console.log(`✅ Migrated ${n} orphan records → admin`);
  }
});

// ── MIDDLEWARE ────────────────────────────────────────────
function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try { req.user = jwt.verify(h.slice(7), JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  next();
}

// ── FIX 4: Helper — admin sees all, user sees only own ───
function userFilter(req) {
  if (req.user.role === 'admin') return {};
  return { userId: req.user.id };
}

// ── AUTH ──────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password, name } = req.body;
    if (!username||!password||!name) return res.status(400).json({ error: 'All fields required' });
    if (await User.findOne({ username })) return res.status(400).json({ error: 'Email already registered' });
    const hash  = await bcrypt.hash(password, 10);
    const token = crypto.randomBytes(32).toString('hex');
    const smtpConfigured = !!(process.env.SMTP_USER && process.env.SMTP_PASS);

    if (!smtpConfigured) {
      // No SMTP configured — auto-verify so user can log in immediately
      await User.create({ username, password:hash, name, role:'user', verified:true });
      return res.json({ message:'SMTP_NOT_CONFIGURED' });
    }

    await User.create({ username, password:hash, name, role:'user', verified:false, verifyToken:token, verifyExpires:new Date(Date.now()+86400000) });
    try { await sendVerificationEmail(username, name, token); } catch(e) { console.error('Email error:', e.message); }
    res.json({ message:'CHECK_EMAIL' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/auth/verify-email', async (req, res) => {
  try {
    const user = await User.findOne({ verifyToken:req.query.token, verifyExpires:{ $gt:new Date() } });
    if (!user) return res.send(`<html><body style="font-family:-apple-system,sans-serif;background:#0a0a0f;color:#fff;text-align:center;padding:80px"><h2 style="color:#FF453A">❌ Link expired or invalid</h2><p><a href="/" style="color:#0A84FF">Go to FinVault</a></p></body></html>`);
    user.verified=true; user.verifyToken=undefined; user.verifyExpires=undefined;
    await user.save();
    res.send(`<html><body style="font-family:-apple-system,sans-serif;background:#0a0a0f;color:#fff;text-align:center;padding:80px"><div style="max-width:400px;margin:0 auto"><div style="font-size:56px;margin-bottom:16px">✅</div><h2 style="font-weight:700;font-size:24px">Email Verified!</h2><p style="color:rgba(255,255,255,0.6);margin-top:8px">Your FinVault account is now active.</p><a href="/" style="display:inline-block;background:linear-gradient(135deg,#0A84FF,#5E5CE6);color:#fff;padding:13px 28px;border-radius:12px;text-decoration:none;font-weight:700;margin-top:24px">Sign In →</a></div></body></html>`);
  } catch(e) { res.status(500).send('Error'); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    if (!user.verified) return res.status(403).json({ error:'EMAIL_NOT_VERIFIED', name:user.name });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id:user._id, username:user.username, name:user.name, role:user.role }, JWT_SECRET, { expiresIn:'7d' });
    res.json({ token, user:{ username:user.username, name:user.name, role:user.role } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/resend-verification', async (req, res) => {
  try {
    const user = await User.findOne({ username:req.body.username });
    if (!user||user.verified) return res.status(400).json({ error:'User not found or already verified' });
    const token = crypto.randomBytes(32).toString('hex');
    user.verifyToken=token; user.verifyExpires=new Date(Date.now()+86400000);
    await user.save();
    await sendVerificationEmail(user.username, user.name, token);
    res.json({ message:'Verification email resent' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── FIX 1: Token validation endpoint (fixes logout-on-click bug) ──
app.get('/api/auth/me', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id, '-password -verifyToken');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ username:user.username, name:user.name, role:user.role });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── USERS ─────────────────────────────────────────────────
app.get('/api/users', auth, adminOnly, async (req, res) => {
  try { res.json(await User.find({}, '-password -verifyToken').sort({ createdAt:1 })); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/users', auth, adminOnly, async (req, res) => {
  try {
    const { username, password, name, role } = req.body;
    if (!username||!password||!name) return res.status(400).json({ error:'All fields required' });
    if (await User.findOne({ username })) return res.status(400).json({ error:'Username already taken' });
    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({ username, password:hash, name, role:role||'user', verified:true });
    res.json({ username:user.username, name:user.name, role:user.role, verified:user.verified });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/users/:username', auth, adminOnly, async (req, res) => {
  try {
    if (req.params.username===req.user.username) return res.status(400).json({ error:'Cannot delete yourself' });
    await User.deleteOne({ username:req.params.username });
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── TRANSACTIONS (FIX 4: scoped by userId) ───────────────
app.get('/api/transactions', auth, async (req, res) => {
  try { res.json(await Transaction.find(userFilter(req)).sort({ date:-1, createdAt:-1 })); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/transactions', auth, async (req, res) => {
  try { res.json(await Transaction.create({ ...req.body, userId:req.user.id, addedBy:req.user.username })); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/transactions/bulk', auth, async (req, res) => {
  try {
    const docs = (req.body.transactions||[]).map(t => ({ ...t, userId:req.user.id, addedBy:req.user.username, source:'pdf' }));
    const result = await Transaction.insertMany(docs);
    res.json({ inserted:result.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/transactions/:id', auth, async (req, res) => {
  try {
    await Transaction.findOneAndDelete({ _id:req.params.id, ...userFilter(req) });
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── LOANS GIVEN (FIX 4: scoped by userId) ────────────────
app.get('/api/loans-given', auth, async (req, res) => {
  try { res.json(await LoanGiven.find(userFilter(req)).sort({ date:-1, createdAt:-1 })); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/loans-given', auth, async (req, res) => {
  try { res.json(await LoanGiven.create({ ...req.body, userId:req.user.id, addedBy:req.user.username })); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/loans-given/:id/return', auth, async (req, res) => {
  try {
    res.json(await LoanGiven.findOneAndUpdate(
      { _id:req.params.id, ...userFilter(req) },
      { returned:true, returnedOn:new Date().toISOString().split('T')[0] },
      { new:true }
    ));
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/loans-given/:id', auth, async (req, res) => {
  try { await LoanGiven.findOneAndDelete({ _id:req.params.id, ...userFilter(req) }); res.json({ ok:true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ── BANK LOANS (FIX 4: scoped by userId) ─────────────────
app.get('/api/bank-loans', auth, async (req, res) => {
  try { res.json(await BankLoan.find(userFilter(req)).sort({ startDate:-1, createdAt:-1 })); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/bank-loans', auth, async (req, res) => {
  try { res.json(await BankLoan.create({ ...req.body, userId:req.user.id, addedBy:req.user.username })); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/bank-loans/:id/close', auth, async (req, res) => {
  try { res.json(await BankLoan.findOneAndUpdate({ _id:req.params.id, ...userFilter(req) }, { active:false }, { new:true })); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/bank-loans/:id', auth, async (req, res) => {
  try { await BankLoan.findOneAndDelete({ _id:req.params.id, ...userFilter(req) }); res.json({ ok:true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ── INTEREST PAYMENTS (FIX 4: scoped by userId) ──────────
app.get('/api/interest-payments', auth, async (req, res) => {
  try { res.json(await InterestPayment.find(userFilter(req)).sort({ date:-1, createdAt:-1 })); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/interest-payments', auth, async (req, res) => {
  try { res.json(await InterestPayment.create({ ...req.body, userId:req.user.id, addedBy:req.user.username })); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/interest-payments/:id', auth, async (req, res) => {
  try { await InterestPayment.findOneAndDelete({ _id:req.params.id, ...userFilter(req) }); res.json({ ok:true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ── MIGRATION: assign orphan records to admin ─────────
app.post('/api/admin/migrate', auth, adminOnly, async (req, res) => {
  try {
    const admin = await User.findOne({ role: 'admin' });
    if (!admin) return res.status(404).json({ error: 'No admin found' });
    const [t,l,b,i] = await Promise.all([
      Transaction.updateMany({ userId: { $exists: false } }, { $set: { userId: admin._id } }),
      LoanGiven.updateMany({ userId: { $exists: false } }, { $set: { userId: admin._id } }),
      BankLoan.updateMany({ userId: { $exists: false } }, { $set: { userId: admin._id } }),
      InterestPayment.updateMany({ userId: { $exists: false } }, { $set: { userId: admin._id } }),
    ]);
    res.json({ transactions: t.modifiedCount, loans: l.modifiedCount, bankLoans: b.modifiedCount, interest: i.modifiedCount });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 FinVault v3 on port ${PORT}`));
