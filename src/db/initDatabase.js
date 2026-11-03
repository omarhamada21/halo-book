import { db } from './client.js';
import { cleanExpiredAssignments } from '../jobs/cleanExpiredAssignments.js';

async function initDatabase() {
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT,
        google_id TEXT,
        status TEXT DEFAULT 'pending',
        role TEXT DEFAULT 'teacher',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,
        bundle_code TEXT,
        group_title TEXT,
        teacher_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        deadline TEXT,
        scheme_text TEXT,
        scheme_files_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (teacher_id) REFERENCES users(id)
      );
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS submissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        assignment_id INTEGER NOT NULL,
        student_name TEXT NOT NULL,
        teacher_name TEXT,
        device_id TEXT,
        essay_text TEXT,
        page_count INTEGER DEFAULT 1,
        total_score TEXT,
        category_breakdown TEXT,
        mistakes TEXT,
        weaknesses TEXT,
        similarity_score INTEGER DEFAULT 0,
        similarity_details TEXT,
        ai_score INTEGER DEFAULT 0,
        ai_details TEXT,
        web_score INTEGER DEFAULT 0,
        ip_address TEXT,
        possible_duplicate INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (assignment_id) REFERENCES assignments(id)
      );
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS submission_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_name TEXT NOT NULL,
        assignment_code TEXT,
        assignment_title TEXT,
        teacher_name TEXT,
        submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS mcq_tests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        teacher_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        audio_path TEXT,
        transcript TEXT,
        deadline TEXT,
        status TEXT DEFAULT 'draft',
        code TEXT UNIQUE NOT NULL,
        max_plays INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (teacher_id) REFERENCES users(id)
      );
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS mcq_questions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        test_id INTEGER NOT NULL,
        question_type TEXT DEFAULT 'mcq',
        question_text TEXT NOT NULL,
        options TEXT NOT NULL,
        correct_index INTEGER,
        acceptable_answers TEXT,
        points REAL DEFAULT 1,
        order_index INTEGER DEFAULT 0,
        FOREIGN KEY (test_id) REFERENCES mcq_tests(id)
      );
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS mcq_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        test_id INTEGER NOT NULL,
        student_name TEXT NOT NULL,
        device_id TEXT,
        ip_address TEXT,
        answers TEXT,
        score REAL DEFAULT 0,
        possible_duplicate INTEGER DEFAULT 0,
        diagnostic_feedback TEXT,
        submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (test_id) REFERENCES mcq_tests(id)
      );
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS online_tests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        teacher_id INTEGER,
        title TEXT,
        deadline TEXT,
        status TEXT DEFAULT 'draft',
        code TEXT UNIQUE,
        audio_path TEXT,
        extra_instructions TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS online_test_sections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        test_id INTEGER,
        section_title TEXT,
        section_type TEXT, -- 'listening', 'reading', 'grammar', 'writing', 'general'
        part_number INTEGER DEFAULT 1,
        instructions_text TEXT,
        passage_text TEXT,
        transcript TEXT,
        order_index INTEGER DEFAULT 0
      );
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS online_test_questions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        section_id INTEGER,
        question_type TEXT, -- 'mcq', 'matching', 'fill_blank', 'rewrite', 'short_answer', 'writing'
        question_text TEXT,
        options TEXT, -- JSON array of strings or visual option objects
        correct_answer TEXT, -- JSON: index, array of accepted strings, or writing rubric criteria
        min_words INTEGER,
        max_words INTEGER,
        points REAL DEFAULT 1,
        order_index INTEGER DEFAULT 0,
        stimulus_image_url TEXT,
        has_visual_options INTEGER DEFAULT 0,
        group_title TEXT,
        group_instructions TEXT,
        shared_word_bank TEXT
      );
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS online_test_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        test_id INTEGER,
        student_name TEXT,
        device_id TEXT,
        ip_address TEXT,
        answers TEXT, -- JSON array of { question_id, answer, word_count }
        score REAL DEFAULT 0,
        max_score REAL DEFAULT 0,
        status TEXT DEFAULT 'pending_review', -- 'graded' or 'pending_review'
        possible_duplicate INTEGER DEFAULT 0,
        diagnostic_report TEXT,
        termination_reason TEXT DEFAULT 'normal',
        security_violations TEXT,
        submitted_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const autoMigrations = [
      'ALTER TABLE online_tests ADD COLUMN teacher_id INTEGER;',
      'UPDATE online_tests SET teacher_id = 1 WHERE teacher_id IS NULL;',
      'ALTER TABLE online_test_questions ADD COLUMN stimulus_image_url TEXT;',
      'ALTER TABLE online_test_questions ADD COLUMN has_visual_options INTEGER DEFAULT 0;',
      'ALTER TABLE online_test_questions ADD COLUMN group_title TEXT;',
      'ALTER TABLE online_test_questions ADD COLUMN group_instructions TEXT;',
      'ALTER TABLE online_test_questions ADD COLUMN shared_word_bank TEXT;',
      "ALTER TABLE online_test_attempts ADD COLUMN termination_reason TEXT DEFAULT 'normal';",
      "ALTER TABLE online_test_attempts ADD COLUMN security_violations TEXT;",
      'ALTER TABLE assignments ADD COLUMN bundle_code TEXT;',
      'ALTER TABLE assignments ADD COLUMN group_title TEXT;',
      'ALTER TABLE submissions ADD COLUMN teacher_name TEXT;',
      'ALTER TABLE submissions ADD COLUMN device_id TEXT;',
      'ALTER TABLE submissions ADD COLUMN essay_text TEXT;',
      'ALTER TABLE submissions ADD COLUMN similarity_score INTEGER DEFAULT 0;',
      'ALTER TABLE submissions ADD COLUMN similarity_details TEXT;',
      'ALTER TABLE submissions ADD COLUMN ai_score INTEGER DEFAULT 0;',
      'ALTER TABLE submissions ADD COLUMN ai_details TEXT;',
      'ALTER TABLE submissions ADD COLUMN web_score INTEGER DEFAULT 0;',
      'ALTER TABLE submissions ADD COLUMN ip_address TEXT;',
      'ALTER TABLE submissions ADD COLUMN possible_duplicate INTEGER DEFAULT 0;',
      'ALTER TABLE mcq_tests ADD COLUMN max_plays INTEGER DEFAULT 0;',
      'ALTER TABLE mcq_tests ADD COLUMN transcript TEXT;',
      'ALTER TABLE mcq_attempts ADD COLUMN diagnostic_feedback TEXT;',
      "ALTER TABLE mcq_questions ADD COLUMN question_type TEXT DEFAULT 'mcq';",
      'ALTER TABLE mcq_questions ADD COLUMN acceptable_answers TEXT;',
      `CREATE TABLE IF NOT EXISTS mcq_tests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        teacher_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        audio_path TEXT,
        transcript TEXT,
        deadline TEXT,
        status TEXT DEFAULT 'draft',
        code TEXT UNIQUE NOT NULL,
        max_plays INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (teacher_id) REFERENCES users(id)
      );`,
      `CREATE TABLE IF NOT EXISTS mcq_questions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        test_id INTEGER NOT NULL,
        question_type TEXT DEFAULT 'mcq',
        question_text TEXT NOT NULL,
        options TEXT NOT NULL,
        correct_index INTEGER,
        acceptable_answers TEXT,
        points REAL DEFAULT 1,
        order_index INTEGER DEFAULT 0,
        FOREIGN KEY (test_id) REFERENCES mcq_tests(id)
      );`,
      `CREATE TABLE IF NOT EXISTS mcq_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        test_id INTEGER NOT NULL,
        student_name TEXT NOT NULL,
        device_id TEXT,
        ip_address TEXT,
        answers TEXT,
        score REAL DEFAULT 0,
        possible_duplicate INTEGER DEFAULT 0,
        diagnostic_feedback TEXT,
        submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (test_id) REFERENCES mcq_tests(id)
      );`,
      `CREATE TABLE IF NOT EXISTS online_tests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        teacher_id INTEGER,
        title TEXT,
        deadline TEXT,
        status TEXT DEFAULT 'draft',
        code TEXT UNIQUE,
        audio_path TEXT,
        extra_instructions TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );`,
      `CREATE TABLE IF NOT EXISTS online_test_sections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        test_id INTEGER,
        section_title TEXT,
        section_type TEXT, -- 'listening', 'reading', 'grammar', 'writing', 'general'
        part_number INTEGER DEFAULT 1,
        instructions_text TEXT,
        passage_text TEXT,
        transcript TEXT,
        order_index INTEGER DEFAULT 0
      );`,
      `CREATE TABLE IF NOT EXISTS online_test_questions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        section_id INTEGER,
        question_type TEXT, -- 'mcq', 'matching', 'fill_blank', 'rewrite', 'short_answer', 'writing'
        question_text TEXT,
        options TEXT, -- JSON array of strings or visual option objects
        correct_answer TEXT, -- JSON: index, array of accepted strings, or writing rubric criteria
        min_words INTEGER,
        max_words INTEGER,
        points REAL DEFAULT 1,
        order_index INTEGER DEFAULT 0,
        stimulus_image_url TEXT,
        has_visual_options INTEGER DEFAULT 0,
        group_title TEXT,
        group_instructions TEXT,
        shared_word_bank TEXT
      );`,
      `CREATE TABLE IF NOT EXISTS online_test_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        test_id INTEGER,
        student_name TEXT,
        device_id TEXT,
        ip_address TEXT,
        answers TEXT, -- JSON array of { question_id, answer, word_count }
        score REAL DEFAULT 0,
        max_score REAL DEFAULT 0,
        status TEXT DEFAULT 'pending_review', -- 'graded' or 'pending_review'
        possible_duplicate INTEGER DEFAULT 0,
        diagnostic_report TEXT,
        termination_reason TEXT DEFAULT 'normal',
        security_violations TEXT,
        submitted_at TEXT DEFAULT CURRENT_TIMESTAMP
      );`,
      'ALTER TABLE online_test_questions ADD COLUMN word_bank TEXT;'
    ];

    for (const sql of autoMigrations) {
      try { await db.execute(sql); } catch (_) { }
    }

    console.log('Connected to Database successfully.');
    cleanExpiredAssignments();
  } catch (err) {
    console.error('Database initialization error:', err.message);
  }
}
initDatabase();

export { initDatabase };
