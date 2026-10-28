import contextlib
import json
import os
import sqlite3
from contextvars import ContextVar
from .customization import DEFAULT_RULES
from pathlib import Path

DATA = Path(os.environ.get('DATA_DIR', Path(__file__).resolve().parents[2] / 'data')).resolve()
DATA.mkdir(parents=True, exist_ok=True, mode=0o700)
CURRENT_USER = ContextVar('ledger_user', default='admin')


def data_dir():
    uid = CURRENT_USER.get()
    if uid == 'admin':
        return DATA
    # IDs are server generated, never usernames or request-supplied paths.
    if len(uid) != 32 or any(c not in '0123456789abcdef' for c in uid):
        raise ValueError('账号标识无效')
    return DATA / 'users' / uid


@contextlib.contextmanager
def tenant(uid):
    token = CURRENT_USER.set(uid)
    try:
        yield
    finally:
        CURRENT_USER.reset(token)


@contextlib.contextmanager
def db():
    con = sqlite3.connect(data_dir() / 'ledger.db', timeout=15)
    con.row_factory = sqlite3.Row
    con.execute('PRAGMA foreign_keys=ON')
    try:
        yield con
        con.commit()
    except BaseException:
        con.rollback()
        raise
    finally:
        con.close()


def init():
    directory = data_dir()
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    if os.name != 'nt':
        directory.chmod(0o700)
    with db() as c:
        c.execute('PRAGMA journal_mode=WAL')
        previous_version = c.execute('PRAGMA user_version').fetchone()[0]
        c.executescript('''
        CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY,name TEXT,platform TEXT,payload TEXT,created TEXT DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS decisions(event_id TEXT PRIMARY KEY,payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL,version INTEGER DEFAULT 1);
        CREATE TABLE IF NOT EXISTS remote_cache(ledger TEXT,id TEXT,payload TEXT,PRIMARY KEY(ledger,id));
        CREATE TABLE IF NOT EXISTS bindings(ledger TEXT,expense_id TEXT,record_id TEXT,snapshot TEXT,PRIMARY KEY(ledger,expense_id));
        CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,state TEXT,payload TEXT,created TEXT DEFAULT CURRENT_TIMESTAMP,updated TEXT DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,expires REAL);
        CREATE TABLE IF NOT EXISTS customization(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1);
        CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,kind TEXT NOT NULL,action TEXT NOT NULL,event_id TEXT,summary TEXT NOT NULL,before_json TEXT,after_json TEXT,created TEXT DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS data_preferences(id INTEGER PRIMARY KEY CHECK(id=1),retention_days INTEGER NOT NULL DEFAULT 30,revision INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1);
        CREATE TABLE IF NOT EXISTS trash_batches(id TEXT PRIMARY KEY,deleted_at REAL NOT NULL,expires_at REAL NOT NULL,retention_days INTEGER NOT NULL,summary TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS deleted_events(event_id TEXT PRIMARY KEY,batch_id TEXT NOT NULL REFERENCES trash_batches(id));
        CREATE TABLE IF NOT EXISTS deleted_files(file_id TEXT PRIMARY KEY,batch_id TEXT NOT NULL REFERENCES trash_batches(id));
        CREATE INDEX IF NOT EXISTS idx_trash_events_batch ON deleted_events(batch_id);
        CREATE INDEX IF NOT EXISTS idx_trash_files_batch ON deleted_files(batch_id);
        CREATE TABLE IF NOT EXISTS event_files(event_id TEXT NOT NULL,file_id TEXT NOT NULL,PRIMARY KEY(event_id,file_id));
        CREATE INDEX IF NOT EXISTS idx_event_files_file ON event_files(file_id);
        CREATE TABLE IF NOT EXISTS disabled_files(file_id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS file_reparse(file_id TEXT PRIMARY KEY);
        PRAGMA user_version=5;
        ''')
        c.execute('INSERT OR IGNORE INTO customization(id,payload,version) VALUES (1,?,1)', (dumps(DEFAULT_RULES),))
        c.execute('INSERT OR IGNORE INTO data_preferences(id) VALUES (1)')
        if previous_version < 5:
            # Legacy imports saved only the latest event's file origin. Re-upload
            # must parse once to recover overlap membership instead of short-circuiting.
            c.execute('INSERT OR IGNORE INTO file_reparse SELECT id FROM files')
        for row in c.execute('SELECT id,payload FROM events').fetchall():
            fid = json.loads(row['payload']).get('file_id')
            if fid:
                c.execute('INSERT OR IGNORE INTO event_files VALUES (?,?)',(row['id'],fid))
    if os.name != 'nt':
        (directory / 'ledger.db').chmod(0o600)


def record_operation(c, kind, action, summary, event_id=None, before=None, after=None):
    import uuid
    c.execute('INSERT INTO operations(id,kind,action,event_id,summary,before_json,after_json) VALUES (?,?,?,?,?,?,?)',
              (uuid.uuid4().hex, kind, action, event_id, summary, dumps(before) if before is not None else None, dumps(after) if after is not None else None))


def dumps(x):
    return json.dumps(x, ensure_ascii=False, separators=(',', ':'))


def events():
    from .data_scope import visible_events
    with db() as c:
        return visible_events(c)


def data_preferences():
    with db() as c:
        return dict(c.execute('SELECT retention_days,revision,version FROM data_preferences WHERE id=1').fetchone())


def decisions():
    with db() as c:
        return {r[0]: json.loads(r[1]) for r in c.execute('SELECT event_id,payload FROM decisions')}


def settings(private=False):
    with db() as c:
        row = c.execute('SELECT payload,version FROM settings WHERE id=1').fetchone()
    value = json.loads(row[0]) if row else {}
    value['version'] = row[1] if row else 0
    if not private:
        for key in ('app_secret', 'user_token'):
            value['has_' + key] = bool(value.pop(key, ''))
    return value


def customization():
    with db() as c:
        row = c.execute('SELECT payload,version FROM customization WHERE id=1').fetchone()
    return {'douyin_duplicate_filter': False, **json.loads(row[0]), 'version': row[1]}


def secret_box():
    from cryptography.fernet import Fernet
    key = os.environ.get('CREDENTIAL_KEY')
    if not key:
        p = DATA / 'credential.key'
        if not p.exists():
            try:
                fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, 'wb') as f:
                    f.write(Fernet.generate_key())
            except FileExistsError:
                pass
        key = p.read_bytes()
    return Fernet(key)


def encrypt(value):
    return secret_box().encrypt(value.encode()).decode() if value else ''


def decrypt(value):
    from cryptography.fernet import InvalidToken
    try:
        return secret_box().decrypt(value.encode()).decode() if value else ''
    except InvalidToken:
        raise ValueError('凭证无法解密，请恢复原加密密钥，或在设置中重新输入凭证') from None
