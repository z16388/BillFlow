"""Account registry only. Financial data is held in separate tenant databases."""
import contextlib
import hashlib
import os
import re
import secrets
import sqlite3
import time
import uuid

from argon2 import PasswordHasher
from argon2.exceptions import VerificationError
from . import db as storage

hasher = PasswordHasher()
DUMMY_HASH = hasher.hash(secrets.token_urlsafe(20))


@contextlib.contextmanager
def registry():
    con = sqlite3.connect(storage.DATA / 'accounts.db', timeout=15)
    con.row_factory = sqlite3.Row
    try:
        yield con
        con.commit()
    except BaseException:
        con.rollback()
        raise
    finally:
        con.close()


def init():
    storage.DATA.mkdir(parents=True, exist_ok=True, mode=0o700)
    with registry() as c:
        c.execute('PRAGMA journal_mode=WAL')
        c.executescript('''
        CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT UNIQUE COLLATE NOCASE,password_hash TEXT NOT NULL,role TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,created TEXT DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires REAL NOT NULL,FOREIGN KEY(user_id) REFERENCES users(id));
        ''')
        if not c.execute('SELECT 1 FROM users WHERE id=?', ('admin',)).fetchone():
            c.execute('INSERT OR IGNORE INTO users(id,username,password_hash,role) VALUES (?,?,?,?)',
                      ('admin', 'admin', hasher.hash(os.environ.get('DEFAULT_ADMIN_PASSWORD', 'change-me-before-use')), 'admin'))
        root=c.execute('SELECT role,active FROM users WHERE id=?',('admin',)).fetchone()
        if root['role']!='admin' or not root['active']:
            c.execute("UPDATE users SET role='admin',active=1 WHERE id='admin'")
            c.execute("DELETE FROM sessions WHERE user_id='admin'")
    if os.name != 'nt':
        (storage.DATA / 'accounts.db').chmod(0o600)


def public(row):
    return {k: row[k] for k in ('id', 'username', 'role', 'active', 'created')}


def resolve(token):
    if not token:
        return None
    with registry() as c:
        row = c.execute('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>? AND u.active=1',
                        (hashlib.sha256(token.encode()).hexdigest(), time.time())).fetchone()
    return public(row) if row else None


def verify(username, password):
    with registry() as c:
        row = c.execute('SELECT * FROM users WHERE username=?', (username,)).fetchone()
    try:
        # Equal-cost failure for unknown usernames.
        encoded = row['password_hash'] if row else DUMMY_HASH
        hasher.verify(encoded, password)
    except (VerificationError, ValueError):
        return None
    return public(row) if row and row['active'] else None


def new_session(uid):
    token = secrets.token_urlsafe(32)
    with registry() as c:
        c.execute('DELETE FROM sessions WHERE expires<?', (time.time(),))
        c.execute('INSERT INTO sessions VALUES (?,?,?)', (hashlib.sha256(token.encode()).hexdigest(), uid, time.time() + 43200))
    return token


def logout(token):
    with registry() as c:
        c.execute('DELETE FROM sessions WHERE token=?', (hashlib.sha256(token.encode()).hexdigest(),))


def validate_password(password):
    if not 8 <= len(password) <= 128:
        raise ValueError('密码长度需为 8–128 位')


def create(username, password, role='user'):
    if not re.fullmatch(r'[A-Za-z0-9_.-]{3,40}', username):
        raise ValueError('账号名需为 3–40 位字母、数字、下划线、点或短横线')
    validate_password(password)
    if role not in ('user', 'admin'):
        raise ValueError('角色无效')
    uid = uuid.uuid4().hex
    with registry() as c:
        c.execute('BEGIN IMMEDIATE')
        if c.execute('SELECT 1 FROM users WHERE username=?', (username,)).fetchone():
            raise ValueError('账号名已存在')
        with storage.tenant(uid):
            storage.init()
        c.execute('INSERT INTO users(id,username,password_hash,role) VALUES (?,?,?,?)', (uid, username, hasher.hash(password), role))
        return public(c.execute('SELECT * FROM users WHERE id=?', (uid,)).fetchone())


def update(uid, patch):
    if patch.get('role') not in (None, 'user', 'admin'):
        raise ValueError('角色无效')
    password = patch.get('password')
    if password is not None:
        validate_password(password)
    with registry() as c:
        c.execute('BEGIN IMMEDIATE')
        row = c.execute('SELECT * FROM users WHERE id=?', (uid,)).fetchone()
        if not row:
            raise ValueError('账号不存在')
        if uid=='admin' and (patch.get('role',row['role'])!='admin' or not patch.get('active',bool(row['active']))):
            raise ValueError('默认管理员不能设为普通账号或停用')
        role, active = patch.get('role', row['role']), patch.get('active', bool(row['active']))
        if row['role'] == 'admin' and row['active'] and (role != 'admin' or not active):
            if c.execute("SELECT COUNT(*) FROM users WHERE role='admin' AND active=1").fetchone()[0] <= 1:
                raise ValueError('至少保留一个启用的管理员账号')
        c.execute('UPDATE users SET role=?,active=? WHERE id=?', (role, int(active), uid))
        if password is not None:
            c.execute('UPDATE users SET password_hash=? WHERE id=?', (hasher.hash(password), uid))
        if password is not None or not active or role != row['role']:
            c.execute('DELETE FROM sessions WHERE user_id=?', (uid,))
        return public(c.execute('SELECT * FROM users WHERE id=?', (uid,)).fetchone())


def all_users():
    with registry() as c:
        return [public(r) for r in c.execute('SELECT * FROM users ORDER BY created,id')]
