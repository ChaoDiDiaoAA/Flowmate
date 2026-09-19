"""Resolve current case files through their authoritative catalog.

Roots are quality-data directories (the directory containing cases/manifests).
Only catalog-free legacy fixtures may discover cases by directory scanning.
"""
import json
from pathlib import Path, PurePosixPath
import re

from harness_modules import MODULES

LEGACY_CATEGORIES = {'extraction', 'matching', 'approval', 'submission',
                     'runtime', 'isolation', 'platform'}


def _identity(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]+', value):
        raise ValueError('Unsafe case identity')
    return value


def canonical_case_path(case):
    identity = _identity(case.get('id'))
    if case.get('kind') == 'agent_task' and case.get('schemaVersion') == 1:
        return f'cases/{identity}.json'
    if 'harnessModule' in case:
        folder = case['harnessModule']
        allowed = MODULES
    else:
        folder = case.get('category')
        allowed = LEGACY_CATEGORIES
    if not isinstance(folder, str) or folder not in allowed:
        raise ValueError('Unknown or unsafe case module/category')
    return f'cases/{folder}/{identity}.json'


def _read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def _catalog_paths(root):
    root = Path(root).resolve()
    catalog_path = root / 'manifests/case-catalog.json'
    if not catalog_path.exists():
        return None
    catalog = _read(catalog_path)
    if not isinstance(catalog, dict) or not isinstance(catalog.get('cases'), list):
        raise ValueError('Invalid case catalog')
    paths, seen_paths = {}, set()
    for entry in catalog['cases']:
        if not isinstance(entry, dict):
            raise ValueError('Invalid case catalog member')
        identity = _identity(entry.get('id'))
        relative = entry.get('path')
        if entry.get('kind') == 'product_contract':
            continue  # Suite variants are resolved by the unified asset catalog, not the task-only API.
        if entry.get('kind') == 'agent_task':
            from rebuild_sources import contained
            import hashlib
            if relative != f'cases/{identity}.json':
                raise ValueError('Invalid flat task path')
            path = contained(root, relative)
            raw = path.read_bytes()
            if hashlib.sha256(raw).hexdigest() != entry['sha256'] or identity in paths:
                raise ValueError('Task pin drift or duplicate identity')
            case = json.loads(raw)
            if case['id'] != identity or canonical_case_path(case) != relative:
                raise ValueError('Task identity mismatch')
            paths[identity] = path
            continue
        if not isinstance(relative, str):
            raise ValueError('Missing case catalog path')
        parts = PurePosixPath(relative).parts
        if (len(parts) != 3 or parts[0] != 'cases' or '\\' in relative or ':' in relative
                or parts[1] not in set(MODULES) | LEGACY_CATEGORIES
                or parts[2] != identity + '.json' or relative != '/'.join(parts)):
            raise ValueError(f'Unsafe or mismatched case catalog path: {relative}')
        path = root / relative
        if (not path.resolve().is_relative_to(root)
                or not path.resolve().is_relative_to((root / 'cases').resolve())):
            raise ValueError(f'Case path escapes cases root: {relative}')
        normalized = relative.casefold()
        if identity in paths or normalized in seen_paths:
            raise ValueError('Duplicate case catalog identity or path')
        if not path.is_file():
            raise ValueError(f'Missing case catalog member: {relative}')
        case = _read(path)
        if not isinstance(case, dict) or case.get('id') != identity:
            raise ValueError(f'Case catalog identity differs from file: {relative}')
        if canonical_case_path(case) != relative:
            raise ValueError(f'Case catalog path differs from case module: {relative}')
        if 'harnessModule' in entry and entry['harnessModule'] != case.get('harnessModule'):
            raise ValueError(f'Case catalog module differs from file: {relative}')
        paths[identity] = path
        seen_paths.add(normalized)
    return paths


def _legacy_paths(root):
    root = Path(root).resolve()
    paths = {}
    for path in sorted((root / 'cases').glob('*/*.json')):
        case = _read(path)
        if path.stem != case.get('id'):
            continue  # Historical versions are selected only through releases.
        identity = _identity(case['id'])
        if (identity in paths or canonical_case_path(case) != path.relative_to(root).as_posix()
                or not path.resolve().is_relative_to(root)
                or not path.resolve().is_relative_to((root / 'cases').resolve())):
            raise ValueError('Duplicate or misplaced legacy case')
        paths[identity] = path
    return paths


def list_current_case_paths(root):
    paths = _catalog_paths(root)
    if paths is None:
        paths = _legacy_paths(root)
    return [paths[identity] for identity in sorted(paths)]


def resolve_case_path(root, case_id):
    identity = _identity(case_id)
    paths = _catalog_paths(root)
    if paths is None:
        paths = _legacy_paths(root)
    if identity not in paths:
        raise ValueError(f'Case is not a current catalog member: {identity}')
    return paths[identity]
