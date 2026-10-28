"""Isolated parser subprocess; never emits source data into application logs."""
import json
import sys
from pathlib import Path
from .parsers import parse_file

if __name__ == '__main__':
    try:
        result = parse_file(sys.argv[2], Path(sys.argv[1]).read_bytes(), sys.argv[3])
    except Exception as e:
        result = {'error': str(e) if isinstance(e, ValueError) else '文件损坏、加密或格式不支持，请重新导出'}
    sys.stdout.buffer.write(json.dumps(result, ensure_ascii=False).encode('utf-8'))
