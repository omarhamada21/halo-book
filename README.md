# 🛡️ Mimir Marking

> **Enterprise AI-Powered Examination Ingestion, Proctored Testing & Automated Grading Platform**  
> Designed for Cambridge, IELTS, and GCSE English assessments.

---

## 🌟 Overview

**Mimir Marking** is an end-to-end examination engine that transforms static examination PDFs, audio tracks, and mark schemes into interactive, proctored digital tests. Powered by Google Gemini AI and LibSQL/Turso, the system automates the complete assessment lifecycle: from multi-part document ingestion and teacher review canvases to high-security lockdown exam delivery and OCR-assisted grading.

---

## 🚀 Key Features

### 📄 Autonomous Exam Paper Ingestion
* **Full Multi-Part Parsing**: Ingests complete Cambridge exam papers (Part 1 through Part 5, up to 25 sequential questions) directly from PDF documents and official mark schemes.
* **Universal Audio Transcriber**: Ingests exam listening tracks, stores them securely in S3/Filebase or local storage, and generates verbatim passage transcripts via Gemini.
* **Picture Choice Handling**: Eliminates unreliable coordinate cropping by generating descriptive captions for visual choices, with full manual override capabilities.

### 🎨 Universal Choice Image & Question Builder
* **Interactive Option Management**: Add, replace, or remove image attachments for any option choice (A, B, C, D) on any multiple-choice question.
* **Rich Question Types**:
  * **MCQ**: Standard text and visual choices with per-option images and custom captions.
  * **Matching**: Dynamic pool matching (e.g., Speakers 1–5 to Statements A–H).
  * **Fill-in-the-Blank / Short Answer**: Normalized accepted answer keys with mark scheme variations.
  * **Word Bank Exercises**: Group stimulus headings with shared word banks and draggable/selectable tokens.
  * **Extended Writing / Essay**: Hybrid text typing or multi-page handwritten photo uploads.
* **Completeness Verification**: Strict pre-publish integrity guards ensuring all questions have valid options, answer keys, and assigned marks.

### 🔒 Proctored Exam Environment
* **Strict Lockdown Protocol**:
  * Fullscreen enforcement with resume prompts.
  * Tab-switch and window-blur detection.
  * Right-click and keyboard shortcut lockdown (PrintScreen, F12, developer tools).
  * 2-strike maximum with automated exam termination and auto-submission.
* **Photo-Capture Grace Period**:
  * 2-minute (120-second) grace window allowing students to launch native camera apps and capture handwritten essay pages without incurring proctoring strikes.
* **True Single-Play Audio Enforcement**:
  * Single playback lock per candidate preventing track rewinding or replays during listening exams.

### 📝 Hybrid Essay Submissions & AI Examiner
* **Multi-Page Photo Capture**: Client-side image optimization and multi-page upload manager for handwritten scripts.
* **Gemini OCR & Band Rubrics**: Multi-modal vision analysis transcribes handwriting, evaluates grammar, vocabulary, task achievement, and assigns criteria scores aligned to marking schemes.
* **Printable Diagnostic Reports**: Instant PDF/HTML performance summaries with category breakdowns, error corrections, and senior examiner feedback.

---

## 🛠️ Technology Stack

| Layer | Technologies |
|---|---|
| **Backend** | Node.js (v18+), Express 5, Multer, Cookie-Parser, CORS |
| **Database** | LibSQL / Turso (Cloud & Local SQLite `mimirmarking.db`), bcryptjs, JWT |
| **AI / OCR** | Google Gemini (`@google/genai` SDK - Gemini 2.5 / 3.5 / 3.6 Flash) |
| **Storage** | S3-Compatible Storage (Filebase / AWS S3) & Local Disk Storage |
| **Document Processing** | `pdf-parse`, `pdf-lib`, `sharp`, `puppeteer` |
| **Frontend** | Vanilla JavaScript (ES6+), Modern Semantic HTML5, CSS Custom Properties |

---

## 📂 Project Structure

```text
halo-book/
├── public/                       # Frontend application assets
│   ├── admin.js                  # Teacher authorization & user management
│   ├── assignments.js            # Listening & MCQ test builder
│   ├── dashboard.js              # Teacher statistics & analytics
│   ├── index.html                # Teacher management console & review portal
│   ├── login.html                # Teacher authentication portal
│   ├── mcq-test.html             # Student listening/MCQ exam view
│   ├── online-test.html          # Student full proctored exam environment
│   ├── online-tests.js           # Online tests creation & review canvas
│   ├── shared.js                 # Shared UI components & notifications
│   ├── submissions.js            # Grading, submissions & diagnostic reports
│   ├── submit.html               # Student standalone assignment submission portal
│   └── uploads/                  # Local storage fallback for option images & audio
├── scripts/                      # Verification, testing & audit test suite
│   ├── capture_evidence.mjs      # Headless browser screenshot capture
│   ├── test_option_images.mjs    # Option image upload integration test
│   ├── test_photo_proctoring.mjs # Proctoring & 2-minute grace period test
│   └── verify_audit_final.mjs    # Architecture & route collision validator
├── .env.example                  # Environment variable configuration template
├── .gitignore                    # Git ignore specifications
├── package.json                  # Dependencies & npm scripts
├── server.js                     # Main Express server & API endpoints
└── README.md                     # Project documentation
```

---

## ⚙️ Installation & Setup

### Prerequisites
* **Node.js** (v18.0.0 or higher)
* **npm** (v9.0.0 or higher)
* **Google Gemini API Key** (via Google AI Studio)

### 1. Clone the Repository
```bash
git clone https://github.com/omarhamada21/halo-book.git
cd halo-book
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Configure Environment Variables
Copy `.env.example` to `.env` and fill in your credentials:
```bash
cp .env.example .env
```

Key environment variables:
```ini
PORT=3000
JWT_SECRET=your_jwt_secret_key
GEMINI_API_KEY=your_gemini_api_key

# Root Admin Configuration
ROOT_EMAIL=admin@example.com
ADMIN_EMAIL=teacher_admin@example.com

# Database (Local SQLite or Turso Cloud)
TURSO_DATABASE_URL=file:mimirmarking.db
TURSO_AUTH_TOKEN=

# S3 Storage (Optional Filebase/AWS configuration)
FILEBASE_KEY=
FILEBASE_SECRET=
FILEBASE_BUCKET_NAME=
```

### 4. Start the Application
```bash
npm start
```
The server will initialize the database schema automatically and listen on `http://localhost:3000`.

---

## 🧪 Running Automated Tests

Run the built-in validation suite:

```bash
# 1. Architectural audit (checks zero duplicate routes, zero foreign key locks, clean functions)
node scripts/verify_audit_final.mjs

# 2. Proctoring & photo-capture 2-minute grace period simulation
node scripts/test_photo_proctoring.mjs

# 3. Dedicated option image upload integration test
node scripts/test_option_images.mjs
```

---

## 🔐 Security & Access Control

* **Role Hierarchy**:
  * `root`: Superuser access with global permissions.
  * `admin`: Manage teachers, review submissions, and adjust platform settings.
  * `teacher`: Create tests, review student submissions, and manage assigned cohorts.
* **Strict Per-Teacher Scoping**: Exam tests, draft canvases, and attempt submissions are scoped to individual teachers to prevent unauthorized access or modification.
* **Student Anti-Cheat**: Secure public endpoints strip answer keys and evaluation criteria from student test payloads, ensuring academic integrity.

---

## 📄 License

Proprietary & Confidential. All rights reserved.
