"""Consistent SQLite backup. Keep credential key separately; backup has private data."""
import argparse
import sqlite3
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('database', type=Path)
parser.add_argument('output', type=Path)
args = parser.parse_args()
if args.output.exists():
    raise SystemExit('目标已存在，请使用新的备份文件名')
with sqlite3.connect(f'file:{args.database.resolve().as_posix()}?mode=ro', uri=True) as source:
    with sqlite3.connect(args.output) as target:
        source.backup(target)
args.output.chmod(0o600)
print('数据库备份完成。凭证密钥请另行安全保存。')
