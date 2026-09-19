"""Current-source locations and metric definitions for fresh Case authors.

This is a source register, not an automatically approved atomic requirement
inventory. Coverage requires reviewed condition/edge records and direct checks.
"""
import hashlib
from pathlib import Path
import re


SPEC_PATHS = {'product': 'docs/spec/00_Flowmate完整方案.md',
              'evaluation': 'agent-eval/docs/spec/01_Flowmate_Agent评测总方案.md'}
METRIC = re.compile(r'^\s*\|\s*`((?:MOD-\d{2}|ALL)\.[a-z][a-z0-9.-]*)`')


def parse_document(identity, path, text):
    sections, metrics, current, fenced = [], {}, None, None
    for number, line in enumerate(text.splitlines(), 1):
        fence = re.match(r'^\s*(`{3,}|~{3,})', line)
        if fence:
            marker = fence.group(1)[0]
            if fenced is None:
                fenced = marker
            elif marker == fenced:
                fenced = None
            continue
        if fenced:
            continue
        heading = re.match(r'^(#{1,6})\s+(.+)$', line)
        if heading:
            current = None
            numbered = re.match(r'^(\d+(?:\.\d+)*)(?:\.)?\s*[:：]?\s+(.+)$', heading.group(2))
            if numbered:
                current = {'id': numbered.group(1), 'heading': heading.group(2),
                           'level': len(heading.group(1)), 'startLine': number,
                           'lines': []}
                sections.append(current)
        elif current is not None:
            current['lines'].append({'number': number, 'text': line})
            match = METRIC.match(line)
            if match:
                metric_id = match.group(1)
                if metric_id in metrics:
                    raise ValueError(f'Duplicate metric definition {metric_id}')
                metrics[metric_id] = {'id': metric_id, 'section': current['id'],
                                      'startLine': number, 'definition': line.strip(),
                                      'reviewed': False, 'source': identity,
                                      'commonContractSections': ['8.2', '8.3', '8.9']}
    seen = set()
    for section in sections:
        if section['id'] in seen:
            raise ValueError(f'Duplicate numbered section {section["id"]}')
        seen.add(section['id'])
        section['text'] = '\n'.join(row['text'] for row in section['lines']).strip()
    return {'id': identity, 'path': path, 'bytes': len(text.encode()), 'sha256': hashlib.sha256(text.encode()).hexdigest(),
            'sections': sections, 'metrics': metrics, 'registerStatus': 'source_locations_only'}


def load_spec_contracts(project):
    project = Path(project)
    documents = {}
    for identity, relative in SPEC_PATHS.items():
        data = (project / relative).read_bytes()
        documents[identity] = parse_document(identity, relative, data.decode('utf-8-sig'))
        documents[identity]['sha256'] = hashlib.sha256(data).hexdigest()
        documents[identity]['bytes'] = len(data)
    return {'schemaVersion': 3, 'documents': documents,
            'metrics': documents['evaluation']['metrics'],
            'atomicRequirementReview': 'pending', 'coverageEstablished': False}


def resolve_source_ref(contracts, reference):
    try:
        document = contracts['documents'][reference['spec']]
        section = next(s for s in document['sections'] if s['id'] == reference['section'])
        quote = reference['quote']
    except (KeyError, StopIteration, TypeError) as exc:
        raise ValueError(f'Unknown source or section: {reference}') from exc
    if not isinstance(quote, str) or not quote.strip():
        raise ValueError('Empty source quote')
    # A quote is located in actual non-code source lines of this exact section.
    # Parent section labels are never silently accepted for a different child.
    matches = [row for row in section['lines'] if quote in row['text']]
    if not matches:
        raise ValueError(f'Source quote missing from section {reference["section"]}: {quote}')
    if len(matches) != 1 or matches[0]['text'].count(quote) != 1:
        raise ValueError('Source quote is ambiguous; use a longer unique excerpt')
    return {'path': document['path'], 'specSha256': document['sha256'],
            'section': section['id'], 'heading': section['heading'],
            'startLine': matches[0]['number'], 'quote': quote,
            'quoteSha256': hashlib.sha256(quote.encode()).hexdigest(),
            'interpretationReview': 'pending'}
